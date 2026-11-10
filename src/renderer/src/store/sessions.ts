import { create } from 'zustand'
import type { AgentDef, AgentId, AppState, FolderCandidate, Project, ReviveSummary, SessionInfo, Workspace } from '@shared/types'
import { detectPermission, hasClaudeDialog, hasTrustPrompt } from '@/core/permission-patterns'
import { stripAnsi } from '@/core/terminal-text'
import { omni } from '@/lib/omni'
import { disposeTerminal, screenLines } from '@/panes/terminal/terminal-host'
import { activeTabOf, focusedSessionId, leaves, tabsOf, useLayout, type Leaf, type Tab } from './layout'
import { forgetPasteMode, notePasteMode } from './paste-mode'
import { pruneState } from './persist'
import { useUi } from './ui'

/** `question`: el agente pidió atención (BEL) y nadie le ha escrito desde entonces. */
export type SessionStatus = 'question' | 'working' | 'idle'

interface Activity {
  lastOutput: number
}

/**
 * Fila navegable del sidebar: proyecto, workspace, tab o pane. Los panes solo se listan cuando el tab
 * tiene más de uno (como `choose-tree` en tmux); con un solo pane el tab basta.
 */
export type Row =
  | { key: string; kind: 'project'; project: Project }
  | { key: string; kind: 'workspace'; workspace: Workspace }
  | { key: string; kind: 'tab'; tab: Tab; index: number }
  | { key: string; kind: 'pane'; tab: Tab; leaf: Leaf; index: number }

interface SessionState {
  agents: AgentDef[]
  projects: Project[]
  workspaces: Workspace[]
  sessions: SessionInfo[]
  activity: Record<string, Activity>
  /** Título que el programa escribió por OSC (Claude Code y Codex lo hacen). */
  titles: Record<string, string>
  /** Sesiones que sonaron la campana y esperan al usuario. */
  attention: Record<string, true>
  /** Sesiones ocupadas por algo que no es salida de PTY (el navegador mientras carga). */
  busy: Record<string, true>
  /**
   * Estado que el propio agente anuncia en el título (Claude Code: `✳` en reposo, spinner trabajando).
   * Cuando existe manda sobre la ventana de salida: un redibujo no es trabajo y una tool callada sí lo es.
   */
  declared: Record<string, DeclaredState>
  /** Último artifact de Claude que imprimió cada sesión: la franja ofrece abrirlo en el navegador de omni. */
  artifacts: Record<string, string>
  /**
   * Última URL local (`http://localhost:5173/`) que anunció cada terminal remota: el servidor corre en el
   * VPS, así que la franja ofrece reenviar el puerto y abrirlo (§3.26). Las locales usan Puertos.
   */
  remoteUrls: Record<string, string>
  /** Última vez que el pane de la sesión estuvo en pantalla con el tab activo (§3.14). */
  seen: Record<string, number>
  /** Sesiones que terminaron de trabajar con el pane fuera de pantalla y nadie ha mirado desde entonces. */
  unread: Record<string, true>
  /** Proceso en primer plano de cada terminal (`zsh` si el agente ya salió), refrescado cada `FOREGROUND_POLL_MS`. */
  foreground: Record<string, string>
  /** Workspace visible y destino de lo nuevo. */
  currentWorkspaceId: string | null
  /** Fila del sidebar bajo el cursor. */
  cursor: string | null
  /**
   * Sesiones que ya existían antes de este arranque del renderer (vinieron de `session:list` en `init`):
   * su xterm pide `session:history` al abrirse por primera vez.
   */
  restored: Record<string, true>
  /** `init` terminó: el layout ya está restaurado y se puede persistir (antes, se pisaría el archivo con nada). */
  ready: boolean

  init(): Promise<void>
  /** Pide a main el proceso en primer plano de cada terminal; solo actualiza si cambió algo. */
  refreshForeground(): Promise<void>
  /** Carga real; `init` la serializa. No llamar directo. */
  initOnce(): Promise<void>
  /** Crea el PTY. Dónde se muestra lo decide el comando que llama (tab o split). `args` son flags extra para el CLI del agente. */
  create(agent: AgentId, args?: string[]): Promise<SessionInfo | null>
  addProject(): Promise<void>
  /**
   * Abre (o reutiliza) el proyecto de esa carpeta sin diálogo (quick open, CLI, MCP) y lo deja en
   * pantalla: workspace actual, cursor sobre él y su tab activo si ya tenía. Si era un proyecto oculto,
   * enciende "Mostrar proyectos ocultos" (se pidió explícitamente). Main valida la ruta.
   */
  openProjectPath(path: string): Promise<{ project: Project; workspace: Workspace }>
  /**
   * Oculta o muestra el proyecto (§3.5c). Al ocultar el que está en pantalla, la flota pasa al primer
   * proyecto visible: lo oculto no se queda a la vista.
   */
  setProjectHidden(id: string, hidden: boolean): Promise<void>
  /** Subcarpetas de una ubicación local que se pueden registrar (subproyectos primero), para "Agregar subcarpeta". */
  folderCandidates(locationId: string): Promise<FolderCandidate[]>
  /** Registra la subcarpeta `rel` de la ubicación como ubicación más (§3.5c), la deja como actual y la devuelve. */
  addFolder(locationId: string, rel: string): Promise<Workspace>
  /** Olvida la ubicación; main se niega si aún tiene sesiones o worktrees (el error sube a quien llama). */
  removeFolder(workspaceId: string, closeSessions?: boolean): Promise<void>
  /** Sube (`-1`) o baja (`1`) la ubicación dentro de su proyecto; el cursor la sigue. */
  moveLocation(workspaceId: string, delta: -1 | 1): Promise<void>
  /** Proyecto vacío con ese nombre ("Nuevo proyecto", §3.5c); queda bajo el cursor y lo devuelve. */
  createProject(name: string): Promise<Project>
  /** Nombre del grupo (§3.5c): independiente de sus carpetas. */
  renameProject(projectId: string, name: string): Promise<void>
  /** Nombre visible de una carpeta del proyecto (§3.5c); la ruta no cambia. */
  renameLocation(locationId: string, name: string): Promise<void>
  /** Mete `sourceId` dentro de `targetId` (ubicaciones y worktrees); el cursor queda en el destino. */
  mergeProjects(targetId: string, sourceId: string): Promise<void>
  /** Si el workspace actual es de un proyecto oculto y no se están mostrando, pasa al primero visible. */
  leaveHidden(): void
  /** Quita el proyecto; devuelve las rutas de los worktrees con cambios que main conserva en disco (§3.15). */
  removeProject(id: string): Promise<string[]>
  /**
   * Vuelve a pedir `project:list` (un worktree se creó o se borró, cambió el `testCommand`, §3.15).
   * Si el workspace actual o el cursor ya no existen, caen al primer workspace.
   */
  reloadProjects(): Promise<void>
  setCursor(key: string): void
  moveCursor(delta: number): void
  /** Pone el cursor del sidebar sobre la fila de la sesión: su pane si el tab tiene varios, si no su tab. */
  syncCursor(sessionId: string): void
  /** Único punto para activar un tab: layout, cursor y workspace actual se mueven juntos. */
  activateTab(tabId: string): void
  /** Activa el tab, le da el foco del layout al pane y deja el cursor sobre la fila del pane. */
  activatePane(tabId: string, paneId: string): void
  setWorkspace(id: string): void
  setTitle(id: string, title: string): void
  markAttention(id: string): void
  clearAttention(id: string): void
  /** El pane está (o acaba de estar) en pantalla: anota el momento y quita el "sin leer". */
  markSeen(id: string): void
  /**
   * Un chunk de salida de la PTY (`session:data`): anota actividad (con throttle), detecta la campana en
   * crudo (BEL → pregunta, aunque el pane no esté en pantalla) y arma el temporizador de reposo.
   */
  onData(id: string, data: string): void
  /**
   * La sesión lleva `WORKING_WINDOW_MS` callada: pasó de `working` a `idle`. Queda `sin leer` si hubo
   * salida después de la última vez que se vio y no es la sesión con foco del layout.
   */
  settle(id: string): void
  /** La sesión terminó (`session:exit`): limpia tab, terminal, temporizadores y todo su estado. */
  onExit(id: string): void
  setBusy(id: string, busy: boolean): void
  /** Estado que el agente anunció en su título; `null` lo olvida y vuelve a mandar la ventana de salida. */
  setDeclared(id: string, state: DeclaredState | null): void
  kill(id: string): void
}

/** Sin salida en este lapso, la sesión se considera en reposo. */
export const WORKING_WINDOW_MS = 4000
/**
 * Una ráfaga de salida más corta que esto no es trabajo: es la TUI redibujándose (la ventana perdió el
 * foco, cambió de tamaño o se reconectó). No deja la sesión "sin leer" ni dispara "terminó" (§3.14).
 */
export const MIN_WORK_MS = 1500
/** Estado que un agente anuncia en el título de la terminal. */
export type DeclaredState = 'working' | 'idle'
/** Título por OSC 0 o 2, cerrado con BEL o ST. */
const TITLE_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g
/** Claude Code pone `✳` delante del título en reposo y un spinner (◐◓◑◒, braille o ✢✶✻✽) mientras trabaja. */
const IDLE_GLYPH = /^✳/u
const WORKING_GLYPH = /^[◐◓◑◒✢✶✻✽\u2800-\u28ff]/u

/** Agentes que anuncian su estado en el título y lo animan mientras trabajan (un cuadro cada ~0,5 s). */
const ANNOUNCING_AGENTS = new Set<string>(['claude'])

/**
 * Estado de partida de sesiones que ya existían (recarga del renderer, reinstalación, remotas revividas):
 * su último título se perdió y la pantalla redibujada no es trabajo. Un agente que anuncia arranca en
 * reposo; si en verdad trabaja, el siguiente cuadro del spinner lo corrige al toque. Lo ya anunciado se respeta.
 * Exportada para tests.
 */
export function seedDeclared(sessions: Pick<SessionInfo, 'id' | 'agent'>[], current: Record<string, DeclaredState>): Record<string, DeclaredState> {
  const seeded = sessions.filter((x) => ANNOUNCING_AGENTS.has(x.agent) && !current[x.id]).map((x) => [x.id, 'idle' as const])
  return seeded.length === 0 ? current : { ...current, ...Object.fromEntries(seeded) }
}

/**
 * Estado anunciado en el último título del chunk: `undefined` si el chunk no cambia el título, `null`
 * si el título nuevo no anuncia nada (salió el agente, otro programa) y deja de mandar.
 */
export function scanDeclaredState(data: string): DeclaredState | null | undefined {
  let last: string | undefined
  for (const m of data.matchAll(TITLE_RE)) last = m[1]
  if (last === undefined) return undefined
  if (IDLE_GLYPH.test(last)) return 'idle'
  return WORKING_GLYPH.test(last) ? 'working' : null
}

/** Enlace a un artifact de Claude (ver `isClaudeArtifact` en `links.ts`, que decide cómo se abre). */
const ARTIFACT_URL = /https:\/\/(?:www\.)?claude\.(?:ai\/(?:code\/)?artifacts?\/|site\/artifacts\/)[A-Za-z0-9_\-/]+/g

/** Último enlace a un artifact de Claude en el chunk (texto plano u OSC 8), o `null`. Exportada para tests. */
export function lastArtifactUrl(data: string): string | null {
  let last: string | null = null
  for (const m of data.matchAll(ARTIFACT_URL)) last = m[0].replace(/\/+$/, '')
  return last
}

const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"<>)\]\x1b\x07]*)?/g
const ANSI_SEQ = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/**
 * Última URL local con puerto del chunk (`➜ Local: http://localhost:5173/app/`), sin colores y con
 * `0.0.0.0` como `localhost`; `null` si no hay. Exportada para tests.
 */
export function lastLocalUrl(data: string): string | null {
  let last: string | null = null
  for (const m of data.replace(ANSI_SEQ, '').matchAll(LOCAL_URL)) last = m[0].replace(/[.,;:]+$/, '').replace('0.0.0.0', 'localhost')
  return last
}

/** Una URL local con puerto en la salida: probablemente un dev server que acaba de levantar. */
const LOCAL_URL_HINT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/
let portsTimer: ReturnType<typeof setTimeout> | undefined
/** Un refresco de puertos 1,5 s después del último anuncio (el server tarda un poco en escuchar). */
function schedulePortsRefresh(): void {
  clearTimeout(portsTimer)
  // Import diferido: el store de puertos importa este.
  portsTimer = setTimeout(() => void import('./ports').then((m) => m.usePorts.getState().refresh()), 1500)
}

/** Campana de la terminal: el agente pide atención. */
const BEL = '\x07'
/** Arranque de una secuencia OSC (`ESC ]`); termina en BEL o en ST (`ESC \\`). */
const OSC_START = '\x1b]'
const ST = '\x1b\\'

/**
 * Recorre un chunk buscando una campana de verdad: el BEL que cierra una secuencia OSC (los prompts
 * ponen el título así) no cuenta. `inOsc` es el estado que arrastra la sesión del chunk anterior: un
 * OSC partido en dos chunks (`ESC ] 0 ; …` | `… BEL`) no debe marcar pregunta; se devuelve actualizado.
 */
export function scanBell(data: string, inOsc: boolean): { bell: boolean; inOsc: boolean } {
  let bell = false
  let i = 0
  while (i < data.length) {
    if (inOsc) {
      const bel = data.indexOf(BEL, i)
      const st = data.indexOf(ST, i)
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
      if (end === -1) return { bell, inOsc: true }
      i = end + (end === bel ? 1 : ST.length)
      inOsc = false
    } else {
      const osc = data.indexOf(OSC_START, i)
      const bel = data.indexOf(BEL, i)
      if (bel !== -1 && (osc === -1 || bel < osc)) {
        bell = true
        i = bel + 1
        continue
      }
      if (osc === -1) return { bell, inOsc: false }
      i = osc + OSC_START.length
      inOsc = true
    }
  }
  return { bell, inOsc }
}

/** `true` si el chunk entero trae una campana de verdad, ignorando los BEL que cierran una secuencia OSC. */
export function hasBell(data: string): boolean {
  return scanBell(data, false).bell
}
/**
 * Diálogo de confianza de Claude Code (§3.13): no suena BEL, así que se busca su marcador en la salida.
 * Buffer rodante crudo por sesión (`TRUST_BUFFER_CHARS`): se limpia de ANSI entero en cada chunk, así
 * una frase o una secuencia de escape partida entre dos chunks se ve completa.
 */
export const TRUST_BUFFER_CHARS = 16_000
/** Trozos que tienen que estar en el buffer crudo antes de pagar el strip de ANSI (una TUI repinta mucho). */
const TRUST_HINTS = ['trust', 'Accessing', 'confirm']
const trustBuffers = new Map<string, string>()
/** Sesiones con el marcador a la vista: se marca una vez por aparición, no en cada repintado del diálogo. */
const trustShown = new Set<string>()

/**
 * Acumula el chunk en el buffer rodante de la sesión y dice si el diálogo de confianza acaba de
 * aparecer: `true` solo en el chunk que lo completa; mientras siga en el buffer no se repite, y cuando
 * la salida posterior lo saca del buffer, una nueva aparición vuelve a contar.
 */
export function scanTrustPrompt(id: string, data: string): boolean {
  const buffer = ((trustBuffers.get(id) ?? '') + data).slice(-TRUST_BUFFER_CHARS)
  trustBuffers.set(id, buffer)
  const clean = TRUST_HINTS.some((h) => buffer.includes(h)) ? stripAnsi(buffer) : ''
  const shown = clean !== '' && (hasTrustPrompt(clean) || hasClaudeDialog(clean))
  if (!shown) {
    trustShown.delete(id)
    return false
  }
  if (trustShown.has(id)) return false
  trustShown.add(id)
  return true
}

/**
 * Pregunta en pantalla (§3.13): tras cada ráfaga de salida, cuando xterm ya pintó, se mira lo visible.
 * Un permiso o diálogo de un agente marca atención aunque no suene BEL (config del usuario, TUI a
 * pantalla completa). Una marca por aparición: la clave es el resumen detectado.
 */
export const SCREEN_CHECK_MS = 400
const SCREEN_LINES = 30
const screenTimers = new Map<string, ReturnType<typeof setTimeout>>()
const screenSeen = new Map<string, string>()

/** Resumen de la pregunta que el agente tiene en pantalla, o `null`. Puro sobre las líneas. */
export function screenQuestion(agent: AgentId, lines: readonly string[]): string | null {
  const p = detectPermission(agent, lines)
  if (p) return `${p.kind}:${p.summary}`
  return hasClaudeDialog(lines.join('\n')) ? 'dialog' : null
}

function forgetScreen(id: string): void {
  clearTimeout(screenTimers.get(id))
  screenTimers.delete(id)
  screenSeen.delete(id)
}

/** La actividad se anota como mucho cada tanto: evita re-render por cada chunk del PTY. */
const ACTIVITY_THROTTLE_MS = 500

export const rowKey = {
  project: (id: string) => `p:${id}`,
  workspace: (id: string) => `ws:${id}`,
  tab: (id: string) => `t:${id}`,
  pane: (leafId: string) => `pane:${leafId}`
}

/**
 * Fila que representa a un workspace: el `local` (única ubicación de su proyecto) no tiene fila propia,
 * lo representa su proyecto; con dos o más ubicaciones cada una tiene la suya (§3.5c).
 */
export const cursorOf = (w: Workspace): string => (w.kind === 'local' ? rowKey.project(w.projectId) : rowKey.workspace(w.id))

/** Suscripciones IPC vivas; `init` las repone (en dev, HMR vuelve a llamar a init). */
let unsubscribe: Array<() => void> = []
/** `init` en curso: StrictMode monta el efecto dos veces seguidas y ambas llamadas deben compartir la misma carga. */
let initInFlight: Promise<void> | null = null
let foregroundTimer: ReturnType<typeof setInterval> | undefined

/** Cada cuánto se pregunta qué proceso tiene cada terminal en primer plano. */
export const FOREGROUND_POLL_MS = 2000
/** Temporizador de reposo por sesión: se rearma con cada chunk y dispara `settle` al callarse. */
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Ráfaga de salida en curso por sesión: primer y último chunk desde el último reposo. */
const bursts = new Map<string, { start: number; last: number }>()
/** Sesiones cuyo último chunk terminó dentro de una secuencia OSC sin cerrar (`scanBell`). */
const oscOpen = new Set<string>()

/** La app está a la vista: vista Flota y la ventana con el foco del sistema. Fuera de eso, nadie mira ningún pane. */
/** Alguien mira la flota: vista Flota y ventana activa (la misma regla que marca un pane como visto). */
function appVisible(): boolean {
  const ui = useUi.getState()
  return ui.view === 'fleet' && ui.windowFocused
}

function clearSettleTimer(id: string): void {
  const t = settleTimers.get(id)
  if (t !== undefined) clearTimeout(t)
  settleTimers.delete(id)
}

export const useSessions = create<SessionState>((set, get) => ({
  agents: [],
  projects: [],
  workspaces: [],
  sessions: [],
  activity: {},
  titles: {},
  attention: {},
  busy: {},
  declared: {},
  artifacts: {},
  remoteUrls: {},
  seen: {},
  unread: {},
  foreground: {},
  currentWorkspaceId: null,
  cursor: null,
  restored: {},
  ready: false,

  init() {
    // Dos init concurrentes (StrictMode, HMR) abrían un tab por sesión cada uno: el guard de
    // "ya tiene tab" se evaluaba antes de que el otro hubiera abierto nada.
    if (!initInFlight) initInFlight = get().initOnce().finally(() => (initInFlight = null))
    return initInFlight
  },

  async refreshForeground() {
    const next = await omni.invoke('session:foreground').catch((): Record<string, string> => ({}))
    const prev = get().foreground
    const keys = Object.keys(next)
    if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k])) return
    set({ foreground: next })
    // El agente salió y volvió el shell: su pregunta pendiente ya no espera a nadie.
    get().sessions.forEach((x) => {
      if (agentExited(get(), x)) {
        screenSeen.delete(x.id)
        get().clearAttention(x.id)
        get().setDeclared(x.id, null)
      }
    })
  },

  async initOnce() {
    set({ ready: false })
    // `state:load` va antes de `session:list`: main recrea los navegadores guardados con su mismo id y,
    // pidiéndolo primero, la lista ya los trae aunque main los levante recién al leer el estado.
    const [agents, { projects, workspaces }, saved] = await Promise.all([
      omni.invoke('agents:list'),
      omni.invoke('project:list'),
      omni.invoke('state:load').catch((): AppState | null => null)
    ])
    const sessions = await omni.invoke('session:list')
    // Hosts remotos (§3.26) para el sidebar; un fallo no frena el arranque.
    void import('./hosts').then((m) => m.useHosts.getState().load()).catch(() => undefined)
    set({
      agents,
      projects,
      workspaces,
      sessions,
      restored: Object.fromEntries(sessions.map((x) => [x.id, true as const])),
      declared: seedDeclared(sessions, get().declared),
      currentWorkspaceId: sessions[0]?.workspaceId ?? workspaces[0]?.id ?? null,
      cursor: null
    })
    const first = firstVisibleWorkspace({ projects, workspaces }, useUi.getState().showHidden)
    set({ cursor: first ? cursorOf(first) : null })

    // Arranque en frío con estado guardado: el layout vuelve tal cual, menos las hojas cuya sesión ya no
    // existe. Si el layout ya tiene tabs (HMR, re-init) manda lo vivo, no el archivo.
    const lay = useLayout.getState()
    const restored = saved && lay.tabs.length === 0 ? pruneState(saved, sessions.map((x) => x.id), workspaces.map((w) => w.id)) : null
    if (restored) useLayout.setState({ tabs: restored.tabs, activeTab: restored.activeTab })
    // El título guardado vale hasta que el programa escriba otro: uno ya recibido en esta carga (HMR) gana.
    if (restored) set((s) => ({ titles: { ...restored.titles, ...s.titles } }))
    // Sesiones que sobrevivieron a una recarga del renderer (o que nadie guardó): cada una en su tab (si aún no lo tiene).
    sessions.filter((s) => !useLayout.getState().tabs.some((t) => leaves(t.root).some((l) => l.sessionId === s.id))).forEach((s) => useLayout.getState().openTab(s.workspaceId, s.id))

    if (restored) {
      const wsId = restored.currentWorkspaceId ?? get().currentWorkspaceId
      const active = wsId !== null ? activeTabOf(useLayout.getState(), wsId) : undefined
      // `activateTab` deja layout, cursor y workspace actual coherentes (y despliega el proyecto).
      if (active) get().activateTab(active.id)
      else if (wsId !== null) {
        const ws = workspaces.find((w) => w.id === wsId)
        set({ currentWorkspaceId: wsId, cursor: ws ? cursorOf(ws) : get().cursor })
      }
    }
    get().leaveHidden()
    set({ ready: true })
    // Tras un reinicio de la Mac main ya revivió las terminales de antes (§3.10b): se avisa una vez.
    void omni
      .invoke('session:revived')
      .then((r) => {
        const text = r ? reviveNotice(r) : null
        if (text) void import('./control').then((m) => m.useControl.getState().announce(text))
      })
      .catch(() => undefined)

    unsubscribe.forEach((off) => off())
    unsubscribe = []
    unsubscribe.push(omni.on('session:data', (id, data) => get().onData(id, data)))
    // Como en tmux: cuando el proceso termina, el pane desaparece.
    unsubscribe.push(omni.on('session:exit', (id) => get().onExit(id)))
    // Remotas revividas en segundo plano (§3.26): se suman con su pantalla de antes y cada una a su tab.
    unsubscribe.push(
      omni.on('session:added', (list) => {
        const fresh = list.filter((x) => !get().sessions.some((y) => y.id === x.id))
        if (fresh.length === 0) return
        set((st) => ({ sessions: [...st.sessions, ...fresh], declared: seedDeclared(fresh, st.declared), restored: { ...st.restored, ...Object.fromEntries(fresh.map((x) => [x.id, true as const])) } }))
        fresh.filter((x) => !useLayout.getState().tabs.some((t) => leaves(t.root).some((l) => l.sessionId === x.id))).forEach((x) => useLayout.getState().openTab(x.workspaceId, x.id))
      })
    )
    clearInterval(foregroundTimer)
    foregroundTimer = setInterval(() => void get().refreshForeground(), FOREGROUND_POLL_MS)
    void get().refreshForeground()
  },

  onExit(id) {
    {
      const victim = get().sessions.find((x) => x.id === id)
      const tabBefore = useLayout.getState().tabs.find((t) => leaves(t.root).some((l) => l.sessionId === id))
      useLayout.getState().closeSession(id)
      disposeTerminal(id)
      clearSettleTimer(id)
      bursts.delete(id)
      oscOpen.delete(id)
      trustBuffers.delete(id)
      forgetPasteMode(id)
    forgetScreen(id)
      trustShown.delete(id)
      set((s) => {
        const { [id]: _a, ...activity } = s.activity
        const { [id]: _t, ...titles } = s.titles
        const { [id]: _q, ...attention } = s.attention
        const { [id]: _b, ...busy } = s.busy
        const { [id]: _d, ...declared } = s.declared
        const { [id]: _ar, ...artifacts } = s.artifacts
        const { [id]: _ru, ...remoteUrls } = s.remoteUrls
        const { [id]: _s, ...seen } = s.seen
        const { [id]: _u, ...unread } = s.unread
        const { [id]: _r, ...restored } = s.restored
        const home = victim && s.workspaces.find((w) => w.id === victim.workspaceId)
        return { sessions: s.sessions.filter((x) => x.id !== id), activity, titles, attention, busy, declared, artifacts, remoteUrls, seen, unread, restored, cursor: cursorAfterExit(s.cursor, useLayout.getState(), tabBefore?.id, home) }
      })
      // Si no queda ninguna terminal en el workspace, el teclado vuelve a la lista.
      if (victim && !activeTabOf(useLayout.getState(), victim.workspaceId)) useUi.getState().setFocus('list')
    }
  },

  async create(agent, args) {
    const workspaceId = get().currentWorkspaceId ?? get().workspaces[0]?.id
    if (!workspaceId) return null
    let info: SessionInfo
    try {
      info = await omni.invoke('session:create', args && args.length > 0 ? { agent, workspaceId, args } : { agent, workspaceId })
    } catch (err) {
      // Sin esto el split o el launcher fallaban en silencio. Import diferido: control importa este store.
      const text = createErrorText(err)
      void import('./control').then((m) => m.useControl.getState().announce(text))
      return null
    }
    // Un navegador no tiene salida: su "trabajando" lo marca `busy` mientras carga.
    set((s) => ({
      sessions: [...s.sessions, info],
      currentWorkspaceId: workspaceId,
      activity: agent === 'browser' ? s.activity : { ...s.activity, [info.id]: { lastOutput: Date.now() } }
    }))
    return info
  },

  async addProject() {
    const added = await omni.invoke('project:add')
    if (!added) return
    set((s) => ({
      projects: s.projects.some((p) => p.id === added.project.id) ? s.projects : [...s.projects, added.project],
      workspaces: s.workspaces.some((w) => w.id === added.workspace.id) ? s.workspaces : [...s.workspaces, added.workspace],
      currentWorkspaceId: added.workspace.id,
      cursor: cursorOf(added.workspace)
    }))
  },

  async openProjectPath(path) {
    const { project, workspace } = await omni.invoke('project:addPath', path)
    await get().reloadProjects()
    if (project.hidden) useUi.getState().setShowHidden(true)
    useUi.getState().setCollapsed(project.id, false)
    get().setCursor(cursorOf(workspace))
    if (get().currentWorkspaceId !== workspace.id) get().setWorkspace(workspace.id)
    const tabId = useLayout.getState().activeTab[workspace.id]
    if (tabId) get().activateTab(tabId)
    return { project, workspace }
  },

  async setProjectHidden(id, hidden) {
    await omni.invoke('project:setHidden', id, hidden)
    set((s) => ({ projects: s.projects.map((p) => (p.id !== id ? p : hidden ? { ...p, hidden: true as const } : withoutHidden(p))) }))
    get().leaveHidden()
  },

  folderCandidates: (locationId) => omni.invoke('project:subfolders', locationId),

  async addFolder(locationId, rel) {
    const workspace = await omni.invoke('project:addFolder', locationId, rel)
    await get().reloadProjects()
    useUi.getState().setCollapsed(workspace.projectId, false)
    set({ currentWorkspaceId: workspace.id, cursor: cursorOf(workspace) })
    return workspace
  },

  async removeFolder(workspaceId, closeSessions = false) {
    const ws = get().workspaces.find((w) => w.id === workspaceId)
    await omni.invoke('project:removeFolder', workspaceId, closeSessions)
    await get().reloadProjects()
    // El cursor vuelve a la cabecera del proyecto dueño (no al primero de la lista); `setCursor` fija
    // el destino: su primera ubicación, o ninguno si quedó vacío.
    if (ws) get().setCursor(rowKey.project(ws.projectId))
  },

  async moveLocation(workspaceId, delta) {
    await omni.invoke('project:moveLocation', workspaceId, delta)
    await get().reloadProjects()
    const ws = get().workspaces.find((w) => w.id === workspaceId)
    if (ws) set({ currentWorkspaceId: ws.id, cursor: cursorOf(ws) })
  },

  async createProject(name) {
    const project = await omni.invoke('project:create', name)
    await get().reloadProjects()
    useUi.getState().setCollapsed(project.id, false)
    get().setCursor(rowKey.project(project.id))
    return project
  },

  async renameProject(projectId, name) {
    await omni.invoke('project:rename', projectId, name)
    set((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? { ...p, name: name.trim() } : p)) }))
  },

  async renameLocation(locationId, name) {
    await omni.invoke('project:renameLocation', locationId, name)
    await get().reloadProjects()
  },

  async mergeProjects(targetId, sourceId) {
    await omni.invoke('project:merge', targetId, sourceId)
    await get().reloadProjects()
    useUi.getState().setCollapsed(targetId, false)
  },

  leaveHidden() {
    const s = get()
    const showHidden = useUi.getState().showHidden
    const current = s.workspaces.find((w) => w.id === s.currentWorkspaceId)
    if (!current || showHidden || !projectOf(s, current.projectId)?.hidden) return
    const next = firstVisibleWorkspace(s, false)
    const tab = next ? activeTabOf(useLayout.getState(), next.id) : undefined
    if (tab) return get().activateTab(tab.id)
    set({ currentWorkspaceId: next?.id ?? null, cursor: next ? cursorOf(next) : null })
  },

  async removeProject(id) {
    // Main mata los PTY del proyecto; cada `session:exit` limpia tab, terminal y estado por sesión.
    const { keptWorktrees } = await omni.invoke('project:remove', id)
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.projectId !== id)
      const projects = s.projects.filter((p) => p.id !== id)
      const gone = new Set(s.workspaces.filter((w) => w.projectId === id).map((w) => w.id))
      const next = firstVisibleWorkspace({ projects, workspaces }, useUi.getState().showHidden)
      return {
        projects,
        workspaces,
        sessions: s.sessions.filter((x) => !gone.has(x.workspaceId)),
        currentWorkspaceId: next?.id ?? null,
        cursor: next ? cursorOf(next) : null
      }
    })
    return keptWorktrees
  },

  async reloadProjects() {
    const { projects, workspaces } = await omni.invoke('project:list')
    set((s) => {
      const { collapsed, showHidden } = useUi.getState()
      const first = firstVisibleWorkspace({ projects, workspaces }, showHidden)
      const current = workspaces.some((w) => w.id === s.currentWorkspaceId) ? s.currentWorkspaceId : (first?.id ?? null)
      const cursorAlive = s.cursor !== null && listRows({ projects, workspaces }, useLayout.getState(), collapsed, showHidden).some((r) => r.key === s.cursor)
      return { projects, workspaces, currentWorkspaceId: current, cursor: cursorAlive ? s.cursor : first ? cursorOf(first) : null }
    })
  },

  setCursor(key) {
    const row = listRows(get(), useLayout.getState(), useUi.getState().collapsed, useUi.getState().showHidden).find((r) => r.key === key)
    if (!row) return
    if (row.kind === 'project') {
      // La cabecera apunta a la primera ubicación del proyecto (su workspace `local` si es la única): lo
      // nuevo cae ahí. Un proyecto sin carpetas no tiene destino: lanzar ahí avisa en vez de caer en otro.
      set({ cursor: key, currentWorkspaceId: primaryWorkspace(get(), row.project.id)?.id ?? null })
    } else if (row.kind === 'tab') {
      get().activateTab(row.tab.id)
    } else if (row.kind === 'pane') {
      get().activatePane(row.tab.id, row.leaf.id)
    } else {
      set({ cursor: key, currentWorkspaceId: row.workspace.id })
    }
  },

  moveCursor(delta) {
    const rows = listRows(get(), useLayout.getState(), useUi.getState().collapsed, useUi.getState().showHidden)
    if (rows.length === 0) return
    const i = rows.findIndex((r) => r.key === get().cursor)
    // Sin cursor válido (fila plegada o borrada), J va a la primera y K a la última.
    const next = i === -1 ? (delta > 0 ? 0 : rows.length - 1) : (i + delta + rows.length) % rows.length
    get().setCursor(rows[next].key)
  },

  syncCursor(sessionId) {
    const tab = useLayout.getState().tabs.find((t) => leaves(t.root).some((l) => l.sessionId === sessionId))
    if (!tab) return
    get().activateTab(tab.id)
    // Con varios panes, la fila precisa es la del pane (el layout ya lo enfocó antes de llegar aquí).
    const all = leaves(tab.root)
    const leaf = all.find((l) => l.sessionId === sessionId)
    if (all.length > 1 && leaf) set({ cursor: rowKey.pane(leaf.id) })
  },

  activateTab(tabId) {
    const tab = useLayout.getState().tabs.find((t) => t.id === tabId)
    if (!tab) return
    useLayout.getState().setActiveTab(tab.workspaceId, tab.id)
    // Un tab activo nunca vive en un proyecto plegado: si no, el cursor caería en una fila oculta.
    const ws = get().workspaces.find((w) => w.id === tab.workspaceId)
    if (ws) useUi.getState().setCollapsed(ws.projectId, false)
    const cursor = rowKey.tab(tab.id)
    if (get().cursor !== cursor || get().currentWorkspaceId !== tab.workspaceId) set({ cursor, currentWorkspaceId: tab.workspaceId })
  },

  activatePane(tabId, paneId) {
    const tab = useLayout.getState().tabs.find((t) => t.id === tabId)
    if (!tab || !leaves(tab.root).some((l) => l.id === paneId)) return
    get().activateTab(tabId)
    useLayout.getState().focusPane(tabId, paneId)
    set({ cursor: rowKey.pane(paneId) })
  },

  setWorkspace: (id) => set({ currentWorkspaceId: id }),

  setTitle(id, title) {
    const clean = title.trim()
    if (get().titles[id] === clean) return
    // La línea de comando del agente (el shell la pone de título al lanzarlo o al repetir la pantalla) no pisa un nombre que ya hay.
    const session = get().sessions.find((x) => x.id === id)
    if (session && get().titles[id] && isAgentCommandTitle(get(), session, clean)) return
    set((s) => ({ titles: { ...s.titles, [id]: clean } }))
  },

  markAttention(id) {
    if (get().attention[id]) return
    set((s) => ({ attention: { ...s.attention, [id]: true } }))
  },

  clearAttention(id) {
    if (!get().attention[id]) return
    set((s) => {
      const { [id]: _gone, ...attention } = s.attention
      return { attention }
    })
  },

  markSeen(id) {
    set((s) => {
      // `unread` solo cambia de identidad si había algo que quitar: cada salida visible pasa por aquí y
      // los suscriptores (notificaciones, sidebar) comparan por referencia.
      if (!s.unread[id]) return { seen: { ...s.seen, [id]: Date.now() } }
      const { [id]: _was, ...unread } = s.unread
      return { seen: { ...s.seen, [id]: Date.now() }, unread }
    })
  },

  onData(id, data) {
    const at = Date.now()
    const burst = bursts.get(id)
    bursts.set(id, { start: burst && settleTimers.has(id) ? burst.start : at, last: at })
    // La campana se mira en crudo: `term.onBell` solo suena si el xterm existe y procesa el chunk.
    const scan = scanBell(data, oscOpen.has(id))
    if (scan.inOsc) oscOpen.add(id)
    else oscOpen.delete(id)
    if (scan.bell) get().markAttention(id)
    const declared = scanDeclaredState(data)
    if (declared !== undefined) get().setDeclared(id, declared)
    if (scanTrustPrompt(id, data)) get().markAttention(id)
    notePasteMode(id, data)
    // Un servidor que anuncia su URL (`Local: http://localhost:5173`): los puertos se miran ya, no en el
    // próximo sondeo de 10 s, para que la franja ofrezca abrirlo enseguida (§3.24).
    if (LOCAL_URL_HINT.test(data)) {
      if (get().sessions.find((x) => x.id === id)?.remote) {
        const url = lastLocalUrl(data)
        if (url && get().remoteUrls[id] !== url) set((s) => ({ remoteUrls: { ...s.remoteUrls, [id]: url } }))
      } else schedulePortsRefresh()
    }
    // "Instalar dtach" terminó en una terminal remota: omni vuelve a mirar las herramientas del host.
    if (data.includes('── dtach instalado ──')) {
      const host = get().workspaces.find((w) => w.id === get().sessions.find((x) => x.id === id)?.workspaceId)?.host
      if (host) void import('./hosts').then((m) => m.useHosts.getState().rescan(host)).catch(() => undefined)
    }
    const artifact = lastArtifactUrl(data)
    if (artifact && get().artifacts[id] !== artifact) set((s) => ({ artifacts: { ...s.artifacts, [id]: artifact } }))
    clearTimeout(screenTimers.get(id))
    screenTimers.set(
      id,
      setTimeout(() => {
        screenTimers.delete(id)
        const session = get().sessions.find((x) => x.id === id)
        const lines = session ? screenLines(id, SCREEN_LINES) : null
        if (!session || !lines || agentExited(get(), session)) return
        const q = screenQuestion(session.agent, lines)
        if (q === null) return void screenSeen.delete(id)
        if (screenSeen.get(id) === q) return
        screenSeen.set(id, q)
        get().markAttention(id)
      }, SCREEN_CHECK_MS)
    )
    clearSettleTimer(id)
    settleTimers.set(id, setTimeout(() => {
      settleTimers.delete(id)
      get().settle(id)
    }, WORKING_WINDOW_MS))
    const now = Date.now()
    const prev = get().activity[id]?.lastOutput ?? 0
    if (now - prev < ACTIVITY_THROTTLE_MS) return
    set((s) => ({ activity: { ...s.activity, [id]: { lastOutput: now } } }))
  },

  settle(id) {
    // El agente sigue anunciando trabajo aunque esté callado (una tool larga): todavía no terminó.
    if (get().declared[id] === 'working') {
      settleTimers.set(id, setTimeout(() => {
        settleTimers.delete(id)
        get().settle(id)
      }, WORKING_WINDOW_MS))
      return
    }
    const burst = bursts.get(id)
    bursts.delete(id)
    // Un redibujo instantáneo no es trabajo terminado.
    if (!burst || burst.last - burst.start < MIN_WORK_MS) return
    const s = get()
    const focused = s.currentWorkspaceId !== null ? focusedSessionId(useLayout.getState(), s.currentWorkspaceId) : null
    if (!becomesUnread(s, id, focused, appVisible())) return
    set((st) => ({ unread: { ...st.unread, [id]: true } }))
  },

  setDeclared(id, state) {
    if ((get().declared[id] ?? null) === state) return
    set((s) => {
      const { [id]: _was, ...rest } = s.declared
      return { declared: state ? { ...rest, [id]: state } : rest }
    })
  },

  setBusy(id, busy) {
    if ((get().busy[id] === true) === busy) return
    set((s) => {
      const { [id]: _was, ...rest } = s.busy
      return { busy: busy ? { ...rest, [id]: true } : rest }
    })
  },

  kill: (id) => omni.send('session:kill', id)
}))

/* ---------- selectores (estado derivado, nunca almacenado) ---------- */

export function statusFrom(lastOutput: number | undefined, attention: boolean, now: number, busy = false, declared?: DeclaredState): SessionStatus {
  if (attention) return 'question'
  if (busy) return 'working'
  if (declared) return declared
  return lastOutput !== undefined && now - lastOutput < WORKING_WINDOW_MS ? 'working' : 'idle'
}

export function sessionStatus(s: Pick<SessionState, 'activity' | 'attention'> & { busy?: Record<string, true>; declared?: Record<string, DeclaredState> }, id: string, now = Date.now()): SessionStatus {
  return statusFrom(s.activity[id]?.lastOutput, s.attention[id] === true, now, s.busy?.[id] === true, s.declared?.[id])
}

export const STATUS_LABEL: Record<SessionStatus, string> = { question: 'pregunta', working: 'trabajando', idle: 'listo' }

/** Flag con la que cada CLI deja de pedir permisos (⌥⏎ en el launcher). Sin flag, el agente se lanza normal. */
export const SKIP_PERMISSIONS: Partial<Record<AgentId, string>> = { claude: '--dangerously-skip-permissions', codex: '--full-auto' }

/** La sesión se lanzó con la flag de "sin permisos" de su agente: la franja y el tab lo marcan. */
export function skipsPermissions(session: Pick<SessionInfo, 'agent' | 'args'>): boolean {
  const flag = SKIP_PERMISSIONS[session.agent]
  return flag !== undefined && (session.args?.includes(flag) ?? false)
}

export function agentOf(s: Pick<SessionState, 'agents'>, id: AgentId): AgentDef | undefined {
  return s.agents.find((a) => a.id === id)
}

/** Nombres con los que aparece un shell como proceso (`-zsh` es un login shell). */
const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'nu'])

/** El proceso en primer plano es el shell mismo: no corre nada encima. */
export function isShellProcess(name: string): boolean {
  return SHELLS.has(name.replace(/^-/, '').split('/').pop() ?? '')
}

/** Nombre de proceso de Claude Code instalado con el instalador nativo: su versión. */
const CLAUDE_VERSIONED = /^\d+\.\d+\.\d+$/

/** Tras crear la sesión, el shell está en primer plano hasta que arranca el comando del agente. */
export const AGENT_LAUNCH_GRACE_MS = 5000

/**
 * Agente que corre AHORA en la terminal, para el icono: si el agente salió y quedó el shell, es
 * `shell`; si en un shell se lanzó un agente conocido por su comando, es ese agente. Sin dato del
 * proceso (daemon viejo, navegador, documento) manda el agente con el que se creó la sesión.
 */
export function liveAgent(s: Pick<SessionState, 'agents' | 'foreground'>, session: SessionInfo, now = Date.now()): AgentId {
  const fg = s.foreground[session.id]
  // Remota (§3.26): en el Mac solo se ve `ssh`; el proceso real vive en el host.
  if (!fg || session.remote) return session.agent
  if (isShellProcess(fg)) return session.agent !== 'shell' && now - session.createdAt < AGENT_LAUNCH_GRACE_MS ? session.agent : 'shell'
  const launched = s.agents.find((a) => a.command && a.command.trim().split(/\s+/)[0]?.split('/').pop() === fg)
  if (launched) return launched.id
  // El instalador nativo de Claude Code guarda cada binario con su versión como nombre (`2.1.301`).
  if (CLAUDE_VERSIONED.test(fg) && s.agents.some((a) => a.id === 'claude')) return 'claude'
  return session.agent
}

/** La sesión se lanzó con un agente que ya terminó: lo que quede de él en pantalla es historia. */
export function agentExited(s: Pick<SessionState, 'agents' | 'foreground'>, session: SessionInfo, now = Date.now()): boolean {
  return session.agent !== 'shell' && liveAgent(s, session, now) === 'shell'
}

/** Mensaje para el usuario cuando no se pudo crear una sesión. */
export function createErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/posix_spawnp failed|ptmx|out of pty/i.test(message)) return 'No se pudo abrir la terminal: el sistema se quedó sin PTYs (Apagar todo los libera)'
  return `No se pudo abrir la sesión: ${message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`
}

export function workspaceOf(s: Pick<SessionState, 'workspaces'>, id: string): Workspace | undefined {
  return s.workspaces.find((w) => w.id === id)
}

export function projectOf(s: Pick<SessionState, 'projects'>, id: string): Project | undefined {
  return s.projects.find((p) => p.id === id)
}

/** Proyecto del workspace actual, o `null`. */
export function currentProjectId(s: Pick<SessionState, 'workspaces' | 'currentWorkspaceId'>): string | null {
  return s.workspaces.find((w) => w.id === s.currentWorkspaceId)?.projectId ?? null
}

/**
 * De dónde es un workspace, para mostrarlo: el proyecto, y en un worktree o una subcarpeta también su
 * nombre (`shop · cc-51`, `omni · web`).
 */
export function placeLabel(s: Pick<SessionState, 'workspaces' | 'projects'>, workspaceId: string): string {
  const ws = workspaceOf(s, workspaceId)
  if (!ws) return ''
  const project = projectOf(s, ws.projectId)?.name ?? ws.name
  // Con varias ubicaciones el nombre de la carpeta distingue; con una sola el proyecto basta.
  return ws.kind === 'local' ? project : `${project} · ${ws.name}`
}

/** Texto que reemplaza el nombre de un proyecto oculto donde se vería fuera del sidebar (notificaciones). */
export const HIDDEN_PLACE = 'Proyecto oculto'

/** El workspace es de un proyecto oculto (§3.5c). */
export function inHiddenProject(s: Pick<SessionState, 'workspaces' | 'projects'>, workspaceId: string): boolean {
  const ws = workspaceOf(s, workspaceId)
  return ws !== undefined && projectOf(s, ws.projectId)?.hidden === true
}

/** Proyecto sin la marca de oculto (el JSON de main no guarda `hidden: false`). */
function withoutHidden(p: Project): Project {
  const { hidden: _hidden, ...rest } = p
  return rest
}

/** Proyectos que el sidebar lista: todos con `showHidden`, si no solo los visibles. */
export function visibleProjects(projects: readonly Project[], showHidden: boolean): Project[] {
  return showHidden ? [...projects] : projects.filter((p) => !p.hidden)
}

/**
 * Workspace al que apunta el proyecto (su cabecera, una tarea, "abrir"): su primera ubicación. Los
 * worktrees no cuentan; `undefined` si el proyecto no tiene carpetas.
 */
export function primaryWorkspace(s: Pick<SessionState, 'workspaces'>, projectId: string): Workspace | undefined {
  return s.workspaces.find((w) => w.projectId === projectId && w.kind !== 'worktree')
}

/** Primer workspace del primer proyecto visible que tenga carpetas, destino al quitar u ocultar el actual. */
export function firstVisibleWorkspace(s: Pick<SessionState, 'workspaces' | 'projects'>, showHidden: boolean): Workspace | undefined {
  for (const project of visibleProjects(s.projects, showHidden)) {
    const ws = primaryWorkspace(s, project.id)
    if (ws) return ws
  }
  return undefined
}

/**
 * Proyecto "actual" para los comandos de proyecto: el del workspace actual; sin workspace actual (la
 * cabecera de un proyecto sin carpetas), el de la cabecera bajo el cursor.
 */
export function currentProjectOf(s: Pick<SessionState, 'projects' | 'workspaces' | 'currentWorkspaceId' | 'cursor'>): Project | undefined {
  const id = currentProjectId(s) ?? (s.cursor?.startsWith('p:') ? s.cursor.slice(2) : null)
  return id ? projectOf(s, id) : undefined
}

/**
 * Nombre visible de una sesión: el título OSC si el programa lo puso (el navegador escribe aquí el
 * título de la página); si no, el del agente. Un navegador sin título es "Navegador".
 */
export function sessionTitle(s: Pick<SessionState, 'titles' | 'agents'>, session: SessionInfo): string {
  const agent = agentOf(s, session.agent)
  const fallback = agent?.name || (session.agent === 'browser' ? 'Navegador' : session.agent)
  const title = s.titles[session.id] ?? ''
  return title && !isAgentCommandTitle(s, session, title) ? title : fallback
}

/**
 * `true` si el título es la línea de comando del propio agente (`claude --session-id …` al revivir):
 * el shell la pone de título al ejecutarla y no nombra nada, así que nunca gana sobre otro nombre.
 */
export function isAgentCommandTitle(s: Pick<SessionState, 'agents'>, session: SessionInfo, title: string): boolean {
  const bin = agentOf(s, session.agent)?.command?.split(' ')[0]
  return !!bin && (title === bin || title.startsWith(`${bin} `))
}

/**
 * Orden del sidebar: proyecto → tabs → panes (solo si el tab tiene más de uno). Es el orden de
 * navegación J/K; lo plegado no aparece, y los proyectos ocultos tampoco salvo con `showHidden`. Un
 * proyecto con una sola ubicación (`local`) no le da fila propia: sus tabs cuelgan del proyecto. Con
 * dos o más, cada ubicación (`folder`) tiene su fila con sus tabs debajo; luego los worktrees (main
 * los deriva en ese orden). Un proyecto sin carpetas es solo su cabecera.
 */
export function listRows(s: Pick<SessionState, 'projects' | 'workspaces'>, lay: { tabs: Tab[] }, collapsed: Record<string, true> = {}, showHidden = false): Row[] {
  const rows: Row[] = []
  visibleProjects(s.projects, showHidden).forEach((p) => {
    rows.push({ key: rowKey.project(p.id), kind: 'project', project: p })
    if (collapsed[p.id]) return
    s.workspaces
      .filter((w) => w.projectId === p.id)
      .forEach((w) => {
        if (w.kind !== 'local') rows.push({ key: rowKey.workspace(w.id), kind: 'workspace', workspace: w })
        tabsOf(lay, w.id).forEach((tab, index) => {
          rows.push({ key: rowKey.tab(tab.id), kind: 'tab', tab, index: index + 1 })
          const panes = leaves(tab.root)
          if (panes.length > 1) panes.forEach((leaf, i) => rows.push({ key: rowKey.pane(leaf.id), kind: 'pane', tab, leaf, index: i + 1 }))
        })
      })
  })
  return rows
}

/**
 * Cursor tras morir una sesión (`lay` ya sin ella). Sobre un pane que ya no se lista (murió, o su tab
 * quedó con uno solo) baja al tab que lo tenía (`tabId`, el del muerto); si ese tab desapareció
 * entero, sube al workspace `home`. Sobre proyectos y workspaces no se mueve.
 */
export function cursorAfterExit(cursor: string | null, lay: { tabs: Tab[] }, tabId: string | undefined, home: Workspace | undefined): string | null {
  if (!cursor) return null
  const tabOf = (key: string): Tab | undefined => lay.tabs.find((t) => rowKey.tab(t.id) === key || leaves(t.root).some((l) => rowKey.pane(l.id) === key))
  const survivor = tabOf(cursor)
  if (survivor) return cursor.startsWith('pane:') && leaves(survivor.root).length < 2 ? rowKey.tab(survivor.id) : cursor
  if (!cursor.startsWith('t:') && !cursor.startsWith('pane:')) return cursor
  const parent = tabId !== undefined ? lay.tabs.find((t) => t.id === tabId) : undefined
  if (parent) return rowKey.tab(parent.id)
  return home ? cursorOf(home) : cursor
}

/** Estado agregado de un proyecto: manda la pregunta, luego el trabajo; `null` sin sesiones. */
export function projectStatus(s: Pick<SessionState, 'workspaces' | 'sessions' | 'activity' | 'attention'>, projectId: string, now: number): SessionStatus | null {
  const statuses = s.workspaces
    .filter((w) => w.projectId === projectId)
    .map((w) => workspaceStatus(s, w.id, now))
    .filter((x): x is SessionStatus => x !== null)
  if (statuses.length === 0) return null
  if (statuses.includes('question')) return 'question'
  return statuses.includes('working') ? 'working' : 'idle'
}

/** Estado agregado de un tab: manda la pregunta, luego el trabajo. */
export function tabStatus(s: Pick<SessionState, 'activity' | 'attention'>, tab: Tab, now: number): SessionStatus {
  const statuses = leaves(tab.root).map((l) => sessionStatus(s, l.sessionId, now))
  if (statuses.includes('question')) return 'question'
  return statuses.includes('working') ? 'working' : 'idle'
}

/** Estado agregado de un workspace a partir de sus sesiones: manda la pregunta, luego el trabajo. */
export function workspaceStatus(s: Pick<SessionState, 'sessions' | 'activity' | 'attention'>, workspaceId: string, now: number): SessionStatus | null {
  const statuses = s.sessions.filter((x) => x.workspaceId === workspaceId).map((x) => sessionStatus(s, x.id, now))
  if (statuses.length === 0) return null
  if (statuses.includes('question')) return 'question'
  return statuses.includes('working') ? 'working' : 'idle'
}

/** Sesiones con pregunta pendiente en toda la flota. */
export function attentionCount(s: Pick<SessionState, 'attention'>): number {
  return Object.keys(s.attention).length
}

/**
 * Transición `working` → `idle` (§3.14): la sesión queda sin leer si tuvo salida después de la última vez
 * que su pane se vio, sigue viva y no está ya marcada. La sesión con foco del layout (`focused`) se
 * exceptúa solo si alguien la está mirando (`visible`: vista Flota y ventana con foco); con otra vista
 * encima o la app en segundo plano también queda sin leer y avisa "terminó".
 */
export function becomesUnread(s: Pick<SessionState, 'sessions' | 'activity' | 'seen' | 'unread'>, id: string, focused: string | null, visible: boolean): boolean {
  if (s.unread[id] || (visible && id === focused)) return false
  if (!s.sessions.some((x) => x.id === id)) return false
  const lastOutput = s.activity[id]?.lastOutput
  return lastOutput !== undefined && lastOutput > (s.seen[id] ?? 0)
}

/** Sesiones sin leer en toda la flota. */
export function unreadCount(s: Pick<SessionState, 'unread'>): number {
  return Object.keys(s.unread).length
}

/** Un tab hereda el "sin leer" de cualquiera de sus panes (así se ve aunque las filas de pane no se listen). */
export function tabUnread(s: Pick<SessionState, 'unread'>, tab: Tab): boolean {
  return leaves(tab.root).some((l) => s.unread[l.sessionId] === true)
}

export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

/**
 * Cómo se muestra una ubicación en su fila (§3.5c): la ruta relativa si cuelga de otra ubicación del
 * mismo proyecto en el mismo host (`apps/web`, contra la más cercana); si no, la carpeta que la
 * contiene, corta y con el host delante (`~/sale`, `vps:~/srv`).
 * Exportada para tests.
 */
export function locationMeta(project: Project, workspace: Workspace, hostName?: string): string {
  const parents = project.locations.filter((l) => l.id !== workspace.id && l.host === workspace.host && workspace.path.startsWith(`${l.path}/`))
  const root = parents.sort((a, b) => b.path.length - a.path.length)[0]
  if (root) return workspace.path.slice(root.path.length + 1)
  // El nombre ya está en la fila: se muestra solo dónde está (la carpeta padre), que es lo que distingue.
  const parent = workspace.path.slice(0, Math.max(1, workspace.path.lastIndexOf('/')))
  const path = workspace.host ? parent.replace(/^\/home\/[^/]+|^\/root(?=\/|$)/, '~') : shortPath(parent)
  return workspace.host ? `${hostName ?? 'servidor'}:${path}` : path
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Aviso tras revivir sesiones al arrancar (§3.10b); `null` si no se revivió nada. Exportada para tests. */
export function reviveNotice(r: ReviveSummary): string | null {
  if (r.sessions <= 0) return r.reason === 'upgrade' ? 'Terminales actualizadas' : null
  const head =
    r.reason === 'upgrade'
      ? r.sessions === 1 ? 'Terminales actualizadas: se reabrió 1 terminal' : `Terminales actualizadas: se reabrieron ${r.sessions} terminales`
      : r.sessions === 1 ? 'Se restauró 1 terminal de antes del reinicio' : `Se restauraron ${r.sessions} terminales de antes del reinicio`
  if (r.resumed <= 0) return head
  return `${head}: ${r.resumed === 1 ? '1 agente retomó su conversación' : `${r.resumed} agentes retomaron su conversación`}`
}
