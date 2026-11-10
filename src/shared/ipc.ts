import type { HostStatus, RemoteHost, SshConfigHost, AgentDef, AppState, Broadcast, BrowserElement, CodeDiagnostic, ControlCommand, ControlResult, WhisperStatus, BrowserProfile, BrowserState, Capture, CookieImportResult, CookieImportSource, CostSummary, DocKind, ElementHint, FileHit, FolderCandidate, ForwardedKey, IssueInfo, ListeningProcess, LspServerInfo, PortStopResult, NotifyKind, NotifyTestResult, Project, Rect, ReviveSummary, SessionCreateInput, SessionInfo, Settings, Todo, TreeEntry, UsageReport, ViewportPreset, Workspace, WorkspaceDiff, WorktreeStatus } from './types'

/**
 * Contrato IPC único. Todo canal se declara aquí con sus tipos; main, preload y
 * renderer lo consumen. Nunca se usan strings de canal fuera de este archivo.
 */

/** renderer → main, con respuesta (ipcMain.handle / ipcRenderer.invoke). */
export interface IpcInvokeMap {
  'agents:list': { req: []; res: AgentDef[] }
  'project:list': { req: []; res: { projects: Project[]; workspaces: Workspace[] } }
  /** Abre el selector de carpeta; `null` si el usuario cancela. */
  'project:add': { req: []; res: { project: Project; workspace: Workspace } | null }
  /** Olvida el proyecto; borra solo sus worktrees sin cambios y devuelve las rutas de los que se conservan en disco. */
  'project:remove': { req: [id: string]; res: { keptWorktrees: string[] } }
  /** Abre un proyecto por ruta, sin diálogo (quick open, CLI, pruebas); si ya existe devuelve el mismo. */
  'project:addPath': { req: [path: string]; res: { project: Project; workspace: Workspace } }
  /** Carpetas que empiezan por lo escrito (`~/priv` → `~/private`), para abrir un proyecto por ruta desde el quick open; solo dentro del home. */
  'project:suggestPaths': { req: [input: string]; res: string[] }
  /** Oculta o muestra el proyecto en el sidebar (§3.5c); sus sesiones no se tocan. */
  'project:setHidden': { req: [projectId: string, hidden: boolean]; res: void }
  /** Subcarpetas de una ubicación de este Mac (hasta dos niveles) que se pueden registrar; los subproyectos (con manifiesto) primero. */
  'project:subfolders': { req: [locationId: string]; res: FolderCandidate[] }
  /** Registra una subcarpeta (`rel`, relativa a la ubicación) como ubicación más del proyecto; si ya estaba devuelve la misma. */
  'project:addFolder': { req: [locationId: string, rel: string]; res: Workspace }
  /**
   * Olvida una ubicación; error humano si tiene worktrees, o sesiones vivas sin `closeSessions`. Con
   * `closeSessions` (el usuario lo confirmó) las cierra antes: nada se mata en silencio.
   */
  'project:removeFolder': { req: [workspaceId: string, closeSessions?: boolean]; res: void }
  /** Proyecto nuevo con una carpeta de un host remoto (§3.26); `path` absoluta o con `~`. Si ya es ubicación de alguno, ese. */
  'project:addRemote': { req: [hostId: string, path: string]; res: { project: Project; workspace: Workspace } }
  /** Suma una ubicación (carpeta de este Mac o de un host) a un proyecto (§3.5c). */
  'project:addLocation': { req: [projectId: string, location: { path: string; host?: string }]; res: Workspace }
  /** Olvida una ubicación cualquiera (como `project:removeFolder`). La última deja el proyecto vacío. */
  'project:removeLocation': { req: [workspaceId: string, closeSessions?: boolean]; res: void }
  /** Proyecto vacío, solo con nombre ("Nuevo proyecto", §3.5c); sus carpetas se suman con `project:addLocation`. */
  'project:create': { req: [name: string]; res: Project }
  /** Sube (`-1`) o baja (`1`) una ubicación dentro de su proyecto. */
  'project:moveLocation': { req: [workspaceId: string, delta: -1 | 1]; res: void }
  'project:rename': { req: [projectId: string, name: string]; res: void }
  /** Junta `sourceId` dentro de `targetId` (ubicaciones y worktrees); las sesiones siguen donde estaban. */
  'project:merge': { req: [targetId: string, sourceId: string]; res: void }

  /* hosts remotos por SSH (§3.26) */
  'host:list': { req: []; res: { hosts: RemoteHost[]; statuses: HostStatus[] } }
  /** Hosts de `~/.ssh/config` (sin comodines) para importar. */
  'host:sshConfig': { req: []; res: SshConfigHost[] }
  /** Registra un host (alias de ~/.ssh/config o usuario@host) y lo conecta. */
  'host:add': { req: [name: string, target: string]; res: { host: RemoteHost; status: HostStatus } }
  /** Olvida el host; error humano si algún proyecto tiene ubicaciones ahí. */
  'host:remove': { req: [hostId: string]; res: void }
  'host:connect': { req: [hostId: string]; res: HostStatus }
  'host:disconnect': { req: [hostId: string]; res: void }
  /** Repite el preflight de un host conectado (herramientas recién instaladas, §3.26). */
  'host:rescan': { req: [hostId: string]; res: HostStatus }
  /** Completa rutas de carpetas del host (`~`, `~/x`, absolutas). */
  'host:suggestPaths': { req: [hostId: string, input: string]; res: string[] }
  /** Reenvía `localhost:<remotePort>` del host del workspace a este Mac (§3.26); devuelve el puerto local. */
  'host:forwardPort': { req: [workspaceId: string, remotePort: number]; res: { localPort: number } }
  /**
   * Servidor de lenguaje para un archivo del workspace (§3.19b): lo lanza o devuelve el vivo. `client`
   * identifica esta carga del renderer: uno distinto (recarga) relanza los servidores, porque el
   * `initialize` ya se gastó con el cliente anterior. `null` si no hay servidor para ese archivo.
   */
  'lsp:start': { req: [workspaceId: string, path: string, client: string]; res: LspServerInfo | null }
  'session:create': { req: [input: SessionCreateInput]; res: SessionInfo }
  'session:list': { req: []; res: SessionInfo[] }
  /** Cuántas sesiones se revivieron al arrancar tras un reinicio (§3.10b) y cuántas retomaron su conversación; `null` si ninguna. Solo responde una vez. */
  'session:revived': { req: []; res: ReviveSummary | null }
  /** Salida reciente de una sesión que ya existía (daemon): se escribe en xterm antes de la salida en vivo. */
  'session:history': { req: [id: string]; res: string }
  /** Proceso en primer plano de cada terminal viva (`{ [sessionId]: nombre }`), para saber si el agente ya salió. */
  'session:foreground': { req: []; res: Record<string, string> }
  /** Procesos que escuchan en puertos TCP locales, con repo, rama y sesión de omni de la que salieron (§3.24). */
  'ports:list': { req: []; res: ListeningProcess[] }
  /** Detiene el proceso `pid` si sigue escuchando en `port`: SIGTERM a su trabajo y SIGKILL si no cae (§3.24). */
  'ports:stop': { req: [pid: number, port: number]; res: PortStopResult }
  /** Estado guardado al cerrar (layout, navegadores); `null` si no hay. Main ya recreó los navegadores con sus ids. */
  'state:load': { req: []; res: AppState | null }
  /** Mata todas las sesiones, apaga el daemon y cierra la app ("Apagar todo"). */
  'app:shutdown': { req: []; res: void }
  /** El daemon de terminales es de otro build (la app empaquetada lo conserva para no matar sesiones, §3.10c). */
  'daemon:status': { req: []; res: { outdated: boolean } }
  /** Cambia el daemon por uno de este build y revive las sesiones con su mismo id; luego recarga la ventana. */
  'daemon:upgrade': { req: []; res: void }
  /* navegador embebido: `id` es el id de la sesión de agente `browser` */
  'browser:navigate': { req: [id: string, url: string]; res: void }
  'browser:back': { req: [id: string]; res: void }
  'browser:forward': { req: [id: string]; res: void }
  'browser:reload': { req: [id: string]; res: void }
  'browser:stop': { req: [id: string]; res: void }
  'browser:state': { req: [id: string]; res: BrowserState }
  /**
   * DevTools de Chromium ACOPLADAS en el pane (otra vista nativa a la que el renderer le manda
   * `browser:devtoolsBounds`); `on: false` las cierra. Reemplaza a la consola propia.
   */
  'browser:devtools': { req: [id: string, on: boolean]; res: void }
  /** Últimas líneas de consola de la página (`nivel: texto`), solo para adjuntarlas al agente. */
  'browser:consoleTail': { req: [id: string, lines: number]; res: string[] }
  /* worktrees y revisión (§3.15, §3.16) */
  /** Crea un worktree del proyecto (rama `omni/<name>`); con `issue`, el nombre sale del título. Devuelve su workspace. */
  /** `locationId`: la ubicación (repo) de la que sale; sin ella, la principal del proyecto. */
  'worktree:create': { req: [projectId: string, opts: { name?: string; issue?: number; locationId?: string }]; res: Workspace }
  /** Borra el worktree y su rama (`--force`). */
  'worktree:remove': { req: [workspaceId: string]; res: void }
  /** `fresh` salta la cache de 5 s (el disparo de tests automáticos lo necesita). */
  'worktree:status': { req: [workspaceId: string, fresh?: boolean]; res: WorktreeStatus }
  /** Corre el `testCommand` del proyecto en el worktree ahora; el resultado llega por `worktree:changed`. */
  'worktree:runTests': { req: [workspaceId: string]; res: void }
  /** Con `locationId`, el comando de esa carpeta (manda sobre el del proyecto en sus worktrees, §3.5c). */
  'project:setTestCommand': { req: [projectId: string, command: string | null, locationId?: string]; res: void }
  /** Nombre visible de una carpeta del proyecto; la ruta no cambia. */
  'project:renameLocation': { req: [locationId: string, name: string]; res: void }
  /** `gh issue view` en el repo del proyecto. */
  'git:issue': { req: [projectId: string, number: number]; res: IssueInfo }
  /** Diff del worktree contra su base, o contra otra rama (`base`, p. ej. la de otro candidato de broadcast). */
  'git:diff': { req: [workspaceId: string, base?: string]; res: WorkspaceDiff }
  /* broadcast (§3.18): main solo persiste las rondas; crear worktrees y lanzar agentes lo orquesta el renderer */
  'broadcast:list': { req: []; res: Broadcast[] }
  'broadcast:save': { req: [rounds: Broadcast[]]; res: void }
  /** Squash-merge del worktree en el workspace local y limpieza; error humano si el local está sucio o hay conflicto. */
  'git:merge': { req: [workspaceId: string]; res: { commit: string } }
  'git:discard': { req: [workspaceId: string]; res: void }
  /* documentos: editor y vista previa (§3.19, §3.20) */
  /** Abre un pane de documento; la sesión resultante tiene `agent: kind` y `args: [path]`. */
  'doc:open': { req: [workspaceId: string, path: string, kind: DocKind]; res: SessionInfo }
  /**
   * Lee un archivo de texto del workspace (máx. 2 MB; error humano si es binario o está fuera). Los
   * archivos viajan como `(workspaceId, ruta)`: la ruta es del host del workspace, que puede no ser
   * este Mac (§3.26), y dos hosts pueden tener la misma ruta.
   */
  'file:read': { req: [workspaceId: string, path: string]; res: { text: string; mtime: number } }
  'file:write': { req: [workspaceId: string, path: string, text: string]; res: { mtime: number } }
  /** Vigila un archivo; `file:changed` llega con cada cambio en disco hasta `file:unwatch`. */
  'file:watch': { req: [workspaceId: string, path: string]; res: void }
  'file:unwatch': { req: [workspaceId: string, path: string]; res: void }
  /** Entradas de un directorio del workspace (sin ocultos ni ignorados del índice), carpetas primero; `truncated` si se cortó en el tope. */
  'files:tree': { req: [workspaceId: string, dir: string]; res: { entries: TreeEntry[]; truncated: boolean } }
  /**
   * Errores de `tsc` y `eslint` del propio proyecto sobre un archivo del workspace. Solo corre los
   * binarios instalados en su `node_modules/.bin` (nunca descarga nada); `tools` dice cuáles corrieron.
   */
  'diagnostics:check': { req: [workspaceId: string, path: string, skip?: Array<'tsc' | 'eslint'>]; res: { diagnostics: CodeDiagnostic[]; tools: Array<'tsc' | 'eslint'> } }
  /** Texto del archivo en la base (HEAD del local, o la base del worktree); `null` si es nuevo. */
  'git:fileAtBase': { req: [workspaceId: string, path: string]; res: string | null }
  /* socket de control (§3.21): el renderer devuelve el resultado de un comando reenviado por main */
  'app:commandResult': { req: [id: number, result: ControlResult]; res: void }
  /** Líneas `claude mcp add omni …` y `claude mcp add omni-browser …` con las rutas reales de este omni. */
  'mcp:command': { req: []; res: string }
  /* dictado (§3.22) */
  'whisper:status': { req: []; res: WhisperStatus }
  /** Baja `ggml-base.bin` a `~/.config/omni/models/`; progreso por `whisper:progress`. */
  'whisper:downloadModel': { req: []; res: WhisperStatus }
  /** PCM 16 kHz mono int16 (ArrayBuffer) → texto. `OMNI_FAKE_WHISPER` devuelve ese texto sin binario. */
  'whisper:transcribe': { req: [pcm: ArrayBuffer]; res: { text: string; ms: number } }
  /* costo (§3.17) */
  'cost:summary': { req: []; res: CostSummary }
  /** Consumo de hoy y topes del plan de cada agente (§3.25); `force` vuelve a pedir los topes en vivo. */
  'usage:get': { req: [force?: boolean]; res: UsageReport }
  /* quick open: archivos y detalle de workspace */
  /** Búsqueda difusa de archivos en todos los workspaces (índice en main, ignora node_modules, .git, out, dist…). */
  'files:search': { req: [query: string, limit?: number]; res: FileHit[] }
  /** Rama git del workspace o `null` si no es un repo. */
  'workspace:branch': { req: [workspaceId: string]; res: string | null }
  /** Muestra el archivo en el Finder. */
  /** Guarda bytes soltados sin ruta en disco (p. ej. un arrastre que solo trae contenido) y devuelve la ruta temporal. */
  'file:saveDrop': { req: [name: string, data: Uint8Array]; res: string }
  /** Soltado sobre una terminal remota (§3.26): sube los bytes a `~/.omni/drops/` del host y devuelve esa ruta. */
  'file:uploadDrop': { req: [workspaceId: string, name: string, data: Uint8Array]; res: string }
  /** Imagen del portapapeles del Mac como PNG, o `null` si no hay (⌃V en una terminal remota: el agente del VPS no ve este portapapeles). */
  'clipboard:readImage': { req: []; res: Uint8Array | null }
  'file:reveal': { req: [path: string]; res: void }
  /** Abre el archivo con la app por defecto del sistema. */
  'file:open': { req: [path: string]; res: void }
  /** Abre una URL en el navegador del sistema; solo `http:`/`https:` (enlaces externos de la vista previa). */
  'shell:openExternal': { req: [url: string]; res: void }
  /* notificaciones nativas (§3.14) */
  /** Muestra una notificación del sistema si la ventana no tiene el foco; main agrupa por sesión y tipo. */
  /** Aviso de ejemplo desde Ajustes, sin filtros ni agrupación: dice si macOS lo mostró o por qué no. */
  'notify:test': { req: []; res: NotifyTestResult }
  'notify:show': { req: [sessionId: string, title: string, body: string, kind: NotifyKind, onScreen: boolean, subtitle?: string]; res: void }
  /** Retira las notificaciones pendientes de esa sesión (se respondió o se entró al pane). */
  'notify:dismiss': { req: [sessionId: string]; res: void }
  /* to-do */
  'todo:list': { req: []; res: Todo[] }
  /** Reemplaza la lista completa (el renderer es el dueño del estado; main solo persiste). */
  'todo:save': { req: [todos: Todo[]]; res: void }
  /* perfiles y cookies */
  'browser:profiles': { req: []; res: BrowserProfile[] }
  'browser:profileCreate': { req: [name: string]; res: BrowserProfile }
  'browser:profileDelete': { req: [id: string]; res: void }
  /** Cambia el perfil de una vista: se recrea con la partición nueva en la misma URL. */
  'browser:profileSet': { req: [id: string, profileId: string]; res: void }
  /** Importa cookies de otro navegador al perfil de esa vista; `path` solo con `file`. */
  'browser:importCookies': { req: [id: string, source: CookieImportSource, path?: string]; res: CookieImportResult }
  /** Diálogo nativo para elegir un archivo de cookies (cookies.txt de Netscape o JSON); `null` si cancela. */
  'browser:pickCookieFile': { req: []; res: string | null }
  /** Viewport fijo (centrado en el hueco) o `null` = responsive. Sustituye a `browser:mobile`. */
  'browser:viewport': { req: [id: string, preset: ViewportPreset | null]; res: void }
  /** Borra cookies y storage del perfil de esa vista. */
  'browser:clearData': { req: [id: string]; res: void }
  /** PNG de la página (o de `rect`, en px CSS de la página) en ~/.config/omni/captures. También va al portapapeles. */
  'browser:capture': { req: [id: string, rect?: Rect]; res: Capture }
  /* modo elemento (canvas 07): main inyecta un script de solo lectura que dibuja letras sobre los elementos visibles */
  /** Enciende el modo elemento: devuelve los hints dibujados. Mientras está activo, main reenvía TODAS las teclas de la página. */
  'browser:elements': { req: [id: string]; res: ElementHint[] }
  /** Elige un elemento por su letra: lo resalta, devuelve su detalle (html, css) y deja el modo elemento apagado. */
  'browser:elementPick': { req: [id: string, hint: string]; res: BrowserElement | null }
  /** Apaga el modo elemento y borra los hints. */
  'browser:elementsClear': { req: [id: string]; res: void }
  /** Guarda un PNG (data URL) recortado en el renderer; mismo destino y portapapeles que `browser:capture`. */
  'capture:save': { req: [dataUrl: string]; res: Capture }
  /** Copia otra vez al portapapeles la imagen de una captura guardada (solo rutas de la carpeta de capturas). */
  'capture:copyImage': { req: [path: string]; res: void }
  /** PNG de la vista como data URL, sin guardar ni tocar el portapapeles: para la captura de área (se guarda solo el recorte, con `capture:save`). */
  'browser:snapshot': { req: [id: string]; res: string }
  'settings:get': { req: []; res: Settings }
  /** Aplica un parche validado y devuelve los ajustes completos resultantes. */
  'settings:set': { req: [patch: Partial<Settings>]; res: Settings }
}

/** renderer → main, sin respuesta (ipcMain.on / ipcRenderer.send). */
export interface IpcSendMap {
  /** Muestra la ruta en el Finder. */
  'app:reveal': [path: string]
  'session:write': [id: string, data: string]
  /** Un mensaje JSON-RPC (sin cabeceras) al servidor de lenguaje; main le pone el `Content-Length`. */
  'lsp:send': [serverId: string, message: string]
  /** El renderer ya no tiene archivos abiertos con ese servidor: main lo apaga. */
  'lsp:stop': [serverId: string]
  'session:resize': [id: string, cols: number, rows: number]
  'session:kill': [id: string]
  /** El renderer guarda su estado (debounced) cada vez que cambia el layout. */
  'state:save': [state: AppState]
  /** Dónde pintar la vista nativa; `null` = ocultarla (pane fuera de pantalla u overlay abierto). */
  'browser:bounds': [id: string, rect: Rect | null]
  /** Navegadores con pane montado; main esconde las vistas del resto (red de seguridad de `browser:bounds`). */
  'browser:mounted': [ids: string[]]
  /** El renderer quiere el teclado de vuelta (p. ej. tras un atajo): main enfoca su webContents. */
  'browser:blur': [id: string]
  /** Espejo de `browser:blur`: el renderer quiere que la página tome el teclado (⏎ en la barra de URL, entrar al pane). */
  'browser:focusView': [id: string]
  /** Modo área con teclado (H J K L) o elemento activo en el renderer: main reenvía todas las teclas de la página mientras dure. */
  'browser:keyGrab': [id: string, on: boolean]
  /** Dónde pintar las DevTools acopladas; `null` las esconde (overlay abierto, pane fuera de pantalla). */
  'browser:devtoolsBounds': [id: string, rect: Rect | null]
}

/** main → renderer (webContents.send / ipcRenderer.on). */
export interface IpcEventMap {
  'session:data': [id: string, data: string]
  'session:exit': [id: string, code: number]
  /** Mensaje JSON-RPC del servidor de lenguaje (cuerpo sin cabeceras). */
  'lsp:message': [serverId: string, message: string]
  /** El servidor murió (crash, binario roto): `error` es un texto humano o `null` si salió solo. */
  'lsp:exit': [serverId: string, error: string | null]
  'settings:changed': [settings: Settings]
  'browser:state': [id: string, state: BrowserState]
  /** El proceso de la página se cayó (`reason` de Chromium) y main la está recargando. */
  'browser:crashed': [id: string, reason: string]
  /** La página embebida tenía el foco y recibió una tecla con ⌘ (o el prefijo): el renderer la resuelve contra su keymap. */
  'browser:key': [id: string, key: ForwardedKey]
  /** La página embebida tomó o soltó el foco del teclado (clic dentro / fuera). */
  'browser:focus': [id: string, focused: boolean]
  /** La ventana de omni ganó o perdió el foco del sistema (es la ventana activa), tenga el teclado el renderer o la página de un navegador (§3.14). */
  'window:focus': [focused: boolean]
  /** El usuario hizo clic en una notificación nativa de esa sesión: entrar a su pane (§3.14). */
  'notify:activate': [sessionId: string]
  /** Un worktree se creó, se borró o cambió su estado (tests, diff): el renderer vuelve a pedir `project:list` y `worktree:status`. */
  'worktree:changed': [workspaceId: string | null]
  /** Cambió el costo acumulado del día. */
  'cost:changed': [summary: CostSummary]
  /** Un archivo vigilado cambió en disco (`mtime` nuevo). */
  'file:changed': [workspaceId: string, path: string, mtime: number]
  /** Cambió el estado de la conexión a un host (§3.26). */
  'host:status': [status: HostStatus]
  /** Sesiones que main creó sin que el renderer las pidiera (remotas revividas al conectar un host): se abren en su tab. */
  'session:added': [sessions: SessionInfo[]]
  /** Comando de `app.sock` para el renderer (§3.21); responde con `app:commandResult`. */
  'app:command': [command: ControlCommand]
  /** Main escribió en esa sesión por el socket de control (`send` ok): la franja del pane lo avisa. */
  'control:sent': [sessionId: string, from: string]
  /** Progreso de la descarga del modelo de whisper (0–1). */
  'whisper:progress': [fraction: number]
}

/** Puente tipado que el preload expone como `window.omni`. */
export interface OmniBridge {
  /** `true` solo si la app arrancó con `OMNI_CDP_PORT` (pruebas e2e): habilita `window.__omniImport`. */
  readonly testMode: boolean
  /** Ruta en disco de un `File` soltado (`webUtils.getPathForFile`); vacía si no tiene. */
  pathForFile(file: File): string
  invoke<K extends keyof IpcInvokeMap>(channel: K, ...args: IpcInvokeMap[K]['req']): Promise<IpcInvokeMap[K]['res']>
  send<K extends keyof IpcSendMap>(channel: K, ...args: IpcSendMap[K]): void
  on<K extends keyof IpcEventMap>(channel: K, cb: (...args: IpcEventMap[K]) => void): () => void
}
