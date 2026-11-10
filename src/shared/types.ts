/**
 * Agentes que omni sabe lanzar. `shell` es una terminal pelada; `browser` no es un PTY sino un
 * `WebContentsView` embebido (ver ARCHITECTURE §3.9), pero vive como sesión para que sidebar,
 * tabs, launcher y layout lo traten igual.
 */
export type AgentId = 'shell' | 'claude' | 'codex' | 'opencode' | 'goose' | 'hermes' | 'browser' | 'editor' | 'preview'

/** Panes de documento (§3.19, §3.20): sesiones sin proceso que main registra como los navegadores. */
export type DocKind = 'editor' | 'preview'

/** Tope de lo que el editor abre y lee (`file:read`, `doc:open` con `editor`): pasado esto, error humano. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

export interface SavedDoc {
  id: string
  workspaceId: string
  /** Ruta absoluta dentro del workspace. */
  path: string
  kind: DocKind
}

/**
 * Error o aviso de una herramienta del proyecto (`tsc`, `eslint`) sobre un archivo, para el editor
 * (`diagnostics:check`, ARCHITECTURE §3.19). Líneas y columnas en base 1; el fin es `null` cuando la
 * herramienta no lo da (tsc solo marca el inicio).
 */
export interface CodeDiagnostic {
  /** Ruta absoluta. */
  path: string
  line: number
  col: number
  endLine: number | null
  endCol: number | null
  severity: 'error' | 'warning' | 'info'
  message: string
  /** `lsp`: el servidor de lenguaje del archivo, en vivo mientras se escribe (§3.19b). */
  source: 'tsc' | 'eslint' | 'lsp'
  /** `TS2322`, `no-unused-vars`. */
  code: string | null
}

/* ---------- servidores de lenguaje del editor (ARCHITECTURE §3.19b) ---------- */

/** Qué servidor atiende un archivo: el del proyecto siempre que exista (su versión de TypeScript, su gopls…). */
export type LspServerKind = 'typescript' | 'tsgo' | 'gopls' | 'pyright' | 'rust-analyzer'

/** Servidor de lenguaje vivo en main para un workspace; el renderer le habla por `lsp:send` / `lsp:message`. */
export interface LspServerInfo {
  /** Id de esta instancia del proceso (cambia si se relanza). */
  id: string
  kind: LspServerKind
  /** Nombre visible para la cabecera del editor, p. ej. "TypeScript 5.9.3" o "gopls". */
  name: string
  /** `file://` de la raíz con la que se inicializa (la del workspace). */
  rootUri: string
  /** `initializationOptions` del `initialize` (p. ej. `tsserver.path` del proyecto); `null` = ninguna. */
  initializationOptions: Record<string, unknown> | null
  /** `languageId` LSP del archivo pedido (`typescript`, `typescriptreact`, `javascript`, `go`…). */
  languageId: string
}

/** Entrada de un directorio para el árbol del editor (`files:tree`). */
export interface TreeEntry {
  name: string
  /** Ruta absoluta. */
  path: string
  dir: boolean
}

export interface AgentDef {
  id: AgentId
  /** Nombre visible, p. ej. "Claude Code". */
  name: string
  /** Etiqueta corta junto a la sesión, p. ej. "CC". */
  badge: string
  /** Comando que se escribe en el shell apenas arranca. `null` para shell sin agente. */
  command: string | null
}

/** Tipo de notificación nativa (main agrupa por sesión y tipo). */
export type NotifyKind = 'question' | 'done'

/** Resultado de `notify:test`: `ok` si macOS mostró el aviso; si no, el motivo para el usuario. */
export interface NotifyTestResult {
  ok: boolean
  error?: string
}

/** Qué avisos nativos salen: preguntas y fines (`all`), solo uno de los dos, o ninguno. */
export type NotificationsSetting = 'all' | 'questions' | 'done' | 'off'

/**
 * Un proyecto es solo un nombre (p. ej. "Billing API") con 0..n ubicaciones, todas iguales: carpetas
 * en este Mac o en un servidor por SSH (§3.5c, §3.26). El orden lo decide el usuario. Se persiste en
 * ~/.config/omni/projects.json. Los datos de antes conservan sus ids (la que era la ubicación principal
 * sigue con el id del proyecto), pero nada depende de eso.
 */
export interface Project {
  id: string
  name: string
  locations: ProjectLocation[]
  /** Comando de tests del proyecto (se corre en el worktree al terminar el agente, §3.15); `null` = no. */
  testCommand?: string | null
  /** Oculto en el sidebar, la flota y Worktrees (trabajo confidencial, §3.5c); solo se ve con "Mostrar proyectos ocultos". */
  hidden?: true
}

/** Una carpeta del proyecto en un host: cada una es un workspace propio (cwd de sus terminales). */
export interface ProjectLocation {
  id: string
  /** Nombre visible ("api", "web", "vps"). */
  name: string
  /** Ruta absoluta en su host (POSIX). */
  path: string
  /** Host remoto (id de `hosts.json`); ausente = este Mac. */
  host?: string
  /** Comando de tests de esta carpeta: manda sobre el del proyecto en sus worktrees (§3.5c). */
  testCommand?: string
}

/** Subcarpeta candidata para registrar (`project:subfolders`): `marker` es el manifiesto que la delata como subproyecto. */
export interface FolderCandidate {
  rel: string
  marker: string | null
}

/* ---------- worktrees, revisión y costo (§3.15–3.17) ---------- */

/** Issue de GitHub resuelto con `gh` (origen de un worktree). */
export interface IssueInfo {
  number: number
  title: string
  url: string
}

/** Worktree persistido en projects.json; su `Workspace` derivado tiene `kind: 'worktree'` y el mismo `id`. */
export interface Worktree {
  id: string
  projectId: string
  /** Ubicación (repo) de la que salió; de ella toma el host y a ella vuelve el merge. */
  locationId: string
  name: string
  branch: string
  base: string
  path: string
  createdAt: number
  issue?: IssueInfo
  /**
   * Ruta de la ubicación dentro de su repo (`apps/web`) cuando el worktree salió de una subcarpeta:
   * agentes y tests arrancan en `<path>/<subdir>`, como en la ubicación de origen. Ausente = la raíz.
   */
  subdir?: string
}

export type TestsStatus = 'pass' | 'fail' | 'running'

export interface TestsResult {
  status: TestsStatus
  /** Última línea no vacía de la salida (o el error). */
  summary: string
  at: number
}

export interface WorktreeStatus {
  branch: string
  base: string
  /** Hay cambios sin commit (git status --porcelain). */
  dirty: boolean
  stat: { files: number; additions: number; deletions: number }
  tests: TestsResult | null
}

export type DiffLineKind = 'ctx' | 'add' | 'del'

export interface DiffLine {
  kind: DiffLineKind
  old: number | null
  new: number | null
  text: string
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export type DiffFileStatus = 'M' | 'A' | 'D' | 'R'

export interface DiffFile {
  path: string
  status: DiffFileStatus
  additions: number
  deletions: number
  binary: boolean
  hunks: DiffHunk[]
}

/** Diff de un worktree contra su base (committed + árbol de trabajo + archivos sin seguimiento). */
export interface WorkspaceDiff {
  base: string
  branch: string
  files: DiffFile[]
  /** Se cortó por tamaño (tope 2 MB). */
  truncated: boolean
}

export type BroadcastState = 'running' | 'done' | 'merged' | 'discarded'

export interface BroadcastCandidate {
  workspaceId: string
  sessionId: string | null
  agent: AgentId
}

/** Ronda de broadcast (§3.18): un prompt lanzado a N agentes, cada uno en su worktree. */
export interface Broadcast {
  id: string
  projectId: string
  prompt: string
  createdAt: number
  candidates: BroadcastCandidate[]
  chosen: string | null
  state: BroadcastState
}

/* ---------- socket de control, CLI y MCP (§3.21) ---------- */

export type ControlCommandType = 'list' | 'send' | 'open' | 'browser' | 'capture' | 'diff' | 'focus' | 'show' | 'todo' | 'notify' | 'statuses'

/** Lo que el renderer sabe de una sesión y main no (lo infiere de la salida): para `omni list`. */
export interface SessionLiveStatus {
  status: 'working' | 'question' | 'idle'
  /** Título que el programa puso por OSC (p. ej. el tema de la conversación de Claude Code); vacío si ninguno. */
  title: string
}

/** Comando llegado por `app.sock` que main no resuelve solo y reenvía al renderer. */
export interface ControlCommand {
  id: number
  type: ControlCommandType
  /** Quién lo pidió: `cli` o `mcp:<agente>`. */
  from: string
  args: Record<string, unknown>
}

export interface ControlResult {
  ok: boolean
  result?: unknown
  error?: string
}

/* ---------- dictado (§3.22) ---------- */

export interface WhisperStatus {
  /** Ruta de `whisper-cli` o `null` si no está instalado. */
  binary: string | null
  /** Ruta del modelo `ggml-base.bin` o `null` si falta. */
  model: string | null
}

export interface SessionCost {
  usd: number
  tokens: number
}

/** Costo del día según los logs locales de los CLIs (piso, §3.17). */
export interface CostSummary {
  today: number
  bySession: Record<string, SessionCost>
  /** Lo de hoy por CLI que deja logs JSONL (widget Uso, §3.25). */
  byAgent: Partial<Record<'claude' | 'codex', SessionCost>>
}

/**
 * Lugar donde corren sesiones dentro de un proyecto: el local (la raíz), una subcarpeta registrada
 * (`folder`, §3.5c) o un worktree (§3.15). Es lo que fija el `cwd`.
 */
export interface Workspace {
  id: string
  projectId: string
  name: string
  /** Ruta en su host (POSIX); en un workspace remoto no existe en este Mac. */
  path: string
  /** `local`: ubicación principal del proyecto; `folder`: otra ubicación (subcarpeta, otra carpeta u otro host); `worktree`. */
  kind: WorkspaceKind
  /** Host remoto de la ubicación; ausente = este Mac (§3.26). */
  host?: string
  /** Dónde arrancan sus terminales si no es `path` (worktree salido de una subcarpeta: `<path>/<subdir>`). */
  cwd?: string
  /** Worktree: la ubicación de la que salió (su comando de tests manda sobre el del proyecto). */
  locationId?: string
}

/* ---------- hosts remotos por SSH (ARCHITECTURE §3.26) ---------- */

/** Un servidor al que omni se conecta con el `ssh` del sistema. Persistido en `~/.config/omni/hosts.json`. */
export interface RemoteHost {
  id: string
  /** Nombre visible ("vps", "cloud-dev"). */
  name: string
  /** Lo que se le pasa a `ssh`: un alias de `~/.ssh/config` o `user@host`; el puerto, llaves y saltos los resuelve `ssh -G`. */
  target: string
}

/** Qué tiene instalado el host (preflight al conectar). */
export interface HostTools {
  /** Persistencia de terminales: sin dtach se abren igual pero mueren si se corta la conexión. */
  dtach: boolean
  /** Ruta absoluta de dtach en el host (la terminal lo lanza fuera del shell de login, sin su PATH). */
  dtachPath?: string
  git: boolean
  /** Agentes encontrados en el shell de login del host (`claude`, `codex`…). */
  agents: AgentId[]
  /** Sin dtach: el comando para instalarlo con el gestor de paquetes del host (`sudo apt-get install -y dtach`). */
  dtachInstall?: string
}

export type HostState = 'disconnected' | 'connecting' | 'connected' | 'error'

/** Estado de la conexión a un host, para el sidebar y Ajustes. */
export interface HostStatus {
  hostId: string
  state: HostState
  /** Mensaje humano del último fallo (auth, host inalcanzable…); `null` si no hubo. */
  error: string | null
  /** `$HOME` del host, conocido tras conectar. */
  home: string | null
  /** Sistema y arquitectura (`Linux x86_64`). */
  system: string | null
  tools: HostTools | null
}

/** Host de `~/.ssh/config` que se puede importar (sin comodines). */
export interface SshConfigHost {
  alias: string
  /** `user@hostname:port` resuelto por `ssh -G`, para mostrarlo. */
  resolved: string
}

export type WorkspaceKind = 'local' | 'folder' | 'worktree'

/** Estado de una sesión tal como lo conoce main. El renderer solo lo refleja. */
export interface SessionInfo {
  id: string
  agent: AgentId
  workspaceId: string
  cwd: string
  createdAt: number
  /** Flags con los que se lanzó el agente (`SessionCreateInput.args`), p. ej. para marcar "sin permisos". Ausente = sin flags. */
  args?: string[]
  /** Id de la conversación del agente (p. ej. `--session-id` de Claude Code) para retomarla tras un reinicio (§3.10b). */
  resumeId?: string
  /** La sesión se revivió tras un reinicio (o una caída del daemon): su pantalla empieza con la de antes. */
  restored?: true
  /** Corre en un host remoto por SSH (§3.26): el foreground siempre es `ssh` y el costo no se cuenta. */
  remote?: true
}

/** Resumen de lo revivido al arrancar (§3.10b), para el aviso del renderer. */
export interface ReviveSummary {
  sessions: number
  /** Agentes que retomaron su conversación (el resto arrancó limpio con la pantalla de antes). */
  resumed: number
  /** `upgrade`: las reabrió "Actualizar terminales" (§3.10c), no un reinicio. */
  reason?: 'upgrade'
}

export interface SessionCreateInput {
  agent: AgentId
  workspaceId: string
  /** Solo para `browser`: URL inicial. Sin ella abre la página vacía con la barra de URL enfocada. */
  url?: string
  /** Flags extra para el comando del agente (p. ej. `--dangerously-skip-permissions` con ⌥⏎ en el launcher). Main escribe `command + ' ' + args.join(' ')`. */
  args?: string[]
}

/* ---------- estado que sobrevive a cerrar la app (ARCHITECTURE §3.10) ---------- */

/** Hoja del árbol de splits: un pane con su sesión. Copia serializable de `store/layout`. */
export interface SavedLeaf {
  kind: 'leaf'
  id: string
  sessionId: string
}
export interface SavedSplit {
  kind: 'split'
  id: string
  dir: 'row' | 'col'
  sizes: number[]
  children: SavedNode[]
}
export type SavedNode = SavedLeaf | SavedSplit

export interface SavedTab {
  id: string
  workspaceId: string
  root: SavedNode
  focusedPaneId: string
  zoomedPaneId: string | null
}

/** Navegador que main recrea al arrancar con el mismo id, para que el layout guardado siga válido. */
export interface SavedBrowser {
  id: string
  workspaceId: string
  url: string
  /** Perfil (partición) con el que corría; ausente o desconocido = "Por defecto". */
  profileId?: string
}

/** `~/.config/omni/state.json`: lo que el renderer necesita para volver a donde estaba. */
export interface AppState {
  /** Panes de documento abiertos (editor / vista previa), recreados al arrancar. */
  docs?: SavedDoc[]
  tabs: SavedTab[]
  /** Tab activo por workspace. */
  activeTab: Record<string, string>
  currentWorkspaceId: string | null
  /**
   * Último título de cada terminal (el que escribió el agente por OSC, p. ej. el tema de la conversación).
   * Sin esto, al reabrir la app los tabs muestran el nombre del agente hasta que el programa vuelva a
   * escribir su título, cosa que un agente en reposo no hace. Ausente en estados anteriores.
   */
  titles?: Record<string, string>
  browsers: SavedBrowser[]
  savedAt: number
}

/* ---------- navegador embebido (ARCHITECTURE §3.9) ---------- */

/** Rectángulo en px CSS del renderer donde debe pintarse la vista nativa. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Estado de navegación que main publica tras cada cambio. */
export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** DevTools acopladas abiertas (el renderer lo necesita tras recargar para volver a mandar `browser:devtoolsBounds`). */
  devtools: boolean
  /** Perfil (partición persistente) en el que corre la vista. */
  profileId: string
  /** Viewport fijo aplicado; `null` = responsive (el hueco del pane). */
  viewport: ViewportPreset | null
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error'

/** Entrada de consola de la página embebida. */
export interface ConsoleEntry {
  id: number
  at: number
  level: ConsoleLevel
  text: string
  /** `archivo:línea` si la página lo dio. */
  source?: string
}

/* ---------- quick open y to-do (ronda canvas 05 / 09b) ---------- */

/** Archivo de un workspace encontrado por el quick open. */
export interface FileHit {
  workspaceId: string
  /** Ruta absoluta. */
  path: string
  /** Ruta relativa a la raíz del workspace, con `/`. */
  rel: string
}

export type TodoWhen = 'today' | 'tomorrow'

/** Tarea del widget To-do (`~/.config/omni/todos.json`). */
export interface Todo {
  id: string
  text: string
  done: boolean
  when: TodoWhen
  /** Proyecto al que pertenece (para lanzar el agente ahí); `null` = el actual al lanzar. */
  projectId: string | null
  /** Agente lanzado desde la tarea, si sigue vivo. */
  sessionId: string | null
  createdAt: number
  doneAt: number | null
}

/* ---------- perfiles, cookies y viewport (ronda Orca) ---------- */

/** Perfil de navegación: una partición persistente de Electron (`persist:omni-<id>`) con sus cookies y storage. */
export interface BrowserProfile {
  id: string
  name: string
  /** `true` para el perfil "Por defecto", que no se puede borrar. */
  builtin?: boolean
}

/** De dónde importar cookies al perfil activo. */
export type CookieImportSource = 'chrome' | 'arc' | 'brave' | 'edge' | 'firefox' | 'safari' | 'file'

export interface CookieImportResult {
  imported: number
  skipped: number
  /** Aviso humano (p. ej. "las sesiones de Google no se importan"). */
  note?: string
}

/** Tamaño del viewport de la vista. `null` = el hueco del pane (responsive). */
export interface ViewportPreset {
  id: string
  name: string
  width: number
  height: number
  /** Emula móvil (UA y pantalla) además del tamaño. */
  mobile?: boolean
}

/** Tecla que la página embebida recibió y main reenvía al renderer (atajos ⌘ y prefijo). */
export interface ForwardedKey {
  key: string
  code: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

/** Resultado de una captura: PNG en disco listo para pegar o mandar a un agente. */
export interface Capture {
  path: string
  width: number
  height: number
}

/* ---------- modo elemento y envío al agente (canvas 07 y 08) ---------- */

/** Un elemento de la página con su letra de atajo, mientras el modo elemento está activo. */
export interface ElementHint {
  /** Letra(s) que lo eligen: `a`…`z`, luego `aa`… */
  hint: string
  /** Selector CSS estable y corto, para mostrar y para volver a encontrarlo. */
  selector: string
  tag: string
  /** Texto visible recortado (≤ 80 chars), para el tooltip y el mensaje. */
  text: string
  /** Rect en px CSS de la página (coordenadas de la vista). */
  rect: Rect
}

/** Detalle de un elemento elegido: lo que se adjunta al agente. */
export interface BrowserElement {
  selector: string
  tag: string
  text: string
  rect: Rect
  /** `outerHTML` recortado a 8 KB. */
  html: string
  /** Estilos computados relevantes (layout, caja, tipografía, color) como bloque CSS. */
  css: string
}

/** Lo que el diálogo "Enviar al agente" puede adjuntar; el usuario lo elige con `1–5`. */
export interface CaptureAttachments {
  image: boolean
  html: boolean
  css: boolean
  context: boolean
  console: boolean
}

/** Paquete que se arma en el renderer y se escribe en la terminal del agente destino. */
export interface CapturePayload {
  browserId: string
  capture: Capture
  /** Miniatura (data URL) para el diálogo. */
  thumb: string
  url: string
  viewport: { width: number; height: number }
  element?: BrowserElement
  /** Últimas líneas de consola (nivel: texto), ya recortadas. */
  consoleTail: string[]
}

/** Ajustes del usuario. Se persisten en ~/.config/omni/settings.json y se editan desde la app (⌘,). */
export interface Settings {
  /** Prefijo tipo tmux dentro de la terminal, como chord canónico (p. ej. `ctrl+a`). */
  prefix: string
  /** Tamaño de fuente de la terminal, en px. */
  terminalFontSize: number
  /**
   * Atajos del usuario por pareja `capa:comando` → chords canónicos. Una pareja presente
   * reemplaza TODOS sus chords por defecto; ausente = defaults. Lista vacía = sin atajo.
   */
  keys: Record<string, string[]>
  /** Notificaciones nativas: todas, solo preguntas, o ninguna. */
  notifications: NotificationsSetting
  /** Fuente de la terminal (solo la terminal; el editor y la UI siguen con Geist Mono), por id de `TERMINAL_FONTS`. */
  terminalFont: TerminalFontId
  /** Interlineado de la terminal: 1 = líneas pegadas como en Terminal.app u Orca. */
  terminalLineHeight: number
  /** Grosor del texto normal de la terminal (el negrito va dos pasos más arriba). */
  terminalFontWeight: TerminalFontWeight
  /** Velocidad del scroll de la terminal: multiplica lo que avanza cada gesto (`scrollSensitivity` de xterm). Con ⌥, 5 veces más. */
  terminalScrollSpeed: number
  /** Tras reiniciar la Mac (o una caída del daemon), volver a abrir las terminales y retomar la conversación de cada agente (§3.10b). */
  reviveSessions: boolean
  /** Abrir omni al iniciar sesión en macOS (solo la app empaquetada; en dev no se registra). */
  openAtLogin: boolean
}

export type TerminalFontId = 'menlo' | 'jetbrains-mono' | 'geist-mono' | 'hack-nerd'
export type TerminalFontWeight = 300 | 400 | 500 | 600

/**
 * Fuentes de la terminal: nombre visible y familia CSS. Detrás de cada una van las Nerd Fonts más
 * comunes y `monospace`, como en Orca, para que los iconos de los CLIs (Powerline, Nerd Font) no
 * salgan como cuadros. Sin "SF Mono": en macOS es una fuente oculta del sistema que Chromium no
 * encuentra por nombre (Orca la pide y en la práctica pinta Menlo).
 */
export const TERMINAL_FONTS: Record<TerminalFontId, { name: string; family: string }> = {
  menlo: { name: 'Menlo', family: 'Menlo' },
  'jetbrains-mono': { name: 'JetBrains Mono', family: 'JetBrains Mono' },
  'geist-mono': { name: 'Geist Mono', family: 'Geist Mono' },
  'hack-nerd': { name: 'Hack Nerd Font', family: 'Hack Nerd Font Mono' }
}
export const TERMINAL_FONT_FALLBACK = '"Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", Menlo, monospace'
export const TERMINAL_LINE_HEIGHTS = [1, 1.1, 1.2, 1.3] as const
export const TERMINAL_FONT_WEIGHTS: readonly TerminalFontWeight[] = [300, 400, 500, 600]
export const TERMINAL_SCROLL_SPEEDS = [1, 1.5, 2, 3, 4] as const

/** `font-family` completa de una fuente de terminal, con su respaldo. */
export function terminalFontFamily(id: TerminalFontId): string {
  return `"${TERMINAL_FONTS[id].family}", ${TERMINAL_FONT_FALLBACK}`
}

/**
 * Terminal por defecto como la ve Orca en este Mac: Menlo, líneas pegadas, peso medio. El scroll va al
 * doble del de xterm (1×), que en el trackpad se siente lento al lado de Terminal.app o Ghostty.
 */
export const DEFAULT_SETTINGS: Settings = { prefix: 'ctrl+a', terminalFontSize: 13, keys: {}, notifications: 'all', terminalFont: 'menlo', terminalLineHeight: 1, terminalFontWeight: 500, terminalScrollSpeed: 2, reviveSessions: true, openAtLogin: false }

/* ---------- puertos en escucha (ARCHITECTURE §3.24) ---------- */

/** Repo git donde corre un servicio: nombre del repo principal (también desde un worktree), rama y subcarpeta. */
export interface PortRepo {
  name: string
  /** Rama de `HEAD`; `null` con HEAD suelto. */
  branch: string | null
  /** El cwd es un worktree enlazado (`.git` es un archivo), no el checkout principal. */
  worktree: boolean
  /** Carpeta del cwd relativa a la raíz del checkout (`service`); vacío si es la raíz. */
  sub: string
}

/** Un proceso que escucha en uno o más puertos TCP de esta máquina. */
export interface ListeningProcess {
  pid: number
  /** Puertos en escucha, de menor a mayor (el primero es el que se abre). */
  ports: number[]
  /** Direcciones donde escucha: `*` (todas las interfaces), `127.0.0.1`, `::1`… */
  hosts: string[]
  /** Nombre corto para la fila: `nuxt dev`, `node dist/main.js`, `Spotify`. */
  name: string
  /** Línea de comando completa (recortada a 400 caracteres). */
  command: string
  cwd: string | null
  repo: PortRepo | null
  /** Arranque del proceso (ms epoch); `null` si `ps` no lo dio. */
  startedAt: number | null
  /** Sesión de omni de la que desciende el proceso (su shell está entre sus ancestros). */
  sessionId: string | null
  /** Desciende del dueño de los PTY de omni, aunque no se sepa de qué sesión (daemon viejo). */
  inOmni: boolean
  /** Es omni mismo (p. ej. el puerto CDP en dev): no se detiene desde el widget. */
  self: boolean
  /** `dev`: servicio levantado desde una carpeta o desde omni; `system`: app o daemon del sistema (cwd `/`). */
  kind: 'dev' | 'system'
}

/** Resultado de detener un proceso: `forced` si hizo falta SIGKILL tras el SIGTERM. */
export interface PortStopResult {
  ok: boolean
  forced: boolean
  /** Motivo humano si no se pudo. */
  error?: string
}

/* ---------- uso por agente (ARCHITECTURE §3.25) ---------- */

/** Un tope del plan: la ventana de 5 h, la semana o la semana de un modelo (`Fable`). */
export interface UsageLimit {
  /** `session`, `weekly` o `model:<nombre>`: estable entre lecturas. */
  id: string
  /** Lo que se pinta: `5 h`, `Semana`, `Fable`. */
  label: string
  /** 0–100. */
  usedPercent: number
  windowMinutes: number
  /** Cuándo se reinicia (ms epoch); `null` si no se sabe. */
  resetsAt: number | null
}

/** Consumo de un agente de código: hoy según sus logs locales y los topes de su plan. */
export interface AgentUsage {
  agent: AgentId
  /** Hay rastro del CLI en esta máquina (logs, base de datos o login). */
  found: boolean
  /** Hoy desde las 00:00 locales; `null` si omni no sabe leer su consumo. */
  today: SessionCost | null
  /** Plan de la cuenta (`Max 20x`, `Plus`); `null` si no se sabe. */
  plan: string | null
  limits: UsageLimit[]
  /** Cuándo se midieron los topes (ms epoch). */
  limitsAt: number | null
  /** Los topes vienen de los logs (último valor conocido), no en vivo. */
  stale: boolean
  /** Por qué no hay topes en vivo (sin login, login vencido, red). */
  limitsError: string | null
}

export interface UsageReport {
  agents: AgentUsage[]
  /** Suma de hoy de todos los agentes. */
  todayUsd: number
  at: number
}
