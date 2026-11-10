import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserState, ControlCommand, Project, SessionInfo, Workspace } from '@shared/types'
import { useBrowser } from './browser'
import { useControl } from './control'
import { useLayout } from './layout'
import { enterSession } from './notify'
import { useSessions } from './sessions'
import { useTodos } from './todos'
import { useUi } from './ui'

const invoke = vi.fn()
const send = vi.fn()
/** Listeners de `omni.on` por canal, para disparar `app:command` a mano. */
const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}

vi.mock('@/lib/omni', () => ({
  omni: {
    invoke: (...args: unknown[]) => invoke(...args),
    send: (...args: unknown[]) => send(...args),
    on: (channel: string, cb: (...args: unknown[]) => void) => {
      ;(listeners[channel] ??= []).push(cb)
      return () => {
        listeners[channel] = (listeners[channel] ?? []).filter((x) => x !== cb)
      }
    }
  }
}))
vi.mock('@/panes/terminal/terminal-host', () => ({
  screenLines: () => null, disposeTerminal: vi.fn(), getTerminal: vi.fn(() => undefined), blurTerminals: vi.fn() }))
// El store del navegador real toca el DOM: aquí basta un store con `states`, `navigate` y `notify`.
vi.mock('./browser', async () => {
  const { create } = await import('zustand')
  const useBrowser = create<{ states: Record<string, BrowserState>; notices: Record<string, string>; navigate: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn>; blur: ReturnType<typeof vi.fn> }>(() => ({
    states: {},
    notices: {},
    navigate: vi.fn(() => Promise.resolve()),
    notify: vi.fn(),
    blur: vi.fn()
  }))
  return { useBrowser, liveBrowserId: () => null, isBlank: () => true }
})
vi.mock('./notify', () => ({ enterSession: vi.fn() }))
const { reviewOpen, docsOpen } = vi.hoisted(() => ({
  reviewOpen: vi.fn(() => Promise.resolve()),
  docsOpen: vi.fn((workspaceId: string, path: string, kind: string) => Promise.resolve({ id: 'd-new', agent: kind, workspaceId, cwd: '/x', args: [path], createdAt: 0 }))
}))
vi.mock('./review', () => ({ useReview: { getState: () => ({ open: reviewOpen }) } }))
vi.mock('./docs', () => ({ useDocs: { getState: () => ({ open: docsOpen }) } }))

const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime()
const project = (id: string): Project => ({ id, name: id, locations: [{ id, name: 'Local', path: `/x/${id}` }] })
const ws = (id: string, projectId: string): Workspace => ({ id, projectId, name: id, path: `/x/${projectId}`, kind: 'local' })
const session = (id: string, workspaceId: string, agent: SessionInfo['agent'] = 'claude'): SessionInfo => ({ id, agent, workspaceId, cwd: `/x`, createdAt: NOW }) as SessionInfo
const state = (url: string, loading = false): BrowserState => ({ url, title: '', loading, canGoBack: false, canGoForward: false, devtools: false, profileId: '', viewport: null })
const cmd = (type: ControlCommand['type'], args: Record<string, unknown>, from = 'mcp:claude', id = 1): ControlCommand => ({ id, type, from, args })
const emit = (channel: string, ...args: unknown[]): void => (listeners[channel] ?? []).forEach((cb) => cb(...args))
const browser = (): { navigate: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> } => useBrowser.getState() as unknown as { navigate: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> }

let stop: () => void = () => {}

beforeEach(() => {
  invoke.mockReset()
  send.mockReset()
  vi.mocked(enterSession).mockReset()
  docsOpen.mockClear()
  Object.keys(listeners).forEach((k) => delete listeners[k])
  useSessions.setState({ projects: [project('p1')], workspaces: [ws('w1', 'p1')], sessions: [], currentWorkspaceId: 'w1', cursor: null, ready: true })
  useLayout.setState({ tabs: [], activeTab: {} })
  useUi.setState({ overlay: null, view: 'fleet', focus: 'list', collapsed: {} })
  useTodos.setState({ todos: [], loaded: true, cursor: null, undo: null, doneOpen: false, composing: false, pendingLaunch: null })
  useBrowser.setState({ states: {}, notices: {} })
  browser().navigate.mockClear()
  browser().notify.mockClear()
  useControl.setState({ banner: null })
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'session:create': {
        const input = args[0] as { agent: SessionInfo['agent']; workspaceId: string }
        return session('b-new', input.workspaceId, input.agent)
      }
      case 'project:addPath':
        return { project: project('p2'), workspace: ws('w2', 'p2') }
      case 'project:list':
        return { projects: [project('p1'), project('p2')], workspaces: [ws('w1', 'p1'), ws('w2', 'p2')] }
      case 'browser:capture':
        return { path: '/caps/x.png', width: 1280, height: 800 }
      default:
        return undefined
    }
  })
})

afterEach(() => {
  stop()
  stop = () => {}
  vi.useRealTimers()
})

describe('init', () => {
  it('cada app:command responde con app:commandResult, también cuando los argumentos no valen', async () => {
    stop = useControl.getState().init()
    emit('app:command', cmd('todo', {}, 'cli', 7))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('app:commandResult', 7, { ok: false, error: 'todo: falta el texto (text)' }))
  })

  it('control:sent (send resuelto en main) pinta CLI / MCP · agente en la franja de esa sesión; una sesión desconocida no pinta nada', () => {
    useSessions.setState({ sessions: [session('s1', 'w1')] })
    stop = useControl.getState().init()
    emit('control:sent', 's1', 'mcp:codex')
    expect(browser().notify).toHaveBeenCalledWith('s1', 'MCP · codex')
    emit('control:sent', 's1', 'cli')
    expect(browser().notify).toHaveBeenCalledWith('s1', 'CLI')
    browser().notify.mockClear()
    emit('control:sent', 's9', 'cli')
    expect(browser().notify).not.toHaveBeenCalled()
    // Al parar, deja de escuchar los dos canales.
    stop()
    stop = () => {}
    expect(listeners['control:sent'] ?? []).toHaveLength(0)
    expect(listeners['app:command'] ?? []).toHaveLength(0)
  })

  it('un fallo del store vuelve como error humano, nunca como excepción', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'project:addPath') throw new Error("Error invoking remote method 'project:addPath': Error: la ruta no existe")
      return undefined
    })
    stop = useControl.getState().init()
    emit('app:command', cmd('open', { path: '/nada' }, 'cli', 3))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('app:commandResult', 3, { ok: false, error: 'la ruta no existe' }))
  })
})

describe('dispatch', () => {
  it('open carpeta: project:addPath, recarga y deja ese workspace como actual', async () => {
    const r = await useControl.getState().dispatch(cmd('open', { path: '/x/p2', kind: 'dir' }))
    expect(r).toEqual({ ok: true, result: { projectId: 'p2', workspaceId: 'w2', path: '/x/p2' } })
    expect(invoke).toHaveBeenCalledWith('project:addPath', '/x/p2')
    expect(invoke).toHaveBeenCalledWith('project:list')
    expect(useSessions.getState().currentWorkspaceId).toBe('w2')
    expect(useSessions.getState().cursor).toBe('p:p2')
  })

  it('open archivo: editor en tab nuevo dentro del workspace que lo contiene, con aviso en su franja', async () => {
    const r = await useControl.getState().dispatch(cmd('open', { path: '/x/p1/src/a.ts' }))
    expect(docsOpen).toHaveBeenCalledWith('w1', '/x/p1/src/a.ts', 'editor', 'tab')
    expect(r).toEqual({ ok: true, result: { sessionId: 'd-new', workspaceId: 'w1', kind: 'editor' } })
    expect(browser().notify).toHaveBeenCalledWith('d-new', 'MCP · claude')
    expect(invoke).not.toHaveBeenCalledWith('project:addPath', expect.anything())
  })

  it('open archivo: Markdown, imágenes y PDF van a la vista previa; fuera de todo workspace → error humano', async () => {
    expect(await useControl.getState().dispatch(cmd('open', { path: '/x/p1/README.md' }))).toEqual({ ok: true, result: { sessionId: 'd-new', workspaceId: 'w1', kind: 'preview' } })
    expect(docsOpen).toHaveBeenLastCalledWith('w1', '/x/p1/README.md', 'preview', 'tab')
    expect(await useControl.getState().dispatch(cmd('open', { path: '/otro/lado/a.ts' }))).toEqual({ ok: false, error: 'El archivo no está dentro de ningún proyecto abierto: /otro/lado/a.ts' })
  })

  it('browser: navegador nuevo en tab propio, navega y avisa MCP · agente', async () => {
    const r = await useControl.getState().dispatch(cmd('browser', { url: 'localhost:3000' }))
    expect(r).toEqual({ ok: true, result: { sessionId: 'b-new' } })
    expect(invoke).toHaveBeenCalledWith('session:create', { agent: 'browser', workspaceId: 'w1' })
    expect(useLayout.getState().tabs).toHaveLength(1)
    expect(browser().navigate).toHaveBeenCalledWith('b-new', 'http://localhost:3000')
    expect(browser().notify).toHaveBeenCalledWith('b-new', 'MCP · claude')
  })

  it('browser con workspaceId desconocido: error humano', async () => {
    const r = await useControl.getState().dispatch(cmd('browser', { url: 'a.test', workspaceId: 'w9' }))
    expect(r).toEqual({ ok: false, error: 'No existe el workspace w9' })
    expect(invoke).not.toHaveBeenCalledWith('session:create', expect.anything())
  })

  it('capture: reutiliza el navegador que ya tiene esa URL cargada y devuelve el PNG', async () => {
    useSessions.setState({ sessions: [session('b1', 'w1', 'browser')] })
    useLayout.getState().openTab('w1', 'b1')
    useBrowser.setState({ states: { b1: state('https://a.test/') } })
    const r = await useControl.getState().dispatch(cmd('capture', { url: 'https://a.test' }, 'cli'))
    expect(r).toEqual({ ok: true, result: { path: '/caps/x.png', width: 1280, height: 800, sessionId: 'b1' } })
    expect(invoke).not.toHaveBeenCalledWith('session:create', expect.anything())
    expect(browser().navigate).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('browser:capture', 'b1')
    expect(browser().notify).toHaveBeenCalledWith('b1', 'CLI · captura')
  })

  it('capture: con otra URL navega y espera a que cargue; en otra vista vuelve a la flota', async () => {
    useSessions.setState({ sessions: [session('b1', 'w1', 'browser')] })
    useLayout.getState().openTab('w1', 'b1')
    useUi.setState({ view: 'review' })
    useBrowser.setState({ states: { b1: state('https://otra.test') } })
    const p = useControl.getState().dispatch(cmd('capture', { url: 'https://a.test', sessionId: 'b1' }))
    await vi.waitFor(() => expect(browser().navigate).toHaveBeenCalledWith('b1', 'https://a.test'))
    expect(useUi.getState().view).toBe('fleet')
    expect(invoke).not.toHaveBeenCalledWith('browser:capture', 'b1')
    // Main publica el estado: primero cargando, luego lista.
    useBrowser.setState({ states: { b1: state('https://a.test/', true) } })
    useBrowser.setState({ states: { b1: state('https://a.test/') } })
    expect(await p).toEqual({ ok: true, result: { path: '/caps/x.png', width: 1280, height: 800, sessionId: 'b1' } })
  })

  it('capture: si la página no carga a tiempo, error humano', async () => {
    vi.useFakeTimers()
    useSessions.setState({ sessions: [session('b1', 'w1', 'browser')] })
    useLayout.getState().openTab('w1', 'b1')
    useBrowser.setState({ states: { b1: state('https://a.test', true) } })
    const p = useControl.getState().dispatch(cmd('capture', { url: 'https://a.test', sessionId: 'b1' }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await p).toEqual({ ok: false, error: 'La página no terminó de cargar en 30 s' })
  })

  it('capture: con un overlay abierto no espera, devuelve error humano', async () => {
    useSessions.setState({ sessions: [session('b1', 'w1', 'browser')] })
    useLayout.getState().openTab('w1', 'b1')
    useBrowser.setState({ states: { b1: state('https://a.test') } })
    useUi.setState({ overlay: 'palette' })
    expect(await useControl.getState().dispatch(cmd('capture', { url: 'https://a.test' }))).toEqual({ ok: false, error: 'No se puede capturar: hay un diálogo abierto en omni' })
    expect(invoke).not.toHaveBeenCalledWith('browser:capture', 'b1')
  })

  it('capture: la sesión pedida tiene que ser un navegador', async () => {
    useSessions.setState({ sessions: [session('s1', 'w1')] })
    expect(await useControl.getState().dispatch(cmd('capture', { url: 'https://a.test', sessionId: 's1' }))).toEqual({ ok: false, error: 'La sesión s1 no es un navegador' })
    expect(await useControl.getState().dispatch(cmd('capture', { url: 'https://a.test', sessionId: 's9' }))).toEqual({ ok: false, error: 'No existe la sesión s9' })
  })

  it('diff: abre la revisión del workspace; desconocido → error', async () => {
    reviewOpen.mockClear()
    expect(await useControl.getState().dispatch(cmd('diff', { workspaceId: 'w1' }))).toEqual({ ok: true, result: { workspaceId: 'w1' } })
    expect(reviewOpen).toHaveBeenCalledWith('w1')
    expect(await useControl.getState().dispatch(cmd('diff', { workspaceId: 'w9' }))).toEqual({ ok: false, error: 'No existe el workspace w9' })
  })

  it('focus: entra al pane como una notificación nativa y pinta CLI en su franja', async () => {
    useSessions.setState({ sessions: [session('s1', 'w1')] })
    expect(await useControl.getState().dispatch(cmd('focus', { sessionId: 's1' }, 'cli'))).toEqual({ ok: true, result: { sessionId: 's1' } })
    expect(enterSession).toHaveBeenCalledWith('s1')
    expect(browser().notify).toHaveBeenCalledWith('s1', 'CLI')
    expect(await useControl.getState().dispatch(cmd('focus', { sessionId: 's9' }))).toEqual({ ok: false, error: 'No existe la sesión s9' })
  })

  it('todo: crea la tarea en el proyecto del workspace actual', async () => {
    const r = await useControl.getState().dispatch(cmd('todo', { text: 'revisar tests' }))
    const todo = useTodos.getState().todos[0]
    expect(todo).toMatchObject({ text: 'revisar tests', projectId: 'p1' })
    expect(r).toEqual({ ok: true, result: { id: todo.id } })
  })

  it('notify: con pane con foco va a su franja; sin pane queda como banner y sale nativa', async () => {
    useSessions.setState({ sessions: [session('s1', 'w1')] })
    useLayout.getState().openTab('w1', 's1')
    expect(await useControl.getState().dispatch(cmd('notify', { title: 'Build', body: 'todo verde' }, 'cli'))).toEqual({ ok: true, result: { shown: 'pane' } })
    expect(browser().notify).toHaveBeenCalledWith('s1', 'CLI · Build: todo verde')
    expect(invoke).toHaveBeenCalledWith('notify:show', 's1', 'Build', 'todo verde', 'done', true)

    useLayout.setState({ tabs: [], activeTab: {} })
    expect(await useControl.getState().dispatch(cmd('notify', { title: 'Build' }))).toEqual({ ok: true, result: { shown: 'banner' } })
    expect(useControl.getState().banner).toMatchObject({ title: 'MCP · claude · Build', body: '' })
    expect(invoke).toHaveBeenCalledWith('notify:show', 'control', 'Build', '', 'done', false)
  })
})
