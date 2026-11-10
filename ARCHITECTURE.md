# Arquitectura de omni

omni es un entorno de desarrollo agéntico (ADE) de escritorio, operado por teclado.
Cada agente de código (Claude Code, Codex, OpenCode, Goose, Hermes) corre **tal cual, en
su propia terminal**; omni es el marco que los supervisa: flota, worktrees, diff,
browser, editor y voz. Este documento fija la estructura del código y los patrones que
toda contribución debe respetar. El producto y sus hitos están en `DESIGN.md`.

## 1. Procesos y responsabilidades

Electron impone tres procesos. La regla de reparto es una sola: **main es dueño de los
procesos y del sistema operativo; renderer es dueño de los píxeles.** El renderer es una
vista de lo que vive en main y debe poder recargarse sin perder nada.

| Proceso | Carpeta | Responsabilidad | Prohibido |
| --- | --- | --- | --- |
| main | `src/main` | PTY, procesos, git, archivos, SQLite, MCP, notificaciones, ventanas | Lógica de UI, strings de canal IPC |
| preload | `src/preload` | Puente tipado `window.omni` | Lógica de cualquier tipo |
| renderer | `src/renderer` | UI, estado de la vista, teclado, panes | Tocar Node, `ipcRenderer` o `window.omni` fuera de `lib/` y `store/` |
| shared | `src/shared` | Tipos y contratos compartidos | Dependencias de runtime |

### 1.1 IPC: un contrato, cero strings sueltos

`src/shared/ipc.ts` declara los tres mapas de canales con sus tipos:

- `IpcInvokeMap`: renderer → main con respuesta (`invoke`).
- `IpcSendMap`: renderer → main sin respuesta (`send`).
- `IpcEventMap`: main → renderer (`on`).

El preload expone un puente genérico (`OmniBridge`) que solo transporta esos canales.
`src/main/ipc.ts` cablea canal → servicio con helpers tipados. Agregar un canal es:
declararlo en el mapa, implementarlo en `main/ipc.ts`, consumirlo desde un store.
Nunca se escribe un nombre de canal fuera de esos tres archivos.

### 1.2 Servicios de main

`src/main/services/<dominio>.ts`: una clase o módulo por dominio (`pty`, `agents`; luego
`git`, `worktrees`, `browser`, `store`, `mcp`, `hooks`). Los servicios no conocen IPC ni
Electron salvo que su dominio lo exija (ventanas, `WebContentsView`). `main/index.ts` solo
los instancia y cablea.

## 2. Renderer

```
src/renderer/src/
  app/        shell de la app: App, TitleBar (cabecera de ventana y StatusBar), Footer, registro de comandos y atajos
  core/       infraestructura sin React ni dominio: bus de comandos, chords, keymap
  panes/      tipos de pane (contrato PaneContent): terminal; luego browser, editor, diff
  features/   slices verticales de producto: fleet, launcher, palette; luego worktrees…
  store/      estado (zustand), un slice por dominio, con selectores
  ui/         primitivos tontos y reutilizables, cada uno con su CSS al lado (ver §3.8)
  lib/        fachadas: omni (puente IPC)
  styles/     tokens.css (paleta y escala tipográfica, único lugar con colores y tamaños de letra) y base.css (solo reset)
```

Dependencias permitidas, de abajo hacia arriba: `styles` ← `ui` ← `core` ← `store` ←
`panes` ← `features` ← `app`. Un módulo solo importa de capas inferiores o de la suya.
`core` no importa React ni stores.

## 3. Patrones

### 3.1 Todo es un comando

Toda acción del usuario es un `Command` con id estable y namespace por dominio
(`session.next`, `launcher.open`), registrado en `core/commands/registry.ts`. Las teclas,
la paleta ⌘K, los botones, y más adelante la CLI y el servidor MCP, llaman al mismo
registro. Un `onClick` o un handler de teclado **nunca** contiene lógica: llama
`commands.run(id)`. `when()` decide disponibilidad; la paleta solo lista lo disponible.

### 3.2 Teclado por capas

`core/keys/keymap.ts` mapea chord → id de comando en tres capas. Qué capas aplican lo decide
el foco (`store/ui.ts`):

| Foco | Capas activas | Ejemplo |
| --- | --- | --- |
| overlay abierto | solo el toggle del atajo que lo abrió (`⌘K` cierra el quick open, `⇧⌘P` la paleta); el resto lo maneja el overlay | `↑↓ ⏎ Esc` en ListPicker |
| `list` | `list`, luego `global` | `j k ⏎ n x`, `⌘T` |
| `terminal` | `global` (⌘) en la app; `terminal` tras el prefijo `C-a` dentro de xterm | `C-a Esc`, `C-a j` |

Principios: `⌘` para lo global, teclas sueltas estilo vim en listas, prefijo `C-a` solo
cuando una terminal tiene el foco, y `Esc` (o `C-a Esc`) siempre vuelve a la lista. Los
atajos se declaran en un solo lugar: `app/keybindings.ts`. Los chords tienen forma canónica
(modificadores en orden `ctrl, alt, shift, cmd` + tecla): `chordOf()` la produce desde el
evento y `normalizeChord()` la aplica a lo que se escribe a mano en `bind`/`resolve`, así
`cmd+shift+d` y `shift+cmd+d` son el mismo atajo. Los símbolos imprimibles (`%`, `|`, `?`)
van sin `shift` para no depender del layout del teclado. `prettyChord()` los pinta (`⇧⌘D`,
`C-a x`); nadie escribe atajos a mano en la UI: `Kbd` recibe lo que devuelve el keymap.

Prefijo `C-a`: los modificadores sueltos no lo desarman (si no, `C-a %` moriría al apretar
Shift), caduca a 1.5 s y se publica en `ui.prefixArmed` para que el footer lo muestre.
`⇧⏎` dentro de la terminal se traduce a `CSI 13;2u` (salto de línea en Claude Code y Codex).

Acciones destructivas: matar un proceso que está `working` pasa por el overlay `confirmKill`
(`killWithConfirm` en `app/commands.ts`); en reposo se mata al toque, como `kill-pane` de tmux.

### 3.3 Panes imperativos, React reserva el hueco

Un pane (terminal, browser, editor, diff) es contenido imperativo con ciclo de vida propio
(`panes/types.ts`: `mount → focus/blur/fit → dispose`). El componente React solo monta un
`div` y delega. Las instancias viven fuera de React (p. ej. `terminal-host.ts`) para que
cambiar de sesión no destruya el buffer. Un pane oculto se mantiene montado pero invisible
y se reajusta (`fit`) al volver.

### 3.4 Estado derivado, nunca almacenado

Los stores guardan hechos (sesiones, timestamps de actividad, foco). Todo lo que se puede
calcular (estado de una sesión, filas del sidebar, estado agregado de un workspace) es un
selector puro exportado desde el store (`sessionStatus`, `listRows`, `workspaceStatus`).
Lo que depende del tiempo lee `now` de `store/clock.ts`, que avanza cada segundo, para que
ningún componente muestre un estado viejo.

### 3.5 Proyecto → workspace → sesión

El modelo de datos tiene tres niveles y el sidebar los refleja tal cual (como Orca):

- **Proyecto**: un nombre con 0..n ubicaciones (carpetas aquí o en un servidor, §3.5c). Persistido
  por `main/services/projects.ts`.
- **Workspace**: dónde corre una sesión dentro del proyecto. Uno por ubicación (`local` si es la única
  del proyecto, `folder` si hay varias, §3.5c) y uno `worktree` por worktree (§3.15). Es lo que fija el
  `cwd`.
- **Sesión**: un PTY con un agente, siempre colgado de un workspace.

El cursor del sidebar (`sessions.cursor`) recorre proyectos, workspaces, tabs y panes en ese
orden (`listRows`). Sobre un workspace, `⏎` lanza un agente ahí; sobre un tab, entra a su
terminal; sobre un pane, a ese pane. `currentWorkspaceId` es el destino de todo lo nuevo.

Estado de sesión (`sessionStatus`): `question` si la terminal sonó la campana (BEL) y nadie le
escribió desde entonces, `working` si hubo salida hace menos de 4 s, `idle` en otro caso. Si el
agente anuncia su estado en el título (`declared`, `scanDeclaredState`: Claude Code pone `✳` en reposo y
un spinner `◐◓◑◒`/braille mientras trabaja), eso manda sobre la ventana de salida: un redibujo (foco,
resize) no vuelve a `working` y una tool larga y callada no cae a `idle`; mientras anuncia trabajo,
`settle` espera. Un título sin marca, o que el agente salga al shell, lo olvida. El
título visible es el OSC que el programa escribe (`term.onTitleChange`), con el nombre del
agente como respaldo. La actividad se anota como mucho cada 500 ms para no repintar por chunk.

### 3.5b Ajustes del usuario

`~/.config/omni/settings.json`, dueño `main/services/settings.ts`: valida (`sanitize`), persiste y
emite `settings:changed`. El renderer los espeja en `store/settings.ts` y nunca inventa un valor:
cada cambio va a main (`settings:set`) y se aplica lo que main devuelve. Lo que depende de un
ajuste lo lee en el momento (`currentPrefix()` en el handler del prefijo, `usePrefixLabel()` en
hints y títulos) o se entera por `useSettings.subscribe` en `App.tsx`: cualquier cambio de
prefijo o de `keys` reconstruye el keymap entero (`applyKeybindings`) y el tamaño de fuente se
aplica a las terminales vivas (`applyTerminalSettings`).

**Atajos configurables.** `app/keybindings.ts` es una tabla declarativa (`DEFAULT_BINDINGS`); el
usuario sobreescribe por pareja `capa:comando` en `settings.keys` (una pareja presente reemplaza
todos sus chords por defecto; lista vacía = sin atajo). `applyKeybindings` vacía el keymap y lo
rearma con defaults + sobreescrituras, con el prefijo resuelto para `terminal.sendPrefix`. Las
reglas por capa viven en `validateChordFor` (global exige ⌘, las otras lo prohíben, Esc nunca) y
el panel además rechaza choques con otro comando de la misma capa nombrando al dueño. Footer,
hoja de atajos y tooltips leen el keymap vigente, nunca una tecla escrita a mano; tras el prefijo
se pinta con `prettyKey` (caja exacta, `h` ≠ `H`), con ⌘ con `prettyChord` (`⌘T`).

El panel `features/settings/SettingsPanel.tsx` (`⌘,`, engranaje del sidebar) compone `Dialog`
(con filtro) + `DialogSection` + `Field` + `KeyCapture`: prefijo, tamaño de fuente y una fila por
atajo agrupadas por capa, con reset al default cuando está sobreescrito.

### 3.5c Proyectos con varias ubicaciones, subcarpetas y proyectos ocultos

**Un proyecto es solo un nombre.** `Project { id, name, locations, testCommand?, hidden? }`: un nombre
("Billing API", "Shop") y **0..n ubicaciones** `ProjectLocation { id, name, path, host? }`, todas
iguales, cada una una carpeta de este Mac o de un servidor SSH (§3.26), en cualquier lado (no tienen que
colgar una de otra: `shop/` y `sales/order-service` en el mismo proyecto). No hay ubicación
"principal": el orden lo elige el usuario y la primera solo es el destino por defecto. Los datos de antes
conservan sus ids (la que era la principal sigue con el id del proyecto; su viejo nombre fijo "Local"
pasa a ser el de su carpeta). El formato anterior (`path` + `host` + `folders[].rel`) se migra solo al
leer (`sanitizeProject`); un proyecto del formato nuevo con nombre se conserva aunque no tenga carpetas.

`ProjectStore.workspaces()` deriva un `Workspace` por ubicación, con su `host`, más uno por worktree
(`Worktree.locationId` dice de qué repo salió; hereda su host). El `kind` depende de cuántas hay, y con él
cómo se ve el sidebar (`listRows`, `cursorOf`):

| Ubicaciones | `kind` | Sidebar |
|---|---|---|
| 0 | — | Solo la cabecera y la pista "Sin carpetas · ⏎ para agregar una". `N` avisa que falta una carpeta en vez de lanzar en otro proyecto; `⏎` abre "Agregar carpeta". La vista principal ofrece el mismo botón. |
| 1 | `local` | Compacto: la fila del proyecto **es** esa carpeta y sus tabs cuelgan directo debajo. `⏎`/`N` como siempre. |
| ≥ 2 | `folder` todas (también la primera) | La fila del proyecto es una cabecera de grupo (`⏎`/clic la pliegan); cada ubicación tiene su fila de nivel 1 con sus tabs. `N` sobre la cabecera lanza en la primera ubicación (el destino de la cabecera, `primaryWorkspace`). |

Como los ids de workspace nunca cambian, al sumar la segunda ubicación las sesiones y tabs de la primera
simplemente pasan de colgar del proyecto a colgar de su propia fila (y al revés al quedar una sola).
El "proyecto actual" de los comandos (`currentProjectOf`) es el del workspace actual o, sin workspace
(cabecera de un proyecto vacío), el de la cabecera bajo el cursor.

- **Nuevo proyecto** (`project.new`, paleta, estado vacío del sidebar y el `+` de Proyectos): overlay
  `projectNew` pide solo el nombre (`project:create` → proyecto vacío, bajo el cursor, con la pista "Sin
  carpetas · ⏎ para agregar una"); no abre nada más. El `+` de la cabecera Proyectos (`project.add`,
  overlay `projectAdd`) ofrece Nuevo proyecto, Abrir carpeta y Abrir carpeta remota. **Abrir proyecto**
  (`project.open`, `⌘O`) y **Abrir carpeta remota** siguen creando un proyecto de
  una ubicación con el nombre de la carpeta; si la carpeta ya es ubicación de alguno, abren ese
  (`openFolder`/`openRemote` devuelven el workspace de esa carpeta, sea o no la primera).
- **Agregar carpeta** (`project.addLocation`, menú del proyecto): overlay `locationPicker` (Este Mac /
  cada servidor con su estado / "Agregar servidor SSH") y luego `locationPath` (ruta con sugerencias:
  `project:suggestPaths` o `host:suggestPaths`; ↑↓ eligen, Tab completa, ⏎ abre). Una carpeta que ya es
  de otro proyecto se rechaza con error humano: para juntarlos está **Combinar con otro proyecto**
  (`project.merge`, overlay `projectMerge`: las ubicaciones y worktrees del elegido pasan al actual, los
  ids no cambian y sus sesiones siguen vivas). **Renombrar proyecto** (`project.rename`).
- **Opciones de una ubicación** (menú del proyecto con el cursor en una ubicación concreta: su fila, o la
  del proyecto si es la única; en la cabecera de un grupo o en un proyecto vacío no salen): **Quitar
  del proyecto** (`project.removeFolder`, cualquiera, también la primera; no una con worktrees: error
  humano. Con sesiones abiertas pide confirmar (overlay `confirmRemoveLocation`, dice cuántas se cierran
  y si hay editores sin guardar) y main las cierra antes de olvidarla (`closeSessions`, las remotas en su
  host); quitar la última deja el proyecto vacío), **Mover
  arriba/abajo** (`project.moveLocationUp/Down`, `project:moveLocation`, con dos o más), **Agregar
  subcarpeta**, Mostrar en Finder y Copiar ruta.
- **Subcarpetas (monorepos)**: `project.addFolder` ("Agregar subcarpeta") ofrece las subcarpetas de la
  **ubicación actual** hasta dos niveles (`folderPicker`, las que tienen manifiesto primero;
  `project:subfolders`/`project:addFolder` reciben el id de la ubicación) y las registra como ubicación
  más (`addFolder` → `addLocation`). Solo en una ubicación de este Mac.
- **Worktrees** (§3.15): "Nuevo worktree" sale de la ubicación en la que se está parado; desde la
  cabecera, un worktree u otro proyecto, de la primera. Un proyecto vacío no puede tener worktrees.
- **Sidebar**: la fila de una ubicación muestra la ruta relativa si cuelga de **otra ubicación** del mismo
  proyecto en el mismo host (la más cercana: `apps/web`); si no, la carpeta que la contiene, corta y con
  el host delante (`~/sale`, `vps:~/srv`; `locationMeta`). Las remotas llevan icono de servidor en vez de
  carpeta (ámbar sin conexión, tenue mientras conecta); un proyecto de una sola ubicación remota lleva la
  marca de servidor junto al nombre. `⏎`/`N` sobre una ubicación lanza con ese `cwd`.
- El índice de archivos del quick open salta las ubicaciones que cuelgan de otra del mismo proyecto
  (ya están dentro de su índice).

**Proyectos ocultos (trabajo confidencial, pantalla compartida).** `Project.hidden: true` en
`projects.json` (`project:setHidden`). `project.hide` / `project.unhide` (menú del proyecto) y
`project.showHidden` (`⇧⌘H`, "Mostrar u ocultar proyectos ocultos") que alterna `ui.showHidden`, a
propósito no persistido: tras recargar vuelven a esconderse. Sin `showHidden`, un proyecto oculto no
sale en `listRows`, en la vista ni el conteo de Worktrees, y si era el workspace en pantalla la flota
pasa al primer proyecto visible (`leaveHidden`, también al arrancar). Con `showHidden` se listan con
un `EyeOff` junto al nombre, y la cabecera de Proyectos muestra un botón para volver a esconderlos
(solo entonces: el botón no delata que existen). Sus sesiones siguen vivas y avisando, pero el banner
nativo no lleva el título de la sesión, ni lo que dijo el agente, ni el proyecto ("Proyecto oculto").
Abrirlo por ruta (quick open, `omni open`) enciende
`showHidden`: se pidió explícitamente. El costo del día lo sigue sumando.

**Carpetas, segunda parte.**

- **Worktree desde una subcarpeta.** `git worktree add` desde una ubicación que es subcarpeta de su repo
  (`apps/web`) crea el worktree del repo entero; `Worktree.subdir` guarda esa ruta (`git rev-parse
  --show-prefix`) y su workspace expone `cwd = <worktree>/<subdir>` y `locationId`. Agentes (`ptys.create`,
  también en remoto) y tests arrancan en `cwd`, igual que en la ubicación de origen. Un `subdir` absoluto o
  con `..` se descarta al leer `projects.json`.
- **Tests por carpeta.** `ProjectLocation.testCommand` manda sobre el del proyecto en los worktrees que salen
  de ella (`ProjectStore.testCommandOf` en main, `testCommandOf` en el renderer para el auto-run y la vista
  Worktrees). `project:setTestCommand` lleva `locationId` opcional; el diálogo dice de qué carpeta es y,
  vacío, vuelve al del proyecto.
- **Renombrar carpeta** (`project.renameFolder`, `project:renameLocation`): solo el nombre de la fila.
- En la fila de una carpeta el menú `…` ofrece "Renombrar carpeta" y "Tests de la carpeta" en el bloque de
  la carpeta y quita "Renombrar" y "Comando de tests" del bloque del proyecto (siguen en su cabecera y en
  la paleta): así entra entero sin scroll. Los diálogos de renombrar abren con el nombre seleccionado
  (`TextInput selectOnFocus`). Lo prueban `worktrees.test.ts` (git real) y `e2e/scenarios/folder-extras.mjs`.

### 3.6 Layout tipo tmux: tab → árbol de splits → pane

`store/layout.ts` es un store puro (sin IPC ni sesiones): por workspace hay tabs (las
*windows* de tmux); cada tab tiene un árbol de splits cuyas hojas son panes con una sesión.
Operaciones: `openTab`, `split` (si el padre ya va en esa dirección inserta al lado, si no
crea un split), `closeSession` (colapsa splits de un hijo y cierra tabs vacíos), foco por
offset o por dirección (geometría de los elementos, en el comando), zoom, resize y
`setSizes` para el arrastre de divisores. Los comandos (`app/commands.ts`) orquestan: crean
el PTY en `sessions` y luego lo colocan en el layout según `ui.launchTarget`.

**Tamaño desde el teclado.** `prefijo ⇧H/⇧J/⇧K/⇧L` (`pane.resize.*`) mueve el divisor del pane con foco
un 5 % hacia ese lado, como `resize-pane` de tmux (el borde va hacia donde apunta la tecla, esté el pane
a la izquierda o a la derecha). Con el `repeat-time` de tmux: tras cada paso, durante `PREFIX_REPEAT_MS`
(600 ms) otra `⇧H/J/K/L` repite sin volver a pulsar el prefijo; cualquier otra tecla corta la repetición
y va a la terminal. El pie lo muestra como `⇧H J K L tamaño`. Lo prueba `e2e/scenarios/split.mjs`.

**Mover un pane de lugar** (no solo su tamaño). `prefijo ⌥h/⌥j/⌥k/⌥l` o `⌥←↓↑→` (`pane.move.*`,
`layout.moveFocused`): si hay un vecino en esa dirección (la misma geometría que el foco) se
intercambian las sesiones y el foco sigue a la sesión; si no lo hay, el pane pasa a ese borde del tab
ocupando todo el alto o el ancho (así dos panes lado a lado quedan uno encima del otro). Con el mouse,
la franja del pane es el asa: pasados 5 px el clic pasa a arrastre, `.pane-drop` (`--drop-zone`)
marca la mitad del pane destino más cercana al cursor (`sideAt`) y al soltar `layout.movePane` lo
saca del árbol y lo inserta a ese lado (entra como hermano si el padre ya va en esa dirección; si no,
el destino se vuelve un split). Esc o soltar fuera cancela; durante el arrastre las vistas nativas se
esconden como con los divisores. `C-a }`/`C-a {` siguen intercambiando en orden de árbol. No va en el
pie (tope de nueve hints): está en la paleta y en Atajos. Lo prueba `e2e/scenarios/pane-move.mjs`.

Como en tmux, cuando el proceso de un pane termina el pane desaparece. Las terminales no se
destruyen al cambiar de tab: `terminal-host` reparenta el contenedor de xterm al pane que lo
muestra (`attachTerminal` / `detachTerminal`), así el buffer sobrevive.

**WebGL solo en las terminales montadas.** Chromium mantiene unos 16 contextos WebGL por ventana y, al
pasarse, mata el más viejo: su canvas queda en blanco con una carita. `attachTerminal` carga el
`WebglAddon` y `detachTerminal` lo suelta, así solo las visibles tienen contexto por más tabs que haya.
Si igual se pierde (GPU reiniciada), `onContextLoss` lo descarta y la terminal sigue con el renderer
DOM. Lo prueba `e2e/scenarios/webgl-contexts.mjs` (20 tabs y una pérdida forzada).

El sidebar pinta el mismo árbol (`listRows(sessions, layout)`): proyecto → tab → panes, como
`choose-tree` en tmux. Los panes solo se listan cuando el tab tiene más de uno (fila `pane`,
`rowKey.pane(leafId)`, nivel 2 con guía vertical); con uno solo, el tab basta. El cursor J/K recorre
las cuatro clases de fila; mover el cursor a un tab lo pone en pantalla y moverlo a un pane además le
da el foco del layout (`sessions.activatePane` = `activateTab` + `layout.focusPane` + cursor en el
pane); `⏎` entrega el teclado (`session.enter`). `X` sobre un pane cierra solo ese pane; sobre un tab,
todos los suyos. Cuando muere una sesión, `cursorAfterExit` baja el cursor del pane al tab (si quedó
con uno solo o el pane murió) o lo sube al workspace si el tab desapareció entero.

**Forma del sidebar** (referencia: Frameless). Ancho por defecto `--sidebar-w` (290 px); su borde
derecho (`.sidebar__resizer`) se arrastra entre 220 y 480 px (`ui.sidebarWidth`, `localStorage`
`omni.sidebar.width`) y el doble clic lo restaura. La ventana recuerda tamaño, posición y si estaba
maximizada o a pantalla completa en `~/.config/omni/window.json` (`main/services/window-state.ts`:
guarda con espera al mover o redimensionar y al cerrar; al abrir, `fitToDisplays` la recoloca si su
monitor ya no está). Cabecera con el botón de ocultar
(`sidebar.toggle`, `⌘B`, estado `ui.sidebarCollapsed` persistido en `localStorage`
`omni.sidebar.hidden`), el nombre y, al borde derecho, el engranaje de Ajustes; fila Buscar
(`palette.open`); navegación con `NavItem` (Worktrees, Broadcast, Tareas, Puertos): el atajo
siempre a la derecha como `Kbd` (sale del keymap) y el conteo (worktrees, rondas, tareas pendientes,
puertos) en gris junto al nombre: al final parecía una tecla. No hay ítem Flota (es la vista por defecto: `⌘1` y `Esc` desde las otras vuelven a
ella) ni Ajustes ni Atajos sueltos: los atajos se ven y se cambian dentro de Ajustes. Sección Proyectos con
`+` (`project.add`: nuevo proyecto vacío, abrir carpeta o carpeta remota); cada proyecto es una `Row` nivel 0 con `RowChip` (color por `chipOf(id)`,
tokens `--chip-1`…`--chip-6`), nombre con `RowCount` de agentes y, al hover o con el
cursor, `…` (menú) y el chevron de plegar; sus tabs en nivel 1 (icono de agente, título con `RowCount`
de panes si hay split, tiempo, punto) y los panes en nivel 2. **Un punto solo cuando hay algo que
mirar**: aro que gira (trabajando), naranja (espera tu respuesta) o azul (terminó sin revisar), con su
texto al pasar el mouse. En reposo y visto no hay punto, ni en la franja del pane. Las filas de
ubicación no lo llevan (sus tabs están debajo) y la cabecera del proyecto solo plegada, como resumen de
lo que esconde.

**Cabecera de la ventana.** No hay barra de título aparte: la ventana usa `hiddenInset` y la fila del
semáforo (`--titlebar-h`, 40 px) la comparten la cabecera del sidebar y los tabs del workspace, así que
las terminales llegan hasta arriba. `WindowHead` (`app/TitleBar.tsx`: botón del sidebar, "omni" y el
engranaje de Ajustes al borde derecho, con 80 px libres para el semáforo) vive en la cabecera del sidebar; con el sidebar oculto abre la fila de
tabs. Solo las vistas sin tabs (worktrees, broadcast, revisión) recuperan con el sidebar oculto
una fila superior (`TitleBar`) con el buscador. El estado global (`StatusBar`: aviso de
`announce` y costo de hoy) va en el pie, a la derecha. `announce` escribe en la franja del pane con
foco solo en la flota; en las demás vistas esa franja no está en pantalla y el aviso va al pie. Los
atajos de una vista viven solo en el pie global (no se repiten dentro de la vista: su pie propio
aparece únicamente con un aviso o un error). Lo comprueba `e2e/scenarios/window-chrome.mjs`.

Operaciones de pane: split (`row`/`col`, anidable), zoom, resize, swap (`swapFocused`), break
a tab nuevo (`breakFocused`) y cierre con colapso del split. Cada pane lleva una franja con
identidad y botones de split/zoom/cerrar; el mousedown en el pane lo enfoca antes de que el
botón corra el comando, así los comandos siempre actúan sobre el pane con foco.

### 3.7 Agentes como catálogo, luego como adaptadores

Hoy un agente es un `AgentDef` (nombre, badge, comando) y lanzarlo es abrir un shell y
escribir el comando. El estado se infiere por actividad del PTY. En M2 cada agente tendrá un
adaptador en `main/services/agents/<id>.ts` con tres niveles de fidelidad (ver DESIGN.md §7):
hooks nativos para Claude Code, observación por regex para los demás. El estado se derivará en
main, para que estado y notificaciones funcionen con la ventana oculta.

`SessionCreateInput.args` lleva flags extra para el CLI (main escribe `command + ' ' + args.join(' ')`):
`⌥⏎` en el launcher lanza con la flag de "sin pedir permisos" del agente (`SKIP_PERMISSIONS` en
`store/sessions.ts`: `--dangerously-skip-permissions` para Claude Code, `--full-auto` para Codex); el
modo queda en `ui.launchMode` y lo consume `session.new.*`, igual que el destino del split. Main
devuelve las flags en `SessionInfo.args`; `skipsPermissions()` las reconoce y la franja del pane y el
tooltip del tab marcan "sin permisos" (`Badge` naranja).

**Iconos.** `AgentIcon` (`ui/icons.tsx`) pinta el logo real de cada agente, como Orca, en un solo color
para que ninguno destaque (salvo el asterisco naranja de Claude Code):
- Codex: la flor de OpenAI, en SVG.
- OpenCode: su marca, en SVG con el lienzo recortado al dibujo.
- Goose y Hermes: máscaras PNG en `ui/logos/`, sacadas de su favicon (oscuro → opaco, recortadas al
  dibujo y sin el marco). Se pintan con `background: currentColor`.

Todos miden 16 × 16 en el launcher y se centran con su nombre (e2e `agent-icons`). Un agente nuevo del
catálogo necesita su logo aquí: no hay monograma de respaldo.

**Logo de omni.** `OmniMark` (`ui/icons.tsx`) es el símbolo de `design/brand/` en `currentColor`; a 24 px
o menos dibuja el corte chico (ranuras más anchas). Va en la cabecera de la ventana (14 px, junto al
nombre) y en la pantalla vacía del workspace (56 px, en `--surface-3`). Fuera de la ventana: el bundle
lleva `build/icon.icns`; en desarrollo main pone `build/icon.png` en el Dock y en "Acerca de omni".

### 3.8 Primitivos de `ui/`: las features componen, no pintan

Cada pieza visual repetida es un componente de `ui/` con su CSS al lado y estados por `data-*`.
Las features (`Sidebar`, `WorkspaceView`, `Layout`) solo deciden qué datos van en qué primitivo:

| Primitivo | Para qué | Estado |
| --- | --- | --- |
| `Kbd`, `Hint` | atajos ya formateados (`prettyChord`) y "tecla + qué hace" | `data-on` |
| `Dot` | punto de estado de sesión/tab/proyecto; `working` es un aro que gira (quieto con `prefers-reduced-motion`); `unread` (azul, `--status-unread`) es el "sin leer" de §3.14. En el sidebar va uno por fila y solo si hay algo que mirar | `data-status` |
| `Badge` | conteo de panes/tabs, flag `Z` | `data-tone` soft/solid/mark |
| `Button`, `IconButton` | acciones; `IconButton` nunca es tabulable ni roba el foco; `Button` con `quiet` tampoco (cabecera de un pane). `IconButton` `primary` para las acciones primarias de una barra de iconos (relleno suave fijo). `Button` sin marco: relleno `surface-2` que sube a `surface-3` al pasar el mouse; `primary` relleno claro. `variant="danger"` para lo destructivo (texto rojo) | `data-variant`, `data-size`, `data-on`, `data-primary` |
| `Row` + `RowLabel`/`RowMeta`/`RowCount`/`RowActions`/`RowChip` | fila `role="option"` de una lista por teclado; `level` 0 proyecto (14px medium), 1 tab (sangría 24), 2 pane (sangría 40, 13px, sin icono); `guide` pinta la guía vertical de un bloque de hijos; `RowChip color` es la pastilla de color (22px) con un icono blanco dentro, `chipOf(id)` elige el color estable; `multiline` (Worktrees, Broadcast, Puertos) es la variante de varias líneas (relleno 10×12, 82px con tres) cuyo cuerpo es `RowLines` con `RowLine` (20px; `muted` 12px gris para la línea de tipo) y `RowTime` (espera, 12px tabular) al extremo | `data-cursor`, `data-active`, `data-level`, `data-guide`, `data-multiline`, `data-status` |
| `NavItem` | fila de navegación del sidebar (icono + etiqueta + `count` en gris junto a ella + `end`: el `Kbd` del atajo); no es tabulable ni roba el foco | `data-active`, `disabled` |
| `Dialog` | panel modal con título, cuerpo libre y pie; Esc y clic fuera cierran, devuelve el foco; `wide` para cuerpos a dos columnas | `data-wide` |
| `Field` | fila de formulario: etiqueta y descripción + control | — |
| `KeyCapture` | botón que captura la siguiente combinación de teclas | `data-capturing`, `data-error` |
| `Tabs`, `Tab`, `TabAction`, `TabsEnd`, `TabLabel` | barra de tabs; cierre como hermano, nunca anidado | `data-active` |
| `Strip` + `StripTitle`/`StripEnd`/`StripActions` | cabecera de un pane; no roba el foco | `data-focus` live/layout/none |
| `ListPicker` | overlay listbox con filtro: paleta, launcher, menú, confirmación; `onPick(item, mods)` trae ⌥/⇧ del ⏎ o clic | `data-menu`, ítems `data-active`/`data-danger` |
| `Checkbox` | casilla decorativa de 16 px del to-do: `data-state` todo / done / working (anillo ámbar); no es un control de formulario, la fila entera es la que se activa | `data-state` |
| `Empty` | estado vacío centrado; `icon` opcional (decorativo) arriba del título | — |
| `UrlInput` | barra de dirección (`.url-bar` con el `input.url-input` dentro): mono, selecciona todo al enfocarse, ⏎ confirma, Esc restaura; siempre muestra la URL (o el placeholder), sin pastillas dentro: el atajo va en `title` | `data-editing` |
| `Toggle` | chip conmutable para filtros y opciones cortas (grosor S/M/L del markup); no roba el foco | `data-on` |
| `Switch` | interruptor de ajustes (`role="switch"`, 32 × 18, pista rellena sin borde); tabulable, Espacio lo cambia | `data-on`, `aria-checked` |
| `Check` | casilla de una lista de opciones (adjuntos de una captura) con atajo a la derecha; no roba el foco, así el textarea de al lado sigue escribiendo | `data-on`, `data-disabled` |
| `Toolbar` + `ToolbarSep` | pastilla flotante de herramientas (markup del navegador) que agrupa `IconButton`, `ColorSwatch` y `Toggle`; no roba el foco, así el lienzo sigue recibiendo las teclas | — |
| `ColorSwatch` | muestra de color del markup: punto redondo; elegida = relleno suave detrás y el punto más grande, nunca anillo; el color sale de `--mark-<nombre>` en tokens.css | `data-on` |
| `Select` | `<select>` nativo para formularios (perfil, viewport): relleno suave y chevron, sin borde; tabulable, vive en diálogos | `data-disabled` |
| `TextInput` | campo de texto de una línea para diálogos (nombre de un perfil): relleno suave, ⏎ confirma; tabulable. `Dialog` respeta un hijo con `autoFocus` | — |
| `TextArea` | campo de varias líneas (compositor de un comentario de la revisión, §3.16): relleno suave, ⏎ es salto de línea, ⌘⏎ confirma (`onSubmit`) y Esc cancela (`onCancel`); tabulable, crece con el texto hasta 220 px. Mientras tiene el foco, `useKeyboard` no despacha teclas sueltas | — |
| `Highlight` | texto con las coincidencias de una búsqueda en `<mark>`: sin fondo, blanco y peso 500 sobre el gris de alrededor; recibe los rangos `[inicio, fin)` de `fuzzyMatch` (quick open) | — |

Reglas: sin marcos ni acentos laterales para cursor o selección (relleno suave y nada más).
Una `Row` tiene dos marcas independientes: **activa** (`data-active`, el tab que está en
pantalla) siempre visible, con relleno fuerte cuando el teclado está en la terminal y un tono
más suave cuando está en la lista; y **cursor** (`data-cursor`), relleno fuerte solo con
`[data-focus='list']` en `.app`. Así, desde la terminal se ve dónde estás, y desde la lista se
distingue "lo que miro" de "lo que está en pantalla". Mover el cursor a un tab lo pone en
pantalla (cursor = lo que se ve); `⏎` solo entrega el teclado. En un tab con split, las filas de
sus panes llevan la misma marca activa sobre el pane con foco del layout: el tab sigue activo
("lo que está en pantalla") y el pane dice cuál de ellos tiene o tendrá el teclado; son dos
niveles distintos, no dos activos del mismo nivel. Ningún `IconButton` cambia el foco (mousedown
cancelado), así la terminal o la lista lo conservan.

### 3.9 Navegador embebido (pane `browser`)

Un navegador es una **sesión** con `agent: 'browser'`: main no crea un PTY sino un
`WebContentsView` (`main/services/browser.ts`, `BrowserService`), y lo expone con el mismo
`SessionInfo` para que sidebar, tabs, launcher y layout no sepan la diferencia. `session:create`
con `agent: 'browser'` (y `url` opcional) lo crea; `session:list` lo incluye; `session:kill` lo
destruye y emite `session:exit` como cualquier sesión. La vista vive en main, así que sobrevive a
recargas del renderer igual que los PTY.

**Pintado.** La vista nativa va encima del DOM. El renderer (`panes/browser/BrowserPane.tsx`)
reserva un hueco (`div.browser__view`) y manda `browser:bounds` con su rect (px CSS, redondeado)
cada vez que cambia (ResizeObserver + cambio de layout/tab/zoom + resize de ventana) y `null`
cuando el pane no está en pantalla, hay un overlay abierto (si no, la vista taparía el launcher o la
paleta), se arrastra un divisor (`ui.dragging`: la vista se tragaría el mouse) o está el lienzo de
recorte encima. Main llama `setBounds`/`setVisible`. Un pane oculto no se destruye. Red de seguridad:
cada vez que un pane de navegador monta o desmonta, `browser-host.ts` manda `browser:mounted` con los
ids que tienen pane y main esconde las vistas del resto (`keepOnly`), así una vista que se quedó sin su
`null` no tapa las terminales. Si el proceso de una página se cae (`render-process-gone`, salvo
`clean-exit`), Chromium la pintaría como una carita gris; main la recarga sola y manda `browser:crashed`,
y la franja avisa "La página se cerró inesperadamente; se recargó" (e2e `browser-crash`, con
`Page.crash` por CDP).

**Foco y teclado.** Al hacer clic dentro de la página, el teclado se lo queda el webContents de
la vista: los atajos del renderer no llegan. Main escucha `before-input-event` en la vista y
reenvía como `browser:key` las teclas con ⌘ y el prefijo configurado (el resto se lo queda la
página); el renderer las resuelve con el mismo keymap: ⌘ contra `global` en `store/browser.ts`,
y el prefijo se arma ahí (`armBrowserPrefix`, mismo timeout que la terminal) mientras main devuelve
el teclado al renderer, así la tecla siguiente llega como `keydown` normal y `useKeyboard` la
resuelve contra `terminal` (`takeBrowserPrefix`). `browser:focus` avisa cuando la vista toma o
suelta el foco: al tomarlo, `ui.focus` es `terminal`, el layout y el cursor se alinean y el foco
DOM se mueve a la raíz del pane (`.browser`, `tabindex=-1`; si se quedara en otra terminal, al
volver el teclado al renderer esa terminal se enfocaría sola). La raíz y la barra de URL mantienen
`ui.focus` con el mismo focus/blur que el textarea de xterm (§5). `session.leave` (prefijo Esc) y
cualquier ⌘ que abra un overlay mandan `browser:blur`; `browser:focusView` es el espejo (⏎ en la
barra, `pane.next` que cae en un navegador). Un navegador nuevo en blanco arranca con la barra
enfocada.

**Remontaje.** Zoom y split recrean el pane: `BrowserPane` al montar con el foco del layout e
intención `terminal` le da el teclado a la página (`focusView`), a la barra si está en blanco, o a
su raíz si hay un prefijo a medio camino; es el espejo de `TerminalPane` enfocando su textarea. Y
tras un comando disparado con el prefijo desde la página (`prefijo z`), `refocusBrowserAfterCommand`
devuelve el teclado a la página si el pane con foco sigue siendo ese navegador y no se abrió overlay.

**Cabecera.** Solo iconos, como la barra de Orca (barra de 36 px, `IconButton` de 26 px con icono
de 16, gap 4 px): atrás y adelante (`ArrowLeft`/`ArrowRight`, deshabilitados cuando no se puede), el
campo de URL con `flex: 1` que siempre muestra la URL o el placeholder "Dirección", Recargar (Parar
mientras carga), Vista móvil (`data-on` con un preset móvil), DevTools (`<>`, `data-on` con las
DevTools abiertas), Elemento y Captura (`primary`: relleno suave fijo) y el menú `…`
(`browser.menu`). Nada de etiquetas de texto ni `Kbd` visibles: el atajo va en el tooltip
("Recargar · ⌘R", "Elemento · C-a f"), sacado del keymap (`hintFor`), y el tamaño del viewport solo
se ve en el menú `…` → "Tamaño de viewport" y en los ajustes. No hay modo compacto por ancho.
⏎ en la barra navega (sin esquema se antepone `https://`, salvo `localhost` y IPs que van por
`http://`); título de la página en la franja y en el tab, estado `working` mientras carga.
Comandos `browser.*` (navigate, back, forward, reload, stop, focusUrl, capture, element, mobile,
devtools, menu, settings) registrados como todo lo demás. El pie (`app/Footer.tsx`) suma, con un
navegador bajo el teclado, `f modo elemento · ⌘⇧S captura · ⌘L URL`, y en los modos (`browserMode` en
`store/browser.ts`: `element` | `area` | `markup`) solo las teclas del modo.

**Captura (imágenes al agente).** Un solo flujo, `browser.capture` (`⌘⇧S`, botón cámara): **recortar
→ dibujar → enviar o copiar**. (1) `browser:snapshot` (data URL, sin disco ni portapapeles) y el lienzo
de recorte (`AreaCapture.tsx`, modo `area`; ver "Área con teclado"): soltar el arrastre o `⏎` recorta,
`⇧⏎` se queda con la página entera, `Esc` cancela; una barra (`Toolbar`) abajo ofrece Cancelar, Toda
la página y Recortar. (2) `cropDone` pasa el recorte al lienzo de dibujo (`Markup.tsx`, modo `markup`;
ver "Markup"): dibujar es opcional y **Siguiente** (`⌘⏎`) sigue con o sin trazos. (3) El PNG final se
guarda con `capture:save` (`~/.config/omni/captures/<fecha>.png` y al portapapeles) y se abre "Enviar al
agente", que describe la imagen como `captura · w×h` o `captura con dibujo · w×h`. El renderer arma
el `CapturePayload` (`buildPayload` en `store/browser.ts`: captura, miniatura, URL, viewport medido,
elemento si lo hay y las últimas 20 líneas de consola, que pide a main con `browser:consoleTail` al
armar el paquete) y abre el diálogo "Enviar al agente"; nada
se escribe en una terminal sin pasar por ahí. La miniatura es `browser:snapshot` (data URL sin tocar
disco ni portapapeles) recortada con canvas al rect cuando lo hay (modo elemento); en la captura el
propio PNG final es la miniatura. Las capturas esperan a que la vista
esté en pantalla (`whenVisible`: sin overlay y dos frames después, lo que tarda el pane en reenviar
bounds), si no la paleta capturaría una vista oculta; si main no puede capturar, la franja lo avisa
y no se abre nada. Tras recargar el renderer, `store/browser.ts` hidrata el estado de cada navegador
vivo con `browser:state`. El destino preseleccionado del diálogo sale de `captureTarget()`
(`store/capture-target.ts`, puro, con tests) y el orden de la lista de `rankTargets()` (mismo
archivo); el historial de foco por pane lo lleva `store/browser.ts` (`recentFocus`).

**Diseño de referencia (canvas "omni concept", artboards 07 y 08).** La cabecera del pane lleva
botones con etiqueta y atajo (`Button` con `kbd`): `⌥⌘←` `⌥⌘→` atrás/adelante, campo de URL con la
marca `⌘L` y el tamaño del viewport a la derecha, Recargar `⌘R`, Móvil `⌘⇧M`, DevTools `⌥⌘I`, Markup `⌥⌘M`, (el usuario después pidió la barra solo con iconos: manda lo de **Cabecera**)
**Elemento (`prefijo f`)** y **Captura `⌘⇧S`** como primarios. Pie con `F modo elemento · a–z elegir · ⏎ enviar
al agente · ⌘⇧S viewport · ⌘⇧A área con H J K L · ⌘L URL · Esc salir`.

**Modo elemento.** `browser.element` (`f` tras el prefijo, o el botón) → main inyecta un script de
solo lectura (`executeJavaScriptInIsolatedWorld`, world propio: la página no ve `window.__omniHints`
ni puede sabotear el script; los scripts los arma `main/services/browser-elements.ts` y la lógica
pura de letras y selector vive en `shared/dom-selector.ts`) que lista los elementos visibles con sentido (enlaces, botones,
campos, encabezados, tablas, imágenes, tarjetas) y dibuja una letra sobre cada uno (`ElementHint`),
estilo Vimium: fondo oscuro, mono, el elegido en naranja. Mientras está activo, main reenvía TODAS
las teclas de la página (`browser:keyGrab`): `a–z` eligen (con dos letras si hay más de 26), `Esc`
sale, `⏎` con uno elegido abre "Enviar al agente". Elegir uno devuelve `BrowserElement` (selector
corto, outerHTML ≤ 8 KB, CSS computado relevante) y recorta su rect con `browser:capture(id, rect)`.
Las etiquetas se recolocan en scroll y resize (listener en la página, coalescido con rAF) y se van
con `browser:elementsClear`; nunca se lee el `value` de un campo (contraseñas). El reenvío total
(`keyGrab`) es un flag por vista que comparte con el área con teclado, y main lo apaga solo al
navegar a otro documento o al recargar el renderer.
En el renderer el modo vive en `store/browser.ts` (`browserMode = 'element'`, `elementPick` con los
hints, la letra acumulada y el elegido): `elementKey(chord)` atiende la tecla venga de `useKeyboard`
(teclado en el renderer) o de `browser:key` (teclado en la página). Dos pasos: la letra **elige**
(`browser:elementPick` resalta y devuelve el `BrowserElement`, que queda en `chosen`; otra letra
re-elige, pidiendo antes `browser:elements` de nuevo), y `⏎` con uno elegido **envía**:
`browser:capture(rect)` → miniatura → `browser:elementsClear` → diálogo. `Esc` limpia y sale.
Mientras dura, las teclas sueltas no llegan a otro atajo; las de ⌘ siguen su camino (⌘W, ⌘K, ⌘Q).
Si el pane se desmonta con el modo activo (cambio de tab con el mouse), el pane lo cierra al irse.
La resolución letra → hint es `stepHint()` (`store/element-hints.ts`, puro, con tests).

**Área con teclado.** El paso de recorte de la captura acepta el teclado además del arrastre: aparece
un rectángulo centrado al 60 %; `H J K L` lo mueven 24 px, `⇧H ⇧J ⇧K ⇧L` lo redimensionan 24 px, `⏎`
recorta, `⇧⏎` usa la página entera, `Esc` cancela (`AreaCapture.tsx`; `browserMode = 'area'`; el pane lo cierra si se desmonta). El lienzo toma el foco DOM, y por si la
página se quedó con el teclado, el store manda `browser:keyGrab` al entrar y al salir y las teclas
reenviadas llegan al lienzo por `setModeKeyHandler` (`browser-host.ts`, compartido con el markup).

**Enviar al agente (artboard 08).** Toda captura (la del flujo de captura o la de un elemento) abre el overlay
`sendCapture` (`features/capture/SendCapture.tsx`, un `Dialog` ancho): miniatura; **Adjuntar**
(`Check`): imagen recortada 2x, HTML del elemento, CSS computado (ambos apagados sin elemento), URL y
viewport, últimas 20 líneas de consola; **Destino** (`Row`): terminales del mismo workspace con
estado y tiempo, con pregunta abierta primero, luego trabajando, luego listo (`rankTargets`), y la
última fila = nuevo agente con esta captura; **Mensaje** (textarea, con el foco al abrir). Como el
textarea tiene el foco, los atajos del diálogo llevan ⌘ para no pelear con lo que se escribe:
`⌘1`…`⌘5` adjuntos, `⌘J` `⌘K` destino, `⌘N` agente nuevo, `⌘⏎` envía, `⌘C` (sin selección en el
textarea) copia el paquete como texto, `⌘⇧C` (**Copiar imagen**) deja solo el PNG en el portapapeles
para pegarlo donde sea (`capture:copyImage`, que solo acepta PNG de la carpeta de capturas:
`isCaptureFile`) y cierra con el aviso "Imagen copiada al portapapeles", Esc cierra; con el foco fuera del textarea valen también
`1–5`, `J K`, `↑↓` y `N`. El texto lo arma `formatCapturePayload()` (`features/capture/format.ts`,
puro, con tests): mensaje, línea en blanco, `Imagen: <ruta>`, `URL: <url> · viewport w×h`,
`Elemento: <selector> (w×h)`, bloques ```html y ```css, `Consola (últimas N):`. El paquete pasa por
`sanitizeForPty()` (quita todo carácter de control salvo `\n` y `\t`: el HTML, el CSS, la consola y la
URL vienen de la página, y un `\x1b[201~…\r` escondido ahí cerraría el pegado y ejecutaría lo que
siga). Enviar escribe en la PTY del destino (`session:write`; con saltos de línea va como bracketed
paste, así Claude Code, Codex y zsh lo toman como un bloque) y `⏎` si el destino no es shell; cierra el diálogo, da el
teclado a esa terminal y la franja del navegador avisa "Enviado a Claude Code". Copiar deja solo el
texto en el portapapeles (reemplaza la imagen que main puso al capturar; la imagen sigue en disco).
Nuevo agente: `sessions().create('claude')` en el workspace del navegador, tab nuevo, y el paquete
se escribe cuando la TUI pidió bracketed paste (`\x1b[?2004h` en `session:data`) y la salida lleva
2.5 s callada; si en 8 s no llegó esa señal, va en texto plano y la franja lo avisa. `CapturePayload` en
`shared/types.ts` es el paquete; lo arma `store/browser.ts`.

**Móvil.** `browser.mobile` (`⌘⇧M`) alterna el viewport entre responsive y el preset iPhone 14
(`toggledMobile()` en `store/viewport-presets.ts`, por `browser:viewport`); desde cualquier otro
preset vuelve a responsive. Solo viewport y UA: no hay eventos touch.

**DevTools acopladas (sustituyen a la consola propia).** No hay cajón de consola: `browser.devtools`
(`⌥⌘I`, botón `<>` de la cabecera) alterna las DevTools de Chromium dentro del pane. Main crea una
segunda `WebContentsView` por navegador, la engancha con `webContents.setDevToolsWebContents` y
`openDevTools({ mode: 'detach' })`; el renderer reserva un hueco bajo la página (`.browser__devtools`,
40 % del alto por defecto, divisor con la misma clase que los splits del layout, mínimo 120 px por
lado, proporción en `localStorage` `omni.devtools.ratio`) y manda `browser:devtoolsBounds` igual que
`browser:bounds` (y `null` con overlay, arrastre, área, markup o pane fuera de pantalla). Cerrar =
`closeDevTools` + quitar la vista. Main sigue escuchando `console-message` solo para
`browser:consoleTail` (adjunto del diálogo de envío).

**Markup (artboard de Orca).** Paso 2 de la captura, sin comando propio: se pinta el recorte en un
lienzo DOM y encima una barra flotante con lápiz, resaltador, flecha, rectángulo, elipse, texto,
borrador, color, grosor, deshacer, rehacer y limpiar; pie "Dibuja encima si quieres marcar algo" con
Cancelar y **Siguiente**. Siguiente compone recorte + trazos en un PNG (`capture:save`) y abre "Enviar
al agente" con esa imagen; `Esc` cancela.
Todo en el renderer (`panes/browser/Markup.tsx`), sin inyectar nada en la página. El dibujo es una
lista de operaciones vectoriales en px de la captura (`store/markup-ops.ts`, puro, con tests: deshacer,
rehacer, papelera y borrador por objeto son operaciones más, así todo se deshace); `markup-draw.ts` las
pinta en el `<canvas>` y en la composición final. Atajos dentro del modo: `p h a r o t e` herramienta,
`⌘Z` `⇧⌘Z`, `⌘⏎` siguiente, `Esc`; `browser:keyGrab` sigue tomado desde el recorte, y el diálogo de
envío se abre con la etiqueta `captura con dibujo · w×h` (o `captura · w×h` si no se dibujó nada). Colores `--mark-*` en tokens.css.

**Perfiles y cookies.** Cada navegador corre en un perfil = partición persistente de Electron
(`persist:omni-<id>`); los perfiles viven en `~/.config/omni/profiles.json` (`main/services/profiles.ts`),
con "Por defecto" fijo. Menú `…` de la cabecera: perfil actual (lista, Nuevo perfil), Importar cookies
(Chrome, Arc, Brave, Edge, Firefox, Safari, archivo), Tamaño de viewport (Responsive, iPhone 14,
iPhone SE, iPad, 1280 × 800, 1440 × 900, 1920 × 1080) y Ajustes del navegador (perfil, UA, viewport,
borrar datos). Importar: los Chromium leen `Cookies` (SQLite, copia temporal, `sqlite3 -json`) y
descifran con la clave del llavero (`security find-generic-password -s "<Nombre> Safe Storage" -w`,
PBKDF2 1003 iteraciones, salt `saltysalt`, AES-128-CBC); Firefox `cookies.sqlite` en claro; Safari
`Cookies.binarycookies` (parser propio); archivo = cookies.txt de Netscape o JSON exportado. Los
logins de Google no sobreviven a la importación (lo decimos en el menú, como Orca). En el renderer el
menú es `features/browser/BrowserMenu.tsx` (un `ListPicker` sin filtro con páginas: Esc vuelve a la
raíz), los ajustes `BrowserSettings.tsx` (`Dialog` con `Select`; borrar datos y eliminar perfil
confirman en la misma fila) y el nombre del perfil nuevo `ProfileNameDialog.tsx`; el navegador al que
pertenecen es `menuId` en `store/browser.ts`, y el resultado de importar sale en la franja
("N cookies importadas" o el error).

**Viewport.** `browser:viewport` sustituye a `browser:mobile`: un preset fija el tamaño de la vista
(centrada en el hueco, con scroll si no cabe) y, si es móvil, UA y emulación; `null` = responsive.
El pane pone al hueco el tamaño del preset (`data-viewport` en `.browser`, `margin: auto` dentro de
`.browser__page`, que hace scroll y reenvía `browser:bounds` al desplazarse); la vista nativa no se
recorta, así que si el preset no cabe asoma por fuera del pane hasta que se hace scroll.

**Límites.** Una vista por sesión; sin pestañas internas (cada navegador es un pane). Popups
(`window.open`) se abren en el navegador del sistema. Sin extensiones. El modo elemento solo ve el documento top: los iframes no entran.


**Enlaces de la terminal y artifacts de Claude.** `@xterm/addon-web-links` (texto plano) y el
`linkHandler` de xterm (OSC 8) abren enlaces con ⌘-clic, como Terminal.app e iTerm (un clic suelto
selecciona o va a la TUI). `openTerminalLink` (`store/links.ts`) manda los artifacts de Claude
(`isClaudeArtifact`: `claude.ai/artifact/…`, `claude.ai/code/artifact/…`, `claude.site/artifacts/…`) al
navegador de omni, en el workspace de la terminal y con la partición persistente del perfil, así el login de
claude.ai se conserva; el resto va al navegador del sistema. Además `onData` anota el último artifact que
imprimió cada sesión (`sessions.artifacts`) y la franja lo ofrece (`StripLink` "artifact", `prefijo a`,
`pane.openArtifact`). El navegador abierto para un enlace se reusa aunque la página haya redirigido
(`openedFor`). Lo prueba `e2e/scenarios/claude-artifact.mjs`.
### 3.10 Persistencia: el daemon y el estado

**Cerrar omni no cierra nada.** Los PTY no viven en Electron sino en `omni-daemon`
(`src/daemon/index.ts`, segundo entry de main en `electron.vite.config.ts`, sale como
`out/main/daemon.js`), un proceso Node desacoplado (`detached`, `ELECTRON_RUN_AS_NODE=1` sobre el
binario de Electron para que `node-pty` cargue con el mismo ABI; en macOS, el **Helper** del bundle
(`nodeExecPath()`, `LSUIElement`): con el ejecutable principal LaunchServices tomaba al daemon por la app
abierta y, con la ventana cerrada, abrir omni desde el Finder fallaba con "omni is not open anymore"
(-600); los servidores de lenguaje usan el mismo) que escucha en
`~/.config/omni/daemon.sock` con el protocolo NDJSON de `src/shared/daemon.ts`. Al arrancar, main
intenta conectar; si no hay socket vivo, lo lanza y espera. `main/services/pty.ts` pasa a ser un
cliente (`DaemonClient`) con la misma API de antes: `create/list/write/resize/kill/onData/onExit`,
más `history(id)`. El daemon lleva por sesión un espejo sin pantalla (`src/daemon/screen.ts`:
`@xterm/headless` con `unicode11`) que procesa la misma salida y sigue los resize. Al reconectar, el
renderer pide `session:history` cuando abre la xterm de una sesión que ya existía y recibe
`SerializeAddon.serialize()`: el estado exacto de la pantalla (scrollback, pantalla alterna de las
TUI, colores) en vez de bytes crudos que podían empezar a medio escape. Lo escribe y manda un resize
de un carácter y vuelta para que las TUI (Claude Code, Codex) repinten. Si el espejo falla, `history`
cae a los últimos `HISTORY_BYTES` crudos del ring. Igual que Orca, la xterm del renderer carga
además `addon-image` (SIXEL y protocolo de iTerm) y `addon-ligatures` (Local Font Access; con una
fuente sin ligaduras, como Menlo, no cambia nada).

**Fuente de la terminal.** Ajustes → Terminal: `terminalFont` (Menlo, JetBrains Mono, Geist Mono,
Hack Nerd Font; la lista solo muestra las instaladas, medidas en un canvas contra un respaldo
genérico en `lib/fonts.ts`), `terminalLineHeight` (1.0–1.3) y `terminalFontWeight` (300–600; el
negrito va 200 más). Por defecto lo que se ve en Orca en este Mac: Menlo, 1.0, 500. Orca pide
"SF Mono", pero en macOS esa es una fuente oculta del sistema (".SF NS Mono") que Chromium no
encuentra por nombre y cae a Menlo; por eso no está en la lista. Detrás de la elegida van las Nerd
Fonts comunes y `monospace`, como en Orca, para los iconos de los CLIs. Solo afecta a la terminal: el
editor y la interfaz siguen con Geist Mono (`--mono`). `applyTerminalSettings` lo aplica en vivo; lo
mide `e2e/scenarios/terminal-font.mjs` (con 1.0 la fila mide 14 px a 12 px de letra; con 1.3, 20,5).

**Velocidad del scroll.** Ajustes → Terminal: `terminalScrollSpeed` (1×, 1.5×, 2×, 3×, 4×) va a
`scrollSensitivity` de xterm; `fastScrollSensitivity` (5×, con ⌥) se queda como está. Por defecto 2×:
el 1× de xterm se siente lento con el trackpad al lado de Terminal.app o Ghostty. Claude Code corre en
el buffer normal sin capturar el mouse, así que su historial usa este mismo scroll. Se aplica en vivo
sin reajustar la terminal (no cambia la métrica); lo prueba `e2e/scenarios/scroll-speed.mjs`.

**Quién muere y cuándo.** Cerrar la ventana o `⌘Q` solo cierra la app: las sesiones siguen (y los
agentes siguen trabajando). `project:remove` y `session:kill` sí matan. El comando "Apagar todo"
(`app:shutdown`, paleta) mata todas las sesiones, apaga el daemon y cierra la app. En dev, si el
sello de build del daemon (`DaemonInfo.build`) no coincide con el de la app, main lo apaga y lo
relanza (los procesos mueren, pero se reviven al reconectar como tras un reinicio, §3.10b; el renderer puede cambiar
libremente). `OMNI_DAEMON=0` corre los PTY dentro de main como antes (pruebas, depuración).
`state.json` lo escribe el renderer al cambiar el layout y main lo vuelve a escribir (500 ms de
debounce) cuando un navegador cambia de estado, para que la URL guardada sea la viva y no la de la
última reorganización de panes. Al apagarse, un daemon solo cierra su servidor y borra socket e info si `daemon.json` lleva su pid:
`server.close()` hace que libuv borre el archivo del socket por su ruta, y un daemon reemplazado se
llevaría el socket del vivo (pasó: el vivo quedaba con sus sesiones pero inalcanzable). Además cada
5 s el daemon comprueba que su socket existe y, si desapareció, vuelve a escuchar en la misma ruta
(`watchSocket`) sin cerrar el servidor viejo: `close()` esperaría a que terminen sus conexiones (la
app sigue conectada) y su unlink borraría la ruta nueva; el viejo sigue sirviendo lo que ya tiene.
Verificado: borrar el socket con la app conectada lo recrea en el siguiente tick de 5 s y las
conexiones nuevas entran por él. El daemon ignora `SIGHUP` (cerrar la terminal que lanzó `pnpm dev` no lo mata) y al apagarse solo
borra el socket si `daemon.json` lleva su pid: un daemon viejo que muere tarde no se lleva el socket
del que lo reemplazó. Ojo al buscarlo: `process.title` es `omni-daemon`, así que `pgrep -f daemon.js`
no lo encuentra; `pgrep -fl omni-daemon` sí. Para reiniciar la app sin tocar el daemon hay que matar `electron-vite` (el proceso se llama
`electron-vite.js dev`, así que `pkill -f "electron-vite dev"` NO matchea; usar `pkill -f electron-vite`)
y los Electron sin `daemon.js`/`--type=`; si no, se acumulan servidores de Vite (5173, 5174…) y
apps duplicadas. Con `-w`, un cambio en `src/main` reinicia Electron y el puerto CDP puede quedar
"Address already in use": tras tocar main, relanzar `pnpm dev` a mano. Un segfault de Electron deja
un `.ips` en `~/Library/Logs/DiagnosticReports`; los símbolos de Electron Framework salen mal
atribuidos (p. ej. `node::sqlite`), así que se ubica el paso instrumentando con `console.log`.
Lección concreta: `enableDeviceEmulation`/`disableDeviceEmulation` sobre un webContents sin renderer
(recién creado) hace segfault; se aplica tras `dom-ready`. Los escenarios que mandan paquetes eligen SIEMPRE su propio shell como destino (`#send-target-<id>`):
el destino por defecto prefiere agentes, y con un Codex del usuario abierto el paquete de prueba le
llegaría a él. Lo mismo con el launcher: se filtra "Nueva terminal" antes de ⏎, porque el orden del
picker puede poner primero a un agente. Tras editar un store por HMR, reiniciar la app antes de
correr e2e: el renderer queda con dos instancias del módulo y el estado se parte. `pnpm e2e:persist` (`e2e/persist.sh`) recorre el ciclo
real: abre shell y navegador, cierra solo la app (sin tocar el daemon), reabre y comprueba sesión,
layout, historial, terminal viva y navegador recreado con su URL.

**Estado.** `~/.config/omni/state.json` (`AppState`): tabs con su árbol de splits, tab activo por
workspace, workspace actual, los navegadores (id, workspace, URL) y el último título de cada terminal
(`titles`: el que escribió el agente por OSC; un agente en reposo no lo repite y el historial del
daemon puede ya no traerlo). El título guardado vale hasta que el programa escriba otro, y la línea
de comando del propio agente (`claude --session-id …`, que el shell pone de título al revivir) nunca
pisa un nombre. El renderer lo manda con `state:save` (debounced ~500 ms) en cada cambio del layout,
de navegación o de títulos; main lo escribe. Al
arrancar, main lee el estado, recrea cada navegador con **el mismo id** y su URL (`BrowserService.create`
acepta `id`), y el renderer, tras `session:list`, restaura el layout descartando las hojas cuya sesión
ya no existe (y los tabs que quedan vacíos); lo que no esté en el layout pero sí en `session:list`
(sesiones creadas mientras la app estaba cerrada, p. ej. por un CLI futuro) se abre en su tab. Los
splits conservan tamaños, foco y zoom.

**Qué corre ahora en cada terminal.** Un agente corre dentro de un shell de login: al salir
(`/exit`, Ctrl-C) la sesión sigue viva con el shell en primer plano. El pedido `foreground` del
daemon devuelve el proceso en primer plano de cada PTY (`IPty.process`), y el renderer lo consulta cada
`FOREGROUND_POLL_MS` (`session:foreground`). `liveAgent` decide el icono de tab, franja y sidebar: el
shell en primer plano es `shell`, salvo en los primeros `AGENT_LAUNCH_GRACE_MS`, mientras el agente
arranca. Un proceso que se llama como el comando de un agente (`claude` lanzado a mano en un shell)
toma su icono, y cualquier otro proceso conserva el agente de origen. El binario de Claude Code se
llama por su versión (`2.1.301`), por eso se compara contra el shell y no contra `claude`. Si el agente
salió, su pregunta pendiente se limpia y lo que quede en pantalla ya no se lee como diálogo
(`agentExited`). `session.agent` no cambia: sigue mandando para los patrones. Un daemon
anterior a este pedido responde error, `foreground` devuelve `{}` y se usa el agente de origen.

**Soltar archivos sobre una terminal.** Como en Terminal.app o iTerm, soltar archivos (una captura
desde el thumbnail de macOS, un PDF de Finder) pega sus rutas escapadas (`core/drop-paths.ts`) con
`term.paste`, que respeta el bracketed paste de la TUI. Así Claude Code reconoce la imagen y la adjunta
como `[Image #1]`. La ruta sale de `webUtils.getPathForFile` (preload `pathForFile`); si el arrastre
no trae ruta en disco, `file:saveDrop` guarda los bytes en `$TMPDIR/omni-drops` (tope `MAX_DROP_BYTES`).
La ventana bloquea `will-navigate`, así que soltar fuera de una terminal no reemplaza la app por el archivo.
**Pegar una imagen.** `⌘V` con una imagen y sin texto en el portapapeles (una captura de macOS, una imagen
copiada del navegador) se trata igual que soltarla: un listener de `paste` en captura sobre la terminal
la intercepta antes que xterm (que solo pega texto y no mandaría nada) y pega la ruta de
`<hora>-portapapeles.png`; con texto manda el pegado normal. `⌃V` en una terminal remota es el "pegar
imagen" de Claude Code, que en el VPS leería un portapapeles vacío: omni pide la imagen del Mac
(`clipboard:readImage`, `clipboard.read()` de Electron), la sube como al soltar y pega esa ruta; sin
imagen, el `⌃V` llega tal cual. En una local el `⌃V` no se toca (Claude Code lee el portapapeles del
Mac). E2e `clipboard-image`.

**Parche de node-pty (`patches/node-pty@1.1.0.patch`).** En macOS, `pty_posix_spawn` de node-pty
1.1.0 fugaba en cada spawn un `/dev/ptmx` (el bucle de limpieza de `low_fds` nunca cerraba el índice 0)
y el fd del slave en el padre. En un daemon de larga vida eso agota `kern.tty.ptmx_max` (511) **de todo
el sistema**: después ni omni ni tmux ni otra terminal pueden abrir PTYs (`posix_spawnp failed`). El
parche aplica el fix de upstream (1.2.0-beta) con el índice acotado. Lo aplica `pnpm install` vía
`patchedDependencies` y lo compila el `postinstall` (`electron-rebuild`). Para comprobarlo:
`lsof -p <pid del daemon> | grep -c ptmx` debe igualar el número de sesiones vivas.

### 3.10b Revivir sesiones tras un reinicio

Apagar o reiniciar la Mac mata el daemon y todos los procesos: eso no se evita. Lo que se hace es
**revivir**: al volver, cada terminal reabre en su carpeta, con su mismo id (el layout de
`state.json` sigue válido) y, si era un agente, retomando su conversación.

**Registro (daemon, `src/daemon/manifest.ts`).** `~/.config/omni/sessions.json` lleva las sesiones
vivas (id, agente, workspace, cwd, `createdAt` original, flags y `resumeId`) y
`~/.config/omni/screens/<id>.ans` la última foto de cada pantalla (scrollback reciente del buffer
normal, sin pantalla alterna ni modos; `ScreenMirror.snapshot`), guardada cada 5 s si hubo salida.
Al arrancar, todo lo que había en el archivo es de un daemon muerto → **huérfanas**. Quién borra:

- `kill` (cerrar el pane, quitar el proyecto) olvida la sesión al instante, con su foto.
- La salida del shell (`exit`) la olvida tras 3 s de gracia (`EXIT_GRACE_MS`).
- SIGTERM/SIGINT o el reinicio por build distinto **congelan** el registro (`freeze`) antes de matar
  nada: en un apagado los shells mueren antes o a la vez que llega la señal al daemon, y sin la
  gracia y el congelado esas muertes vaciarían el registro. Un corte de luz deja el último registro escrito.
- "Apagar todo" manda `shutdown` con `forget: true`: borra registro y fotos (`clear`). Nada que revivir.

**Revivir (main, `src/main/services/revive.ts`).** Tras `ptys.start()` y antes de crear la ventana,
`reviveSessions` pide `orphans` al daemon y por cada una: descarta (`dismiss`) si el workspace ya no
existe, el agente no está en el catálogo o la carpeta desapareció (cae al path del workspace si solo
falta el cwd); si no, crea la sesión con el mismo id, `restored: true` y el comando de retomar. El
daemon la saca de las huérfanas, conserva su `createdAt` original y, con `restoreScreen`, pinta
primero la foto guardada y una línea tenue `── sesión restaurada HH:MM ──` (`restorePreamble`); un
agente que retoma su conversación lleva solo la línea (la conversación la repinta él). El renderer
pide `session:revived` una vez y avisa "Se restauraron N terminales de antes del reinicio".

**Cómo se encuentra cada conversación** (`ResumeResolver`, solo lectura; las bases con
`/usr/bin/sqlite3 -readonly`). Dos terminales nunca retoman la misma (`claimed`):

| Agente | Lanzamiento | Retomar | De dónde sale el id |
|---|---|---|---|
| Claude Code | `claude --session-id <uuid>` (omni elige el uuid) | `claude --resume <uuid>` | `resumeId`; solo si existe `~/.claude/projects/<cwd codificado>/<uuid>.jsonl` (nace con el primer mensaje). Sin él, se relanza con el mismo `--session-id` |
| Codex | `codex` | `codex resume <id>` | `~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl` (hora local): `session_meta` con `payload.cwd` (ruta real) y lanzamiento en `[T−2 s, T+60 s]`; sin forks ni `exec`. El id es UUIDv7 (hora en sus 48 bits): se filtra por nombre antes de abrir. Retomar reusa id y archivo |
| OpenCode | `opencode` | `opencode -s <id>` | tabla `session` de `~/.local/share/opencode/opencode.db`: `directory`, sin `parent_id` ni archivada, `time_created ≥ T−2 s` (la fila nace con el primer prompt) |
| Hermes | `hermes` | `hermes --resume <id>` | tabla `sessions` de `~/.hermes/state.db`: `cwd`, sin `parent_session_id`; la hora de lanzamiento va en el id (`AAAAMMDD_HHMMSS_xxxxxx`, hora local). Hermes sigue solo la cadena de compresión |
| Goose y shell | igual | se relanza tal cual | sin conversación que retomar (el `goose` del PATH puede ser la herramienta de migraciones `pressly/goose`, no el agente) |

El id encontrado se guarda como `resumeId`: el próximo reinicio solo comprueba que siga existiendo.
Los flags originales (`--dangerously-skip-permissions`…) van detrás del comando de retomar.

**Ajustes** (sección Sesiones): `reviveSessions` (por defecto sí; apagado, las huérfanas se
descartan) y `openAtLogin` (`app.setLoginItemSettings`, solo la app empaquetada): con los dos,
prender la Mac deja todo como estaba sin tocar nada. `OMNI_DAEMON=0` no guarda registro (las
sesiones mueren con la app a propósito).

**Límites.** Un agente a mitad de un paso (una edición, un `npm test`) pierde ese paso: retoma la
conversación y hay que decirle que siga. Un dev server o un `watch` no se relanza solo. Tras `/clear`
Claude Code abre otra conversación con otro id; `/resume` dentro de Claude Code, igual. Por eso el
daemon sigue la conversación en curso (`daemon/agent-session.ts`, cada 10 s): para cada Claude Code
local busca entre los descendientes del shell el `~/.claude/sessions/<pid>.json` que Claude Code
mantiene con su `sessionId` vivo y, si cambió, actualiza `resumeId` en la sesión y en el registro. Así
se retoma el chat en el que se estaba, no el del lanzamiento (las remotas no se siguen: su Claude
corre en el host). Un daemon de un build anterior no hace este seguimiento: "Actualizar terminales" lee los
chats en curso desde main justo antes de apagarlo (`currentClaudeChats`) y se los pasa al revive como
`resumeOverrides`. Un daemon de
un build anterior (la app empaquetada lo conserva para no matar sesiones) no guarda registro: el
primer reinicio tras actualizar todavía no revive; desde el siguiente, sí.

`pnpm e2e:revive` (`e2e/revive.sh`) lo prueba de punta a punta en un HOME aislado con un Claude Code
y un Codex de mentira (`e2e/revive/fake-*.py`, no gastan uso): un `/resume` a otro chat en el Claude
falso (que el daemon debe aprender), apagado simulado con SIGTERM a todo a la vez, reapertura, ids, `--resume`/`resume`, foto y separador, shell vivo, aviso; y "Apagar todo"
deja el registro vacío.

### 3.10c Actualizar el daemon sin perder sesiones

La app empaquetada conserva un daemon de otro build para no matar sesiones (`restartOnBuildMismatch`
solo en dev), así que sus arreglos no llegaban hasta "Apagar todo". Ahora:

- **Sin sesiones vivas**, al arrancar se relanza solo: no hay paso en curso que perder.
- **Con sesiones**, se conserva (`DaemonClient.outdated()`) y el pie muestra **Actualizar terminales**
  (`daemon:status`, `store/daemon.ts`). El comando `daemon.upgrade` (paleta, solo con daemon viejo) abre
  `ConfirmUpgrade`: "Reabrir N terminales" y, si hay agentes trabajando, cuántos pierden el paso en curso.
- **`daemon:upgrade`** (`upgradeDaemon` en `main/index.ts`): `backend.upgrade()` manda `shutdown` sin
  `forget` (el daemon congela el registro, §3.10b) y levanta otro; mientras dura, las salidas de sesión
  no se avisan (`restarting`). Después `reviveSessions` y `reviveRemote` reabren todo con el mismo id
  (los agentes retoman su conversación, las remotas se reenganchan a su dtach) y la ventana se recarga:
  el layout de `state.json` sigue válido. El aviso dice "Terminales actualizadas" (`ReviveSummary.reason`).

`pnpm e2e:upgrade` (`e2e/upgrade.sh`) lo prueba en un HOME aislado: `OMNI_TEST_BUILD` fija el sello de
main y daemon y `OMNI_KEEP_DAEMON=1` emula la app empaquetada en dev; daemon "viejo" con un shell, app
"nueva", aviso, confirmación, daemon reemplazado (otro pid), sesión con su id y su pantalla.

### 3.11 Quick open unificado (`⌘K`, canvas 05)

Un solo buscador para todo lo que se puede abrir o hacer: `features/quickopen/QuickOpen.tsx`, overlay
`quickopen`, 720 × 480 centrado a 110 px del borde superior (como el artboard), sobre el `Dialog`/
`ListPicker` de `ui/`. La paleta de comandos sigue existiendo (`palette.open`, ahora `⇧⌘P`) y es lo
que el quick open muestra bajo el prefijo `:`.

**Entrada y prefijos.** El campo acepta texto libre y un prefijo que filtra el tipo: `:` comandos,
`@` agentes (sesiones), `/` archivos; sin prefijo busca en todo y agrupa por tipo en este orden:
Agentes, Comandos, Archivos. A la derecha del campo, chips `Todo · : Comandos · @ Agentes · / Archivos`
(`Toggle` de `ui/`, el activo en relleno). `Tab` rota el tipo (`⇧Tab` al revés) reescribiendo el
prefijo del campo: el texto es la única fuente de verdad y el chip solo lo refleja. Las coincidencias
se resaltan con `Highlight` (`<mark>` sin fondo, blanco, 500) sobre el texto gris. Lógica pura con
tests en `features/quickopen/search.ts`: parseo de prefijos, `fuzzyMatch` (subsecuencia
case-insensitive por programación dinámica: +3 inicio de palabra, +4 consecutiva, −1 por salto),
`rank` y `quoteForShell`.

**Abrir proyecto por ruta.** Si lo escrito es una ruta de la carpeta de usuario (`~`, `~/…`,
`/Users/<yo>/…`, `/home/<yo>/…`: `pathQuery`; `/src/app` sigue siendo búsqueda de archivos), el quick
open solo lista el grupo Carpetas con lo que sugiere main (`project:suggestPaths`: carpetas que empiezan
por el último tramo, sin distinguir mayúsculas; con barra final, las hijas; solo dentro del home).
`Tab` completa con la activa conservando la forma escrita (`completePath`: `~/priv` → `~/private/`) y
`⏎` la abre como proyecto (`sessions.openProjectPath`, el mismo camino que `omni open`), o salta al
existente.

**Resultados.** Agentes: todas las sesiones de todos los workspaces, fila con `AgentIcon`, título de
la sesión y estado (`pregunta` en ámbar, `trabajando`, `listo` en gris; no hay noción de "sin leer")
y `⏎` en la fila activa. Orden sin consulta: pregunta, trabajando, listo, y dentro por última salida;
con consulta manda la puntuación difusa y luego ese mismo orden. Se busca en el título y en el
nombre del agente (`claude` encuentra un Claude Code con título OSC propio). Comandos: los de
`commands.list()` con su atajo (`hintFor`), solo los que pasan `when`; sin consulta, los primeros en
orden de registro (no hay historial de uso). Archivos: `files:search(query, límite)` de main con
debounce de 80 ms y descarte de respuestas viejas por generación (`store/quickopen.ts`); nombre del
archivo como etiqueta y carpeta en mono; sin consulta no se listan. Máximo 8 por grupo sin prefijo;
con prefijo, hasta 40.

**Panel derecho (230 px).** Para el resultado activo: agente → nombre, badge, estado (`pregunta ·
2m 14s` desde la última salida; `trabajando` y `listo` sin tiempo: no se guarda cuándo empezó a
trabajar), `cwd`, `rama` (`workspace:branch`, cache de 30 s en el store), `pane` (`en pantalla` /
`en otro tab`); archivo → ruta completa, workspace y rama; comando → grupo y atajo. Pie del panel:
`Tab tipo`.

**Acciones** (`features/quickopen/actions.ts`). `⏎` abre: agente → entrar a su pane (equivale a
`session.enter`: `activatePane` y foco a la terminal o a la página); comando → `commands.run`;
archivo → escribir la ruta en la terminal con foco (relativa si es del mismo workspace, absoluta si
no; `quoteForShell` la entrecomilla con comillas simples si lleva algo fuera de `[A-Za-z0-9._/-]`;
`writeToSession` sin `⏎`: el agente la recibe como contexto; sin terminal bajo el teclado cae a
`file:open`). `⌘⏎` agente → mostrarlo en un split a la derecha del pane actual (si ya está en el
tab en pantalla solo se enfoca; si vive en otro tab del mismo workspace se muda su hoja; desde otro
workspace no hay split y se entra a su tab); archivo → `file:open` (app del sistema); `⌥⏎`
archivo → `file:reveal` (Finder). No hay menú de acciones secundario en esta ronda. Pie del
overlay: `↑↓ mover · ⏎ abrir · ⌘⏎ en split · prefijo : @ / filtra` (con un archivo activo, `⌘⏎
abrir con el sistema · ⌥⏎ Finder`). Esc cierra y devuelve el foco a quien lo tenía, salvo que la
acción abriera otro overlay. `⌘K` con el overlay abierto lo cierra (toggle, como la paleta).

**Índice de archivos (main, `services/files.ts`).** Por workspace, un recorrido perezoso al primer
uso y refresco cada 30 s si se vuelve a consultar: ignora `.git`, `node_modules`, `out`, `dist`,
`build`, `.next`, `target`, `coverage`, `.cache`, `.DS_Store` y respeta los patrones simples
(`dir/`, `*.ext`, nombres) del `.gitignore` raíz; tope 20 000 archivos por workspace. Búsqueda:
subsecuencia sobre la ruta relativa, puntuando inicio de segmento y nombre de archivo; empata por
ruta más corta. Nunca lee contenido.

### 3.12 To-do widget (`⇧⌘T`, canvas 09b)

Una lista de tareas del día que se convierten en agentes: `features/todo/TodoWidget.tsx`, overlay
`todo`, modal de 400 × 560 al centro de la ventana con el velo de los diálogos (`--scrim`), al estilo
de un widget de macOS: radio 22, material translúcido (`--widget-bg` con `backdrop-filter: blur(32px)`), sombra
de contacto más sombra de ambiente (`--widget-shadow`), sin bordes. Entra con un zoom leve (0,96 → 1,
180 ms) que se omite con `prefers-reduced-motion`. Estado en `store/todos.ts`, persistido por main en
`~/.config/omni/todos.json` (`todo:list` al arrancar, `todo:save` con debounce de 300 ms).

**Contenido.** Cabecera: `Tareas` con su atajo a la izquierda y el número de pendientes en grande a
la derecha, con `pendientes` debajo. Luego el campo `+ Nueva tarea` (fila de 36 px con relleno suave;
la tecla de la derecha dice `A` o `⏎` según haya texto); `⏎` la crea con el proyecto actual, `Esc`
vuelve a la lista. Una sola lista de pendientes por orden de creación (no hay Hoy/Mañana: el campo
`when` de tareas viejas se ignora) y, plegado al final, `Hecho` (solo las terminadas hoy) con su
conteo a la derecha; sin pendientes pero con hechas dice "Todo hecho". Columnas fijas: `+` y
casillas a 24 px; texto a 50 px.
Fila: casilla redonda clicable (`○` pendiente, `✓` hecha tachada, anillo ámbar con punto si su
agente trabaja; área de clic del alto de la fila), texto, y a la derecha el badge del agente o el
`Dot` si pregunta. Con el cursor o el mouse encima, la fila cambia el badge por sus acciones
(`IconButton`): lanzar agente (`⏎`) o ir al agente (`G`) y borrar (`D`).
Texto largo: las filas van en una línea con `…`; la fila con cursor (`J K` o clic) se despliega y
muestra el texto entero en varias líneas, con casilla y acciones alineadas a la primera. Relleno
8 + línea 20 + 8 = 36 px, así una tarea corta no cambia de alto al recibir el cursor.
Pie de atajos en una línea: `X hecha · ⏎ lanzar agente · D borrar`.

**Teclas.** `J K` mover el cursor; `X` alterna hecha; `D` borra
(sin confirmación: hay `⌘Z` para deshacer la última borrada mientras el widget esté abierto); `A`
enfoca el campo; `⏎` sobre una tarea sin agente abre el launcher con el proyecto de la tarea y, al
elegir el agente, escribe el texto de la tarea como primer prompt cuando el prompt se calma (mismo
`writeWhenSettled` del envío de capturas) y vincula `sessionId`; `⏎` sobre una tarea con agente =
`G`; `G` entra al pane del agente y cierra el widget. Si el agente muere, la tarea pierde el
vínculo (no se marca hecha sola). Comandos: `todo.toggle` (`⇧⌘T`), `todo.add` (desde la paleta).

**Sidebar.** Ítem de navegación `Tareas` con el conteo de pendientes, después de Broadcast; abre el modal.

**Escribir a un agente (`store/session-write.ts`).** `writeToSession` sanea, usa bracketed paste si hay
varias líneas y manda el `⏎` en un write aparte 150 ms después (`SUBMIT_DELAY_MS`): Claude Code trata
texto+⏎ en un mismo chunk como pegado y no envía. `writeWhenSettled` espera a que la TUI tenga el modo
de pegado activo (`store/paste-mode.ts` lo sigue por sesión desde el stream, así vale aunque `?2004h`
se emitiera antes de suscribirse) y 2,5 s de silencio; si en 8 s no hay señal escribe el texto SIN ⏎
(delante puede haber un shell si el agente murió: un prompt con ⏎ se ejecutaría como comando).

### 3.13 Preguntas y permisos detectados

omni no responde a los agentes: detecta cuándo esperan al usuario y lo marca como `pregunta` (punto
ámbar en el sidebar, notificación nativa §3.14); la respuesta se da siempre dentro del pane. (Hubo una
vista Inbox que respondía permisos desde fuera de la sesión; se retiró.)

Diálogos de selección de Claude Code (confianza, servidor MCP nuevo…) terminan en "Enter to confirm · Esc to cancel" y no suenan BEL: `scanTrustPrompt` los detecta en el stream (buffer rodante de 16 KB, `stripAnsi` convierte los saltos de cursor `ESC[<col>G` con que Ink separa palabras en espacios) y los marca como atención; `detectClaudeDialog` resume el título. Diálogo de confianza de Claude Code ("Quick safety check" en cada carpeta nueva, p. ej. cada worktree): no suena BEL, así que `store/sessions.ts` lo detecta por texto y lo marca como atención (e2e `trust-prompt`); la decisión es del usuario, dentro del pane.

**Patrones (`core/permission-patterns.ts`, puros, con tests).** Por agente, regex sobre la cola sin
ANSI que extraen `{ kind: 'bash' | 'edit' | 'read' | 'other' | 'trust', summary }`: Claude Code
(`Do you want to proceed?`, `Bash command`, `Edit file`, `Write`, `Read`), Codex (`Allow command?`,
`approve`), Hermes/OpenCode/Goose: solo BEL genérico hasta tener patrones. Alimentan el estado de la
sesión y el cuerpo de la notificación (el comando o archivo que pide). Un patrón no reconocido nunca
bloquea: la sesión queda como pregunta genérica. La cola sale de la pantalla renderizada si existe,
si no de las últimas 40 líneas de `session:history` sin ANSI (`core/terminal-text.ts`); el resumen
nunca es chrome de la TUI ni el prompt de la shell (`lastMeaningfulLine`/`agentMessage`, §3.14).

**Vistas.** `⌘1` (`fleet.open`) vuelve a Flota desde cualquier vista (Worktrees `⌘3`, Broadcast
`⌘4`, revisión). `⌘2` queda libre.

### 3.14 Atención, sin leer y notificaciones nativas

**Atención por salida cruda.** La campana (`\x07`) se detecta en `session:data` dentro del store
(`hasBell` → `markAttention`), no solo en `term.onBell`: así una sesión cuyo pane no está en
pantalla también entra en `pregunta`. Ojo: el BEL que cierra una secuencia OSC (`ESC ] … BEL`, el
título que pone cada prompt de zsh) NO es campana; `hasBell` quita las OSC antes de mirar. Sin eso
cada prompt marcaba atención y "escribirle" nunca la limpiaba. Se limpia al escribirle (como hoy).

**Sin leer.** `sessions.seen[id]` = última vez que el pane estuvo en pantalla con el tab activo
(`Layout` lo marca al pintar y en cada salida mientras es visible). Visible = vista Flota **y ventana
activa** (`ui.windowFocused`, que main avisa con `window:focus` desde `browser-window-focus`/`blur`; el
`blur` del documento no sirve porque también salta cuando la página de un navegador embebido toma el
teclado). Sin la ventana activa, con omni en segundo plano cada salida marcaba visto el pane en pantalla y
"terminó" nunca avisaba; al volver a la ventana el efecto lo marca visto y la notificación se retira
(e2e `notify-background`). Una sesión queda `sin leer`
cuando pasa de `working` a `idle` (sin salida durante `WORKING_WINDOW_MS`) con
`lastOutput > seen` y no es la sesión con foco. El sidebar pinta el punto azul (`--status-unread`)
al final de la fila, en lugar del de estado; entrar al pane lo limpia.

**Solo en la app empaquetada.** macOS registra en el Centro de Notificaciones únicamente bundles
firmados (ad-hoc basta) con bundle id propio: el Electron de desarrollo (`com.github.Electron`,
lanzado desde `pnpm dev`) y un bundle sin firma quedan fuera y `Notification.show()` se descarta en
silencio aunque `isSupported()` sea `true`. `pnpm package` (electron-builder `--mac dir` +
`codesign --sign -`) produce `pe.alexander.omni`; la primera notificación aparece como pedido de
permiso del sistema. Para probarla con el harness: lanzar el binario del bundle con
`OMNI_CDP_PORT=9229` (el renderer se sirve desde `file://…/out/renderer/index.html`; `e2e/cdp.mjs`
lo acepta, pero los `import('/src/…')` de los escenarios no existen ahí: solo teclas, DOM y
`window.omni`).

**Notificaciones nativas (main).** `notify:show(id, title, body, kind, onScreen, subtitle)` →
`new Notification`; solo si la ventana no tiene el foco o la sesión no está en pantalla. El renderer
las pide cuando una sesión entra en `pregunta` (título "<sesión> pregunta") y cuando pasa a `sin leer`
(título "<sesión> terminó"). Subtítulo (`notifyPlace`): el proyecto, y en un worktree también su
nombre (`shop · cc-51`). Cuerpo (`notifyBody`): en una pregunta, el resumen del patrón de permiso; si
no, lo último que dijo el agente en su pantalla renderizada (`agentMessage` de `core/terminal-text.ts`:
el mensaje con `⏺`/`●`/`•`, sin llamadas a herramientas, con su continuación), recortado a 180
caracteres. Nunca el chrome de la TUI (`isTuiChrome`: bordes, prompt, `-- INSERT --`, `auto mode on`,
`shift+tab`…), que es lo que salía antes como "última línea".

**"Terminó" exige trabajo (`MIN_WORK_MS`, 1,5 s).** Una sesión solo queda `sin leer` si su ráfaga de
salida (del primer chunk tras el último reposo al último antes de callarse `WORKING_WINDOW_MS`) duró al
menos 1,5 s. Claude Code activa el modo de foco (`?1004`): cada vez que la ventana pierde el foco xterm
le manda `ESC [O` y la TUI se redibuja de un golpe; lo mismo al cambiar de tamaño o reconectar. Antes
ese redibujo contaba como trabajo terminado y, con omni en segundo plano, cada cambio de app disparaba
un "terminó" (notificaciones sin fin). Lo prueban `sessions.test.ts` y `notify-background.mjs`. Clic en la notificación → main
emite `notify:activate(id)` → el renderer enfoca la ventana (`win.show()` + `focus()` lo hace
main) y entra a la sesión. Ajuste `settings.notifications`: `all` (defecto), `questions`, `done`, `off`.
En Ajustes (⌘,) son dos `Switch` ("Cuando un agente pregunta", "Cuando un agente termina"; `notifyFlags`
↔ `notifySetting`) y "Probar notificación": `notify:test` manda un aviso de ejemplo sin filtros ni
agrupación y devuelve si macOS lo mostró o por qué no (en dev, "macOS no deja notificar a omni"); la
fila dice dónde activarlo. Lo prueba `e2e/scenarios/settings-notifications.mjs`. Nunca más de una notificación por sesión y estado (se agrupa: si la
sesión ya tiene una pendiente de pregunta no se repite hasta que se responda).

### 3.15 Worktrees (`⌘3`, canvas 10 "Worktrees y revisión")

Un agente, un worktree: el diff es la unidad de revisión. Un worktree es un `Workspace` de
`kind: 'worktree'` (el modelo ya lo preveía): `{ id, projectId, name, path, kind }`, y main guarda
en `projects.json` `worktrees: [{ id, projectId, name, branch, base, path, createdAt, issue? }]`.
Ruta: `~/.config/omni/worktrees/<proyecto>/<name>` (fuera del repo, nada que ignorar). Rama:
`omni/<name>`; base: la rama actual de la ubicación (repo) de la que sale, al crearlo (o `origin/HEAD` si existe).
`git worktree add -b omni/<name> <path> <base>` por `execFile`, nunca por shell.

**Crear.** (a) Launcher `⌘T`: `⇧⏎` lanza el agente elegido "en un worktree nuevo" (nombre
`<badge>-<n>` en minúscula, p. ej. `cc-51`), el pie del launcher lo dice. (b) Comando
`worktree.new` (vista Worktrees `N`, quick open): `TextInput` con el nombre. (c) `worktree.fromIssue`
(`I`): pide el número; main `git:issue(projectId, n)` usa `gh issue view n --json number,title,url`
(si `gh` falla: error humano "gh no está autenticado o el repo no es de GitHub"); el nombre sale
del título (`issue-41-rate-limit-por-ip`, ≤ 40 chars) y el primer prompt del agente lanzado desde
ahí es `Issue #41: <título>\n<url>`. Un proyecto que no es repo git no puede crear worktrees
(el menú lo deshabilita con el motivo; `N` e `I` avisan en el pie "<proyecto> no es un repo git (git init)" y
la vista vacía lo explica en vez de ofrecer `N`).

**Estado (`worktree:status(workspaceId)`).** `{ branch, base, dirty, stat: { files, additions,
deletions }, tests: { status: 'pass' | 'fail' | 'running', summary, at } | null }`; main lo
calcula con `git diff --shortstat <base>` + `git status --porcelain` y lo cachea 5 s; evento
`worktree:changed` cuando cambian los tests o el worktree se crea/borra.

**Tests al terminar.** `projects.json` guarda por proyecto `testCommand: string | null` (menú del
proyecto → "Comando de tests", `TextInput`). Cuando un agente que vive en un worktree pasa de
`working` a `idle` (misma señal que "sin leer") y el worktree tiene cambios, main corre
`testCommand` ahí (`execFile('sh', ['-lc', cmd])`, timeout 10 min, salida capturada hasta 64 KB) y
publica `tests` en el estado; la última línea no vacía es el `summary`. Nunca se lanza dos veces a
la vez para el mismo worktree.

**Limpieza.** Al morir la última sesión de un worktree sin cambios respecto a su base (`stat.files
=== 0 && !dirty`) main lo borra solo (`git worktree remove`, `git branch -D`). Con cambios, queda
listado "sin agente" hasta que el usuario lo mergee o descarte.

**Vista Worktrees (`ui.view = 'worktrees'`, `⌘3`).** `features/worktrees/WorktreesView.tsx`: lista
agrupada por proyecto; fila (`Row multiline`): nombre y rama, agente vinculado (badge + estado) o
"sin agente", `+a −d · n archivos`, tests (`ok` verde / `fallaron` rojo / `corriendo`) y antigüedad.
Teclas (capa `worktrees`): `J K` mover, `⏎` abrir revisión, `O` entrar al agente, `N` nuevo, `I`
desde issue, `R` correr tests ahora, `X` descartar (confirma con `ConfirmKill`-like overlay
`confirmDiscard`), `Esc` Flota. Sidebar: ítem `Worktrees` con el conteo, antes de `Broadcast` y `Tareas`
(orden del canvas: Flota, Worktrees, Broadcast). El sidebar de Flota lista los worktrees
como workspaces del proyecto (ya hay filas de workspace), con su rama en gris.

### 3.16 Revisión: diff anotado (`ui.view = 'review'`, canvas 03)

Entrada: `review.open` desde Worktrees (`⏎`), desde quick open (agente en worktree → `⌘D`) o
desde la franja de un pane cuyo workspace es un worktree (icono `GitCompare`). Estado en
`store/review.ts` (`workspaceId`, `diff`, `cursor { file, hunk, line }`, `comments`, `composer`).

**Datos.** `git:diff(workspaceId)` → `{ base, branch, files: [{ path, status: 'M' | 'A' | 'D' | 'R',
additions, deletions, binary, hunks: [{ header, lines: [{ kind: 'ctx' | 'add' | 'del', old: number |
null, new: number | null, text }] }] }] }`: `git diff --no-color -U3 <merge-base>` sobre el árbol de
trabajo más los archivos sin seguimiento como añadidos (contenido leído, máx. 512 KB por archivo);
parser puro en `core/unified-diff.ts` con tests. Tope 2 MB de diff; binarios sin hunks.

**UI (artboard 03).** Cabecera: `Revisión · <proyecto>`, badge del agente y `Dot`, línea mono
`omni/<name> → <base> · n archivos · +a −d · tests ok|fallaron|sin correr`; botones `Editor O`
(abre el archivo bajo el cursor con la app del sistema: `file:open`), `Descartar ⇧X`, `Enviar n
comentarios ⇧S`, `Merge ⇧M` (primario). Aside 280 px: archivos con `M/A/D` y `+a −d`, luego
comentarios (`archivo:línea` + primera línea). Cuerpo: hunks en mono 12.5 px con dos columnas de
números, signo y texto; fondos `--diff-add-bg` / `--diff-del-bg` (tokens nuevos, verdes y rojos al
10 %), cabecera de hunk en `--surface`; la línea bajo el cursor con relleno `--surface-2` (sin
marco). Compositor de comentario bajo la línea (`C`): `TextInput` multilínea, `⌘⏎` guarda, `Esc`
cancela; los comentarios se pintan bajo su línea con acento `--accent-comment` (token nuevo, violeta
del artboard) a la izquierda.

**Teclas (capa `review`).** `] [` hunk siguiente/anterior, `} {` archivo, `J K` línea, `C`
comentar, `⇧S` enviar, `⇧M` merge, `⇧X` descartar, `O` editor, `R` recargar diff, `Esc` volver a
Worktrees. Pie global: `] [ hunk · } { archivo · J K línea · C comentar · ⇧S enviar · E copiar para PR · ⇧M merge · Esc volver`.

**Acciones (main, `services/git.ts` ampliado).** `git:merge(workspaceId)`: exige la ubicación de la que salió
en la rama base y limpio (`git status --porcelain --untracked-files=no` vacío: los archivos sin
seguimiento no bloquean; si no, error "el repo tiene cambios sin commit: a, b"); en el
worktree `git add -A && git commit -m "wip (omni)"` si hay cambios; en el local `git merge --squash
omni/<name>` + `git commit -m "<name> (omni)"`; conflicto → `git merge --abort` y error con los
archivos; éxito → borra worktree y rama, publica `worktree:changed`, y las sesiones del worktree se
matan con confirmación previa en el renderer. `git:discard(workspaceId)`: `git worktree remove
--force` + `git branch -D`. Enviar comentarios: texto `Revisión de omni/<name>:\n- src/client.ts:48:
…` escrito con `writeToSession` al agente del worktree (con `\r` si no es shell); sin agente, se
copia al portapapeles y la franja lo dice. Tras enviar, los comentarios quedan marcados `enviado`.

**Exportar para un PR (`E`, `review.export`).** `reviewMarkdown` (pura, `review-logic.ts`) arma la
revisión en Markdown y va al portapapeles: título `Revisión de \`rama\` → \`base\``, totales y tests (con
el resumen si fallaron), lista de archivos con estado y `+a −d`, los comentarios por archivo en orden
de línea (con la línea citada y la marca de desfasado) y el diff de cada archivo en un `<details>`
plegado con bloque `diff`, cuyo fence es más largo que cualquier racha de backticks del contenido. Lo
prueba `worktree-flow` (con `pbpaste`).

### 3.17 Costo como piso (pie)

Main `services/cost.ts`: lee los logs locales de los CLIs y suma tokens × precio: Claude Code en
`~/.claude/projects/<cwd codificado: todo carácter no alfanumérico → ->/*.jsonl` (también `<sesión>/subagents/*.jsonl`) (`message.usage` con `input_tokens`,
`output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` y `message.model`;
tabla de precios por familia opus/sonnet/haiku, desconocido = sonnet) y Codex en
`~/.codex/sessions/**/*.jsonl` (eventos con `usage`/`token_count` y `model`). `cost:summary` →
`{ today, bySession: Record<id, { usd, tokens }> }`: `today` = todo lo registrado desde las 00:00
locales; por sesión, los archivos cuyo `cwd` coincide con el workspace y que cambiaron después de
`createdAt` (aproximación: por eso es un piso). Cache 30 s; `cost:changed` cuando varía. Sin logs →
`today = 0` y nada se pinta.

**UI.** Pie, a la derecha (`StatusBar`): `$18.60+` en mono `--text-3`; es un botón que abre el widget
Uso (§3.25). Oculto si es 0. Quick open, panel del agente:
`costo $3.10 · 62k`. Vista Worktrees y Broadcast: columna `Costo`.

### 3.18 Broadcast: un prompt a N agentes (`⌘4`, canvas 04)

Una ronda = un prompt lanzado a varios agentes, cada uno en su worktree, para comparar y elegir.
Main guarda las rondas en `~/.config/omni/broadcasts.json`: `{ id, projectId, prompt, createdAt,
candidates: [{ workspaceId, sessionId, agent }], chosen: workspaceId | null, state: 'running' |
'done' | 'merged' | 'discarded' }`. Un candidato se crea con `worktree:create` (nombre
`<badge>-<n>`) y se lanza el agente ahí con el prompt como primer mensaje (`writeWhenSettled`,
como las tareas). Los tests del proyecto (`testCommand`) corren en cada worktree al callarse su
agente, como en §3.15.

**Nueva ronda (`⇧B` en la vista, `broadcast.new`).** `Dialog` con: prompt (`TextArea`, obligatorio),
agentes (chips con los agentes del catálogo que tengan comando; varios seleccionables, mínimo
uno, se puede repetir uno con `+`), tests al terminar (lectura del `testCommand` del proyecto, con
atajo para editarlo). `⌘⏎` lanza. El proyecto es el actual.

**Vista (`ui.view = 'broadcast'`).** Nav interno de 260 px: `Rondas` del proyecto
con nombre (primeras palabras del prompt), `n agentes · hace 14m`, y abajo `⇧B Nueva ronda`.
Cabecera: título, `n worktrees desde <base> · <testCommand> al terminar`, botones `Comparar dos
⇧D`, `Relanzar R`, `Merge del elegido ⇧M` (primario, solo con elegido). Bloque del prompt con
`P` (ver completo). Tarjetas en fila (`features/broadcast/Candidate.tsx`, una por candidato, mismo
ancho, fondo `--surface`, elegida con relleno `--surface-2`, nunca borde): cabecera `Dot` de estado,
nombre del worktree, badge, `★ elegido`, tiempo; pares `Diff +a −d · n archivos`, `Tests`, `Costo`
(`sessionCostLabel`), `Deps` (archivos de dependencias tocados: `package.json`, `go.mod`,
`requirements.txt`, `Cargo.toml`); resumen = última línea no vacía de la terminal; lista mono de
archivos con `+a −d` (máx. 6 y `…n más`). Estado `trabajando` / `listo` / `pregunta` del agente.

**Teclas (capa `broadcast`).** `H L` mover entre tarjetas, `J K` entre rondas, `⏎` entrar al
agente de la tarjeta, `D` abrir la revisión del candidato (`review.open` con su workspace),
`⇧D` diff entre dos (abre la revisión del segundo con el primero como base: `git:diff` admite
`base?: string` = rama del otro candidato), `S` elegir/deselegir (`★`), `X` descartar el candidato
(worktree y agente, con confirmación), `R` relanzar la ronda (nuevos worktrees con el mismo
prompt y agentes; los viejos se descartan si no están elegidos), `⇧M` merge del elegido
(`git:merge`, luego descarta el resto y marca la ronda `merged`), `⇧B` nueva ronda, `Esc` Flota.
Pie global: `H L comparar · D diff · ⏎ abrir agente · X descartar · ⇧M merge y limpiar`. Sidebar: ítem
`Broadcast` después de `Worktrees`, con el número de rondas activas.

### 3.19 Editor con cambios del agente (pane `editor`, canvas 09)

Un pane de editor es una sesión sin proceso que main registra como el navegador (`DocService`,
`services/docs.ts`): `doc:open(workspaceId, path, kind)` → `SessionInfo { agent: 'editor' | 'preview',
cwd: <workspace>, args: [path] }`; vive hasta `session:kill`, se persiste en `state.json` como
`docs: [{ id, workspaceId, path, kind }]` y se recrea al arrancar (como los navegadores). Los ids
`editor` y `preview` entran al catálogo bajo "Herramientas" (`Editor`, `Vista previa`), sin comando.

**Abrir.** Quick open, resultado archivo: `⏎` inserta la ruta en la terminal (como hoy), `⌘⏎`
abre el editor en un split a la derecha del pane con foco, `⌥⏎` Finder, `⇧⏎` app del sistema.
Launcher: "Editor" pide ruta con `TextInput` (relativa al workspace). Franja del pane: ruta
relativa, `TypeScript` por extensión, `●` si está sucio, badge `ED`.

**Buffer.** CodeMirror 6 (`@codemirror/view`, `state`, `commands`, `language`, `merge`, `lint`, `autocomplete`, lenguajes JS/TS, JSON,
Markdown, CSS, HTML, Python, Go, Rust, YAML; `@replit/codemirror-vim` para los modos NORMAL /
INSERT del artboard), tema propio desde `tokens.css` (nunca colores sueltos), fuente mono de la
terminal. `file:read(path)` / `file:write(path, text)` (solo dentro de un workspace; error humano
si no). `⌘S` guarda; al cerrar un pane sucio, `ConfirmKill`-like "Descartar cambios". Recarga sola
si el archivo cambia en disco y el buffer está limpio (`file:watch` / `file:changed`); si está
sucio, aviso en la franja "cambió en disco" con `R` para recargar.

**Cambios del agente.** Para archivos dentro de un repo: `git:fileAtBase(workspaceId, path)` → texto
en HEAD (o en la base del worktree si es worktree). Los hunks se calculan en el renderer
(`core/line-diff.ts`, Myers sobre líneas, con tests) y son la fuente de verdad de `]c [c A R C ⌥⌘A`;
el pintado es de `@codemirror/merge` (`unifiedMergeView`, sin sus botones): líneas añadidas con
`--diff-add-bg`, el bloque borrado encima con su resaltado de sintaxis y fondo `--diff-del-bg`, el
cambio exacto dentro de la línea subrayado, y una barra de 4 px en el margen (verde añadido, roja
borrado). Merge compara contra la base con los hunks ya aceptados aplicados (`comparisonText`), así
lo aceptado no se vuelve a pintar. "Solo cambios" (`editor.changesOnly`, `⇧⌘D`, botón de la cabecera)
pliega lo que no cambió dejando 3 líneas alrededor de cada cambio ("N líneas sin cambios", clic para
desplegar).
Cabecera del pane: `● n cambios del agente · ⓘ n errores · Solo cambios ⇧⌘D · Diff ⌘D · Al agente ⌥⌘A`. Teclas en NORMAL (mapeadas en vim, no en el keymap de omni: con el foco en un pane solo rige la capa global): `]c [c`
siguiente/anterior hunk, `]d [d` error siguiente/anterior (cursor al inicio del error con su mensaje
en un tooltip, sin selección visual), `A` aceptar (el hunk deja de marcarse hasta que vuelva a cambiar: se guarda
como "visto" en el estado del pane), `R` revertir (reemplaza el rango por el texto de la base; guarda
al toque si el buffer estaba limpio y, si ya tenía cambios, deja el buffer sucio y avisa "revertido sin
guardar (⌘S)"; si el archivo cambió en disco con el buffer sucio, `R` primero recarga), `C` comentar (compositor bajo el hunk, `⌘⏎` manda `archivo:línea: texto` al agente del
workspace con `writeToSession`, como la revisión). Sin hunk bajo el cursor, `A` `R` `C` hacen lo de vim
(append, replace, change): la acción prueba los comandos `editor.*` y, si ninguno está disponible, quita
su mapeo, vuelve a despachar la tecla y lo restaura. `⌘S` con el archivo cambiado en disco y el buffer
sucio no pisa a ciegas: overlay `confirmOverwriteDoc` (Sobrescribir / Recargar / Cancelar). El árbol
lateral (`⌘E`) tiene su capa de teclado `editorTree` (`j k ⏎ l h ⌫ Esc`), activa cuando el foco DOM está
en `.editor__tree`. Cerrar un pane o un tab con editores sucios pasa por `confirmDiscardDoc`
(`closeManyIfClean` en `store/docs.ts`; `killWithConfirm` los desvía antes de matar el resto). Las
rutas se canonizan (`normalizePath`: `~`, `.`, `..`, barras) antes de buscar un documento ya abierto. `⌥⌘A` manda al agente el archivo y los hunks
actuales como contexto (bracketed paste sin ⏎: el usuario sigue escribiendo su pedido). `⌘D` abre la revisión del worktree. `⌘E` árbol de archivos del workspace
en un lateral del pane (`files:tree(workspaceId, dir)`, `Row` nivel 1/2, `⏎` abre en este pane).
**Errores (`diagnostics:check`, `services/diagnostics.ts`).** Al abrir, recargar y guardar, main
corre el `tsc` y el `eslint` que el proyecto ya tiene en su `node_modules/.bin` (buscado desde la
carpeta del archivo hasta la raíz del workspace; nunca `npx` ni binarios globales), con el entorno de
los tests y Homebrew en el PATH. `tsc --noEmit --pretty false -p <tsconfig>` (un tsconfig "solución"
con `files: []` se reemplaza por sus `references`; dos editores del mismo proyecto comparten la
corrida) y `eslint -f json --no-warn-ignored <archivo>`; un tsc que sale con error sin dejar
diagnósticos legibles no cuenta como "sin errores". El renderer los pinta con `@codemirror/lint`:
subrayado ondulado (`--danger` error, `--status-working` aviso), marca en un margen de 14 px (círculo
error, triángulo aviso: la forma también dice la severidad) y tooltip "error · mensaje" con
`tsc TS2322` / `eslint regla`. La cabecera resume `n errores · n avisos` (clic = `]d`). `⌥⌘A` agrega
los errores al contexto como `archivo:línea:col: [herramienta código] mensaje`. `editor.checkDiagnostics`
vuelve a correrlos a mano.

**Autocompletado (`@codemirror/autocomplete`).** En INSERT, al escribir: lo que ofrece el lenguaje
(variables del scope y snippets en JS/TS, Python, CSS, HTML, Go, Markdown) y, en los lenguajes sin
fuente propia (JSON, YAML, Rust, texto), las palabras del archivo. `⏎` acepta, `↑↓` eligen, `Esc`
cierra. Textos de CodeMirror traducidos por `EditorState.phrases`.

Con servidor de lenguaje (§3.19b) las sugerencias vienen del servidor y reemplazan a las del lenguaje.

### 3.19b Servidor de lenguaje en el editor (LSP)

El editor habla con el servidor de lenguaje **del proyecto** (su versión de TypeScript, su gopls):
autocompletado del servidor, tipos al pasar el mouse, ayuda de firmas, ir a definición, referencias,
renombrar y **errores en vivo mientras se escribe** (sin guardar).

**Main (`services/lsp.ts`).** `lsp:start(workspaceId, path, client)` resuelve el servidor del archivo
(`resolveServer`) y lo lanza o reusa uno vivo con la misma `key` (tipo + raíz + TypeScript/binario):

| Archivo | Servidor | Cómo |
|---|---|---|
| TS/JS con `node_modules/typescript` ≤ 5 (el más cercano subiendo desde el archivo) | `typescript` | `typescript-language-server` incluido en omni (`process.execPath` como Node) con `initializationOptions.tsserver.path` = el tsserver del proyecto |
| TS/JS con TypeScript ≥ 7 (nativo, sin `tsserver.js`) | `tsgo` | `<proyecto>/node_modules/typescript/bin/tsc --lsp --stdio` |
| TS/JS sin TypeScript instalado | ninguno | el editor sigue con tsc/eslint al guardar |
| `.go` | `gopls` | del PATH |
| `.py` | `pyright` | `basedpyright-langserver` o `pyright-langserver --stdio` del PATH |
| `.rs` | `rust-analyzer` | del PATH |

El PATH de los servidores suma `EXTRA_BIN_DIRS`, `~/go/bin`, `~/.cargo/bin` y `~/.local/bin` (una app
abierta desde el Finder tiene un PATH mínimo). Main solo hace de tubo: `LspFramer` corta el stdout por
`Content-Length` (bytes) y cada cuerpo sale como `lsp:message`; `lsp:send` le pone la cabecera. El
`initialize` lo manda el renderer, así que `client` (un uuid por carga del renderer) distinto mata
los servidores del cliente anterior. Un servidor que muere avisa con `lsp:exit` y un texto humano
("gopls se cerró (código 2): …"). Cada servidor lidera su grupo de procesos (`detached`): `stopAll` (SIGTERM y SIGKILL tras la gracia) al cerrar la ventana y `killAll` (SIGKILL al grupo, también a hijos como tsserver) al salir, para que ninguno sobreviva a omni. Los errores pull se piden con un `DiagnosticPuller` por cliente: un barrido por tick, un pedido en vuelo por archivo (el anterior se cancela con `$/cancelRequest`) y solo vale la respuesta vigente; dos editores del mismo archivo comparten el documento del servidor (`didClose` con el último). En la app empaquetada
`typescript-language-server` va en `asarUnpack` (el proceso hijo lo carga como módulo ES).

**Renderer (`panes/editor/lsp.ts`).** Un `LSPClient` de `@codemirror/lsp-client` por servidor,
compartido por los editores del workspace, con un `Workspace` propio (`OmniWorkspace`): compara URIs
por ruta decodificada (el servidor puede escaparlas distinto) y `displayFile` abre el archivo en un
editor a la derecha (o enfoca el que ya estaba) y espera a que tenga el texto antes del salto. Cada
editor conecta en `load` y suma a un compartimento: el plugin, `serverCompletion({ override: true })`,
`hoverTooltips`, `signatureHelp` y `autoSync` (manda los cambios 400 ms después de teclear). Al cerrar
el último editor de un servidor, se apaga a los 30 s (`lsp:stop`).

**Errores.** Push (`textDocument/publishDiagnostics`) o pull (`textDocument/diagnostic`, LSP 3.17: el
TypeScript 7 nativo publica listas vacías y responde al pedirlos) según `diagnosticProvider`; con pull
se piden todos los archivos abiertos del servidor tras cada sincronización (editar `a.ts` cambia los
errores de `b.ts`) y lo publicado se ignora. Se llevan al buffer actual (`unsyncedChanges`) y entran
como `CodeDiagnostic { source: 'lsp', code: 'TS2322' }`. El editor pinta juntos los del servidor y
los del chequeo de herramientas; con servidor de TypeScript ese chequeo ya no corre tsc
(`diagnostics:check(…, skip: ['tsc'])`), solo eslint al guardar.

**Teclas** (comandos `editor.definition`, `editor.references`, `editor.rename`, solo con servidor):
`F12` y `gd` en NORMAL ir a definición, `⇧F12` y `gr` referencias (panel abajo, `Esc` lo cierra),
`F2` renombrar (en todos los archivos, sin guardar). Sin servidor `gd`/`gr` caen a lo de vim. La
cabecera muestra el servidor en vez del lenguaje ("TypeScript 5.9.3"); si no arrancó, "TypeScript ·
sin servidor" en ámbar con el motivo en el tooltip. Textos de renombrar y referencias en
`EditorState.phrases`; tooltips y paneles con los tokens.

Fuera por ahora: Vue (`.vue` necesita `@vue/language-server` y su plugin de TypeScript) y un `K` de
vim que muestre los tipos sin mouse.

`e2e/scenarios/editor-lsp.mjs` lo prueba contra servidores reales sin red: un proyecto con el
TypeScript 7 de omni y otro con un TypeScript 5 (si está en la máquina, `OMNI_E2E_TS5`): servidor en
la cabecera, TS2322 en vivo, error nuevo al escribir sin guardar, autocompletado, hover, `gd` a otro
archivo, cabeceras en split sin desbordes, `⇧F12` y `F2`.

### 3.20 Vista previa (pane `preview`)

Pane `preview` para Markdown, imágenes y PDF. Main registra el protocolo `omni-file://<workspaceId>/
<ruta relativa>` que sirve archivos SOLO dentro de ese workspace (sin `..`, realpath comprobado,
tipo MIME por extensión). Markdown: `markdown-it` + `DOMPurify`, estilos de lectura desde tokens,
imágenes relativas resueltas al protocolo, enlaces relativos abren otro preview en el mismo pane,
externos con `shell.openExternal` (confirmación de dominio no hace falta: es el usuario quien
hace clic). Imágenes: `<img>` centrada con zoom `+ -` y `0`. PDF: `<iframe>` al protocolo (el
visor de Chromium). Recarga sola con `file:changed`. Franja: nombre, tipo y `⌘⇧V` para alternar
"editor ↔ preview" del mismo archivo (abre el otro pane al lado; `⌘⇧P` es la paleta). Historial del
pane con `⌥⌘[` (`⌘[` es pane anterior); zoom de imágenes `⌘=` `⌘-` `⌘0` solo con un preview enfocado.

### 3.21 Socket de control, CLI y bus MCP (canvas: "Bus por MCP", "CLI sobre el socket")

Main abre un segundo socket Unix, `~/.config/omni/app.sock` (NDJSON, mismo `LineSplitter` que el
daemon), que acepta comandos de fuera de la app: `{ id, type, ... }` → `{ id, ok, result | error }`.
Tipos: `list` (sesiones con workspace, agente y proyecto; además `status` —`working`, `question`, `idle`— y `title` vivo: el estado se infiere en el renderer, así que main le manda el pedido interno `statuses`, fuera de `TYPES`, y si la ventana no contesta en 1,5 s la lista sale sin ellos), `send { sessionId | title, text, submit? }`
(`title` = nombre o badge del agente, del workspace o del proyecto, exacto sin mayúsculas; prefijo solo para ids; desde `mcp:*` nunca a shells ni a documentos, solo a agentes)
(escribe a la PTY con `sanitizeForPty`; `submit` añade `\r`), `open { path }` (abre proyecto o, si
es archivo, un editor), `browser { url, workspaceId? }` (pane navegador), `capture { sessionId?,
url }` (captura de un navegador y ruta del PNG), `diff { workspaceId }` (abre la revisión),
`focus { sessionId }` (entra al pane), `show { sessionId }` (pone el pane en pantalla sin mover el
teclado), `todo { text }` (nueva tarea), `notify { title, body }`, y `page.<op>` (navegador manejado por
un agente, §3.23; los resuelve main). `OMNI_SOCK` cambia la ruta del socket en main y en los clientes
(pruebas con el omni instalado abierto: la ruta de un socket Unix no pasa de 104 caracteres).
Main resuelve lo que es suyo (list, send) y el resto lo manda al renderer por el evento
`app:command` (`{ id, type, args }`) y espera `app:commandResult` (`invoke` del renderer). Nunca
ejecuta comandos de shell. `app.sock` tiene permisos 600 y se borra al salir.

**CLI `omni`** (`bin/omni.mjs`, publicado en `package.json` `bin`; `pnpm link --global` lo deja en el
PATH): `omni list`, `omni send <sesión|título> "texto" [--submit]`, `omni open <ruta>`, `omni browser
<url>`, `omni capture <url>`, `omni diff <worktree>`, `omni focus <sesión>`, `omni todo "texto"`,
`omni notify "título" "cuerpo"`. Salida humana por defecto, `--json` para scripts. Si la app no
está abierta: "omni no está abierto" y salida 2.

**Servidor MCP `omni-mcp`** (`bin/omni-mcp.mjs`, stdio, protocolo MCP 2025-06-18 implementado a
mano: `initialize`, `tools/list`, `tools/call`; sin SDK): herramientas `omni_list_sessions`,
`omni_send`, `omni_open`, `omni_open_browser`, `omni_capture` (devuelve la ruta del PNG y el
tamaño), `omni_open_diff`, `omni_todo`, `omni_notify`; cada una mapea 1:1 a un comando del socket.
Para registrarlo en Claude Code: `claude mcp add omni -- node <ruta>/bin/omni-mcp.mjs` (la paleta
tiene `mcp.copyCommand`, que copia esa línea y la de `omni-browser`, §3.23); Codex:
`~/.codex/config.toml` `[mcp_servers.omni]`.
El renderer muestra en la franja del pane `MCP` cuando el agente hizo algo por el bus (aviso de
notice, como las capturas).

**Seguridad.** Solo escucha en el socket local del usuario; `send` sanea; `open` solo rutas
existentes; `capture` y `browser` solo URLs permitidas (`isAllowedUrl`). Cada comando llega al
renderer con el nombre de quien lo pidió (`cli` o `mcp:<agente>`) para el aviso.

### 3.22 Dictar al agente (`⌥Space`, canvas 09c)

Mantener `⌥Space` graba el micrófono (renderer, `getUserMedia` + `AudioWorklet` → PCM 16 kHz mono),
muestra el overlay "Dictando a <sesión> <badge> 0:07" con la transcripción parcial, y al soltar
transcribe con whisper local y escribe el texto en el prompt del agente con foco (`writeToSession`
con `\r`). `⇧` al soltar: deja el texto en un `TextArea` para revisarlo antes de enviar (`⌘⏎`
envía, `Esc` descarta). `Tab` mientras dicta cambia el destino (lista de agentes como en "Enviar
al agente"). `⌥⇧Space`: dictar y elegir destino al final. `⌥Space ×2`: manos libres (graba hasta
`⌥Space` otra vez). Pie del overlay: "whisper local · nada sale de la máquina".

**Transcripción (main, `services/whisper.ts`).** Usa el binario `whisper-cli` de `whisper.cpp`
(`brew install whisper-cpp`) y el modelo `ggml-base.bin` en `~/.config/omni/models/`; `whisper:status`
→ `{ binary: ruta | null, model: ruta | null }`; `whisper:downloadModel` baja el modelo base desde
Hugging Face (ggerganov/whisper.cpp) con progreso por evento; `whisper:transcribe(pcm16kWav)`
escribe un WAV temporal y corre `whisper-cli -m <modelo> -f <wav> -l es --no-timestamps -otxt`
con timeout 60 s. Sin binario o modelo, el overlay lo dice y ofrece `D` para descargar el modelo
y copia el `brew install`. Para pruebas: `OMNI_FAKE_WHISPER=texto` hace que `transcribe` devuelva
ese texto sin binario.

### 3.23 Navegador manejado por un agente (MCP `omni-browser`)

Un segundo servidor MCP, `omni-browser` (`bin/omni-browser-mcp.mjs`, mismo núcleo que `omni-mcp`),
deja que un agente maneje los panes de navegador como Claude in Chrome maneja Chrome. La extensión
de Chrome no sirve aquí: Electron no implementa `chrome.debugger`, `nativeMessaging` ni `sidePanel`.
Cada herramienta va a un comando `page.<op>` del socket, que main resuelve en `services/browser-agent.ts`
(`BrowserAgent`, sin importar `BrowserService`: `main/ipc.ts` le pasa un `AgentHost`).

| Herramienta | Op | Qué hace |
| --- | --- | --- |
| `tabs` | `tabs` | navegadores abiertos, URL, título, si está en pantalla y cuál es el destino por defecto |
| `navigate` | `navigate` | carga una URL (o `back` / `forward` / `reload`) y espera; `newTab` o sin navegadores abre uno |
| `read_page` | `read` | `interactive` (controles con ref `[r12]`, estado y valor, más títulos), `all` (más texto), `text` |
| `click` | `click` | por ref (lo trae a la vista; si algo lo tapa, error con qué lo tapa) o por `x, y` |
| `type` | `type` | escribe en el ref o en el foco (`Input.insertText`); `clear` reemplaza |
| `press_key` | `key` | golpes separados por espacio: `Enter`, `cmd+a Backspace`, `shift+Tab` |
| `scroll` | `scroll` | página o contenedor del ref; con ref y sin cantidad, lo trae a la vista |
| `screenshot` | `screenshot` | JPEG al ancho CSS de la vista: una coordenada de la imagen sirve tal cual para `click` |
| `draw` | `draw` | cajas (con etiqueta), flechas, notas y puntos numerados sobre la página; `clear` los borra |
| `console` | `console` | últimas líneas de consola, filtro por regex |
| `eval` | `eval` | JS en el mundo de la página; devuelve la última expresión (con el mensaje real si falla) |
| `wait_for` | `wait` | texto o selector que aparece (o desaparece con `gone`), o una espera fija |

Sin `sessionId`, el destino es el navegador que estuvo en pantalla por última vez.

**Cómo se lee.** Los scripts corren en el isolated world de omni (`OMNI_WORLD`, como el modo
elemento): la página no ve los refs. Cada elemento guarda su ref en un `WeakMap` mientras dure el
documento; tras navegar, un ref viejo da "vuelve a leerla con read_page". Las marcas de `draw` viven
en `<div data-omni-draw>`, en coordenadas de documento, sin capturar el ratón, y `read_page` no las lee.
Los colores van inline (naranja, rojo, amarillo, verde, azul, morado): la página no tiene los tokens de omni.

**Cómo se actúa.** Ratón y teclado van por CDP (`webContents.debugger`: `Input.dispatchMouseEvent`,
`Input.dispatchKeyEvent`, `Input.insertText`), como la extensión. Hay tres detalles que lo hacen
fiable:
- Al engancharse se emula el foco (`Emulation.setFocusEmulationEnabled`). Sin eso, Chromium descarta
  el input de una página sin foco, y el foco suele estar en la terminal del agente.
- `keepAwake` desactiva `backgroundThrottling` de la vista mientras el agente la usa. Con la ventana
  tapada, macOS la daría por oculta: no pinta y Chromium tira el input. A los 60 s de la última
  operación se restaura y se suelta el debugger.
- Antes de cada clic se espera un frame y se comprueba que llegó el `mousedown`. Si no llegó, se
  reintenta y, con ref, se usa `el.click()` como último recurso; las teclas que no llegan dan error.
  Nunca se usa `sendInputEvent`: sin foco en la vista, macOS lo puede entregar al renderer de omni y
  una tecla suelta dispararía sus atajos.

Mientras dura una operación, `before-input-event` no reenvía las teclas del agente como atajos de
omni: `cmd+k` es de la página.

**En pantalla.** Leer, actuar, dibujar y capturar necesitan layout: una vista que nunca se mostró
mide 0×0. Si la vista está oculta, antes se pide `show`: el renderer pone el pane en pantalla
(cambia de tab si hace falta) sin mover el teclado. Con un overlay de omni abierto, la operación falla
con error humano. `console`, `eval`, `wait_for` y `tabs` no lo necesitan. Cada operación pinta
`MCP · <agente>` en la franja del pane. La captura del agente no toca el portapapeles ni escribe
archivo, a diferencia de `omni_capture`.

**Seguridad.** Lo mismo que el socket (local, 600). `eval` corre JS con las sesiones del perfil del
pane, como `javascript_tool` de Claude in Chrome: es para el navegador de quien tiene omni abierto.

### 3.24 Puertos en escucha (`⌥⌘P`)

Cuántos servicios hay levantados en la máquina, de dónde salieron y cómo llegar a ellos o tumbarlos. Es un
widget como el de Tareas (§3.12): `features/ports/PortsWidget.tsx`, overlay `ports`, modal de 440 × 560 con
el mismo material. Lo mismo que el panel Ports de Orca, en versión de teclado.

**Detección (main, `services/ports.ts`).**
- `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` da quién escucha. Es el mismo comando que usa Orca, ~60 ms. IPv4 e
  IPv6 del mismo proceso cuentan una vez, y un proceso es una fila aunque escuche en varios puertos (el
  menor se abre; los demás, como HMR o inspector, van como `+ 24678`).
- `ps -axww -o pid,ppid,pgid,etime,command` da el árbol, el tiempo arriba y la línea de comando.
- `lsof -a -d cwd` da la carpeta de cada proceso.
- Nombre corto (`describeCommand`): el binario de `node_modules/.bin` con su subcomando (`nuxt dev`), el
  script de un intérprete (`node dist/main.js`, `python3 -m http.server`) o la app de macOS (`Spotify`).
- Repo, rama y subcarpeta se leen de `.git` a mano (`readRepo`, caché 30 s). Un worktree enlazado se
  nombra por su repo principal; la rama los distingue.
- Origen (`resolveOwner`): se sube por el árbol hasta el shell de una sesión. El pedido `pids` del daemon
  (`{ root, sessions }`) da el pid de cada shell. Si el daemon es viejo y no lo conoce, solo se sabe que es
  "de omni" (desciende del daemon), no de qué sesión, hasta reiniciar el daemon ("Apagar todo"). Orca
  atribuye por cwd o línea de comando. Aquí el árbol da la terminal exacta aunque el servidor corra en
  otra carpeta.
- `kind`:
  - `dev`: cwd distinto de `/`, o lanzado desde omni.
  - `system`: apps y daemons con cwd `/`.

  `self` marca procesos de omni mismo (el CDP de dev), que no se detienen.

**Detener (`ports:stop(pid, port)`).**
1. Se vuelve a escanear: si el pid ya no escucha en ese puerto (pid reciclado), no se toca.
2. SIGTERM al grupo del proceso, como ⌃C a un trabajo (cae `pnpm dev` con su hijo). Solo si el líder del
   grupo es él o un ancestro y en ese tramo no hay un shell, un agente (`claude`, `codex`…) ni omni. Si no,
   la señal va solo al pid: nunca se tumba la terminal ni el agente que lo lanzó.
3. Si en 3 s no cayó, SIGKILL.

**Renderer.**
- `store/ports.ts` pide `ports:list` cada 2 s con el widget abierto y cada 10 s con la ventana enfocada
  (para el conteo del sidebar).
- `store/ports-logic.ts` agrupa, filtra y arma las etiquetas.
- URL (como Orca): si el servidor anunció en su terminal de omni una URL local para ese puerto
  (`➜ Local: https://localhost:5173/app/`), se abre y se copia esa, con su esquema y su ruta. Sale de
  `session:history` sin códigos ANSI. Si no anunció ninguna, se usa `http://localhost:<puerto>`.

**Contenido.**
- Cabecera: `Puertos` con su atajo y el número de servicios en grande.
- Filtro (`/`): por puerto, nombre, repo, rama o carpeta. Todas las palabras deben coincidir.
- Grupos, en este orden:
  1. `En <proyecto>`: los del workspace actual, por su sesión o su carpeta. Es el "Active Workspace" de
     Orca.
  2. `Otros`.
  3. `Sistema`, plegado (`H`), con su conteo.
- Fila (`Row multiline`, 57 px):
  - el puerto en mono, en una columna fija de 48 px alineada con la lupa del filtro;
  - el nombre y el tiempo arriba (`recién`, `14m`, `3h`, `2d`);
  - debajo, `repo/sub · rama · + otros puertos`;
  - el badge del agente que lo levantó.
- Tooltip con URL, línea de comando, carpeta, pid y si se ve desde la red.
- Con el cursor o el mouse, la fila cambia el badge por sus acciones (`IconButton`): abrir en omni, copiar
  URL, ir a su terminal (solo si se sabe la sesión) y detener.
- Pie de atajos, o el aviso de la última acción (`Copiado …`, `Detenido :3000 nuxt dev`).

**Teclas.**
- `J K` (o flechas, también desde el filtro): mover el cursor.
- `⏎`: abre en un navegador de omni en el workspace del servicio, o entra al navegador que ya lo muestra.
- `O` / `⇧⏎`: navegador del sistema.
- `C`: copiar la URL.
- `G`: entrar a la terminal que lo levantó.
- `X`: arma la detención y la fila dice "X otra vez para detener"; la segunda `X` antes de 3 s detiene.
- `R`: refrescar.
- `Esc`: cierra; desde el filtro vuelve a la lista.

Comandos: `ports.toggle` (`⌥⌘P`) y `ports.filter` (desde la paleta). Sidebar: ítem `Puertos` con el conteo
de servicios, después de Tareas.

**Dev server desde la franja.** Si un servicio salió de una terminal de omni (`sessionId`), la franja
de ese pane muestra `StripLink` `localhost:<puerto>` (`devServerOf`); clic o `prefijo w`
(`pane.openDevServer`) hace lo mismo que `⏎` en el widget: va al navegador que ya lo muestra o abre uno con
la URL que el servidor anunció (`advertisedUrl`). Para que aparezca enseguida, `onData` ve una URL local
con puerto en la salida y pide `ports:list` 1,5 s después (sin eso, hasta 10 s de sondeo). Lo prueba
`e2e/scenarios/dev-server.mjs`.

### 3.25 Uso por agente (`⌥⌘U`, o clic en el costo del pie)

Cuánto se gastó hoy con cada agente de código y cuánto queda de su plan.

**Datos (main, `services/usage.ts`, `usage:get(force?)`).**
- **Hoy**, desde las 00:00 locales; es un piso, como §3.17:
  - Claude Code y Codex: `CostSummary.byAgent` del `CostTracker` (cada `Source` sabe su CLI).
  - OpenCode: suma `cost` y `tokens` de los mensajes `assistant` de `~/.local/share/opencode/opencode.db`.
  - Hermes: suma `session_model_usage` de `~/.hermes/state.db` (costo real si lo hay; si no, el estimado),
    contado el día de su última llamada.
  - Las bases se leen con `/usr/bin/sqlite3 -readonly` y `file:…?mode=ro`, sin dependencias nativas.
  - Siete días no: los logs de Claude de una semana pasan de 700 MB. La semana la cuentan los topes.
- **Topes del plan, en vivo como Orca**, con el login que ya tiene cada CLI:
  - Claude Code: `security find-generic-password -s "Claude Code-credentials" -w` →
    `claudeAiOauth.accessToken` → `GET api.anthropic.com/api/oauth/usage`. Devuelve `five_hour`,
    `seven_day` y los `limits[]` `weekly_scoped` por modelo (Fable). El plan sale de `subscriptionType`
    y `rateLimitTier` (`Max 20x`).
  - Codex: `~/.codex/auth.json` → `GET chatgpt.com/backend-api/wham/usage`. Devuelve `plan_type` y las
    ventanas `primary` y `secondary`, ordenadas de la más corta a la más larga.
  - Sin red o sin login, Codex cae al último `rate_limits` de sus logs (`stale`, con su hora).
- **Seguridad:**
  - El token solo vive dentro de la función que pide. No se guarda, no se registra en logs y no viaja
    al renderer.
  - Los errores dicen el código HTTP y qué hacer ("El login de Claude Code venció: abre Claude Code y
    se renueva").
  - omni nunca renueva un login: si rotara el refresh token, cerraría la sesión del CLI.
  - `net.fetch` de Electron respeta el proxy del sistema.
- **Caché:** topes 60 s (`force` lo salta) y lo local 15 s.

**UI (`features/usage/UsageWidget.tsx`).** Usa el marco `ui/Widget`, compartido con Puertos.
- Cabecera: `Uso` con su atajo y el total de hoy en grande.
- Una tarjeta de relleno suave por agente con rastro en la máquina, en el orden del catálogo:
  - icono, nombre y `Badge` del plan; lo de hoy en dólares a la derecha;
  - una fila por tope: etiqueta (`5 h`, `Semana`, `Fable`, `30 días`), barra `ui/Meter` (`role="meter"`;
    naranja desde el 80 % y rojo desde el 95 %), el % siempre escrito y el reinicio (`1h 40m` dentro del
    día, `sáb 4:00` dentro de la semana, `20 nov` más lejos; redondeado al minuto);
  - debajo, los tokens de hoy y, si los topes vienen de los logs, "topes de hace 3h" con el motivo en el
    tooltip.
- Un agente sin uso hoy queda en una línea que dice "sin uso hoy"; solo crece si tiene topes.
- Los agentes sin rastro van al final, en "Sin datos en esta máquina".
- Contraste AA medido sobre la tarjeta: lo secundario en `--text-2` (5,9:1), porque `--text-3` da 3,9:1.

**Teclas.** `R` vuelve a medir (pide los topes en vivo), `J K` desplazan, `Esc` cierra. Mientras está
abierto se repide cada minuto. Comando `usage.toggle` (`⌥⌘U`). El `$` de hoy del pie (§3.17) es un botón
que lo abre.

### 3.26 Hosts remotos por SSH

Trabajar en un VPS como en local: terminales y agentes corren en el servidor, el editor y el quick open
leen sus archivos y la revisión ve su git. Mismo diseño que Zed y distinto de Orca (que sube su propio
daemon con Node y `node-pty` al host): el **`ssh` del sistema** con una conexión compartida por host y
**dtach** en el servidor para que las terminales sobrevivan a cortes. Así `~/.ssh/config`, `ProxyJump`,
las llaves y el ssh-agent funcionan tal cual y omni nunca guarda credenciales.

**Hosts (`~/.config/omni/hosts.json`, `services/hosts.ts`).** `RemoteHost { id, name, target }`; `target`
es un alias de `~/.ssh/config` o `usuario@host` (`validateTarget`: sin espacios ni `-` inicial). "Agregar
servidor SSH" (`host.add`, overlay `hostAdd`) lista los alias de `~/.ssh/config` (siguiendo `Include`,
sin comodines; cada uno resuelto con `ssh -G`) o acepta uno escrito. `HostRegistry`
(`services/host-registry.ts`) lleva el estado por host (`HostStatus`: `disconnected | connecting |
connected | error`, con mensaje humano, `$HOME`, sistema y herramientas) y lo emite con `host:status`.
Al abrir omni se conectan solos los hosts que tienen ubicaciones. Ajustes → Servidores los lista con
Probar/Reconectar/Quitar; `host.reconnect` ("Reconectar servidor") con el cursor en una ubicación remota.

**Transporte (`src/main/hosts/`).** `SshTransport` corre todo como `ssh <opts> <target> -- <línea>` con
`ControlMaster=auto`, `ControlPersist=600`, `ControlPath=/tmp/omni-ssh-<uid>/<hash>` (carpeta 0700,
dueño verificado; ≤ 104 bytes), `BatchMode=yes` (sin prompts de contraseña: llaves o agente; un host
nuevo se acepta una vez desde una terminal, omni no acepta huellas solo), `ConnectTimeout=10` y
keepalive 15 s × 3. Salida 255 = falla de ssh → `SshError` con mensaje humano (auth, DNS, rechazo,
huella cambiada con el `ssh-keygen -R` a correr, timeout); otro código es resultado normal del comando.
**Única excepción a "nunca por shell"**: la línea remota se arma con `shq` (comillas simples POSIX,
probado contra comillas, `$`, backticks, saltos de línea, unicode y `-`) y `shCommand`
(`cd -- '<cwd>' && exec 'cmd' 'arg'…`); herramientas con PATH de usuario van con `loginWrap`
(`"$SHELL" -lc`). `Host` (`hosts/types.ts`) es la costura: `exec`, `execLogin`, `fs: HostFs` (stat,
lectura binaria, escritura atómica tmp + `mv` que conserva el modo, readdir robusto a saltos de línea,
realpath) y `home()`; `LocalHost` y `SshHost` la implementan igual (misma batería de tests contra los
dos, el remoto con `e2e/fake-ssh/ssh`). El preflight (`preflight.ts`) corre una vez al conectar:
`uname -sm`, `$HOME` y `command -v` de dtach, git y los agentes en el shell de login.

**Comillado contra cualquier shell de login.** sshd pasa la línea al `$SHELL` del usuario (puede ser
fish, csh o tcsh): toda línea remota viaja como `exec /bin/sh -c '<línea>'` (`remoteLine`), y si
lleva saltos de línea, `!`, `\` o no-ASCII, codificada en octal y decodificada por el `printf` de
`/bin/sh`. `loginWrap` pasa la línea en `OMNI_LINE` y el shell de login solo carga su perfil y ejecuta
un `/bin/sh` fijo, nunca interpreta código POSIX (csh/tcsh van con `-c`, sin `-l`).

**Terminales.** `session:create` en un workspace remoto pide `hosts.terminalSpawn` y el daemon lanza
`ssh -tt … -- <terminalCommand>` en vez del shell local (`DaemonCreateInput.spawn`). En el host:
`cd` al cwd, `TERM_PROGRAM=omni OMNI_SESSION=1` y, con dtach, `<dtach> -A ~/.omni/run/<id>.sock -r
winch -z "$SHELL" -l` con la ruta absoluta que encontró el preflight en el shell de login
(`HostTools.dtachPath`: el shell sin login de sshd puede no tenerlo en el PATH). Si `ssh` sale con 255
(se cayó la red, se cerró la tapa) el daemon relanza lo mismo con espera creciente
(`RECONNECT_BACKOFF_MS`; el contador solo vuelve a cero si el proceso aguantó 30 s) y pinta `── conexión
perdida, reconectando ──`: el agente nunca murió. El comando del agente queda pendiente en la sesión
hasta escribirse tras el primer prompt de un proceso que siga vivo (un primer ssh fallido no lo pierde).
Agotadas las esperas (o al primer 255 si el host no tiene dtach), la sesión no se olvida: el daemon
guarda la última foto de su pantalla (`ExitListener` con `screen`), el manifest la pasa a huérfana
(`lost`) y main la revive sola (`remoteRecovery` en `services/revive.ts`): cada salida 255 y cada
`powerMonitor` `resume` (abrir la tapa) agendan un intento que verifica la conexión (`hosts.connect`) y
corre `reviveRemote` para ese host; si siguen huérfanas reintenta a los 3 s, 10 s, 30 s, 1 min, 2 min
y luego cada 5 min unas cuantas veces. También se revive al próximo `connected`. Un id pedido que ya está vivo se rechaza en `restored`/`spawn` (nunca
se inventa otro: el socket remoto lleva ese nombre). Cerrar la sesión mata también la remota
(`killSession`: `pkill` con el patrón anclado `^…dtach -A …/<id>\.sock` —sin anclar, en Linux se
mataba su propio shell y el `rm` del socket no corría— y borra el socket); con el host caído el kill
queda en cola hasta que conecte. Sin dtach la terminal funciona pero su proceso muere con la conexión:
al volver se relanza en el mismo tab, con la pantalla de antes y, si era Claude Code, retomando la
conversación con `--resume` (lo que estuviera corriendo en ese momento se pierde; el diálogo de carpeta
y Ajustes lo avisan: `sudo apt install dtach`). El e2e `remote-drop` lo prueba con
`FAKE_SSH_DROP_FILE` (el ssh falso corta la conexión con 255 mientras ese archivo exista). El proceso en primer plano siempre es `ssh`
(`SessionInfo.remote`): para las remotas manda el agente de origen. `connect` sobre un host ya
conectado solo verifica la conexión compartida (sin eventos si sigue viva).

**Revivir (§3.10b).** Las huérfanas remotas no se descartan por no existir su cwd en el Mac:
`reviveRemote` conecta al host, y si su sesión dtach sigue viva (socket **y** proceso dtach vivo,
`sessionCheckCommand`; un socket muerto tras reiniciar el VPS se borra) se engancha con el mismo id **sin
escribir nada**; nunca dos revividos crean la misma sesión (ids en vuelo y re-chequeo antes de crear); si el host se reinició, abre otra y relanza el agente (Claude Code con `--resume` si su
transcript está en el host). El arranque espera esto hasta 6 s; lo que tarda más (VPS lento o caído)
sigue en segundo plano o al conectarse el host, y llega al renderer por `session:added`, que lo abre en
su tab.

**Archivos y git.** Los canales de archivo viajan como `(workspaceId, ruta)` (la ruta es del host del
workspace; dos hosts pueden repetirla). En un workspace remoto `file:read/write`, `files:tree`, la
vigilancia (sondeo de mtime), el quick open (`git ls-files`), el protocolo `omni-file://` y git (rama,
base del editor, diff) pasan por `hosts.forWorkspace(ws)`. Fuera por ahora: Finder / "abrir con" y
listar los puertos del host (Puertos solo ve los del Mac).

**Segunda parte.**

- **Reenvío de puertos.** Una terminal remota que anuncia `http://localhost:N/…` deja la URL en
  `sessions.remoteUrls` y la franja ofrece `localhost:N` (`prefijo w`, `pane.openDevServer`).
  `host:forwardPort` → `HostRegistry.forwardPort` → `SshTransport.forward` (`ssh -O forward -L
  127.0.0.1:<local>:localhost:<N>` por el ControlMaster: sin otra conexión). Usa el mismo puerto en el Mac
  si está libre; si no, otro y lo avisa. Reusa el túnel si sigue escuchando y lo cancela al desconectar.
- **Soltar archivos.** Sobre una terminal remota, los bytes suben a `~/.omni/drops/` del host
  (`file:uploadDrop`, mismo saneo y tope que `saveDropped`) y se pega esa ruta. Pegar una imagen
  (`⌘V`, o `⌃V` como en Claude Code) hace lo mismo con la del portapapeles del Mac (§ "Pegar una imagen").
- **Worktrees remotos.** `WorktreeService` y `GitService` corren todo con el `exec`/`fs` del host del repo
  (`place`): el worktree vive en `~/.omni/worktrees/<proyecto>/<nombre>` del host, el estado, el diff (con
  untracked por `head -c`), los tests (shell de login del host), el merge y el borrado (`git worktree
  remove`, o `rm -rf` solo bajo `.omni/worktrees`) pasan allá.
- **LSP y diagnósticos remotos.** `resolveRemoteServer` resuelve con los archivos y el PATH de login del
  host (TS 7: su `tsc --lsp`; TS < 7: `typescript-language-server` del host; gopls, rust-analyzer, pyright)
  y lanza el servidor por `ssh -T` (`HostRegistry.lspHost`): las rutas del editor ya son del host. Los
  diagnósticos usan un `DiagnosticsService` por host con su `execLogin` y sus archivos.
- **Costo.** `CostTracker` suma los logs de Claude Code y Codex de cada host conectado con sesiones vivas
  (`HostRegistry.costLogs`: `find` + `stat` GNU o BSD y `tail -c` incremental) y atribuye por host + cwd.
- **CLI `omni` desde el VPS.** Al conectar, `setupCli` copia `omni`, `omni-mcp` y su cliente a
  `~/.omni/bin` (lanzadores que resuelven su ruta real) y reenvía el socket de control a
  `~/.omni/run/app.sock` (`ssh -O forward -R`, Unix a Unix, 0600, `StreamLocalBindUnlink=yes`). Las
  terminales remotas exportan `OMNI_SOCK` y ponen `~/.omni/bin` en el PATH. Requiere `node` en el host.
- **Instalar dtach.** El preflight detecta el gestor de paquetes (`HostTools.dtachInstall`). Ajustes →
  Servidores y `host.installDtach` abren una terminal en ese servidor con el comando escrito **sin ⏎**
  (sudo pide contraseña; el usuario lo revisa). Al terminar, la marca `── dtach instalado ──` hace
  `host:rescan`: las terminales nuevas ya usan dtach.

El ssh falso (`e2e/fake-ssh/ssh`) implementa `-O forward -L` (proxy TCP real) y `-R` de sockets Unix, así
`e2e/scenarios/remote-forward.mjs` (puerto, drop, CLI e instalar dtach), `remote-worktree.mjs` y
`remote-lsp.mjs` prueban todo de verdad con este Mac como servidor.

`e2e/scenarios/remote-ssh.mjs` lo recorre con el ssh falso (`OMNI_SSH_BIN`) y un HOME aislado:
agregar servidor desde `~/.ssh/config`, carpeta remota con sugerencias y Tab, una ubicación local en el
mismo proyecto, renombrar, unir otro proyecto, terminal remota en el cwd del host y editar un archivo
remoto.

## 4. Convenciones

- **Código en inglés, comentarios y docs en español.** Commits en Conventional Commits.
- Componentes React: `PascalCase.tsx`, uno por archivo, export nombrado. Todo lo demás:
  `kebab-case.ts`.
- Sin `default export`. Sin `any`. Sin `!` de aserción salvo en `main.tsx`.
- Estilos: CSS plano junto a cada componente (`ui/row.css` al lado de `ui/Row.tsx`), importado
  por el propio componente. Clases de bloque y elemento (`row`, `row__label`); el estado va en
  atributos `data-*` (`data-cursor`, `data-active`, `data-status`, `data-focus`), nunca en clases
  modificadoras. Una feature solo tiene CSS de contenedor (`features/fleet/sidebar.css`).
  Los colores solo existen como tokens en `tokens.css` (paleta de Orca).
  Los tamaños de letra también: cinco tokens y ninguno más (`--fs-xs` 11, `--fs-sm` 12, `--fs-md` 13,
  `--fs-lg` 14, `--fs-xl` 16); un `font-size` en px fuera de `tokens.css` es un bug. La terminal y el
  editor usan el tamaño de Ajustes, y el texto del markup es contenido del usuario: no entran en la escala.
- Los ids de comando y los chords son strings estables: cambiarlos rompe config de usuario.
- Un servicio de main nunca importa de otro servicio; si dos necesitan hablar, lo cablea
  `main/index.ts`.

## 5. Flujo de una tecla, de punta a punta

1. `useKeyboard` captura `keydown` en `window` (fase de captura, antes que xterm).
2. Si hay overlay, solo atiende el toggle de su propio atajo. Si no, calcula el chord y las capas según el foco.
3. `keymap.resolve` devuelve un id de comando; `commands.run(id)` lo ejecuta.
4. El comando muta un store (`sessions.create`, `ui.setFocus`) o llama a `lib/omni`.
5. El store habla con main por el puente tipado; main responde o emite eventos.
6. React re-renderiza desde el store; los panes reaccionan por efectos (`fit`, `focus`).

Dentro de una terminal, xterm recibe todo salvo `⌘` (lo deja pasar) y `C-a`, que arma el
prefijo: la siguiente tecla se resuelve contra la capa `terminal` con el mismo keymap.
**Foco: una sola fuente de verdad, el foco DOM del textarea de xterm.** Su `focus` pone
`ui.focus='terminal'`, enfoca la hoja en el layout y mueve el cursor del sidebar a su fila
(`sessions.syncCursor` → `activateTab`, y al pane si el tab tiene varios). Su `blur` se evalúa un tick después: si el foco fue a un
overlay o a otra terminal no pasa nada; si el textarea ya no está en el DOM (pane cerrado) la
intención sigue en `terminal` y el pane vecino la toma; si no, `ui.focus='list'`. Fuera del host,
`setFocus('terminal')` es solo intención: `TerminalPane` enfoca al montar si su pane tiene el foco
del layout. Nadie llama `blur` a mano desde React; "salir" es `blurTerminals()`.
`sessions.activateTab` es el único punto que activa un tab (teclas, barra, sidebar): mueve layout,
cursor y workspace actual juntos y despliega el proyecto si estaba plegado. Al cerrar un overlay,
`ListPicker` devuelve el foco a quien lo tenía si nadie lo tomó mientras tanto.

Tests: `pnpm test` (Vitest, Node, sin DOM) cubre `core/keys`, `core/commands` y los stores
`layout` y `sessions` (selectores y acciones sin IPC, con `omni` y `terminal-host` mockeados).

**End-to-end sobre la app viva (`e2e/`).** `OMNI_CDP_PORT=9229 pnpm dev` expone Chrome DevTools
Protocol (solo en dev, nunca empaquetado) y `pnpm e2e [filtro]` corre los escenarios de
`e2e/scenarios/` contra el renderer real: teclas y clics despachados por CDP pasan por xterm, el
prefijo `C-a`, los overlays y el foco DOM igual que los del usuario, y el estado se lee del DOM
(`data-focus`, `.pane`, `.overlay`). Cada cambio de teclado, foco u overlay se prueba ahí antes de
darse por hecho: los tests unitarios no ven el foco DOM ni StrictMode, y ahí es donde han vivido
los bugs. Los escenarios corren sobre la app viva, **con el usuario sin tocarla**: `assertQuiet`
aborta si algo cambia solo o hay un overlay abierto. Un escenario deja la app como la encontró y
solo cierra shells (`closePanes` y `confirmKillIfShell` se niegan ante un agente); `x` jamás se
manda sin el teclado en una terminal, porque en la lista cierra el tab bajo el cursor.
`api.screenshot(file)` y `api.parkMouse()` sirven para revisar a ojo lo que el DOM no cuenta;
`api.clickAt(x, y)` es un clic real (uno sintético no mueve el foco DOM y esconde bugs) y
`api.setViewport(w, h)` emula otro tamaño de ventana (escenario `resize`). Toda UI nueva lleva
además una **validación de layout medida en el DOM** dentro del escenario (ver `focus-sidebar`,
paso H2: texto de cada nivel a la derecha del padre, puntos de estado en una columna, aire entre
rellenos) y capturas 1:1 de la zona tocada revisadas antes de darla por lista (regla en CLAUDE.md). Trampas aprendidas:
la vista nativa del navegador no sale en `api.screenshot` (es otro webContents) y no pinta si la
ventana está tapada (`document.visibilityState === 'hidden'`): la captura devuelve error y el
escenario `browser` solo comprueba el contenido con la ventana visible. Espiar un store con
`import('/src/store/x.ts')` desde la página solo sirve hasta el siguiente HMR de ese módulo (la
app queda con la versión `?t=…` y el import trae otra instancia): recargar el renderer antes.
En una URL `data:` el `#` arranca el fragmento (nada de colores hex en el HTML de prueba). Con un solo overlay abierto, `useKeyboard` solo reacciona al atajo que lo abrió
(`OPENER`); los overlays sin atajo propio (confirmKill, projectMenu) no se cierran con teclas sueltas.

## 6. Pendientes de infraestructura

- CSP en `index.html` para el build empaquetado (en dev lo bloquea el preamble de React).
- `electron-builder` y firma/notarización al primer release.
- Persistencia en SQLite (M1) y daemon separado para detach (M6).
