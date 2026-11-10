import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Project, SessionInfo, Workspace } from '@shared/types'
import { useLayout, type LayoutNode, type Tab } from './layout'
import { useUi } from './ui'
import {
  STATUS_LABEL,
  AGENT_LAUNCH_GRACE_MS,
  hasBell,
  agentExited,
  createErrorText,
  isShellProcess,
  liveAgent,
  scanBell,
  scanDeclaredState,
  lastArtifactUrl,
  seedDeclared,
  scanTrustPrompt,
  TRUST_BUFFER_CHARS,
  MIN_WORK_MS,
  WORKING_WINDOW_MS,
  attentionCount,
  becomesUnread,
  currentProjectOf,
  cursorAfterExit,
  cursorOf,
  firstVisibleWorkspace,
  primaryWorkspace,
  inHiddenProject,
  listRows,
  placeLabel,
  visibleProjects,
  plural,
  projectStatus,
  reviveNotice,
  rowKey,
  sessionStatus,
  sessionTitle,
  shortPath,
  statusFrom,
  tabStatus,
  tabUnread,
  unreadCount,
  useSessions,
  workspaceStatus
} from './sessions'

vi.mock('@/lib/omni', () => ({
  omni: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(() => () => {}) }
}))
vi.mock('@/panes/terminal/terminal-host', () => ({
  screenLines: () => null, disposeTerminal: vi.fn() }))

const NOW = 1_000_000

const AGENTS: AgentDef[] = [
  { id: 'claude', name: 'Claude Code', badge: 'CC', command: 'claude' },
  { id: 'shell', name: 'Shell', badge: 'SH', command: null }
]

const project = (id: string): Project => ({ id, name: `Proyecto ${id}`, locations: [{ id, name: 'Local', path: `/Users/x/${id}` }] })

const workspace = (id: string, projectId: string, kind: Workspace['kind'] = 'local'): Workspace => ({
  id,
  projectId,
  name: id,
  path: `/Users/x/${projectId}`,
  kind
})

const session = (id: string, workspaceId: string): SessionInfo => ({
  id,
  agent: 'claude',
  workspaceId,
  cwd: '/Users/x',
  createdAt: NOW
})

/** Tab de una sola hoja, para los selectores que solo leen la forma del árbol. */
function tab(id: string, workspaceId: string): Tab {
  const leaf: LayoutNode = { id: `${id}-leaf`, kind: 'leaf', sessionId: `s-${id}` }
  return { id, workspaceId, root: leaf, focusedPaneId: leaf.id, zoomedPaneId: null }
}

/** Tab con dos hojas en un split row: sesiones `${id}-a` y `${id}-b`. */
function splitTab(id: string, workspaceId: string): Tab {
  return {
    id,
    workspaceId,
    root: {
      id: `${id}-split`,
      kind: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        { id: `${id}-a`, kind: 'leaf', sessionId: `${id}-a` },
        { id: `${id}-b`, kind: 'leaf', sessionId: `${id}-b` }
      ]
    },
    focusedPaneId: `${id}-a`,
    zoomedPaneId: null
  }
}

const initialState = {
  agents: [],
  projects: [],
  workspaces: [],
  sessions: [],
  activity: {},
  titles: {},
  attention: {},
  busy: {},
  seen: {},
  unread: {},
  currentWorkspaceId: null,
  cursor: null
}

beforeEach(() => {
  useSessions.setState(initialState)
  useLayout.setState({ tabs: [], activeTab: {} })
})

describe('statusFrom', () => {
  it('pregunta gana sobre trabajo aunque hubo salida reciente', () => {
    expect(statusFrom(NOW, true, NOW)).toBe('question')
  })

  it('trabajando si hubo salida hace menos de 4000 ms', () => {
    expect(statusFrom(NOW, false, NOW + 3999)).toBe('working')
  })

  it('listo cuando la última salida tiene 4000 ms o más', () => {
    expect(statusFrom(NOW, false, NOW + 4000)).toBe('idle')
  })

  it('listo si nunca hubo salida', () => {
    expect(statusFrom(undefined, false, NOW)).toBe('idle')
  })
})

describe('estado anunciado en el título', () => {
  it('Claude Code: ✳ es reposo y el spinner es trabajo', () => {
    expect(scanDeclaredState('\x1b]0;✳ Claude Code\x07')).toBe('idle')
    expect(scanDeclaredState('\x1b]0;◐ Respuesta simple\x07')).toBe('working')
    expect(scanDeclaredState('\x1b]2;⠂ Tarea\x1b\\')).toBe('working')
  })

  it('manda el último título del chunk', () => {
    expect(scanDeclaredState('\x1b]0;◑ a\x07texto\x1b]0;✳ a\x07')).toBe('idle')
  })

  it('sin título no cambia nada; un título sin marca deja de mandar', () => {
    expect(scanDeclaredState('hola\x1b[2J')).toBeUndefined()
    expect(scanDeclaredState('\x1b]0;zsh\x07')).toBeNull()
  })

  it('reposo anunciado gana a la salida reciente (redibujo); trabajo anunciado, al silencio (tool larga)', () => {
    expect(statusFrom(NOW, false, NOW, false, 'idle')).toBe('idle')
    expect(statusFrom(NOW - 60_000, false, NOW, false, 'working')).toBe('working')
    expect(statusFrom(NOW, true, NOW, false, 'working')).toBe('question')
  })

  it('las sesiones de Claude Code que ya existían arrancan en reposo; las demás y lo ya anunciado no se tocan', () => {
    const seeded = seedDeclared([{ id: 'a', agent: 'claude' }, { id: 'b', agent: 'codex' }, { id: 'c', agent: 'claude' }], { c: 'working' })
    expect(seeded).toEqual({ a: 'idle', c: 'working' })
  })

  it('una salida con ✳ en el título deja la sesión lista al toque', () => {
    useSessions.getState().onData('s1', 'output\x1b]0;✳ Claude Code\x07')
    expect(sessionStatus(useSessions.getState(), 's1')).toBe('idle')
    useSessions.getState().onData('s1', '\x1b]0;◐ Claude Code\x07')
    expect(sessionStatus(useSessions.getState(), 's1', Date.now() + 60_000)).toBe('working')
  })
})

describe('sessionStatus', () => {
  it('lee actividad y atención del estado', () => {
    const s = { activity: { a: { lastOutput: NOW }, b: { lastOutput: NOW - 60_000 } }, attention: { c: true as const } }

    expect(sessionStatus(s, 'a', NOW)).toBe('working')
    expect(sessionStatus(s, 'b', NOW)).toBe('idle')
    expect(sessionStatus(s, 'c', NOW)).toBe('question')
  })
})

describe('STATUS_LABEL', () => {
  it('tiene la etiqueta en español de cada estado', () => {
    expect(STATUS_LABEL).toEqual({ question: 'pregunta', working: 'trabajando', idle: 'listo' })
  })
})

describe('sessionTitle', () => {
  const s = { agents: AGENTS }

  it('usa el título OSC si el programa lo escribió', () => {
    expect(sessionTitle({ ...s, titles: { x: 'Refactor login' } }, session('x', 'w'))).toBe('Refactor login')
  })

  it('cae al nombre del agente si no hay título', () => {
    expect(sessionTitle({ ...s, titles: {} }, session('x', 'w'))).toBe('Claude Code')
  })

  it('cae al id del agente si no lo conoce', () => {
    const unknown = { ...session('x', 'w'), agent: 'codex' as const }
    expect(sessionTitle({ agents: [], titles: {} }, unknown)).toBe('codex')
  })

  it('el comando del agente escrito por el shell no gana sobre su nombre', () => {
    expect(sessionTitle({ ...s, titles: { x: 'claude --session-id d23a' } }, session('x', 'w'))).toBe('Claude Code')
    expect(sessionTitle({ ...s, titles: { x: 'claude' } }, session('x', 'w'))).toBe('Claude Code')
    expect(sessionTitle({ ...s, titles: { x: 'claudette' } }, session('x', 'w'))).toBe('claudette')
  })

  it('un título vacío no gana sobre el nombre del agente', () => {
    expect(sessionTitle({ ...s, titles: { x: '' } }, session('x', 'w'))).toBe('Claude Code')
  })
})

describe('listRows', () => {
  const p1 = project('p1')
  const p2 = project('p2')
  const local1 = workspace('w-local1', 'p1')
  const wt1 = workspace('w-wt1', 'p1', 'worktree')
  const local2 = workspace('w-local2', 'p2')
  const state = { projects: [p1, p2], workspaces: [local1, wt1, local2] }
  const lay = { tabs: [tab('tA', 'w-local1'), tab('tA2', 'w-local1'), tab('tB', 'w-wt1'), tab('tC', 'w-local2')] }

  it('ordena proyecto, workspace solo si no es local, y tabs con índice base 1 por workspace', () => {
    const rows = listRows(state, lay)

    expect(rows.map((r) => r.key)).toEqual([
      'p:p1',
      't:tA',
      't:tA2',
      'ws:w-wt1',
      't:tB',
      'p:p2',
      't:tC'
    ])
    const indices = rows.flatMap((r) => (r.kind === 'tab' ? [r.index] : []))
    expect(indices).toEqual([1, 2, 1, 1])
  })

  it('un proyecto plegado muestra su fila pero no sus hijos', () => {
    const rows = listRows(state, lay, { p1: true })

    expect(rows.map((r) => r.key)).toEqual(['p:p1', 'p:p2', 't:tC'])
  })

  it('sin proyectos no hay filas', () => {
    expect(listRows({ projects: [], workspaces: [] }, { tabs: [] })).toEqual([])
  })

  it('un proyecto oculto no se lista salvo con showHidden; sus tabs tampoco', () => {
    const hidden = { projects: [{ ...p1, hidden: true as const }, p2], workspaces: [local1, wt1, local2] }
    expect(listRows(hidden, lay).map((r) => r.key)).toEqual(['p:p2', 't:tC'])
    expect(listRows(hidden, lay, {}, true).map((r) => r.key)).toEqual(['p:p1', 't:tA', 't:tA2', 'ws:w-wt1', 't:tB', 'p:p2', 't:tC'])
  })

  it('una subcarpeta tiene fila propia con sus tabs, antes de los worktrees', () => {
    const folder = workspace('w-web', 'p1', 'folder')
    const rows = listRows({ projects: [p1], workspaces: [local1, folder, wt1] }, { tabs: [tab('tA', 'w-local1'), tab('tW', 'w-web'), tab('tB', 'w-wt1')] })
    expect(rows.map((r) => r.key)).toEqual(['p:p1', 't:tA', 'ws:w-web', 't:tW', 'ws:w-wt1', 't:tB'])
  })

  it('un tab con varios panes lista sus panes debajo, con índice base 1; con uno solo no', () => {
    const rows = listRows({ projects: [p1], workspaces: [local1] }, { tabs: [splitTab('tS', 'w-local1'), tab('tA', 'w-local1')] })

    expect(rows.map((r) => r.key)).toEqual(['p:p1', 't:tS', 'pane:tS-a', 'pane:tS-b', 't:tA'])
    const panes = rows.flatMap((r) => (r.kind === 'pane' ? [{ tab: r.tab.id, leaf: r.leaf.id, index: r.index }] : []))
    expect(panes).toEqual([
      { tab: 'tS', leaf: 'tS-a', index: 1 },
      { tab: 'tS', leaf: 'tS-b', index: 2 }
    ])
  })

  it('los panes de un proyecto plegado tampoco aparecen', () => {
    const rows = listRows({ projects: [p1], workspaces: [local1] }, { tabs: [splitTab('tS', 'w-local1')] }, { p1: true })

    expect(rows.map((r) => r.key)).toEqual(['p:p1'])
  })

  it('rowKey construye claves con prefijo por tipo', () => {
    expect(rowKey.project('p1')).toBe('p:p1')
    expect(rowKey.workspace('w1')).toBe('ws:w1')
    expect(rowKey.tab('t1')).toBe('t:t1')
    expect(rowKey.pane('l1')).toBe('pane:l1')
  })

  it('la clave de un pane no se confunde con la de un proyecto', () => {
    expect(rowKey.pane('x').startsWith('p:')).toBe(false)
  })
})

describe('cursorAfterExit', () => {
  const home = workspace('w1', 'p1')

  it('sobre un pane que sigue listado no se mueve', () => {
    const lay = { tabs: [splitTab('t', 'w1')] }
    expect(cursorAfterExit('pane:t-a', lay, 'otro', home)).toBe('pane:t-a')
  })

  it('sobre un pane cuyo tab quedó con uno solo baja al tab', () => {
    const lay = { tabs: [tab('t', 'w1')] }
    expect(cursorAfterExit('pane:t-leaf', lay, 't', home)).toBe('t:t')
  })

  it('sobre el pane que murió va al tab que lo tenía si sobrevive', () => {
    const lay = { tabs: [splitTab('t', 'w1')] }
    expect(cursorAfterExit('pane:muerto', lay, 't', home)).toBe('t:t')
  })

  it('sobre un tab o pane cuyo tab desapareció sube al workspace', () => {
    expect(cursorAfterExit('t:muerto', { tabs: [] }, 'muerto', home)).toBe('p:p1')
    expect(cursorAfterExit('pane:muerto', { tabs: [] }, 'muerto', home)).toBe('p:p1')
  })

  it('sobre un tab vivo, un proyecto o un workspace no se mueve', () => {
    const lay = { tabs: [tab('t', 'w1')] }
    expect(cursorAfterExit('t:t', lay, 'otro', home)).toBe('t:t')
    expect(cursorAfterExit('p:p1', { tabs: [] }, 'otro', home)).toBe('p:p1')
    expect(cursorAfterExit('ws:w1', { tabs: [] }, 'otro', home)).toBe('ws:w1')
    expect(cursorAfterExit(null, { tabs: [] }, 'otro', home)).toBeNull()
  })
})

describe('agregados de estado', () => {
  it('workspaceStatus es null sin sesiones', () => {
    expect(workspaceStatus({ sessions: [], activity: {}, attention: {} }, 'w1', NOW)).toBeNull()
  })

  it('workspaceStatus: la pregunta manda sobre el trabajo', () => {
    const s = {
      sessions: [session('a', 'w1'), session('b', 'w1')],
      activity: { a: { lastOutput: NOW }, b: { lastOutput: NOW } },
      attention: { b: true as const }
    }

    expect(workspaceStatus(s, 'w1', NOW)).toBe('question')
  })

  it('workspaceStatus: trabajando si ninguna pregunta y alguna trabaja', () => {
    const s = {
      sessions: [session('a', 'w1'), session('b', 'w1')],
      activity: { a: { lastOutput: NOW }, b: { lastOutput: NOW - 60_000 } },
      attention: {}
    }

    expect(workspaceStatus(s, 'w1', NOW)).toBe('working')
  })

  it('workspaceStatus ignora sesiones de otros workspaces', () => {
    const s = { sessions: [session('a', 'w2')], activity: {}, attention: { a: true as const } }

    expect(workspaceStatus(s, 'w1', NOW)).toBeNull()
  })

  it('tabStatus: pregunta gana, luego trabajo, luego listo', () => {
    const t = splitTab('t', 'w1')
    expect(tabStatus({ activity: { 't-a': { lastOutput: NOW } }, attention: { 't-b': true as const } }, t, NOW)).toBe('question')
    expect(tabStatus({ activity: { 't-a': { lastOutput: NOW } }, attention: {} }, t, NOW)).toBe('working')
    expect(tabStatus({ activity: {}, attention: {} }, t, NOW)).toBe('idle')
  })

  it('projectStatus es null sin sesiones en el proyecto', () => {
    const s = { workspaces: [workspace('w1', 'p1')], sessions: [], activity: {}, attention: {} }

    expect(projectStatus(s, 'p1', NOW)).toBeNull()
  })

  it('projectStatus: la pregunta de cualquier workspace manda', () => {
    const s = {
      workspaces: [workspace('w1', 'p1'), workspace('w2', 'p1')],
      sessions: [session('a', 'w1'), session('b', 'w2')],
      activity: { a: { lastOutput: NOW } },
      attention: { b: true as const }
    }

    expect(projectStatus(s, 'p1', NOW)).toBe('question')
  })

  it('projectStatus: trabajando sobre listo', () => {
    const s = {
      workspaces: [workspace('w1', 'p1'), workspace('w2', 'p1')],
      sessions: [session('a', 'w1'), session('b', 'w2')],
      activity: { a: { lastOutput: NOW } },
      attention: {}
    }

    expect(projectStatus(s, 'p1', NOW)).toBe('working')
  })

  it('projectStatus: listo si hay sesiones y ninguna trabaja ni pregunta', () => {
    const s = {
      workspaces: [workspace('w1', 'p1')],
      sessions: [session('a', 'w1')],
      activity: {},
      attention: {}
    }

    expect(projectStatus(s, 'p1', NOW)).toBe('idle')
  })

  it('attentionCount cuenta las sesiones con pregunta pendiente', () => {
    expect(attentionCount({ attention: { a: true, b: true } })).toBe(2)
    expect(attentionCount({ attention: {} })).toBe(0)
  })
})

describe('utilidades de texto', () => {
  it('shortPath reemplaza el home de macOS por ~', () => {
    expect(shortPath('/Users/x/dev')).toBe('~/dev')
    expect(shortPath('/opt/proyecto')).toBe('/opt/proyecto')
  })

  it('plural elige singular solo para 1', () => {
    expect(plural(1, 'sesión', 'sesiones')).toBe('1 sesión')
    expect(plural(0, 'sesión', 'sesiones')).toBe('0 sesiones')
    expect(plural(2, 'sesión', 'sesiones')).toBe('2 sesiones')
  })
})

describe('acciones sin IPC', () => {
  it('setTitle recorta el texto', () => {
    useSessions.getState().setTitle('s1', '  Claude  ')

    expect(useSessions.getState().titles.s1).toBe('Claude')
  })

  it('setTitle con el mismo valor no vuelve a escribir el estado', () => {
    useSessions.getState().setTitle('s1', 'Claude')
    const before = useSessions.getState().titles

    useSessions.getState().setTitle('s1', ' Claude ')

    expect(useSessions.getState().titles).toBe(before)
  })

  it('markAttention y clearAttention activan y quitan la pregunta', () => {
    useSessions.getState().markAttention('s1')
    expect(useSessions.getState().attention.s1).toBe(true)

    useSessions.getState().clearAttention('s1')
    expect(useSessions.getState().attention.s1).toBeUndefined()
  })

  it('markAttention repetido no cambia el estado', () => {
    useSessions.getState().markAttention('s1')
    const before = useSessions.getState().attention

    useSessions.getState().markAttention('s1')

    expect(useSessions.getState().attention).toBe(before)
  })

  it('clearAttention sobre una sesión sin pregunta no cambia el estado', () => {
    const before = useSessions.getState().attention

    useSessions.getState().clearAttention('s1')

    expect(useSessions.getState().attention).toBe(before)
  })

  it('syncCursor pone el cursor en el tab que contiene la sesión', () => {
    const t = useLayout.getState().openTab('w1', 's1')
    useSessions.setState({ currentWorkspaceId: null, cursor: null })

    useSessions.getState().syncCursor('s1')

    expect(useSessions.getState().cursor).toBe(rowKey.tab(t.id))
    expect(useSessions.getState().currentWorkspaceId).toBe('w1')
  })

  it('syncCursor con varios panes deja el cursor sobre la fila del pane', () => {
    const t = useLayout.getState().openTab('w1', 's1')
    useLayout.getState().split('w1', 'row', 's2')
    useSessions.setState({ currentWorkspaceId: null, cursor: null })

    useSessions.getState().syncCursor('s1')

    const leaf = useLayout.getState().tabs[0].root
    const leafA = leaf.kind === 'split' ? leaf.children[0] : leaf
    expect(useSessions.getState().cursor).toBe(rowKey.pane(leafA.id))
    expect(useLayout.getState().activeTab.w1).toBe(t.id)
    expect(useSessions.getState().currentWorkspaceId).toBe('w1')
  })

  it('syncCursor con una sesión sin tab no cambia el cursor', () => {
    useSessions.setState({ cursor: 'ws:w1' })

    useSessions.getState().syncCursor('fantasma')

    expect(useSessions.getState().cursor).toBe('ws:w1')
  })

  it('setCursor sobre una fila de tab activa ese tab y fija el workspace', () => {
    const p1 = project('p1')
    const w1 = workspace('w1', 'p1')
    useSessions.setState({ projects: [p1], workspaces: [w1] })
    const t1 = useLayout.getState().openTab('w1', 'a')
    useLayout.getState().openTab('w1', 'b')

    useSessions.getState().setCursor(rowKey.tab(t1.id))

    expect(useLayout.getState().activeTab.w1).toBe(t1.id)
    expect(useSessions.getState().cursor).toBe(rowKey.tab(t1.id))
    expect(useSessions.getState().currentWorkspaceId).toBe('w1')
  })

  it('setCursor sobre un pane activa su tab, le da el foco del layout y deja el cursor en el pane', () => {
    useSessions.setState({ projects: [project('p1')], workspaces: [workspace('w1', 'p1')] })
    const t1 = useLayout.getState().openTab('w1', 'a')
    useLayout.getState().split('w1', 'row', 'b')
    useLayout.getState().openTab('w1', 'c')
    const root = useLayout.getState().tabs[0].root
    const leafA = root.kind === 'split' ? root.children[0] : root

    useSessions.getState().setCursor(rowKey.pane(leafA.id))

    expect(useLayout.getState().activeTab.w1).toBe(t1.id)
    expect(useLayout.getState().tabs[0].focusedPaneId).toBe(leafA.id)
    expect(useSessions.getState().cursor).toBe(rowKey.pane(leafA.id))
    expect(useSessions.getState().currentWorkspaceId).toBe('w1')
  })

  it('activatePane con un pane que no es del tab no hace nada', () => {
    useSessions.setState({ projects: [project('p1')], workspaces: [workspace('w1', 'p1')], cursor: 'p:p1' })
    const t1 = useLayout.getState().openTab('w1', 'a')

    useSessions.getState().activatePane(t1.id, 'fantasma')

    expect(useSessions.getState().cursor).toBe('p:p1')
  })

  it('moveCursor pasa por los panes de un tab con split', () => {
    useSessions.setState({ projects: [project('p1')], workspaces: [workspace('w1', 'p1')], cursor: rowKey.project('p1') })
    const t1 = useLayout.getState().openTab('w1', 'a')
    useLayout.getState().split('w1', 'row', 'b')
    const root = useLayout.getState().tabs[0].root
    const [leafA, leafB] = root.kind === 'split' ? root.children : [root, root]

    useSessions.getState().moveCursor(1)
    expect(useSessions.getState().cursor).toBe(rowKey.tab(t1.id))
    useSessions.getState().moveCursor(1)
    expect(useSessions.getState().cursor).toBe(rowKey.pane(leafA.id))
    expect(useLayout.getState().tabs[0].focusedPaneId).toBe(leafA.id)
    useSessions.getState().moveCursor(1)
    expect(useSessions.getState().cursor).toBe(rowKey.pane(leafB.id))
    expect(useLayout.getState().tabs[0].focusedPaneId).toBe(leafB.id)
    useSessions.getState().moveCursor(1)
    expect(useSessions.getState().cursor).toBe(rowKey.project('p1'))
  })

  it('setCursor sobre un proyecto apunta al workspace local', () => {
    const p1 = project('p1')
    useSessions.setState({
      projects: [p1],
      workspaces: [workspace('w-wt', 'p1', 'worktree'), workspace('w-local', 'p1')],
      currentWorkspaceId: 'w-wt'
    })

    useSessions.getState().setCursor(rowKey.project('p1'))

    expect(useSessions.getState().currentWorkspaceId).toBe('w-local')
    expect(useSessions.getState().cursor).toBe(rowKey.project('p1'))
  })

  it('setCursor con una clave que no está en el sidebar no hace nada', () => {
    useSessions.setState({ cursor: 'p:p1' })

    useSessions.getState().setCursor('t:fantasma')

    expect(useSessions.getState().cursor).toBe('p:p1')
  })

  it('moveCursor recorre las filas con wrap-around', () => {
    const p1 = project('p1')
    useSessions.setState({
      projects: [p1],
      workspaces: [workspace('w1', 'p1')],
      cursor: rowKey.project('p1')
    })
    const t1 = useLayout.getState().openTab('w1', 'a')
    const t2 = useLayout.getState().openTab('w1', 'b')

    useSessions.getState().moveCursor(1)
    expect(useSessions.getState().cursor).toBe(rowKey.tab(t1.id))
    useSessions.getState().moveCursor(1)
    expect(useSessions.getState().cursor).toBe(rowKey.tab(t2.id))
    useSessions.getState().moveCursor(1)
    expect(useSessions.getState().cursor).toBe(rowKey.project('p1'))
    useSessions.getState().moveCursor(-1)
    expect(useSessions.getState().cursor).toBe(rowKey.tab(t2.id))
  })

  it('moveCursor sin cursor válido va a la primera fila con J y a la última con K', () => {
    useSessions.setState({
      projects: [project('p1')],
      workspaces: [workspace('w1', 'p1')],
      cursor: 't:borrado'
    })
    const t1 = useLayout.getState().openTab('w1', 'a')

    useSessions.getState().moveCursor(-1)
    expect(useSessions.getState().cursor).toBe(rowKey.tab(t1.id))
    useSessions.setState({ cursor: 't:borrado' })
    useSessions.getState().moveCursor(1)
    expect(useSessions.getState().cursor).toBe(rowKey.project('p1'))
  })
})

describe('atención por salida cruda (§3.14)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('el BEL que cierra un OSC (título del prompt) no es campana; uno suelto sí', () => {
    expect(hasBell('\x1b]0;~/private/omni\x07λ ~/private/omni/ ')).toBe(false)
    expect(hasBell('\x1b]2;title\x1b\\')).toBe(false)
    expect(hasBell('\x1b]0;t\x07\x07')).toBe(true)
    expect(hasBell('Do you want to proceed?\x07')).toBe(true)
    expect(hasBell('sin campana')).toBe(false)
  })

  it('scanBell arrastra un OSC partido entre chunks: su BEL final no es campana', () => {
    const first = scanBell('\x1b]0;~/private/omni', false)
    expect(first).toEqual({ bell: false, inOsc: true })
    const second = scanBell('\x07λ ~/private/omni/ ', first.inOsc)
    expect(second).toEqual({ bell: false, inOsc: false })
    expect(scanBell('\x07', true)).toEqual({ bell: false, inOsc: false })
    expect(scanBell('\x1b\\', true)).toEqual({ bell: false, inOsc: false })
  })

  it('scanBell: un BEL suelto después de cerrar el OSC partido sí es campana', () => {
    expect(scanBell('\x07prompt\x07', true)).toEqual({ bell: true, inOsc: false })
    expect(scanBell('\x1b\\Do you want to proceed?\x07', true)).toEqual({ bell: true, inOsc: false })
    expect(scanBell('a\x07\x1b]0;t', false)).toEqual({ bell: true, inOsc: true })
  })

  it('un OSC partido en dos chunks de session:data no marca pregunta; un BEL suelto después sí', () => {
    useSessions.getState().onData('s1', '\x1b]0;~/private/omni')
    useSessions.getState().onData('s1', '\x07λ ~/private/omni/ ')
    expect(useSessions.getState().attention.s1).toBeUndefined()

    useSessions.getState().onData('s1', 'Do you want to proceed?\x07')
    expect(useSessions.getState().attention.s1).toBe(true)
  })

  it('session:exit olvida el OSC abierto: el BEL del chunk siguiente de un id reciclado cuenta', () => {
    useSessions.getState().onData('s1', '\x1b]0;abierto')
    useSessions.getState().onExit('s1')
    useSessions.getState().onData('s1', '\x07')

    expect(useSessions.getState().attention.s1).toBe(true)
  })

  it('un chunk con BEL marca la pregunta aunque el pane no tenga xterm', () => {
    useSessions.getState().onData('s1', 'Do you want to proceed?\x07')

    expect(useSessions.getState().attention.s1).toBe(true)
  })

  it('un chunk sin BEL no marca nada y anota la actividad', () => {
    vi.setSystemTime(NOW)
    useSessions.getState().onData('s1', 'hola')

    expect(useSessions.getState().attention.s1).toBeUndefined()
    expect(useSessions.getState().activity.s1?.lastOutput).toBe(NOW)
  })
})

describe('sin leer (§3.14)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    useSessions.setState({ projects: [project('p1')], workspaces: [workspace('w1', 'p1')], sessions: [session('a', 'w1'), session('b', 'w1')], currentWorkspaceId: 'w1' })
  })
  afterEach(() => vi.useRealTimers())

  it('becomesUnread: salida después de la última vista, viva y sin foco', () => {
    const base = { sessions: [session('a', 'w1')], activity: { a: { lastOutput: NOW } }, seen: {}, unread: {} }
    expect(becomesUnread(base, 'a', null, true)).toBe(true)
    expect(becomesUnread({ ...base, seen: { a: NOW + 1 } }, 'a', null, true)).toBe(false)
    expect(becomesUnread({ ...base, seen: { a: NOW - 1 } }, 'a', null, true)).toBe(true)
    expect(becomesUnread(base, 'a', 'a', true)).toBe(false)
    expect(becomesUnread({ ...base, unread: { a: true } }, 'a', null, true)).toBe(false)
    expect(becomesUnread({ ...base, sessions: [] }, 'a', null, true)).toBe(false)
    expect(becomesUnread({ ...base, activity: {} }, 'a', null, true)).toBe(false)
  })

  it('becomesUnread: la sesión con foco también queda sin leer si nadie la mira (otra vista encima o app en segundo plano)', () => {
    const base = { sessions: [session('a', 'w1')], activity: { a: { lastOutput: NOW } }, seen: {}, unread: {} }
    expect(becomesUnread(base, 'a', 'a', false)).toBe(true)
    expect(becomesUnread({ ...base, seen: { a: NOW + 1 } }, 'a', 'a', false)).toBe(false)
  })

  /** Ráfaga de trabajo real: salida que dura `MIN_WORK_MS` (spinner, respuesta). */
  const work = (id: string): void => {
    useSessions.getState().onData(id, 'trabajando')
    vi.advanceTimersByTime(MIN_WORK_MS)
    useSessions.getState().onData(id, 'listo')
  }

  it('pasa a sin leer cuando se calla tras WORKING_WINDOW_MS con el pane fuera de pantalla', () => {
    work('a')
    vi.advanceTimersByTime(WORKING_WINDOW_MS - 1)
    expect(useSessions.getState().unread.a).toBeUndefined()

    vi.advanceTimersByTime(1)

    expect(useSessions.getState().unread.a).toBe(true)
    expect(unreadCount(useSessions.getState())).toBe(1)
  })

  it('cada chunk rearma el temporizador: mientras habla no es sin leer', () => {
    useSessions.getState().onData('a', 'uno')
    vi.advanceTimersByTime(WORKING_WINDOW_MS - 100)
    useSessions.getState().onData('a', 'dos')
    vi.advanceTimersByTime(WORKING_WINDOW_MS - 100)
    expect(useSessions.getState().unread.a).toBeUndefined()

    vi.advanceTimersByTime(100)
    expect(useSessions.getState().unread.a).toBe(true)
  })

  it('no queda sin leer si el pane se vio después de la última salida', () => {
    useSessions.getState().onData('a', 'salida')
    vi.setSystemTime(NOW + 10)
    useSessions.getState().markSeen('a')

    vi.advanceTimersByTime(WORKING_WINDOW_MS)

    expect(useSessions.getState().unread.a).toBeUndefined()
    expect(useSessions.getState().seen.a).toBe(NOW + 10)
  })

  it('la sesión con foco del layout no queda sin leer mientras la app está a la vista', () => {
    useUi.setState({ view: 'fleet', windowFocused: true })
    useLayout.getState().openTab('w1', 'a')
    useSessions.getState().onData('a', 'salida')

    vi.advanceTimersByTime(WORKING_WINDOW_MS)

    expect(useSessions.getState().unread.a).toBeUndefined()
  })

  it('la sesión con foco sí queda sin leer con la ventana en segundo plano u otra vista encima', () => {
    // Ventana en segundo plano: main avisa `window:focus(false)` (el blur del documento no basta, §3.14).
    useUi.setState({ view: 'fleet', windowFocused: false })
    useLayout.getState().openTab('w1', 'a')
    work('a')
    vi.advanceTimersByTime(WORKING_WINDOW_MS)
    expect(useSessions.getState().unread.a).toBe(true)

    useUi.setState({ view: 'worktrees', windowFocused: true })
    work('b')
    useLayout.getState().openTab('w1', 'b')
    vi.advanceTimersByTime(WORKING_WINDOW_MS)
    expect(useSessions.getState().unread.b).toBe(true)
    useUi.setState({ view: 'fleet' })
  })

  it('un redibujo instantáneo no es trabajo: con omni en segundo plano no queda sin leer ni dispara "terminó"', () => {
    // Al perder el foco o cambiar de tamaño, Claude Code se redibuja de un golpe (bug de notificaciones sin fin).
    useUi.setState({ view: 'fleet', windowFocused: false })
    useLayout.getState().openTab('w1', 'a')
    useSessions.getState().onData('a', '\x1b[2J redibujo')
    useSessions.getState().onData('a', 'resto del redibujo')
    vi.advanceTimersByTime(WORKING_WINDOW_MS)
    expect(useSessions.getState().unread.a).toBeUndefined()
    // Una ráfaga corta fuera de pantalla tampoco.
    useSessions.getState().onData('b', 'x')
    vi.advanceTimersByTime(MIN_WORK_MS - 1)
    useSessions.getState().onData('b', 'y')
    vi.advanceTimersByTime(WORKING_WINDOW_MS)
    expect(useSessions.getState().unread.b).toBeUndefined()
    useUi.setState({ windowFocused: true })
  })

  it('session:exit cancela el temporizador de reposo: la sesión muerta no queda sin leer', () => {
    useSessions.getState().onData('a', 'salida')
    useSessions.getState().onExit('a')

    vi.advanceTimersByTime(WORKING_WINDOW_MS)

    expect(useSessions.getState().unread.a).toBeUndefined()
    expect(useSessions.getState().sessions.map((x) => x.id)).toEqual(['b'])
  })

  it('markSeen limpia el sin leer', () => {
    useSessions.setState({ unread: { a: true, b: true } })

    useSessions.getState().markSeen('a')

    expect(useSessions.getState().unread).toEqual({ b: true })
    expect(unreadCount(useSessions.getState())).toBe(1)
  })

  it('markSeen conserva la identidad de unread si la sesión no estaba sin leer', () => {
    useSessions.setState({ unread: { b: true } })
    const before = useSessions.getState().unread

    useSessions.getState().markSeen('a')

    expect(useSessions.getState().unread).toBe(before)
    expect(useSessions.getState().seen.a).toBe(NOW)
  })

  it('tabUnread: el tab hereda el sin leer de cualquiera de sus panes', () => {
    const t = splitTab('t', 'w1')
    expect(tabUnread({ unread: { 't-b': true } }, t)).toBe(true)
    expect(tabUnread({ unread: { otro: true } }, t)).toBe(false)
  })
})

describe('atención por el diálogo de confianza de Claude Code (§3.13)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useSessions.setState({ attention: {} })
  })
  afterEach(() => {
    useSessions.getState().onExit('trust-1')
    useSessions.getState().onExit('trust-2')
    vi.useRealTimers()
  })

  const PROMPT = '\x1b[1mQuick safety check:\x1b[0m Is this a project you created or one you trust?\r\n ❯ 1. Yes, proceed\r\n   2. No, exit\r\n'

  it('el marcador partido en dos chunks (y con una secuencia ANSI partida) marca pregunta sin BEL', () => {
    useSessions.getState().onData('trust-1', '╭───╮\r\n│ Accessing works')
    expect(useSessions.getState().attention['trust-1']).toBeUndefined()
    useSessions.getState().onData('trust-1', 'pace: /tmp/p\r\n')
    expect(useSessions.getState().attention['trust-1']).toBe(true)
  })

  it('una sola marca por aparición: los repintados del diálogo no la vuelven a poner tras atenderla', () => {
    expect(scanTrustPrompt('trust-2', PROMPT)).toBe(true)
    expect(scanTrustPrompt('trust-2', PROMPT)).toBe(false)
    expect(scanTrustPrompt('trust-2', ' ❯ 2. No, exit\r\n')).toBe(false)
    // La sesión sigue: el diálogo sale del buffer y una aparición nueva vuelve a contar.
    expect(scanTrustPrompt('trust-2', 'x'.repeat(TRUST_BUFFER_CHARS))).toBe(false)
    expect(scanTrustPrompt('trust-2', PROMPT)).toBe(true)
  })

  it('se limpia como una pregunta normal: clearAttention (el usuario escribió) y onExit', () => {
    useSessions.getState().onData('trust-1', PROMPT)
    expect(useSessions.getState().attention['trust-1']).toBe(true)
    useSessions.getState().clearAttention('trust-1')
    expect(useSessions.getState().attention['trust-1']).toBeUndefined()
    // Con el diálogo aún en pantalla, más chunks del mismo diálogo no lo vuelven a marcar.
    useSessions.getState().onData('trust-1', ' ❯ 1. Yes, proceed\r\n')
    expect(useSessions.getState().attention['trust-1']).toBeUndefined()
    useSessions.getState().onData('trust-1', 'sin marcador')
    expect(hasBell('sin marcador')).toBe(false)
  })
})

describe('screenQuestion (pantalla renderizada de una TUI a pantalla completa)', () => {
  it('reconoce el permiso real de Claude Code tal como lo pinta xterm', async () => {
    const { screenQuestion } = await import('./sessions')
    const screen = [
      '❯ Crea un archivo nota.txt con el texto hola. No hagas nada más.',
      '⏺ Write(nota.txt)',
      ' Create file',
      ' nota.txt',
      '  1 hola',
      ' Do you want to create nota.txt?                                               ◐',
      '─❯─1. Yes───────────────────────────────────────────────────────',
      '───2. Yes,─and─switch─to─accept edits (auto-approve file edits)'
    ]
    expect(screenQuestion('claude', screen)).toBe('edit:nota.txt')
    expect(screenQuestion('claude', ['❯ Try "refactor <filepath>"', '-- INSERT --'])).toBeNull()
  })
})

describe('liveAgent', () => {
  const claude: SessionInfo = { id: 'c', agent: 'claude', workspaceId: 'w', cwd: '/', createdAt: NOW }
  const shell: SessionInfo = { id: 's', agent: 'shell', workspaceId: 'w', cwd: '/', createdAt: NOW }
  const later = NOW + AGENT_LAUNCH_GRACE_MS

  it('reconoce shells, también como login shell', () => {
    expect(isShellProcess('zsh')).toBe(true)
    expect(isShellProcess('-zsh')).toBe(true)
    expect(isShellProcess('/bin/bash')).toBe(true)
    expect(isShellProcess('2.1.301')).toBe(false)
    expect(isShellProcess('vim')).toBe(false)
  })

  it('un agente que salió y dejó el shell en primer plano se muestra como shell', () => {
    expect(liveAgent({ agents: AGENTS, foreground: { c: 'zsh' } }, claude, later)).toBe('shell')
    // Recién creada: el shell aún no escribió el comando del agente.
    expect(liveAgent({ agents: AGENTS, foreground: { c: 'zsh' } }, claude, NOW + 100)).toBe('claude')
    expect(agentExited({ agents: AGENTS, foreground: { c: 'zsh' } }, claude, later)).toBe(true)
    // Un shell que vuelve a su prompt no "salió" de nada.
    expect(agentExited({ agents: AGENTS, foreground: { s: 'zsh' } }, shell, later)).toBe(false)
  })

  it('cuando el agente sale, su pregunta pendiente se limpia', async () => {
    const { omni } = await import('@/lib/omni')
    const session: SessionInfo = { ...claude, id: 'exit-q', createdAt: Date.now() - AGENT_LAUNCH_GRACE_MS * 2 }
    useSessions.setState({ agents: AGENTS, sessions: [session], foreground: { 'exit-q': '2.1.301' }, attention: { 'exit-q': true } })
    vi.mocked(omni.invoke).mockResolvedValueOnce({ 'exit-q': 'zsh' } as never)
    await useSessions.getState().refreshForeground()
    expect(useSessions.getState().attention['exit-q']).toBeUndefined()
  })

  it('el agente corriendo (aunque el binario se llame por su versión) conserva su icono', () => {
    expect(liveAgent({ agents: AGENTS, foreground: { c: '2.1.301' } }, claude, later)).toBe('claude')
  })

  it('un shell donde se lanzó un agente conocido toma su icono; sin dato manda el de origen', () => {
    expect(liveAgent({ agents: AGENTS, foreground: { s: 'claude' } }, shell, later)).toBe('claude')
    expect(liveAgent({ agents: AGENTS, foreground: { s: 'vim' } }, shell, later)).toBe('shell')
    // `claude` a mano en un shell: el binario nativo se llama por su versión.
    expect(liveAgent({ agents: AGENTS, foreground: { s: '2.1.301' } }, shell, later)).toBe('claude')
    expect(liveAgent({ agents: AGENTS, foreground: {} }, claude, later)).toBe('claude')
  })
})

describe('createErrorText', () => {
  it('explica el agotamiento de PTYs y limpia el prefijo de IPC en lo demás', () => {
    expect(createErrorText(new Error("Error invoking remote method 'session:create': Error: posix_spawnp failed."))).toMatch(/sin PTYs/)
    expect(createErrorText(new Error("Error invoking remote method 'session:create': Error: workspace desconocido: x"))).toBe('No se pudo abrir la sesión: workspace desconocido: x')
  })
})

describe('proyectos ocultos y subcarpetas (§3.5c)', () => {
  const p1 = { ...project('p1'), hidden: true as const }
  const p2 = project('p2')
  const s = { projects: [p1, p2], workspaces: [workspace('l1', 'p1'), workspace('f1', 'p1', 'folder'), workspace('wt2', 'p2', 'worktree'), workspace('l2', 'p2')] }

  it('visibleProjects y firstVisibleWorkspace saltan los ocultos; el primero visible cae en su local', () => {
    expect(visibleProjects(s.projects, false)).toEqual([p2])
    expect(visibleProjects(s.projects, true)).toEqual([p1, p2])
    expect(firstVisibleWorkspace(s, false)?.id).toBe('l2')
    expect(firstVisibleWorkspace(s, true)?.id).toBe('l1')
    expect(firstVisibleWorkspace({ projects: [p1], workspaces: [workspace('l1', 'p1')] }, false)).toBeUndefined()
  })

  it('inHiddenProject y placeLabel: la subcarpeta lleva su nombre como el worktree', () => {
    expect(inHiddenProject(s, 'f1')).toBe(true)
    expect(inHiddenProject(s, 'l2')).toBe(false)
    expect(placeLabel(s, 'l1')).toBe('Proyecto p1')
    expect(placeLabel(s, 'f1')).toBe('Proyecto p1 · f1')
    expect(placeLabel(s, 'wt2')).toBe('Proyecto p2 · wt2')
  })
})

describe('un proyecto es solo un nombre: 0, 1 o varias ubicaciones (§3.5c)', () => {
  const empty: Project = { id: 'p0', name: 'Vacío', locations: [] }
  const single = project('p1')
  const group: Project = {
    id: 'p2',
    name: 'Shop',
    locations: [
      { id: 'p2', name: 'shop', path: '/Users/x/shop' },
      { id: 'vps', name: 'api', path: '/srv/api', host: 'h1' }
    ]
  }
  const workspaces = [workspace('p1', 'p1'), workspace('p2', 'p2', 'folder'), workspace('vps', 'p2', 'folder'), workspace('wt', 'p2', 'worktree')]
  const state = { projects: [empty, single, group], workspaces }
  const lay = { tabs: [tab('t1', 'p1'), tab('tFirst', 'p2'), tab('tApi', 'vps'), tab('tWt', 'wt')] }

  it('listRows: vacío = solo la cabecera; una = tabs bajo el proyecto; varias = cada ubicación con su fila y sus tabs (también la primera)', () => {
    expect(listRows(state, lay).map((r) => r.key)).toEqual(['p:p0', 'p:p1', 't:t1', 'p:p2', 'ws:p2', 't:tFirst', 'ws:vps', 't:tApi', 'ws:wt', 't:tWt'])
  })

  it('cursorOf: la única ubicación es su proyecto; en un grupo cada ubicación es su fila', () => {
    expect(cursorOf(workspaces[0])).toBe('p:p1')
    expect(cursorOf(workspaces[1])).toBe('ws:p2')
  })

  it('primaryWorkspace y firstVisibleWorkspace: la primera ubicación, nunca un worktree; un proyecto vacío se salta', () => {
    expect(primaryWorkspace(state, 'p2')?.id).toBe('p2')
    expect(primaryWorkspace(state, 'p0')).toBeUndefined()
    expect(primaryWorkspace({ workspaces: [workspace('wt', 'p2', 'worktree')] }, 'p2')).toBeUndefined()
    expect(firstVisibleWorkspace(state, false)?.id).toBe('p1')
  })

  it('setCursor en la cabecera: un grupo apunta a su primera ubicación; uno vacío no apunta a nada y sigue siendo el proyecto actual', () => {
    useSessions.setState({ ...state, currentWorkspaceId: 'p1', cursor: 'p:p1' })
    useSessions.getState().setCursor('p:p2')
    expect(useSessions.getState().currentWorkspaceId).toBe('p2')
    useSessions.getState().setCursor('p:p0')
    expect(useSessions.getState().currentWorkspaceId).toBeNull()
    expect(currentProjectOf(useSessions.getState())?.id).toBe('p0')
    useSessions.getState().setCursor('ws:vps')
    expect(currentProjectOf(useSessions.getState())?.id).toBe('p2')
  })

  it('placeLabel: con varias ubicaciones lleva el nombre de la carpeta, con una sola solo el proyecto', () => {
    expect(placeLabel(state, 'p1')).toBe('Proyecto p1')
    expect(placeLabel(state, 'p2')).toBe('Shop · p2')
  })
})

describe('reviveNotice', () => {
  it('sin sesiones revividas no hay aviso', () => {
    expect(reviveNotice({ sessions: 0, resumed: 0 })).toBeNull()
  })

  it('singular y plural, con los agentes que retomaron su conversación', () => {
    expect(reviveNotice({ sessions: 1, resumed: 0 })).toBe('Se restauró 1 terminal de antes del reinicio')
    expect(reviveNotice({ sessions: 1, resumed: 1 })).toBe('Se restauró 1 terminal de antes del reinicio: 1 agente retomó su conversación')
    expect(reviveNotice({ sessions: 3, resumed: 0 })).toBe('Se restauraron 3 terminales de antes del reinicio')
    expect(reviveNotice({ sessions: 3, resumed: 2 })).toBe('Se restauraron 3 terminales de antes del reinicio: 2 agentes retomaron su conversación')
  })
})

describe('lastArtifactUrl', () => {
  it('toma el último artifact del chunk, en texto plano o dentro de un OSC 8', () => {
    expect(lastArtifactUrl('Listo: https://claude.ai/code/artifact/aaa y luego https://claude.ai/artifact/bbb.')).toBe('https://claude.ai/artifact/bbb')
    expect(lastArtifactUrl('\x1b]8;;https://claude.ai/artifact/ccc\x07ver\x1b]8;;\x07')).toBe('https://claude.ai/artifact/ccc')
    expect(lastArtifactUrl('https://claude.ai/new')).toBeNull()
  })
})

describe('setTitle · línea de comando del agente', () => {
  it('no pisa un nombre que ya hay, pero sí lo pone si no había ninguno', () => {
    useSessions.setState({ agents: AGENTS, sessions: [session('x', 'w')], titles: { x: 'bug-prd' } })
    useSessions.getState().setTitle('x', 'claude --session-id d23a')
    expect(useSessions.getState().titles.x).toBe('bug-prd')
    useSessions.getState().setTitle('x', 'otro tema')
    expect(useSessions.getState().titles.x).toBe('otro tema')
  })
})
