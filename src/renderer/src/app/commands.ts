import { useHosts } from '@/store/hosts'
import type { AgentId } from '@shared/types'
import { commands } from '@/core/commands/registry'
import { prettyChord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { omni } from '@/lib/omni'
import { acceptHunk, cancelComposer, checkDiagnostics, closeTree, editorHasLsp, gotoDefinition, gotoDiagnostic, gotoHunk, openComposer, reloadDoc, renameAtCursor, revertHunk, saveDoc, sendContext, showReferences, submitComposer, toggleChangesOnly, toggleTree, treeEnter, treeMove, treeUp } from '@/panes/editor/editor-host'
import { hunkAt } from '@/panes/editor/editor-logic'
import { useEditor } from '@/panes/editor/editor-store'
import { blurTerminals, getTerminal, sendRawPrefix } from '@/panes/terminal/terminal-host'
import { currentCandidate, currentPair, currentRound, useBroadcast } from '@/store/broadcast'
import { isBlank, liveBrowserId, useBrowser } from '@/store/browser'
import { useDocs } from '@/store/docs'
import { useControl } from '@/store/control'
import { humanError } from '@/store/control-logic'
import { activeTabOf, focusedSessionId, leaves, tabsOf, useLayout, type Dir } from '@/store/layout'
import { usePreview } from '@/store/preview'
import { useQuickOpen } from '@/store/quickopen'
import { cursorAnchor, cursorFilePath, reviewTargetId, useReview } from '@/store/review'
import { pendingComments } from '@/store/review-logic'
import { SKIP_PERMISSIONS, currentProjectOf, sessionStatus, useSessions } from '@/store/sessions'
import { devServerOf, usePorts } from '@/store/ports'
import { openInOmniBrowser, openRemoteUrl } from '@/store/links'
import { portRowId } from '@/store/ports-logic'
import { useTodos } from '@/store/todos'
import { useDaemon } from '@/store/daemon'
import { useUi, type LaunchMode, type LaunchTarget } from '@/store/ui'
import { useVoice } from '@/store/voice'
import { currentRow, keptWorktreesNotice, projectIsRepo, testCommandOf, useWorktrees } from '@/store/worktrees'

const AGENTS: Array<{ id: AgentId; title: string }> = [
  { id: 'shell', title: 'Nueva terminal' },
  { id: 'claude', title: 'Nuevo Claude Code' },
  { id: 'codex', title: 'Nuevo Codex' },
  { id: 'opencode', title: 'Nuevo OpenCode' },
  { id: 'goose', title: 'Nuevo Goose' },
  { id: 'hermes', title: 'Nuevo Hermes' },
  { id: 'browser', title: 'Nuevo navegador' }
]

/* ---------- lecturas de estado ---------- */
const ui = useUi.getState
const sessions = useSessions.getState
const layout = useLayout.getState
const browser = useBrowser.getState
const todos = useTodos.getState
const voice = useVoice.getState
const review = useReview.getState
const worktrees = useWorktrees.getState
const broadcast = useBroadcast.getState

const wsId = (): string | null => sessions().currentWorkspaceId
const hasWorkspace = (): boolean => wsId() !== null
const currentWorkspace = () => sessions().workspaces.find((w) => w.id === wsId())
/** Proyecto de la fila bajo el cursor del sidebar: la cabecera (aunque no tenga carpetas) o el del workspace actual. */
const currentProject = () => currentProjectOf(sessions())
/**
 * Ubicación sobre la que actúan los comandos de ubicación (§3.5c): la del workspace actual, salvo con el
 * cursor en la cabecera de un proyecto de varias ubicaciones (ahí no hay una sola de la que hablar).
 * Nunca un worktree.
 */
const currentLocation = () => {
  const ws = currentWorkspace()
  if (!ws || ws.kind === 'worktree') return undefined
  if (sessions().cursor?.startsWith('p:') && ws.kind !== 'local') return undefined
  return ws
}
/** Posición de la ubicación actual en su proyecto y cuántas tiene, para subirla o bajarla. */
const locationSlot = (): { index: number; count: number } | null => {
  const ws = currentLocation()
  const project = ws ? sessions().projects.find((p) => p.id === ws.projectId) : undefined
  if (!ws || !project) return null
  return { index: project.locations.findIndex((l) => l.id === ws.id), count: project.locations.length }
}
/** Proyecto bajo el cursor sin carpetas: no hay dónde lanzar nada. */
const emptyProjectUnderCursor = () => {
  const project = currentProject()
  return project && project.locations.length === 0 ? project : undefined
}
const currentSessionId = (): string | null => (wsId() ? focusedSessionId(layout(), wsId()!) : null)
const hasSession = (): boolean => currentSessionId() !== null
const isBrowserSession = (id: string | null): boolean => id !== null && sessions().sessions.find((s) => s.id === id)?.agent === 'browser'
/** El pane con foco del layout es un navegador: ahí valen los comandos `browser.*`. */
const browserFocused = (): boolean => isBrowserSession(currentSessionId())
/** Id del navegador con foco del layout; para los `run` de `browser.*`, que ya pasaron el `when`. */
const browserId = (): string => currentSessionId() ?? ''
/* editor (ARCHITECTURE §3.19) */
const isEditorSession = (id: string | null): boolean => id !== null && sessions().sessions.find((s) => s.id === id)?.agent === 'editor'
/** El pane con foco del layout es un editor: ahí valen los comandos `editor.*`. */
const editorFocused = (): boolean => isEditorSession(currentSessionId())
const editorId = (): string => currentSessionId() ?? ''
const editorDoc = () => useEditor.getState().docs[editorId()]
/** Hay un hunk visible bajo el cursor del editor con foco. */
const editorHunkAtCursor = (): boolean => {
  const doc = editorDoc()
  return doc !== undefined && hunkAt(doc.hunks, doc.line, doc.lineCount) !== null
}
const hasTabs = (): boolean => (wsId() ? activeTabOf(layout(), wsId()!) !== undefined : false)
const listHasFocus = (): boolean => ui().focus === 'list'
/* worktrees (ARCHITECTURE §3.15) */
const worktreesShown = (): boolean => ui().view === 'worktrees'
/** Fila bajo el cursor de la vista Worktrees. */
const worktreeRow = () => currentRow(worktrees(), sessions())
/** Proyecto al que se le crea un worktree: el de la fila en Worktrees, el del cursor en la flota, si no el actual. */
const worktreeProjectId = (): string | null => {
  if (worktreesShown()) return worktreeRow()?.project.id ?? currentWorkspace()?.projectId ?? null
  const cur = sessions().cursor
  if (cur?.startsWith('p:')) return cur.slice(2)
  return currentWorkspace()?.projectId ?? null
}
/**
 * Los comandos de worktree nuevo valen con cualquier proyecto: si no es repo git avisan por qué no
 * hacen nada en vez de quedarse callados (la tecla `N` parecía rota).
 */
const worktreeTargetOrNotice = (): string | null => {
  const id = worktreeProjectId()
  if (id === null) return null
  // Sin dato de rama cacheada se da por posible: main contesta el error en el diálogo.
  if (projectIsRepo(sessions(), id) !== false) return id
  const name = sessions().projects.find((p) => p.id === id)?.name ?? 'El proyecto'
  useControl.getState().announce(`${name} no es un repo git (git init)`)
  return null
}
/** La revisión de un worktree está en pantalla (ARCHITECTURE §3.16): ahí valen los comandos `review.*` de teclas sueltas. */
const reviewShown = (): boolean => ui().view === 'review'
/** Hay un diff cargado en la revisión (las teclas de navegación y las acciones git lo necesitan). */
const reviewHasDiff = (): boolean => reviewShown() && review().diff !== null
/* broadcast (ARCHITECTURE §3.18): ronda y candidato bajo el cursor con la vista en pantalla */
const broadcastShown = (): boolean => ui().view === 'broadcast'
const broadcastRound = () => currentRound(broadcast(), sessions())
const broadcastCandidate = () => currentCandidate(broadcast(), sessions())
const broadcastIdle = (): boolean => broadcastShown() && !broadcast().launching
const cursorIsWorkspace = (): boolean => sessions().cursor?.startsWith('ws:') ?? false
/** Proyecto bajo el cursor del sidebar, si el cursor está sobre uno. */
const cursorProjectId = (): string | null => {
  const cur = sessions().cursor
  return cur?.startsWith('p:') ? cur.slice(2) : null
}
/** Proyecto al que pertenece la fila bajo el cursor (para plegar desde cualquier fila). */
const projectOfCursor = (): string | null => {
  const p = cursorProjectId()
  if (p) return p
  const ws = currentWorkspace()
  return ws?.projectId ?? null
}
/** Tab bajo el cursor del sidebar, si el cursor está sobre uno. */
const cursorTabId = (): string | null => {
  const cur = sessions().cursor
  return cur?.startsWith('t:') ? cur.slice(2) : null
}
/** Pane bajo el cursor del sidebar (fila de nivel 2), con su tab. */
const cursorPane = (): { tabId: string; paneId: string; sessionId: string } | null => {
  const cur = sessions().cursor
  if (!cur?.startsWith('pane:')) return null
  const paneId = cur.slice(5)
  const tab = layout().tabs.find((t) => leaves(t.root).some((l) => l.id === paneId))
  const leaf = tab && leaves(tab.root).find((l) => l.id === paneId)
  return tab && leaf ? { tabId: tab.id, paneId, sessionId: leaf.sessionId } : null
}

/* vista previa (ARCHITECTURE §3.20) */
const preview = usePreview.getState
/** Agente del pane con foco del layout. */
const focusedAgent = (): AgentId | undefined => sessions().sessions.find((s) => s.id === currentSessionId())?.agent
/** El pane con foco es una vista previa: ahí valen zoom y atrás. */
const previewFocused = (): boolean => focusedAgent() === 'preview'
/** El pane con foco es un documento (editor o vista previa): ahí vale alternar entre los dos. */
const docFocused = (): boolean => previewFocused() || focusedAgent() === 'editor'
/** La vista previa con foco muestra una imagen (zoom). */
const previewImageFocused = (): boolean => previewFocused() && preview().docs[browserId()]?.kind === 'image'

/**
 * Lleva el teclado al pane con foco del layout. `setFocus('terminal')` es la intención:
 * si el pane aún no montó, `TerminalPane` (o `BrowserPane`) enfoca al montar; si ya está, se enfoca
 * aquí mismo. Si la página de un navegador tenía el teclado y el destino es otro pane, primero se le
 * pide a main que lo devuelva al renderer (`browser:blur`). En un navegador el teclado va a la
 * página, salvo que esté en blanco: ahí a la barra de URL.
 */
function focusTerminal(): void {
  const id = currentSessionId()
  if (!id) return
  ui().setFocus('terminal')
  const live = liveBrowserId(browser())
  if (live && live !== id) browser().blur(live)
  const term = getTerminal(id)
  if (term) term.focus()
  else if (isBrowserSession(id)) {
    if (isBlank(browser().states[id])) browser().focusUrl(id)
    else if (live !== id) browser().focusView(id)
  }
}

/** Cambia de tab con wrap-around pasando por `activateTab`, que también mueve el cursor. */
function goTab(delta: number): void {
  const tabs = tabsOf(layout(), wsId()!)
  if (tabs.length === 0) return
  const i = tabs.findIndex((t) => t.id === activeTabOf(layout(), wsId()!)?.id)
  sessions().activateTab(tabs[(i + delta + tabs.length) % tabs.length].id)
  if (ui().focus === 'terminal') focusTerminal()
}

/** Mata al toque si la sesión está en reposo; si está trabajando, pide confirmación. */
function killWithConfirm(ids: string[]): void {
  // Editores con cambios sin guardar (§3.19): van a su propia confirmación; el resto sigue aquí.
  const docs = useDocs.getState()
  const dirtyDocs = ids.filter((id) => docs.dirty[id] === true)
  if (dirtyDocs.length > 0) {
    docs.closeManyIfClean(dirtyDocs)
    ids = ids.filter((id) => !dirtyDocs.includes(id))
    // Dos overlays no conviven: lo que además necesitaría `confirmKill` se queda vivo esta vez.
    if (ids.some((id) => sessionStatus(sessions(), id) !== 'idle')) ids = ids.filter((id) => sessionStatus(sessions(), id) === 'idle')
  }
  const busy = ids.filter((id) => sessionStatus(sessions(), id) !== 'idle')
  if (busy.length === 0) {
    ids.forEach((id) => sessions().kill(id))
    return
  }
  ui().setPendingKill(ids)
  ui().openOverlay('confirmKill')
}

/** Crea la sesión y la coloca según el destino pedido (tab nuevo o split del pane con foco). `yolo` agrega la flag de sin permisos del agente. */
async function launch(agent: AgentId, target: LaunchTarget = ui().launchTarget, mode: LaunchMode = ui().launchMode): Promise<void> {
  // Tarea que esperaba a este agente (⏎ en el widget To-do) y worktree en espera (§3.15): se toman antes
  // de cerrar el launcher, que es lo que los cancela.
  const pending = todos().takePendingLaunch()
  const worktree = worktrees().takePendingLaunch()
  const inNewWorktree = worktrees().takeLaunchInNew()
  // ⇧⏎: el worktree `<badge>-<n>` se crea antes de cerrar el launcher; si el proyecto no es repo git, main
  // devuelve error y el agente se lanza normal, con el motivo en la franja de su pane.
  let noWorktree: string | null = null
  if (inNewWorktree) {
    const ws = await worktrees().createForLaunch(agent)
    // El usuario cerró el launcher mientras git trabajaba (Esc, otro overlay): nada se lanza y el worktree recién creado se borra.
    if (ui().overlay !== 'launcher') {
      if (ws) void worktrees().remove(ws.id)
      return
    }
    if (ws) sessions().setWorkspace(ws.id)
    else noWorktree = worktrees().error ?? 'No se pudo crear el worktree'
  }
  ui().closeOverlay()
  ui().setLaunchTarget('tab')
  ui().setLaunchMode('normal')
  const flag = mode === 'yolo' ? SKIP_PERMISSIONS[agent] : undefined
  // La sesión de una tarea nace en el workspace de su proyecto, aunque el foco haya movido el actual entretanto.
  if (pending) sessions().setWorkspace(pending.workspaceId)
  if (worktree) sessions().setWorkspace(worktree.workspaceId)
  const info = await sessions().create(agent, flag ? [flag] : undefined)
  if (!info) return
  if (pending) todos().linkLaunched(pending.todoId, info)
  if (worktree) worktrees().linkLaunched(worktree, info)
  if (target === 'tab') layout().openTab(info.workspaceId, info.id)
  else layout().split(info.workspaceId, target === 'split-right' ? 'row' : 'col', info.id)
  focusTerminal()
  if (noWorktree) browser().notify(info.id, `Sin worktree: ${noWorktree}`)
}

/** Sube o baja la ubicación actual (§3.5c); un error de main se dice, no se traga. */
function moveLocation(delta: -1 | 1): void {
  const ws = currentLocation()
  if (!ws) return
  void sessions()
    .moveLocation(ws.id, delta)
    .catch((e: unknown) => useControl.getState().announce(humanError(e, 'No se pudo mover la carpeta')))
}

/** Abre el launcher recordando dónde debe caer lo que se elija. */
function openLauncher(target: LaunchTarget): void {
  // Un proyecto sin carpetas no tiene cwd: se dice qué hacer en vez de lanzar en otro proyecto.
  const empty = emptyProjectUnderCursor()
  if (empty || !hasWorkspace()) {
    useControl.getState().announce(empty ? `${empty.name} no tiene carpetas: agrega una` : 'No hay dónde lanzar: abre un proyecto')
    return
  }
  ui().setLaunchTarget(target)
  ui().openOverlay('launcher')
}

/** Pane vecino en una dirección, por geometría de los elementos en pantalla. */
function paneInDirection(dir: 'left' | 'right' | 'up' | 'down'): string | null {
  const ws = wsId()
  const tab = ws ? activeTabOf(layout(), ws) : undefined
  if (!tab) return null
  const els = [...document.querySelectorAll<HTMLElement>(`[data-tab-id="${tab.id}"] [data-pane-id]`)]
  const cur = els.find((e) => e.dataset.paneId === tab.focusedPaneId)
  if (!cur) return null
  const a = cur.getBoundingClientRect()
  const overlapY = (b: DOMRect): boolean => b.bottom > a.top && b.top < a.bottom
  const overlapX = (b: DOMRect): boolean => b.right > a.left && b.left < a.right
  let best: { id: string; d: number } | null = null
  els.forEach((e) => {
    if (e === cur) return
    const b = e.getBoundingClientRect()
    let d = -1
    if (dir === 'right' && b.left >= a.right - 2 && overlapY(b)) d = b.left - a.right
    if (dir === 'left' && b.right <= a.left + 2 && overlapY(b)) d = a.left - b.right
    if (dir === 'down' && b.top >= a.bottom - 2 && overlapX(b)) d = b.top - a.bottom
    if (dir === 'up' && b.bottom <= a.top + 2 && overlapX(b)) d = a.top - b.bottom
    if (d >= 0 && (!best || d < best.d)) best = { id: e.dataset.paneId!, d }
  })
  return best ? (best as { id: string }).id : null
}

/** Registro de todos los comandos de la app. Se llama una vez al arrancar. */
export function registerAppCommands(): () => void {
  const dirCmd = (dir: 'left' | 'right' | 'up' | 'down', title: string) => ({
    id: `pane.${dir}`,
    title,
    group: 'Pane',
    when: hasTabs,
    run: () => {
      const tab = activeTabOf(layout(), wsId()!)
      // En zoom solo hay un pane en pantalla: hjkl recorre la lista como o/;.
      if (tab?.zoomedPaneId) layout().focusOffset(wsId()!, dir === 'left' || dir === 'up' ? -1 : 1)
      else {
        const id = paneInDirection(dir)
        if (id && tab) layout().focusPane(tab.id, id)
      }
      focusTerminal()
    }
  })
  // Mover el pane (no el foco): con vecino en esa dirección se intercambian; si no, va a ese borde del tab.
  const moveCmd = (dir: 'left' | 'right' | 'up' | 'down', title: string) => ({
    id: `pane.move.${dir}`,
    title,
    group: 'Pane',
    when: hasTabs,
    run: () => {
      const side = dir === 'up' ? 'top' : dir === 'down' ? 'bottom' : dir
      layout().moveFocused(wsId()!, side, paneInDirection(dir))
      focusTerminal()
    }
  })
  const resizeCmd = (id: string, title: string, dir: Dir, delta: number) => ({
    id,
    title,
    group: 'Pane',
    when: hasTabs,
    run: () => layout().resizeFocused(wsId()!, dir, delta)
  })

  return commands.register(
    /* ---- app ---- */
    { id: 'palette.open', title: 'Paleta de comandos', group: 'App', run: () => ui().openOverlay('palette') },
    // Quick open (ARCHITECTURE §3.11): agentes, comandos y archivos en un solo buscador. Abre limpio cada vez.
    {
      id: 'quickopen.open',
      title: 'Buscar agentes, comandos y archivos',
      group: 'App',
      run: () => {
        useQuickOpen.getState().reset()
        ui().openOverlay('quickopen')
      }
    },
    { id: 'help.keys', title: 'Hoja de atajos', group: 'App', run: () => ui().openOverlay('keys') },
    { id: 'settings.open', title: 'Ajustes', group: 'App', run: () => ui().openOverlay('settings') },
    { id: 'sidebar.toggle', title: 'Mostrar u ocultar el sidebar', group: 'App', run: () => ui().setSidebarCollapsed(!ui().sidebarCollapsed) },
    { id: 'overlay.close', title: 'Cerrar overlay', group: 'App', when: () => ui().overlay !== null && ui().overlay !== 'palette' && ui().overlay !== 'quickopen', run: () => ui().closeOverlay() },
    // Cierra agentes, terminales, el daemon y omni (ARCHITECTURE §3.10). Siempre pide confirmación: no hay vuelta atrás.
    {
      // El servidor que levantó la terminal en foco (§3.24): se abre en el navegador de omni, o se va al que ya lo muestra.
      id: 'pane.openDevServer',
      title: 'Abrir el dev server en el navegador',
      group: 'Puertos',
      when: () => {
        const id = currentSessionId()
        return id !== null && (devServerOf(usePorts.getState().list, id) !== undefined || sessions().remoteUrls[id] !== undefined)
      },
      run: () => {
        const id = currentSessionId() ?? ''
        // Remota: el servidor corre en el VPS; se reenvía su puerto antes de abrir (§3.26).
        const remote = sessions().remoteUrls[id]
        if (remote) return void openRemoteUrl(id, remote)
        const p = devServerOf(usePorts.getState().list, id)
        if (p) void usePorts.getState().open(portRowId(p))
      }
    },
    {
      // Último artifact de Claude que imprimió la terminal en foco: al navegador de omni (sesión de claude.ai persistente).
      id: 'pane.openArtifact',
      title: 'Abrir el artifact en el navegador',
      group: 'Navegador',
      when: () => currentSessionId() !== null && sessions().artifacts[currentSessionId() ?? ''] !== undefined,
      run: () => {
        const id = currentSessionId()
        const url = id ? sessions().artifacts[id] : undefined
        if (url) void openInOmniBrowser(url, id)
      }
    },
    { id: 'app.shutdown', title: 'Apagar todo', group: 'App', run: () => ui().openOverlay('confirmShutdown') },
    // Solo con un daemon de otro build (§3.10c): reabre las terminales con el daemon nuevo.
    { id: 'daemon.upgrade', title: 'Actualizar terminales', group: 'App', when: () => useDaemon.getState().outdated && !useDaemon.getState().upgrading, run: () => ui().openOverlay('confirmUpgrade') },

    /* ---- proyecto ---- */
    {
      id: 'project.toggle',
      title: 'Plegar o desplegar el proyecto',
      group: 'Proyecto',
      when: () => listHasFocus() && projectOfCursor() !== null,
      run: () => {
        const id = projectOfCursor()
        if (id) ui().setCollapsed(id, !ui().collapsed[id])
      }
    },
    {
      id: 'project.collapse',
      title: 'Plegar el proyecto',
      group: 'Proyecto',
      when: () => listHasFocus() && projectOfCursor() !== null,
      run: () => {
        const id = projectOfCursor()
        if (!id) return
        ui().setCollapsed(id, true)
        sessions().setCursor(`p:${id}`)
      }
    },
    {
      id: 'project.expand',
      title: 'Desplegar el proyecto',
      group: 'Proyecto',
      when: () => listHasFocus() && cursorProjectId() !== null,
      run: () => {
        const id = cursorProjectId()
        if (id) ui().setCollapsed(id, false)
      }
    },
    { id: 'project.open', title: 'Abrir proyecto', group: 'Proyecto', run: () => sessions().addProject() },
    // Un proyecto es solo un nombre (§3.5c): se crea vacío y enseguida se le suma la primera ubicación.
    { id: 'project.new', title: 'Nuevo proyecto', group: 'Proyecto', run: () => ui().openOverlay('projectNew') },
    // `+` de la sección Proyectos: nuevo (vacío), abrir carpeta o carpeta remota.
    { id: 'project.add', title: 'Agregar proyecto', group: 'Proyecto', run: () => ui().openOverlay('projectAdd') },
    { id: 'project.menu', title: 'Menú del proyecto', group: 'Proyecto', when: () => currentProject() !== undefined, run: () => ui().openOverlay('projectMenu') },
    {
      id: 'project.reveal',
      title: 'Mostrar carpeta en Finder',
      group: 'Proyecto',
      when: hasWorkspace,
      run: () => {
        const ws = currentWorkspace()
        if (ws) omni.send('app:reveal', ws.path)
      }
    },
    {
      id: 'project.copyPath',
      title: 'Copiar ruta de la carpeta',
      group: 'Proyecto',
      when: hasWorkspace,
      run: async () => {
        const ws = currentWorkspace()
        if (ws) await navigator.clipboard.writeText(ws.path)
      }
    },
    /* ubicaciones, subcarpetas y proyectos ocultos (ARCHITECTURE §3.5c) */
    { id: 'project.addFolder', title: 'Agregar subcarpeta', group: 'Proyecto', when: () => currentLocation() !== undefined && !currentLocation()?.host, run: () => ui().openOverlay('folderPicker') },
    {
      id: 'project.addLocation',
      title: 'Agregar carpeta al proyecto',
      group: 'Proyecto',
      when: () => currentProject() !== undefined,
      run: () => {
        const project = currentProject()
        if (project) useHosts.getState().startLocation({ mode: 'addTo', projectId: project.id })
      }
    },
    { id: 'project.rename', title: 'Renombrar proyecto', group: 'Proyecto', when: () => currentProject() !== undefined, run: () => ui().openOverlay('projectRename') },
    // Con una sola carpeta la fila es la del proyecto: se renombra el proyecto (§3.5c).
    { id: 'project.renameFolder', title: 'Renombrar carpeta', group: 'Proyecto', when: () => currentLocation()?.kind === 'folder', run: () => ui().openOverlay('locationRename') },
    {
      id: 'project.setFolderTestCommand',
      title: 'Comando de tests de la carpeta',
      group: 'Proyecto',
      when: () => currentLocation()?.kind === 'folder',
      run: () => {
        const ws = currentLocation()
        if (!ws) return
        worktrees().setTargetProject(ws.projectId, ws.id)
        ui().openOverlay('testCommand')
      }
    },
    { id: 'project.merge', title: 'Combinar con otro proyecto', group: 'Proyecto', when: () => currentProject() !== undefined && sessions().projects.length > 1, run: () => ui().openOverlay('projectMerge') },
    /* hosts remotos por SSH (ARCHITECTURE §3.26) */
    { id: 'project.openRemote', title: 'Abrir carpeta remota', group: 'Proyecto', run: () => useHosts.getState().startLocation({ mode: 'newProject' }) },
    {
      // El servidor de la carpeta actual no tiene dtach: sus terminales mueren si se corta la conexión (§3.26).
      id: 'host.installDtach',
      title: 'Instalar dtach en el servidor',
      group: 'Proyecto',
      when: () => {
        const host = currentWorkspace()?.host
        const tools = host ? useHosts.getState().status[host]?.tools : undefined
        return tools != null && !tools.dtach && tools.dtachInstall !== undefined
      },
      run: () => {
        const host = currentWorkspace()?.host
        if (host) void useHosts.getState().installDtach(host)
      }
    },
    {
      id: 'host.add',
      title: 'Agregar servidor SSH',
      group: 'Proyecto',
      run: () => {
        useHosts.setState({ target: null, place: null })
        ui().openOverlay('hostAdd')
      }
    },
    {
      id: 'host.reconnect',
      title: 'Reconectar servidor',
      group: 'Proyecto',
      when: () => {
        const host = currentWorkspace()?.host
        return host !== undefined && useHosts.getState().status[host]?.state !== 'connected'
      },
      run: async () => {
        const host = currentWorkspace()?.host
        if (!host) return
        const status = await useHosts.getState().connect(host)
        useControl.getState().announce(status.state === 'connected' ? `${useHosts.getState().nameOf(host)} conectado` : (status.error ?? 'No se pudo conectar'))
      }
    },
    {
      id: 'project.removeFolder',
      title: 'Quitar carpeta del proyecto',
      group: 'Proyecto',
      when: () => currentLocation() !== undefined,
      run: async () => {
        const ws = currentLocation()
        if (!ws) return
        // Con sesiones abiertas no se mata nada sin preguntar: la confirmación dice cuántas se cierran.
        if (sessions().sessions.some((s) => s.workspaceId === ws.id)) {
          ui().setPendingRemoveLocation(ws.id)
          ui().openOverlay('confirmRemoveLocation')
          return
        }
        await sessions()
          .removeFolder(ws.id)
          .catch((e: unknown) => useControl.getState().announce(humanError(e, 'No se pudo quitar la carpeta')))
      }
    },
    {
      id: 'project.moveLocationUp',
      title: 'Mover carpeta arriba',
      group: 'Proyecto',
      when: () => (locationSlot()?.index ?? 0) > 0,
      run: () => moveLocation(-1)
    },
    {
      id: 'project.moveLocationDown',
      title: 'Mover carpeta abajo',
      group: 'Proyecto',
      when: () => {
        const slot = locationSlot()
        return slot !== null && slot.index >= 0 && slot.index < slot.count - 1
      },
      run: () => moveLocation(1)
    },
    {
      id: 'project.hide',
      title: 'Ocultar proyecto',
      group: 'Proyecto',
      when: () => currentProject() !== undefined && !currentProject()?.hidden,
      run: async () => {
        const project = currentProject()
        if (!project) return
        await sessions().setProjectHidden(project.id, true)
        // El atajo sale del keymap vigente (el usuario lo puede cambiar); sin atajo, el nombre del comando.
        const chord = keymap.chordsFor('project.showHidden').find((c) => c.layer === 'global')?.chord
        useControl.getState().announce(`${project.name} oculto · ${chord ? prettyChord(chord) : 'Mostrar u ocultar proyectos ocultos'} lo vuelve a mostrar`)
      }
    },
    {
      id: 'project.unhide',
      title: 'Mostrar proyecto en el sidebar',
      group: 'Proyecto',
      when: () => currentProject()?.hidden === true,
      run: async () => {
        const project = currentProject()
        if (project) await sessions().setProjectHidden(project.id, false)
      }
    },
    {
      id: 'project.showHidden',
      title: 'Mostrar u ocultar proyectos ocultos',
      group: 'Proyecto',
      when: () => sessions().projects.some((p) => p.hidden),
      run: () => {
        const show = !ui().showHidden
        ui().setShowHidden(show)
        // Al volver a esconderlos, si el que estaba en pantalla era oculto, la flota se va al primero visible.
        if (!show) sessions().leaveHidden()
      }
    },
    {
      id: 'project.remove',
      title: 'Quitar proyecto',
      group: 'Proyecto',
      when: () => currentProject() !== undefined,
      run: async () => {
        const project = currentProject()
        if (!project) return
        // Main conserva en disco los worktrees con cambios (§3.15): se avisa dónde quedaron.
        const kept = await sessions().removeProject(project.id)
        worktrees().setNotice(keptWorktreesNotice(kept))
      }
    },

    /* ---- lanzar ---- */
    {
      id: 'launcher.open',
      title: 'Nuevo agente',
      group: 'Sesión',
      // También sobre un proyecto sin carpetas: `N` ahí avisa qué falta en vez de no hacer nada.
      when: () => hasWorkspace() || emptyProjectUnderCursor() !== undefined,
      run: () => openLauncher('tab')
    },
    ...AGENTS.map((a) => ({ id: `session.new.${a.id}`, title: a.title, group: 'Sesión', when: hasWorkspace, run: () => launch(a.id) })),

    /* ---- pane (tmux) ---- */
    // Un solo split, universal: abre el launcher con destino y el usuario elige qué cae ahí.
    { id: 'pane.split.right', title: 'Split a la derecha', group: 'Pane', when: hasTabs, run: () => openLauncher('split-right') },
    { id: 'pane.split.down', title: 'Split abajo', group: 'Pane', when: hasTabs, run: () => openLauncher('split-down') },
    {
      id: 'pane.next',
      title: 'Pane siguiente',
      group: 'Pane',
      when: hasTabs,
      run: () => {
        layout().focusOffset(wsId()!, 1)
        focusTerminal()
      }
    },
    {
      id: 'pane.prev',
      title: 'Pane anterior',
      group: 'Pane',
      when: hasTabs,
      run: () => {
        layout().focusOffset(wsId()!, -1)
        focusTerminal()
      }
    },
    dirCmd('left', 'Pane a la izquierda'),
    dirCmd('right', 'Pane a la derecha'),
    dirCmd('up', 'Pane arriba'),
    dirCmd('down', 'Pane abajo'),
    {
      id: 'pane.zoom',
      title: 'Zoom del pane',
      group: 'Pane',
      when: hasTabs,
      run: () => {
        layout().toggleZoom(wsId()!)
        if (ui().focus === 'terminal') focusTerminal()
      }
    },
    {
      id: 'pane.swap.next',
      title: 'Intercambiar con el pane siguiente',
      group: 'Pane',
      when: hasTabs,
      run: () => {
        layout().swapFocused(wsId()!, 1)
        focusTerminal()
      }
    },
    {
      id: 'pane.swap.prev',
      title: 'Intercambiar con el pane anterior',
      group: 'Pane',
      when: hasTabs,
      run: () => {
        layout().swapFocused(wsId()!, -1)
        focusTerminal()
      }
    },
    {
      id: 'pane.break',
      title: 'Mover el pane a un tab nuevo',
      group: 'Pane',
      when: hasTabs,
      run: () => {
        layout().breakFocused(wsId()!)
        focusTerminal()
      }
    },
    moveCmd('left', 'Mover el pane a la izquierda'),
    moveCmd('right', 'Mover el pane a la derecha'),
    moveCmd('up', 'Mover el pane arriba'),
    moveCmd('down', 'Mover el pane abajo'),
    resizeCmd('pane.resize.left', 'Mover el borde del pane a la izquierda', 'row', -0.05),
    resizeCmd('pane.resize.right', 'Mover el borde del pane a la derecha', 'row', 0.05),
    resizeCmd('pane.resize.up', 'Mover el borde del pane arriba', 'col', -0.05),
    resizeCmd('pane.resize.down', 'Mover el borde del pane abajo', 'col', 0.05),
    {
      id: 'pane.close',
      title: 'Cerrar el pane (termina su proceso)',
      group: 'Pane',
      when: hasSession,
      run: () => {
        const id = currentSessionId()
        if (id) killWithConfirm([id])
      }
    },
    {
      id: 'list.closeSession',
      title: 'Cerrar el tab del cursor (termina sus procesos)',
      group: 'Lista',
      when: () => cursorTabId() !== null || cursorPane() !== null,
      run: () => {
        // Sobre la fila de un pane solo cae ese pane; sobre un tab, todos los suyos.
        const pane = cursorPane()
        if (pane) return killWithConfirm([pane.sessionId])
        const tab = layout().tabs.find((t) => t.id === cursorTabId())
        if (tab) killWithConfirm(leaves(tab.root).map((l) => l.sessionId))
      }
    },

    /* ---- tabs (windows) ---- */
    { id: 'tab.next', title: 'Tab siguiente', group: 'Tab', when: hasTabs, run: () => goTab(1) },
    { id: 'tab.prev', title: 'Tab anterior', group: 'Tab', when: hasTabs, run: () => goTab(-1) },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
      id: `tab.go.${n}`,
      title: `Ir al tab ${n}`,
      group: 'Tab',
      when: hasTabs,
      run: () => {
        const tab = tabsOf(layout(), wsId()!)[n - 1]
        if (tab) sessions().activateTab(tab.id)
        if (ui().focus === 'terminal') focusTerminal()
      }
    })),
    {
      id: 'tab.close',
      title: 'Cerrar el tab (termina sus procesos)',
      group: 'Tab',
      when: hasTabs,
      run: () => {
        const tab = activeTabOf(layout(), wsId()!)
        if (tab) killWithConfirm(leaves(tab.root).map((l) => l.sessionId))
      }
    },

    /* ---- foco lista ↔ terminal ---- */
    { id: 'list.next', title: 'Fila siguiente', group: 'Lista', when: listHasFocus, run: () => sessions().moveCursor(1) },
    { id: 'list.prev', title: 'Fila anterior', group: 'Lista', when: listHasFocus, run: () => sessions().moveCursor(-1) },
    {
      id: 'session.enter',
      title: 'Entrar a la terminal',
      group: 'Sesión',
      when: listHasFocus,
      run: () => {
        // Sobre un proyecto plegado, ⏎ lo despliega. Desplegado: sin carpetas abre "Agregar ubicación"; con
        // varias ubicaciones (cabecera de grupo) lo pliega; con una sola, sin tabs abre el launcher y con
        // tabs lo pliega. Sobre una ubicación o un worktree abre el launcher; sobre un tab entra a su
        // terminal; sobre un pane, a ese pane.
        const pid = cursorProjectId()
        if (pid) {
          if (ui().collapsed[pid]) return void commands.run('project.expand')
          const count = sessions().projects.find((p) => p.id === pid)?.locations.length ?? 0
          if (count === 0) return void commands.run('project.addLocation')
          if (count === 1 && !hasTabs()) return void commands.run('launcher.open')
          return void commands.run('project.collapse')
        }
        if (cursorIsWorkspace() || !hasSession()) return void commands.run('launcher.open')
        const pane = cursorPane()
        if (pane) sessions().activatePane(pane.tabId, pane.paneId)
        else {
          const tabId = cursorTabId()
          if (tabId) sessions().activateTab(tabId)
        }
        focusTerminal()
      }
    },
    {
      id: 'session.leave',
      title: 'Volver a la lista',
      group: 'Sesión',
      run: () => {
        // Si la página de un navegador tenía el teclado, main se lo devuelve al renderer.
        const live = liveBrowserId(browser())
        if (live) browser().blur(live)
        blurTerminals()
        ui().setFocus('list')
      }
    },
    {
      id: 'terminal.sendPrefix',
      title: 'Enviar el prefijo literal a la terminal',
      group: 'Terminal',
      when: () => ui().focus === 'terminal' && hasSession(),
      run: () => {
        const id = currentSessionId()
        if (id) sendRawPrefix(id)
      }
    },

    /* ---- tareas (ARCHITECTURE §3.12) ---- */
    {
      id: 'todo.toggle',
      title: 'Mostrar u ocultar las tareas',
      group: 'Tareas',
      run: () => (ui().overlay === 'todo' ? ui().closeOverlay() : ui().openOverlay('todo'))
    },
    {
      id: 'todo.add',
      title: 'Nueva tarea',
      group: 'Tareas',
      run: () => {
        // Abre el widget con el campo enfocado; si ya está abierto, solo enfoca el campo.
        todos().setComposing(true)
        if (ui().overlay !== 'todo') ui().openOverlay('todo')
      }
    },
    {
      id: 'todo.done',
      title: 'Marcar la tarea como hecha o pendiente',
      group: 'Tareas',
      when: () => ui().overlay === 'todo' && todos().cursor !== null,
      run: () => {
        const id = todos().cursor
        if (id !== null) todos().toggleDone(id)
      }
    },
    {
      id: 'todo.foldDone',
      title: 'Plegar o desplegar las tareas hechas',
      group: 'Tareas',
      when: () => ui().overlay === 'todo',
      run: () => todos().setDoneOpen(!todos().doneOpen)
    },

    /* ---- puertos (ARCHITECTURE §3.24) ---- */
    {
      id: 'ports.toggle',
      title: 'Mostrar u ocultar los puertos',
      group: 'Puertos',
      run: () => (ui().overlay === 'ports' ? ui().closeOverlay() : ui().openOverlay('ports'))
    },
    {
      id: 'ports.filter',
      title: 'Buscar un puerto',
      group: 'Puertos',
      run: () => {
        // Abre el widget con el filtro enfocado; si ya está abierto, solo enfoca el filtro.
        usePorts.getState().setFiltering(true)
        if (ui().overlay !== 'ports') ui().openOverlay('ports')
      }
    },

    /* ---- uso por agente (ARCHITECTURE §3.25) ---- */
    {
      id: 'usage.toggle',
      title: 'Mostrar u ocultar el uso de los agentes',
      group: 'Uso',
      run: () => (ui().overlay === 'usage' ? ui().closeOverlay() : ui().openOverlay('usage'))
    },

    /* ---- dictado (ARCHITECTURE §3.22): ⌥Space mantener/soltar; el resto lo despacha useHoldKey con el overlay abierto ---- */
    {
      id: 'voice.dictate',
      title: 'Dictar al agente',
      group: 'Dictado',
      when: () => ui().overlay === null || ui().overlay === 'voice',
      run: () => void voice().startHold({ choose: false })
    },
    {
      id: 'voice.dictateChoose',
      title: 'Dictar eligiendo el agente',
      group: 'Dictado',
      when: () => ui().overlay === null || ui().overlay === 'voice',
      run: () => void voice().startHold({ choose: true })
    },
    {
      id: 'voice.handsFree',
      title: 'Dictar con manos libres',
      group: 'Dictado',
      when: () => (ui().overlay === null || ui().overlay === 'voice') && voice().phase !== 'recording',
      run: () => void voice().startHold({ choose: false, handsFree: true })
    },
    // Soltar la tecla (o ⌘⏎ en la revisión, ⏎ al elegir destino). En manos libres la pulsación que termina llega como `stop`.
    {
      id: 'voice.send',
      title: 'Enviar el dictado',
      group: 'Dictado',
      when: () => voice().phase === 'recording' || voice().phase === 'review' || voice().phase === 'choose',
      run: () => (voice().phase === 'recording' ? (voice().handsFree ? voice().stop({ review: false }) : voice().release({ review: false })) : voice().send())
    },
    {
      id: 'voice.review',
      title: 'Revisar el dictado antes de enviar',
      group: 'Dictado',
      when: () => voice().phase === 'recording',
      run: () => (voice().handsFree ? voice().stop({ review: true }) : voice().release({ review: true }))
    },
    { id: 'voice.cancel', title: 'Descartar el dictado', group: 'Dictado', when: () => voice().phase !== 'idle', run: () => voice().cancel() },
    { id: 'voice.nextTarget', title: 'Dictado: siguiente destino', group: 'Dictado', when: () => voice().phase === 'recording' || voice().phase === 'review' || voice().phase === 'choose', run: () => voice().nextTarget(1) },
    { id: 'voice.prevTarget', title: 'Dictado: destino anterior', group: 'Dictado', when: () => voice().phase === 'recording' || voice().phase === 'review' || voice().phase === 'choose', run: () => voice().nextTarget(-1) },
    { id: 'voice.downloadModel', title: 'Descargar el modelo de whisper', group: 'Dictado', when: () => voice().downloading === null && (ui().overlay === null || ui().overlay === 'voice'), run: () => void voice().downloadModel() },
    { id: 'voice.copyInstall', title: 'Copiar el comando para instalar whisper', group: 'Dictado', when: () => voice().phase === 'unavailable' && voice().reason === 'binary', run: () => void voice().copyInstall() },

    /* ---- vistas ---- */
    { id: 'fleet.open', title: 'Ir a la flota', group: 'App', run: () => ui().setView('fleet') },

    /* ---- worktrees (ARCHITECTURE §3.15) ---- */
    { id: 'worktrees.open', title: 'Abrir Worktrees', group: 'Worktrees', run: () => worktrees().open() },
    { id: 'worktrees.back', title: 'Volver a la flota', group: 'Worktrees', when: worktreesShown, run: () => worktrees().back() },
    { id: 'worktrees.next', title: 'Worktree siguiente', group: 'Worktrees', when: worktreesShown, run: () => worktrees().moveCursor(1) },
    { id: 'worktrees.prev', title: 'Worktree anterior', group: 'Worktrees', when: worktreesShown, run: () => worktrees().moveCursor(-1) },
    {
      id: 'worktrees.enter',
      title: 'Abrir la revisión del worktree',
      group: 'Worktrees',
      when: () => worktreesShown() && worktreeRow() !== undefined,
      run: async () => {
        // El worktree bajo el cursor lo resuelve el proveedor de `review-target` (§3.16); si la revisión no está disponible, se entra al agente.
        if (!(await commands.run('review.open'))) void commands.run('worktree.enterAgent')
      }
    },
    {
      id: 'worktree.enterAgent',
      title: 'Entrar al agente del worktree',
      group: 'Worktrees',
      when: () => worktreesShown() && worktreeRow()?.session !== undefined,
      run: () => {
        const row = worktreeRow()
        if (row) worktrees().enterAgent(row.workspace.id)
      }
    },
    {
      id: 'worktree.new',
      title: 'Nuevo worktree',
      group: 'Worktrees',
      when: () => worktreeProjectId() !== null,
      run: () => {
        const id = worktreeTargetOrNotice()
        if (id === null) return
        worktrees().setTargetProject(id)
        ui().openOverlay('worktreeName')
      }
    },
    {
      id: 'worktree.fromIssue',
      title: 'Nuevo worktree desde un issue',
      group: 'Worktrees',
      when: () => worktreeProjectId() !== null,
      run: () => {
        const id = worktreeTargetOrNotice()
        if (id === null) return
        worktrees().setTargetProject(id)
        ui().openOverlay('worktreeIssue')
      }
    },
    {
      id: 'worktree.runTests',
      title: 'Correr los tests del worktree',
      group: 'Worktrees',
      when: () => worktreesShown() && worktreeRow() !== undefined,
      run: () => {
        const row = worktreeRow()
        if (!row) return
        // Sin comando de tests (ni de su carpeta ni del proyecto), primero se pide el del proyecto.
        if (!testCommandOf(sessions().projects, row.workspace)) {
          worktrees().setTargetProject(row.project.id)
          return ui().openOverlay('testCommand')
        }
        void worktrees().runTests(row.workspace.id)
      }
    },
    {
      id: 'worktree.discard',
      title: 'Descartar el worktree',
      group: 'Worktrees',
      when: () => worktreesShown() && worktreeRow() !== undefined,
      run: () => {
        const row = worktreeRow()
        if (row) worktrees().discard(row.workspace.id)
      }
    },
    {
      id: 'project.setTestCommand',
      title: 'Comando de tests del proyecto',
      group: 'Proyecto',
      when: () => worktreeProjectId() !== null,
      run: () => {
        worktrees().setTargetProject(worktreeProjectId())
        ui().openOverlay('testCommand')
      }
    },

    /* ---- revisión de un worktree (ARCHITECTURE §3.16) ---- */
    // Abre la revisión del worktree bajo el cursor de Worktrees, del sidebar o del pane con foco (`reviewTargetId`).
    {
      id: 'review.open',
      title: 'Revisar el worktree',
      group: 'Revisión',
      when: () => reviewTargetId() !== null,
      run: () => {
        const id = reviewTargetId()
        if (id) void review().open(id)
      }
    },
    { id: 'review.back', title: 'Volver a Worktrees', group: 'Revisión', when: reviewShown, run: () => review().back() },
    { id: 'review.reload', title: 'Recargar el diff', group: 'Revisión', when: () => reviewShown() && review().workspaceId !== null, run: () => void review().reload() },
    { id: 'review.nextHunk', title: 'Hunk siguiente', group: 'Revisión', when: reviewHasDiff, run: () => review().nextHunk() },
    { id: 'review.prevHunk', title: 'Hunk anterior', group: 'Revisión', when: reviewHasDiff, run: () => review().prevHunk() },
    { id: 'review.nextFile', title: 'Archivo siguiente', group: 'Revisión', when: reviewHasDiff, run: () => review().nextFile() },
    { id: 'review.prevFile', title: 'Archivo anterior', group: 'Revisión', when: reviewHasDiff, run: () => review().prevFile() },
    { id: 'review.nextLine', title: 'Línea siguiente', group: 'Revisión', when: reviewHasDiff, run: () => review().nextLine() },
    { id: 'review.prevLine', title: 'Línea anterior', group: 'Revisión', when: reviewHasDiff, run: () => review().prevLine() },
    { id: 'review.comment', title: 'Comentar la línea', group: 'Revisión', when: () => reviewHasDiff() && cursorAnchor(review()) !== null, run: () => review().startComment() },
    // Los dos siguientes los corre el compositor (⌘⏎ y Esc dentro del textarea); no tienen tecla en el keymap.
    { id: 'review.saveComment', title: 'Guardar el comentario', group: 'Revisión', when: () => reviewShown() && review().composer !== null, run: () => review().saveComment() },
    { id: 'review.cancelComment', title: 'Cancelar el comentario', group: 'Revisión', when: () => reviewShown() && review().composer !== null, run: () => review().cancelComment() },
    { id: 'review.send', title: 'Enviar los comentarios al agente', group: 'Revisión', when: () => reviewShown() && pendingComments(review().comments).length > 0, run: () => void review().send() },
    { id: 'review.export', title: 'Copiar la revisión como Markdown', group: 'Revisión', when: reviewHasDiff, run: () => void review().exportMarkdown() },
    { id: 'review.merge', title: 'Hacer merge del worktree', group: 'Revisión', when: reviewHasDiff, run: () => review().merge() },
    { id: 'review.discard', title: 'Descartar el worktree', group: 'Revisión', when: () => reviewShown() && review().workspaceId !== null, run: () => review().discard() },
    { id: 'review.editor', title: 'Abrir el archivo en el editor', group: 'Revisión', when: () => reviewHasDiff() && cursorFilePath(review(), sessions()) !== null, run: () => review().openInEditor() },

    /* ---- broadcast (ARCHITECTURE §3.18) ---- */
    { id: 'broadcast.open', title: 'Abrir Broadcast', group: 'Broadcast', run: () => broadcast().open() },
    { id: 'broadcast.back', title: 'Volver a la flota', group: 'Broadcast', when: broadcastShown, run: () => broadcast().back() },
    // Nueva ronda: el proyecto es el actual; el diálogo pide prompt y agentes y lanza con ⌘⏎.
    { id: 'broadcast.new', title: 'Nueva ronda de broadcast', group: 'Broadcast', when: () => hasWorkspace() && !broadcast().launching, run: () => ui().openOverlay('broadcastNew') },
    { id: 'broadcast.next', title: 'Ronda siguiente', group: 'Broadcast', when: broadcastShown, run: () => broadcast().moveRound(1) },
    { id: 'broadcast.prev', title: 'Ronda anterior', group: 'Broadcast', when: broadcastShown, run: () => broadcast().moveRound(-1) },
    { id: 'broadcast.left', title: 'Candidato anterior', group: 'Broadcast', when: () => broadcastShown() && broadcastRound() !== undefined, run: () => broadcast().moveCandidate(-1) },
    { id: 'broadcast.right', title: 'Candidato siguiente', group: 'Broadcast', when: () => broadcastShown() && broadcastRound() !== undefined, run: () => broadcast().moveCandidate(1) },
    { id: 'broadcast.enter', title: 'Entrar al agente del candidato', group: 'Broadcast', when: () => broadcastShown() && broadcastCandidate() !== undefined, run: () => broadcast().enterCandidate() },
    { id: 'broadcast.diff', title: 'Revisar el candidato', group: 'Broadcast', when: () => broadcastShown() && broadcastCandidate() !== undefined, run: () => broadcast().diffCandidate() },
    { id: 'broadcast.diffBetween', title: 'Comparar dos candidatos', group: 'Broadcast', when: () => broadcastShown() && currentPair(broadcast(), sessions()) !== null, run: () => broadcast().diffBetween() },
    { id: 'broadcast.choose', title: 'Marcar o desmarcar como elegido', group: 'Broadcast', when: () => broadcastShown() && broadcastCandidate() !== undefined, run: () => broadcast().choose() },
    { id: 'broadcast.discardCandidate', title: 'Descartar el candidato', group: 'Broadcast', when: () => broadcastIdle() && broadcastCandidate() !== undefined, run: () => broadcast().discardCandidate() },
    { id: 'broadcast.relaunch', title: 'Relanzar la ronda', group: 'Broadcast', when: () => broadcastIdle() && (broadcastRound()?.candidates.some((c) => c.workspaceId !== broadcastRound()?.chosen) ?? false), run: () => void broadcast().relaunch() },
    { id: 'broadcast.merge', title: 'Hacer merge del candidato elegido', group: 'Broadcast', when: () => broadcastIdle() && broadcastRound()?.chosen !== null && broadcastRound() !== undefined, run: () => void broadcast().mergeChosen() },
    { id: 'broadcast.prompt', title: 'Ver el prompt completo', group: 'Broadcast', when: () => broadcastShown() && broadcastRound() !== undefined, run: () => broadcast().togglePrompt() },

    /* ---- navegador (ARCHITECTURE §3.9) ---- */
    { id: 'browser.focusUrl', title: 'Ir a la barra de dirección', group: 'Navegador', when: browserFocused, run: () => browser().focusUrl(browserId()) },
    { id: 'browser.navigate', title: 'Ir a la dirección de la barra', group: 'Navegador', when: browserFocused, run: () => browser().navigateFromBar(browserId()) },
    { id: 'browser.back', title: 'Atrás en el navegador', group: 'Navegador', when: () => browserFocused() && browser().states[browserId()]?.canGoBack === true, run: () => browser().back(browserId()) },
    { id: 'browser.forward', title: 'Adelante en el navegador', group: 'Navegador', when: () => browserFocused() && browser().states[browserId()]?.canGoForward === true, run: () => browser().forward(browserId()) },
    { id: 'browser.reload', title: 'Recargar la página', group: 'Navegador', when: browserFocused, run: () => browser().reload(browserId()) },
    { id: 'browser.stop', title: 'Detener la carga', group: 'Navegador', when: () => browserFocused() && browser().states[browserId()]?.loading === true, run: () => browser().stop(browserId()) },
    // Un solo flujo (§3.9): recortar → dibujar (opcional) → diálogo para enviar a un chat o copiar la imagen.
    { id: 'browser.capture', title: 'Tomar captura de la página', group: 'Navegador', when: () => browserFocused() && browser().browserMode === null && !isBlank(browser().states[browserId()]), run: () => browser().startAreaCapture(browserId()) },
    { id: 'browser.element', title: 'Elegir un elemento de la página', group: 'Navegador', when: () => browserFocused() && browser().browserMode === null && !isBlank(browser().states[browserId()]), run: () => browser().startElementMode(browserId()) },
    { id: 'browser.mobile', title: 'Ver como móvil', group: 'Navegador', when: browserFocused, run: () => browser().toggleMobile(browserId()) },
    { id: 'browser.devtools', title: 'Mostrar u ocultar las DevTools', group: 'Navegador', when: browserFocused, run: () => browser().toggleDevtools(browserId()) },
    { id: 'browser.menu', title: 'Menú del navegador', group: 'Navegador', when: browserFocused, run: () => browser().openMenu(browserId()) },
    { id: 'browser.settings', title: 'Ajustes del navegador', group: 'Navegador', when: browserFocused, run: () => browser().openSettings(browserId()) },

    /* ---- vista previa (ARCHITECTURE §3.20) ---- */
    { id: 'preview.toggle', title: 'Cambiar entre editor y vista previa', group: 'Vista previa', when: docFocused, run: () => preview().toggle(browserId()) },
    { id: 'preview.back', title: 'Atrás en la vista previa', group: 'Vista previa', when: () => previewFocused() && (preview().docs[browserId()]?.history.length ?? 0) > 0, run: () => preview().back(browserId()) },
    { id: 'preview.zoomIn', title: 'Acercar la imagen', group: 'Vista previa', when: previewImageFocused, run: () => preview().zoomIn(browserId()) },
    { id: 'preview.zoomOut', title: 'Alejar la imagen', group: 'Vista previa', when: previewImageFocused, run: () => preview().zoomOut(browserId()) },
    { id: 'preview.zoomReset', title: 'Ajustar la imagen al pane', group: 'Vista previa', when: previewImageFocused, run: () => preview().zoomReset(browserId()) },

    /* ---- socket de control y bus MCP (ARCHITECTURE §3.21) ---- */
    {
      id: 'mcp.copyCommand',
      title: 'Copiar comandos para registrar los MCP de omni',
      group: 'App',
      run: async () => {
        // Main arma las líneas `claude mcp add omni …` y `claude mcp add omni-browser …` con las rutas reales de este omni.
        try {
          const line = await omni.invoke('mcp:command')
          await navigator.clipboard.writeText(line)
          useControl.getState().announce('Comandos MCP copiados')
        } catch (e) {
          useControl.getState().announce(humanError(e, 'No se pudo copiar el comando MCP'))
        }
      }
    },

    /* ---- editor (ARCHITECTURE §3.19) ---- */
    // Desde el launcher: "Editor" / "Vista previa" piden una ruta y caen donde apuntaba el launcher (tab o split).
    {
      id: 'editor.openPath',
      title: 'Abrir archivo en el editor',
      group: 'Editor',
      when: hasWorkspace,
      run: () => useDocs.getState().openPathDialog('editor', ui().launchTarget)
    },
    {
      id: 'editor.openPreviewPath',
      title: 'Abrir archivo en la vista previa',
      group: 'Editor',
      when: hasWorkspace,
      run: () => useDocs.getState().openPathDialog('preview', ui().launchTarget)
    },
    { id: 'editor.save', title: 'Guardar el archivo', group: 'Editor', when: editorFocused, run: () => void saveDoc(editorId()) },
    { id: 'editor.reload', title: 'Recargar el archivo desde disco', group: 'Editor', when: () => editorFocused() && editorDoc()?.changedOnDisk === true, run: () => reloadDoc(editorId()) },
    { id: 'editor.hunk.next', title: 'Cambio siguiente del agente', group: 'Editor', when: () => editorFocused() && (editorDoc()?.hunks.length ?? 0) > 0, run: () => gotoHunk(editorId(), 1) },
    { id: 'editor.hunk.prev', title: 'Cambio anterior del agente', group: 'Editor', when: () => editorFocused() && (editorDoc()?.hunks.length ?? 0) > 0, run: () => gotoHunk(editorId(), -1) },
    { id: 'editor.hunk.accept', title: 'Aceptar el cambio bajo el cursor', group: 'Editor', when: () => editorFocused() && editorHunkAtCursor(), run: () => acceptHunk(editorId()) },
    { id: 'editor.hunk.revert', title: 'Revertir el cambio bajo el cursor', group: 'Editor', when: () => editorFocused() && editorHunkAtCursor(), run: () => revertHunk(editorId()) },
    { id: 'editor.hunk.comment', title: 'Comentar el cambio bajo el cursor', group: 'Editor', when: () => editorFocused() && editorHunkAtCursor(), run: () => openComposer(editorId()) },
    // Los dos siguientes los corre el compositor (⌘⏎ y Esc dentro del textarea); no tienen tecla en el keymap.
    { id: 'editor.sendComment', title: 'Enviar el comentario al agente', group: 'Editor', when: () => editorFocused() && editorDoc()?.composer !== null, run: () => submitComposer(editorId()) },
    { id: 'editor.cancelComment', title: 'Cancelar el comentario', group: 'Editor', when: () => editorFocused() && editorDoc()?.composer !== null, run: () => cancelComposer(editorId()) },
    { id: 'editor.sendContext', title: 'Mandar el archivo, sus cambios y errores al agente', group: 'Editor', when: editorFocused, run: () => sendContext(editorId()) },
    { id: 'editor.diagnostic.next', title: 'Error siguiente', group: 'Editor', when: () => editorFocused() && (editorDoc()?.diagnostics.length ?? 0) > 0, run: () => gotoDiagnostic(editorId(), 1) },
    { id: 'editor.diagnostic.prev', title: 'Error anterior', group: 'Editor', when: () => editorFocused() && (editorDoc()?.diagnostics.length ?? 0) > 0, run: () => gotoDiagnostic(editorId(), -1) },
    // Servidor de lenguaje (§3.19b): solo con un servidor conectado; sin él, `gd`/`gr` caen a vim.
    { id: 'editor.definition', title: 'Ir a la definición', group: 'Editor', when: () => editorFocused() && editorHasLsp(editorId()), run: () => gotoDefinition(editorId()) },
    { id: 'editor.references', title: 'Buscar referencias', group: 'Editor', when: () => editorFocused() && editorHasLsp(editorId()), run: () => showReferences(editorId()) },
    { id: 'editor.rename', title: 'Renombrar el símbolo', group: 'Editor', when: () => editorFocused() && editorHasLsp(editorId()), run: () => renameAtCursor(editorId()) },
    { id: 'editor.checkDiagnostics', title: 'Revisar errores con tsc y eslint', group: 'Editor', when: editorFocused, run: () => checkDiagnostics(editorId()) },
    { id: 'editor.changesOnly', title: 'Mostrar solo los cambios o el archivo entero', group: 'Editor', when: () => editorFocused() && editorDoc()?.base !== null, run: () => toggleChangesOnly(editorId()) },
    // ⌘D ya es `review.open` (vale si el workspace es un worktree); el botón de la cabecera avisa cuando no lo es.
    {
      id: 'editor.diff',
      title: 'Ver el diff del worktree',
      group: 'Editor',
      when: editorFocused,
      run: () => {
        const id = reviewTargetId()
        if (id) void review().open(id)
        else useEditor.getState().notify(editorId(), 'Solo en un worktree: el diff es de la rama del worktree')
      }
    },
    { id: 'editor.tree.toggle', title: 'Mostrar u ocultar el árbol de archivos', group: 'Editor', when: editorFocused, run: () => toggleTree(editorId()) },
    { id: 'editor.tree.close', title: 'Cerrar el árbol de archivos', group: 'Editor', when: () => editorFocused() && editorDoc()?.tree !== null, run: () => closeTree(editorId()) },
    { id: 'editor.tree.next', title: 'Elemento siguiente del árbol', group: 'Editor', when: () => editorFocused() && editorDoc()?.tree !== null, run: () => treeMove(editorId(), 1) },
    { id: 'editor.tree.prev', title: 'Elemento anterior del árbol', group: 'Editor', when: () => editorFocused() && editorDoc()?.tree !== null, run: () => treeMove(editorId(), -1) },
    { id: 'editor.tree.enter', title: 'Abrir el archivo o la carpeta', group: 'Editor', when: () => editorFocused() && editorDoc()?.tree !== null, run: () => treeEnter(editorId()) },
    { id: 'editor.tree.up', title: 'Subir a la carpeta padre', group: 'Editor', when: () => editorFocused() && editorDoc()?.tree !== null, run: () => treeUp(editorId()) }
  )
}
