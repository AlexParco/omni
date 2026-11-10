<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design/brand/omni-horizontal-reversed.svg">
    <img src="design/brand/omni-horizontal.svg" alt="omni" width="240">
  </picture>
</p>

# omni

Entorno de desarrollo agéntico (ADE) de escritorio, operado completamente por teclado.
Los agentes de código (Claude Code, Codex, OpenCode, Goose, Hermes) corren en sus propias
terminales; omni los lanza, los agrupa por estado y, con el tiempo, les da
worktrees, diff anotado, browser embebido, editor y dictado por voz.

Estado: M0 en curso. Hoy abre terminales y agentes y permite moverse entre sesiones por teclado.

La marca (logo, icono de la app, reglas de uso) vive en [`design/brand/`](design/brand/README.md).

## Requisitos

- macOS, Node 22, pnpm 11, Xcode Command Line Tools (compila `node-pty`).
- Los CLIs que quieras lanzar (`claude`, `codex`, `opencode`…) deben estar en el `PATH`.

## Empaquetar (`pnpm package`)

`pnpm package` deja `dist/mac-arm64/omni.app` firmada ad-hoc (sin cuenta de Apple). Ábrela con
`open dist/mac-arm64/omni.app`. Las notificaciones nativas solo existen en la app empaquetada: el
Electron de desarrollo no está registrado en el Centro de Notificaciones de macOS y el sistema las
descarta. La primera vez macOS pregunta si permites las notificaciones de omni; acepta (o Ajustes
del Sistema → Notificaciones → omni).

## Avisos sin robar el foco

Una sesión que termina de trabajar con su pane fuera de pantalla queda "sin leer" (punto azul en
el sidebar) hasta que la mires. Con la ventana en segundo plano o la sesión fuera de pantalla, omni manda una
notificación nativa cuando un agente pregunta o termina; el clic te lleva a esa sesión (solo en la
app empaquetada, ver "Empaquetar"). En Ajustes (`⌘,`)
puedes dejarlas en todas, solo preguntas o ninguna.

## Worktrees, revisión y broadcast (⌘3, ⌘4)

Cada agente puede trabajar en su propio worktree git (rama `omni/<nombre>`, carpeta fuera del
repo): `⇧⏎` en el launcher, `N` en Worktrees o desde un issue de GitHub con `I`. Al callarse el
agente corren los tests del proyecto (menú del proyecto, "Comando de tests"). `⏎` abre la revisión:
diff anotado por hunks, comentarios por línea que `⇧S` manda al agente, `⇧M` merge squash en la
rama base y limpieza, `⇧X` descartar. Broadcast (`⌘4`, `⇧B`) lanza un prompt a varios agentes a la
vez, uno por worktree, compara tarjetas (diff, tests, costo, dependencias) y `⇧M` mergea el elegido.
Ojo: Claude Code pide confirmar la carpeta la primera vez que corre en cada worktree ("Quick safety
check"); omni lo marca como pregunta (punto en el sidebar y notificación), pero la respuesta la das tú dentro del pane.

## Editor y vista previa

Un archivo se abre en un pane de editor desde el quick open (`⌘⏎`), el launcher ("Editor") o el
árbol (`⌘E`). Modos vim, `⌘S` guarda, y los cambios del agente respecto a la base del repo se
marcan por hunk: `]c [c` para moverse, `A` aceptar, `R` revertir, `C` comentar al agente, `⌥⌘A`
mandar el archivo como contexto. `⌘⇧V` alterna con la vista previa (Markdown, imágenes, PDF), que
se recarga sola al cambiar el archivo.

## CLI y MCP

Con omni abierto: `omni list`, `omni send <sesión> "texto" --submit`, `omni open <ruta>`,
`omni browser <url>`, `omni capture <url>`, `omni diff <worktree>`, `omni focus <sesión>`,
`omni todo "texto"`, `omni notify "título" "cuerpo"` (`pnpm link --global` deja `omni` en el PATH).
Los agentes pueden hacer lo mismo por MCP: la paleta tiene "Copiar comandos para registrar los MCP
de omni", que copia las dos líneas:

```
claude mcp add omni -- node …/bin/omni-mcp.mjs
claude mcp add omni-browser -- node …/bin/omni-browser-mcp.mjs
```

`omni-browser` deja que el agente maneje el navegador de omni como Claude in Chrome: `tabs`,
`navigate`, `read_page` (controles con refs `[r12]`), `click`, `type`, `press_key`, `scroll`,
`screenshot`, `draw` (cajas, flechas, notas y puntos encima de la página, que también salen en la
captura), `console`, `eval` y `wait_for`. Usa los perfiles y sesiones del pane, y cada acción se ve en
su franja (`MCP · claude`).

## Dictar al agente (⌥Space)

Mantén `⌥Space`, habla y suelta: el texto se transcribe con whisper local (`brew install
whisper-cpp`, el modelo base se descarga desde la app) y se escribe en el prompt del agente con
foco. `⇧` al soltar deja revisar antes de enviar, `Tab` cambia el destino, dos toques dejan las
manos libres. Nada sale de la máquina.

## Buscar todo con ⌘K

El quick open busca en una sola lista agentes, comandos y archivos de tus proyectos. Prefijos:
`:` comandos, `@` agentes, `/` archivos; sin prefijo mezcla los tres. `⏎` abre (en un archivo,
escribe su ruta en la terminal con foco para dárselo al agente), `⌘⏎` abre el agente en un split
o el archivo con la app del sistema, `⌥⏎` lo muestra en el Finder. La paleta de comandos sigue
disponible en `⇧⌘P`.

## Tareas que se vuelven agentes (⇧⌘T)

Un widget de to-do con Hoy, Mañana y Hecho. `A` escribe una tarea, `X` la marca hecha, `T` la mueve
de día, `D` la borra (`⌘Z` deshace) y `⏎` lanza un agente en el proyecto de la tarea con su texto
como primer prompt; `G` salta al agente vinculado. Se guarda en `~/.config/omni/todos.json`.


## Puertos levantados (⌥⌘P)

Qué servicios escuchan en tu máquina, uno por fila:
- el puerto y qué es (`nuxt dev`);
- repo · rama, así distingues el mismo repo en varios worktrees;
- cuánto lleva arriba;
- qué terminal de omni lo levantó.

Con el cursor encima:
- `⏎` lo abre en el navegador de omni;
- `C` copia la URL (la que el servidor anunció en su terminal, si la hay);
- `G` va a su terminal;
- `X X` lo detiene sin tocar la terminal ni el agente que lo lanzó.

`/` filtra por puerto, repo o rama. Las apps del sistema van plegadas al final, y el sidebar muestra
cuántos servicios hay.

## Uso de cada agente (⌥⌘U)

Cuánto llevas hoy con Claude Code, Codex, OpenCode, Goose y Hermes, según sus logs locales.

Para Claude Code y Codex también salen los topes de tu plan:
- la ventana de 5 h y la semana, más las semanas por modelo como Fable;
- con barra, el porcentaje y cuándo se reinician.

omni los pide en vivo con el login que ya tiene cada CLI, como Orca. El token nunca sale de omni ni se
guarda. También se abre con un clic en el `$` del pie.
## Nada se cierra con la app

Las terminales y los agentes viven en `omni-daemon`, un proceso aparte: cerrar omni (o `⌘Q`) no
los toca, y al volver a abrir la app se reconecta, restaura tabs y splits desde
`~/.config/omni/state.json`, repinta el historial reciente de cada terminal y recrea los
navegadores con su URL. Para matar todo de verdad está "Apagar todo" en la paleta.
`OMNI_DAEMON=0 pnpm dev` vuelve al modo en proceso.

## Navegador embebido

Un pane de navegador (`C-x b` o desde el launcher) es una vista nativa de Chromium dentro de omni.
La cabecera va solo con iconos: atrás, adelante, URL (`⌘L`), recargar, vista móvil, DevTools,
markup, elemento, captura y el menú `…`.

- **DevTools acopladas** (`⌥⌘I`): las DevTools completas de Chrome (Elements, Console, Sources,
  Network…) abajo de la página, con divisor arrastrable. No hay consola propia.
- **Captura** (`⇧⌘S`): recortas una parte de la página (o te quedas con toda), dibujas encima si
  quieres (lápiz, resaltador, flecha, rectángulo, elipse, texto y borrador) y en "Enviar al agente"
  escribes un mensaje y la mandas a un chat, o copias solo la imagen para pegarla donde quieras.
- **Elemento** (`C-x f`): manda al agente el PNG y el HTML del elemento con su selector, más las
  últimas líneas de consola.
- **Perfiles y cookies** (menú `…`): cada perfil es una partición persistente con sus cookies y
  storage; se importan cookies de Chrome, Arc, Brave, Edge, Firefox, Safari o un archivo
  (cookies.txt o JSON). Los logins de Google no sobreviven a la importación.
- **Tamaño de viewport**: responsive o presets (iPhone 14, iPhone SE, iPad, 1280 × 800, 1440 × 900,
  1920 × 1080); "Ajustes del navegador" permite además borrar los datos del perfil.

## Uso

```
pnpm install
pnpm dev                         # OMNI_CWD=<ruta> fija el proyecto inicial
pnpm test                        # unitarios
OMNI_CDP_PORT=9229 pnpm dev      # + pnpm e2e: escenarios contra la app viva
```

| Tecla | Acción |
| --- | --- |
| `⌘O` / `O` | Abrir proyecto (carpeta) |
| `⌘T` / `N` | Nuevo agente o terminal en un tab nuevo |
| `⌘⌥T` | Claude Code directo |
| `⇧⌘B` | Nuevo navegador (también "Nuevo navegador" en `⌘T`, o `b` tras el prefijo) |
| `⌘L` / `⌘R` / `⇧⌘M` | Barra de URL / recargar / vista móvil del navegador con foco |
| `⌥⌘J` / `⌥⌘I` / `⌥⌘←` `⌥⌘→` | Consola embebida / DevTools / atrás y adelante |
| `f` tras el prefijo | Modo elemento: letras `a–z` sobre la página, una letra elige, `⏎` lo envía al agente, `Esc` sale |
| `⇧⌘S` / `⇧⌘A` | Captura de la página / de un área (`H J K L` mueven, `⇧` redimensiona, o arrastre): abre "Enviar al agente" |
| En "Enviar al agente" | `⌘1`–`⌘5` adjuntos (imagen 2x, HTML, CSS, URL y viewport, consola), `⌘J` `⌘K` destino, `⌘N` agente nuevo, `⌘⏎` enviar, `⌘C` copiar |
| `⌥⏎` en `⌘T` | Lanza el agente sin pedir permisos (`--dangerously-skip-permissions` en Claude Code, `--full-auto` en Codex); la franja lo marca |
| `⌘,` | Ajustes: prefijo, tamaño de fuente y **todos los atajos** de las tres capas (clic en el atajo y presiona la combinación nueva); se guardan en `~/.config/omni/settings.json` |
| `⌘]` `⌘[` | Pane siguiente / anterior |
| `⌥⌘1`…`⌥⌘9`, `⌘⇧]` `⌘⇧[` | Cambiar de tab |
| `⌘1` | Volver a Flota |
| `⌘⇧⏎` | Zoom del pane |
| `⌘W` | Cerrar pane (pide confirmación si el proceso está trabajando) |
| `⌘K` | Paleta de comandos (otra vez ⌘K la cierra) |
| `⌘/` | Hoja de atajos |
| `J` `K` `⏎` `N` `O` `M` `X` `?` | En la lista: moverse, entrar o lanzar, nuevo agente, abrir proyecto, menú, cerrar tab, atajos |
| `H` / `L` | Plegar / desplegar el proyecto (también `⏎` sobre él) |

Todas las tablas de abajo son los valores por defecto; cada atajo se cambia en `⌘,`. Dentro de una terminal manda el prefijo, `C-a` por defecto, con la tabla de tmux:

| Tras `C-a` | Acción |
| --- | --- |
| `\|` / `_` | Split a la derecha / abajo (elige terminal o agente) |
| `h j k l` o flechas, `o` / `;` | Moverse entre panes (en zoom, recorren la lista) |
| `H J K L` | Redimensionar |
| `z` | Zoom |
| `{` / `}` | Intercambiar con el pane anterior / siguiente |
| `!` | Sacar el pane a un tab nuevo |
| `x` | Cerrar pane (confirma si está trabajando) |
| `c`, `n`, `p`, `1`…`9`, `&` | Tab nuevo, siguiente, anterior, ir a, cerrar |
| `Esc` | Volver a la lista |
| `C-a` | Enviar un `C-a` literal |
| `?` | Paleta de comandos |

El prefijo caduca a los 1.5 s; mientras está armado el footer lo muestra. Dentro de la terminal
`⇧⏎` manda salto de línea (CSI u) a Claude Code y Codex, y `⌥⏎` también funciona.

Estados de sesión: **trabajando** (hubo salida hace menos de 4 s), **listo**, y **pregunta** cuando
la terminal suena la campana y nadie le ha escrito desde entonces. En Claude Code se activa con
`claude config set preferredNotifChannel terminal_bell`.

El sidebar se organiza por proyectos (carpetas) → workspaces (hoy el local; en M3 los
worktrees) → sesiones. Los proyectos se guardan en `~/.config/omni/projects.json`.

Agentes y comandos se pueden sobrescribir en `~/.config/omni/agents.json`
(lista parcial por `id`, p. ej. `[{"id":"claude","command":"claude --dangerously-skip-permissions"}]`).

## Documentación

- `ARCHITECTURE.md`: estructura del código, patrones y convenciones.
- `DESIGN.md`: producto, tesis e hitos.
