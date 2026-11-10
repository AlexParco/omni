# omni — Documento de diseño

> **Addendum 2026-10-13.** El proyecto se llama **omni** (antes agentdeck). El stack cambió a
> **Electron** (electron-vite, React, TypeScript 7, xterm.js + node-pty, CodeMirror 6,
> `WebContentsView` para el browser embebido); gpui/Rust queda descartado porque el browser
> embebido con captura al agente, el editor y el diff ya están resueltos en el ecosistema web y
> no en gpui. Quedan superseded: §4.3, §4.4, §6, §9 y las filas de §10 sobre gpui. La
> arquitectura vigente está en `ARCHITECTURE.md`; los hitos vigentes son: M0 terminal + bus +
> ⌘K, M1 ⌘T + sidebar + restaurar, M2 estados + notificaciones, M3 worktrees + diff + broadcast,
> M4 browser + captura + MCP, M5 editor + to-do + voz. Los agentes corren **tal cual en su
> terminal** (como en Orca); el "modo gestionado" sin TUI de §7.5 pasa a ser opcional y
> posterior. Siguen vigentes: §1–§3 (tesis), §4.1 (contrato de pane), §4.2 (bus de comandos),
> §7 (adaptadores y tiers), §8 y §11.


> **Nombre provisional.** Alternativas en juego: `omni`, `ccdeck`, `hangar`, `atelier`.
> Se decide antes del primer release público; el nombre del crate raíz se cambia con un `sed`.

**Estado:** diseño · **Última revisión:** 2026-08-17

---

## 1. Qué es

Un entorno de escritorio para trabajar con agentes de Claude Code. Tres capacidades
sobre un mismo sustrato:

- **Gestión de agentes** — varias sesiones en paralelo, **de cualquier vendor**
  (Claude Code, Codex, OpenCode y los que vengan), con su estado, costo, contexto y qué
  están tocando.
- **Manejo de terminales** — multiplexor de PTYs propio, como tmux.
- **Editor de texto** — modal, con config tipo Neovim.

Todo controlable **íntegramente por teclado**.

### 1.1 El problema, medido

El proyecto nace de una máquina concreta, no de una intuición. Medición del
2026-08-27 sobre el setup actual (tmux + alacritty + nvim, M1 Pro 10 núcleos, 16 GB):

| Métrica | Valor |
|---|---|
| Panes de tmux vivos | 17 |
| Procesos `claude` | 13, sumando **2.1 GB** de RSS |
| Swap en uso | **15.4 GB de 16 GB** — 921 MB libres |
| Páginas físicas libres | ~60 MB |
| CPU del servidor de tmux | **0.3 %** |

Las dos últimas filas son la tesis entera:

- **El trabón es presión de memoria, no de render.** macOS está comprimiendo y
  descomprimiendo páginas sin parar (235 M comprimidas / 207 M descomprimidas
  acumuladas) para sostener 13 agentes más el navegador, Docker y una VM.
- **tmux no es el cuello de botella.** Al 0.3 % de CPU, reemplazarlo por un
  multiplexor más rápido no devuelve nada. Alacritty ya es GPU-accelerated; un
  render acelerado tampoco.

> **Lo que omni sí ataca:** que 13 agentes exijan 13 TUIs interactivas vivas.
> **Lo que omni no arregla:** que un agente de Claude Code pese ~300 MB. Eso
> es del vendor, y ninguna arquitectura de panes lo cambia. Ver §8.5.

Esto tiene una consecuencia dura de producto: **el valor no es la velocidad de
pintado, es el control de flota** — y en particular, no pagar el costo de un agente
que no estás mirando (§7.5). Si el proyecto se justifica por performance de render,
se está justificando con un problema que no tiene.

## 2. Por qué las tres cosas juntas

Un agente hace exactamente dos cosas: **corre comandos y edita archivos**. La interfaz
natural para supervisarlo es, por lo tanto, un terminal más un editor. Las tres
capacidades no son features pegadas — son la superficie que el trabajo con agentes ya
requiere.

Esto es lo que hace que el proyecto cierre como uno solo y no como tres.

## 3. Tesis de producto

> Zed y VSCode son **editor-first** con agentes atornillados encima.
> omni es **agent-first** con el editor como un tipo de pane.

Esa inversión es el diferenciador, y tiene consecuencias concretas de diseño:

- La vista por defecto es el estado de la flota de agentes, no un archivo abierto.
- El editor existe para revisar lo que un agente hizo, no como lugar donde vives.
- Los worktrees son ciudadanos de primera clase: un agente, un worktree.
- El bus de comandos (§4.2) es invocable **por los agentes**, no solo por el usuario.

## 4. Arquitectura

La regla que sostiene todo el proyecto:

> **Un sustrato, N tipos de pane.** Lo difícil se escribe una vez. Cada capacidad
> nueva es un tipo de pane, no un subsistema nuevo.

```
sustrato — lo único genuinamente difícil
├── árbol de panes ....... layout, foco, splits
├── motor de keymap ...... modos, resolución, binding → comando
├── render de texto ...... glyph atlas, métricas de celda, damage
├── PaneContent .......... abstracción: algo con líneas que se ve y se scrollea
├── bus de comandos ...... toda acción tiene nombre y es invocable
└── workspace ............ cwd, repo git, worktree

tipos de pane — cada uno incremental sobre el sustrato
├── TerminalPane ......... PTY + VT      → grilla  → render
├── AgentPane ............ sesión claude → estado  → render
├── EditorPane ........... archivo+rope  → líneas  → render
└── ScratchPane .......... Vec<String>   → líneas  → render   (prueba del sustrato)
```

El render de texto y el motor de keymap se escriben **una vez** y los usan los cuatro.
El editor no es otro proyecto: es un pane que pinta un rope en vez de una grilla de
terminal.

### 4.1 El contrato `PaneContent`

Es la pieza que hace que el sustrato no sea terminal-específico. Todo tipo de pane
implementa:

```rust
pub trait PaneContent {
    /// Líneas visibles del viewport, ya resueltas a celdas con atributos.
    fn lines(&self, viewport: Range<usize>) -> Vec<Line>;
    /// Qué cambió desde el último frame. Sin esto no hay performance (§8.1).
    fn damage(&self) -> Damage;
    /// El pane puede consumir la tecla, o devolver un comando para el bus.
    fn on_key(&mut self, key: KeyEvent, mode: Mode) -> KeyOutcome;
    fn on_resize(&mut self, cols: u16, rows: u16);
    fn title(&self) -> String;
    fn scroll(&mut self, delta: isize);
}
```

`KeyOutcome` es `Consumed | Command(Command) | Ignored`. Un TerminalPane con foco
consume casi todo tal cual; un EditorPane resuelve según el modo; un AgentPane consume
poco y emite comandos.

### 4.2 Bus de comandos

**Toda acción del programa tiene un nombre y es invocable como dato.** No hay lógica
que solo se pueda alcanzar apretando una tecla.

```rust
pub enum Command {
    PaneSplit { dir: Direction },
    PaneFocus { target: FocusTarget },
    PaneClose { id: PaneId },
    AgentSpawn { cwd: PathBuf },
    AgentSend  { id: AgentId, text: String },
    EditorOpen { path: PathBuf, line: Option<u32> },
    DiffShow   { worktree: WorktreeId },
    // ...
}

/// name → constructor, para paleta, Lua y agentes.
pub struct CommandRegistry { /* "pane.split" → fn(Args) -> Result<Command> */ }
```

Cuatro cosas salen del mismo diseño:

| Consumidor | Cómo llega al comando |
|---|---|
| Teclado | tabla `(modo, secuencia) → Command` |
| Paleta | búsqueda difusa sobre `CommandRegistry` |
| Config Lua | `deck.cmd("pane.split", {dir="vertical"})` |
| **Agentes** | herramienta MCP o hook que invoca por nombre |

El cuarto es el foso. Con el bus compartido, la integración agente↔editor sale gratis
en vez de ser código a medida:

- El agente termina y abre el archivo que tocó en un pane de editor.
- Marcas una región en el editor y con una tecla se la mandas al agente.
- El agente pide permiso y el diff te salta al lado, ya posicionado.

En un editor donde eso no existe, cada una de esas cosas es una feature específica.
Aquí son tres llamadas al bus.

**Se diseña desde el primer commit.** Es la pieza que, dejada para después, obliga a
reescribir todo lo que la rodea.

### 4.3 Proceso único en el MVP

La arquitectura final es daemon + cliente sobre unix socket, para que los agentes sigan
corriendo con la UI cerrada. **El MVP no implementa ese split**, pero se diseña para él:

- La lógica de sesiones, panes y agentes vive en crates que **no conocen la UI**.
- La UI lee estado y emite comandos. Nunca muta estado directamente.
- `Command` ya es serializable, aunque en el MVP viaje por un canal en memoria.

Meter el socket en M6 es cambiar el transporte, no reescribir el núcleo.

### 4.4 Crates

```
crates/
├── core/       tipos de dominio: PaneId, Mode, Line, Damage, KeyEvent
├── command/    enum Command + CommandRegistry + resolución de nombres
├── keymap/     modos, trie de secuencias, tabla estática (Lua en M4)
├── pane/       trait PaneContent + árbol de layout + foco
├── render/     glyph atlas, métricas de celda, pintado de Line
├── pty/        portable-pty: spawn, resize, señales, lectura
├── term/       wezterm-term: grilla, scrollback acotado  → TerminalPane
├── agent/      trait AgentAdapter + registro de vendors   → AgentPane
│   ├── claude/     adaptador tier 1 (hooks / stream-json)
│   ├── codex/      adaptador — tier por verificar
│   ├── opencode/   adaptador — tier por verificar
│   └── observed/   adaptador tier 3, sirve para cualquier CLI
├── hooks/      receptor de callbacks de vendors tier 1-2 (§7)
├── workspace/  cwd, repo git, worktrees
├── buffer/     ropey + tree-sitter                        → EditorPane  (M7)
├── lsp/        cliente LSP compartido                                   (M7)
└── app/        [bin] gpui: ventana, event loop, input
```

Regla dura: **`app/` y `render/` son los únicos crates que dependen de gpui.** Si algún
día se cambia de framework de GUI, se reescriben dos crates y ninguna lógica.

### 4.5 Flujo de datos

```
     hooks de claude code
              │
              ▼
         hooks ── unix socket, JSON por línea
              │
  PTY ──▶ term ┤
              ├──▶ pane (árbol, foco, estado)
  archivo ▶ buffer ┘         │
                             ▼
                    app (gpui) ── pinta vía render/
                             │
                       KeyEvent + Mode
                             │
                             ▼
                    keymap ──▶ Command ──▶ bus ──▶ pane
                                  ▲
                      Lua, paleta, agentes
```

Un único hilo dueño del estado. Los PTYs leen en tasks de tokio y mandan bytes por
canal. La UI nunca toca un PTY directamente.

## 5. Alcance: diseñar vs implementar

La distinción que ordena el proyecto entero:

| Capacidad | Diseñado desde | Implementado en |
|---|---|---|
| Sustrato completo (§4) | **M0** | M0 |
| Bus de comandos | **M0** | M0 |
| TerminalPane | M0 | M0–M1 |
| AgentPane + panel de flota | M0 | M2–M3 |
| Config Lua | **M0** (tabla estática primero) | M4 |
| Worktrees + diff | M0 | M5 |
| Daemon + detach | **M0** (`Command` serializable) | M6 |
| **EditorPane + LSP** | **M0** (`PaneContent` genérico) | **M7** |

"No lo implemento todavía" es correcto y necesario. **"No lo diseño" es lo que obliga a
reescribir en el mes 8.** El sustrato tiene que poder hospedar un EditorPane desde el
primer commit, aunque el EditorPane no exista hasta M7.

### Fuera de alcance, sin fecha

| Qué | Por qué |
|---|---|
| Windows / Linux | El MVP es macOS. `portable-pty` ya abstrae lo demás. |
| Scrollback infinito, búsqueda, copy-mode | Buffer acotado alcanza hasta M5. |
| Sistema de plugins de terceros | La config Lua de M4 cubre el caso propio. |
| Colaboración multi-usuario | No es el problema. |

## 6. Stack

| Capa | Elección | Descartado |
|---|---|---|
| Lenguaje | **Rust** | Go: `cgo` para tree-sitter/Lua anula el binario estático, y sus libs de VT no están probadas por ningún emulador real. Zig: ecosistema inexistente para esto. |
| GUI / render | **gpui** | `wgpu` + `glyphon` como plan B. `iced`/`egui` no sirven para pintar grillas de celdas. Webview + xterm.js: descartado conscientemente. |
| PTY | `portable-pty` (wezterm) | — |
| Estado VT | `wezterm-term` | `alacritty_terminal` es equivalente; se decide en M0 según cuál exponga mejor el damage. |
| Shaping | `cosmic-text` / `swash` | Lo que traiga gpui, si ya resuelve métricas monoespaciadas. |
| Buffer de texto | `ropey` + `tree-sitter` | (M7) |
| Config | `mlua` | (M4) |
| Async | `tokio` | — |

**Riesgo abierto:** verificar el estado de publicación de `gpui` como crate independiente
antes de comprometerse. **Se cierra en M0.**

## 7. Multi-agente: adaptadores y tiers

**El producto no supervisa Claude Code: supervisa agentes.** Claude Code, Codex,
OpenCode y lo que venga después. Esto es requisito, no extensión futura, y define la
forma del crate `agent/`.

### 7.1 El contrato

```rust
pub trait AgentAdapter: Send {
    fn spawn(&self, cwd: &Path, opts: SpawnOpts) -> Result<AgentHandle>;
    /// Estado normalizado. Es el mínimo común: todo adaptador debe producirlo.
    fn state(&self) -> AgentState;          // Working | NeedsYou | Ready | Down
    fn send(&self, text: &str) -> Result<()>;
    fn interrupt(&self) -> Result<()>;
    /// Qué puede informar este vendor. La UI lee esto para saber qué dibujar.
    fn caps(&self) -> Caps;                 // reason, cost, context, tool_name…
}
```

`AgentState` es el **mínimo común denominador**: los tres estados que el panel de flota
necesita para ordenar por urgencia. Todo lo demás es opcional y va detrás de `Caps`.

### 7.2 Tres tiers de fidelidad

| Tier | Cómo se detecta | Qué se puede mostrar |
|---|---|---|
| **1 · estructurado** | El vendor emite un stream JSON o dispara hooks con payload | Todo: estado, motivo exacto del bloqueo, tool en curso, tokens, costo, contexto |
| **2 · anotado** | Sin stream, pero el vendor puede llamar un callback en transiciones | Estado y tiempo en estado. Sin motivo ni métricas |
| **3 · observado** | Nada. Se infiere del PTY: quiescencia de salida y forma del prompt | Estado aproximado. Se marca como inferido en la UI |

**El tier 3 es la red de seguridad y es obligatorio.** Un adaptador que funciona sin
cooperación del vendor significa que ningún agente queda fuera: uno nuevo funciona el
día uno, degradado, y gana fidelidad cuando alguien le escriba su adaptador.

> **A qué tier pertenece cada vendor hay que verificarlo contra su CLI actual.**
> Las interfaces de Codex y OpenCode se mueven rápido, y este documento no es fuente
> de verdad sobre sus flags. La arquitectura está definida; el mapeo por vendor es una
> tarea de investigación al inicio de M2, una por adaptador.

### 7.3 Adaptador de Claude Code (tier 1)

Es el único con mecanismo ya validado en producción por
[`tmux-cc-sessions`](../tmux-cc-sessions): `scripts/state.sh` escribe el estado desde los
hooks. Se conserva; solo cambia el destino.

| | tmux-cc-sessions | omni |
|---|---|---|
| Transporte | `tmux set-option -p` | unix socket, JSON por línea |
| Correlación | `$TMUX_PANE` | `AGENTDECK_PANE`, inyectada al spawnear |
| Persistencia | ninguna | memoria (MVP), SQLite (M5) |

| Hook | Matcher | Estado |
|---|---|---|
| `UserPromptSubmit` | — | `Working` |
| `Notification` | `permission_prompt` | `NeedsYou` |
| `PreToolUse` | `AskUserQuestion` | `NeedsYou` |
| `Stop` | — | `Ready` |

Alternativa dentro del mismo tier: `--output-format stream-json --input-format
stream-json`. Da más (tokens, costo, contenido del prompt de permiso) pero pierde la TUI
real en el pane. Probablemente ambos modos: hooks para panes interactivos, stream-json
para panes gestionados. Se decide con M2 corriendo.

### 7.4 Consecuencias de diseño

1. **La UI degrada, no se rompe.** Un agente tier 3 ocupa la misma entrada con menos
   líneas. La ausencia de un dato nunca deja un hueco ni un `—` de relleno: la línea no
   existe. La entrada de flota lee `caps()` para decidir qué dibujar.
2. **Etiqueta de vendor en cada sesión.** Dos caracteres (`CC`, `CX`, `OC`), con borde
   punteado cuando el estado es inferido.
3. **El costo agregado es un piso, no un total.** Solo suma los vendors que lo reportan.
   La statusline muestra `$18.60+` — con el `+` — o miente.
4. **El bus se expone por MCP, no por CLI.** Cierra la decisión abierta §11.5: MCP es lo
   único que los tres vendors hablan. Un CLI habría requerido que cada agente supiera
   invocarlo.
5. **El nombre no puede ser `cc*`.** Ver §11.1.

### 7.5 Modo gestionado: el agente sin TUI

**La palanca que resuelve §1.1.** Un agente que no necesita tu atención no tiene por
qué tener una TUI corriendo, redibujándose y ocupando memoria.

Dos formas de hospedar una sesión, decididas por omni, no por el usuario:

| | **Gestionado** (default) | **Materializado** |
|---|---|---|
| Proceso | `--output-format stream-json` | TUI real en un PTY |
| Costo | sin render, sin PTY, sin parseo VT | pane completo |
| Estado | del stream, fidelidad tier 1 completa | de hooks |
| Cuándo | siempre, al arrancar | al pasar a `NeedsYou`, o al saltar tú |

El ciclo de vida: **todo agente arranca gestionado.** Se materializa en un pane solo
cuando (a) su estado pasa a `NeedsYou`, o (b) saltas a él desde el panel de flota. Al
volver a `Working` puede desmaterializarse, conservando el historial en el scrollback
del pane.

Esto convierte los 13 PTYs medidos en §1.1 en **1–2 materializados y el resto como
lectores de un stream JSON**. Es la diferencia entre supervisar una flota y hospedar
trece terminales.

Cierra además la decisión abierta §11.3 en su forma correcta: **no es hooks _vs_
stream-json, son los dos**, y cada uno corresponde a un modo de hospedaje. Hooks para
el pane materializado (donde la TUI real es el punto), stream-json para el gestionado
(donde la TUI es puro desperdicio).

**Riesgo a verificar en M2:** que materializar sea *reversible* y que el traspaso
gestionado → materializado no pierda el hilo de la conversación. Si el vendor no
permite adjuntar una TUI a una sesión ya iniciada, el modo gestionado se degrada a
"la sesión se relanza al materializar", que es peor pero sigue ganando. **Verificarlo
es la primera tarea de M2**, antes de escribir el adaptador.

## 8. Los problemas técnicos reales

Los cuatro son arquitectura, no optimización posterior.

**8.1 Damage tracking.** Un `cargo build` escupe megabytes por el PTY. Repintar la grilla
completa por frame no escala. Diff por línea desde el día uno — está en el trait
`PaneContent` por esta razón.

**8.2 Backpressure.** Descartar frames intermedios cuando el render no alcanza, y capar
el scrollback en memoria. Un agente en loop llena la RAM si no.

**8.3 Métricas de celda.** El grid necesita advance width exacto y consistente. Las
ligaduras se deciden después; primero que las columnas cuadren.

**8.4 Foco de teclado vs control total por teclado.** El conflicto central del proyecto.
Un TerminalPane con foco debe recibir las teclas **tal cual** — si interceptas `Ctrl-B`
para splits, rompes tmux dentro del pane; si interceptas `Ctrl-W`, rompes readline. La
resolución: prefix global (una sola tecla reservada) para comandos de pane, y todo lo
demás pasa al pane. `KeyOutcome::Consumed` existe para esto. Ver decisión abierta §11.4.

**8.5 Presupuesto de recursos.** omni es **co-inquilino de los agentes, no su
dueño**: comparte los 16 GB con ellos, y son ellos los que pesan (§1.1). Por eso el
presupuesto es un requisito de diseño, no una optimización:

| Recurso | Techo |
|---|---|
| RSS de omni con 10 sesiones gestionadas | < 300 MB |
| Sesiones materializadas simultáneas | 2 por defecto, configurable |
| Scrollback por pane | acotado en celdas, no en líneas — una línea de 10k columnas cuesta igual que 60 |
| Parseo VT de panes ocultos | **cero** — es la diferencia estructural con tmux, que parsea los 17 |

El último punto es la única ventaja de performance real sobre tmux, y es de CPU y
arquitectura, no de GPU: tmux mantiene el modelo de pantalla de todos los panes
porque cualquier cliente puede pedirlos. omni sabe cuáles están materializados.

## 9. Hitos

### M0 — El sustrato (3–4 semanas) · **GATE**

El único hito con condición de aborto. Prueba que el sustrato existe y que no es
terminal-específico.

- [ ] Ventana nativa que abre y cierra limpio
- [ ] `render/`: glyph atlas monoespaciado, pinta `Line` con colores y atributos
- [ ] `pane/`: trait `PaneContent`, árbol con splits vertical/horizontal, foco
- [ ] `command/` + `keymap/`: tabla estática `(modo, secuencia) → Command`, ejecutando
- [ ] **TerminalPane**: `vim` y `htop` se ven y se usan sin artefactos
- [ ] `resize` propagado al PTY (`SIGWINCH`) con reflow correcto
- [ ] **Presupuesto de M0, medido, no estimado:** 4 panes con `cargo build` a la vez
      sostienen 60 fps, y el RSS del proceso se mantiene < 150 MB. Si no se cumple,
      es señal del gate — no de "ya lo optimizo después"
- [ ] **ScratchPane**: pinta un `Vec<String>` por el mismo camino que el terminal

Ese último punto cuesta ~50 líneas y es el más importante del hito: **si un pane que no
es un terminal renderiza por el mismo path, el sustrato es real y el EditorPane de M7
está de-riskeado.** Es la semilla literal del editor.

**Gate:** si M0 no está en 4 semanas, se replantea la GUI propia y se evalúa
`wgpu` + `glyphon` o TUI. Es la única decisión del proyecto explícitamente reversible.
M0 vive fuera del árbol de crates definitivo — es un spike, puede tirarse.

### M1 — Multiplexor usable (1–2 semanas)

- [ ] Cerrar panes con el layout recomponiéndose
- [ ] Tabs / ventanas
- [ ] Scrollback acotado + scroll por teclado
- [ ] **Paleta de comandos** — sale casi gratis del bus de M0

### M2 — Sesiones de agentes, multi-vendor (2–3 semanas)

- [ ] `AgentAdapter` + registro de vendors + `Caps`
- [ ] **Adaptador `observed` (tier 3) primero** — obliga a que el mínimo común sea real
- [ ] Adaptador Claude Code: socket de hooks, `AGENTDECK_PANE`, instalador de settings
- [ ] Investigación de superficie de Codex y OpenCode → un adaptador de cada uno
- [ ] Estado por pane: `working` / `needs you` / `ready` + timestamp
- [ ] Etiqueta de vendor, punteada cuando el estado es inferido

El tier 3 va primero a propósito: si el adaptador rico se escribe antes, el «mínimo
común» termina siendo lo que Claude Code da, y los demás vendors no entran.

### M3 — El panel de flota (1–2 semanas) · **cierra el MVP**

- [ ] Panel con todas las sesiones, ordenadas por urgencia
- [ ] Salto a sesión desde el panel
- [ ] Envío de mensaje sin robar foco (ojo bracketed paste: `ESC[200~ … ESC[201~`)
- [ ] Filtro por texto sobre cwd y nombre

**Criterio de MVP, en dos partes:**

1. **Cualitativo — dejar de usar `tmux-cc-sessions` en el día a día.** No "que funcione".
   Si al cerrar M3 sigues abriendo el popup de fzf, el MVP falló.
2. **Cuantitativo — contra la línea base de §1.1.** Con 10 agentes activos en la misma
   máquina: swap en uso por debajo de 8 GB, y como máximo 2 PTYs vivos. Se mide con el
   mismo comando que produjo §1.1, para que sea comparable y no una impresión.

### M4 — Config Lua (1–2 semanas)

- [ ] `mlua` embebido, `deck.cmd(name, args)` sobre el `CommandRegistry`
- [ ] Keymaps definidos en Lua, con la tabla estática de M0 como default
- [ ] Recarga en caliente

Antes que el editor a propósito: el bus lo hace barato y entrega la promesa de
"configurable tipo nvim", que es central a la visión.

### M5 — Worktrees y diff (2–3 semanas)

- [ ] Un worktree por agente, creado y limpiado automáticamente
- [ ] Pane de diff del trabajo de un agente
- [ ] Persistencia en SQLite

### M6 — Daemon y detach (2–3 semanas)

- [ ] Split daemon/cliente sobre unix socket
- [ ] `Command` por el socket en vez del canal en memoria
- [ ] Attach / detach, con los agentes sobreviviendo al cierre de la UI

### M7 — EditorPane (abierto, el más largo)

- [ ] `buffer/`: ropey + tree-sitter, undo tree
- [ ] EditorPane sobre `PaneContent`
- [ ] Edición modal, keymaps por Lua
- [ ] `lsp/`: cliente compartido — diagnósticos, goto, completado

Último por decisión de producto, no por dificultad: es la capacidad menos diferenciada
del proyecto y hasta entonces se abre `$EDITOR` en un TerminalPane.

## 10. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| `gpui` no publicado / API inestable | Alto | Se resuelve en M0. Plan B presupuestado. |
| Sustrato mal diseñado → reescritura al mes 8 | **Alto** | Es la razón de existir de §4 y del ScratchPane en M0. |
| Emular VT bien es más duro de lo que parece | Alto | No se emula: `wezterm-term` lo hace. **Nunca escribir parser propio.** |
| Scope creep hacia el editor antes de M3 | Alto | Está en M7 y ahí se queda. El sustrato ya lo contempla, así que no hay excusa de "lo hago ahora o no entra". |
| Un vendor cambia su superficie de integración | **Alto** | Ya pasó con los hooks de Claude Code en el plugin anterior, y ahora son tres vendors moviéndose. Mitigación estructural: el trait `AgentAdapter` aísla el cambio a un adaptador, y el tier 3 garantiza que la app siga funcionando degradada aunque el adaptador rico se rompa. |
| Perseguir vendors consume el proyecto | Medio | Solo tres adaptadores en M2. El resto entra por tier 3 hasta que alguien los pida. |
| **El producto permite reproducir el problema** | **Alto** | Si materializar 13 panes sigue siendo un clic, vuelves a §1.1 con otra UI. Mitigación: el modo gestionado es el **default** y el techo de materializados es configurable pero finito (§8.5). El producto tiene que hacer que no lo hagas, no solo permitirlo. |
| Duración total desmotiva | Medio | Meta declarada: **"usable por mí a diario"**, no "competir con Zed". 6–12 meses en solitario si el sustrato está bien. Zed tenía equipo financiado. |

## 11. Decisiones abiertas

1. **Nombre.** Antes del primer release público.
2. **`wezterm-term` vs `alacritty_terminal`.** Se cierra en M0.
3. ~~**Hooks vs `stream-json` en el adaptador de Claude Code.**~~ **Cerrada por §7.5:**
   son los dos, y cada uno corresponde a un modo de hospedaje — hooks para el pane
   materializado, stream-json para el gestionado. Lo que queda abierto no es cuál, sino
   si el vendor permite materializar una sesión ya iniciada sin perder el hilo. **Se
   verifica al inicio de M2.**
4. **Modelo de teclado.** Prefix global tipo tmux, o modos globales tipo vim. Inclinación
   actual: **prefix**, por §8.4 — un TerminalPane con foco tiene que recibir las teclas
   tal cual, y un modo normal global pelea con eso. Va contra la idea original de "config
   tipo nvim", así que es la decisión de producto más discutible del doc.
5. ~~**Cómo invoca un agente el bus de comandos.**~~ **Cerrada por §7.4:** servidor MCP.
   Es lo único que Claude Code, Codex y OpenCode hablan en común; un CLI habría requerido
   que cada vendor supiera invocarlo.

6. **Nombre.** Ver §11.1 — y ahora con la restricción dura de que no puede ser `cc*` ni
   aludir a Claude. Candidatos en evaluación: `muster`, `bosun`, `corral`, `glass`,
   `capataz`.

## 12. Referencias

- [`tmux-cc-sessions`](../tmux-cc-sessions) — antecesor, y fuente del mecanismo de hooks
- [Zed](https://github.com/zed-industries/zed) — gpui + `alacritty_terminal` en producción
- [WezTerm](https://github.com/wezterm/wezterm) — `portable-pty`, `wezterm-term`
- [Zellij](https://github.com/zellij-org/zellij) — modelo de sesión y layout
- [Helix](https://github.com/helix-editor/helix) — arquitectura de editor modal en Rust
