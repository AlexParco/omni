import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, Todo, Workspace } from '@shared/types'
import { useLayout } from './layout'
import { useSessions } from './sessions'
import { newTodo } from './todos-logic'
import { useTodos } from './todos'
import { useUi } from './ui'

const invoke = vi.fn()
const send = vi.fn()
/** Listeners de `omni.on` por canal, para disparar `session:exit` y `session:data` a mano. */
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
  screenLines: () => null, disposeTerminal: vi.fn(), getTerminal: vi.fn(() => undefined) }))
vi.mock('./browser', () => ({ liveBrowserId: () => null, useBrowser: { getState: () => ({ blur: vi.fn() }) } }))

const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime()
const ws = (id: string, projectId: string): Workspace => ({ id, projectId, name: id, path: `/x/${projectId}`, kind: 'local' })
const session = (id: string, workspaceId: string, agent: SessionInfo['agent'] = 'claude'): SessionInfo => ({ id, agent, workspaceId, cwd: `/x`, createdAt: NOW }) as SessionInfo
const emit = (channel: string, ...args: unknown[]): void => (listeners[channel] ?? []).forEach((cb) => cb(...args))

let stop: () => void = () => {}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  invoke.mockReset()
  send.mockReset()
  Object.keys(listeners).forEach((k) => delete listeners[k])
  useTodos.setState({ todos: [], loaded: false, cursor: null, undo: null, doneOpen: false, composing: false, pendingLaunch: null })
  useSessions.setState({ sessions: [], workspaces: [ws('w1', 'p1'), ws('w2', 'p2')], currentWorkspaceId: 'w1', ready: true })
  useLayout.setState({ tabs: [], activeTab: {} })
  useUi.setState({ overlay: null, launchTarget: 'tab' })
})

afterEach(() => {
  stop()
  vi.useRealTimers()
})

/** Arranca el store con una lista inicial y espera a `todo:list`. */
async function boot(initial: Todo[] = []): Promise<void> {
  invoke.mockImplementation(async (channel: string) => (channel === 'todo:list' ? initial : undefined))
  stop = useTodos.getState().init()
  await vi.advanceTimersByTimeAsync(0)
}

describe('useTodos', () => {
  it('carga con todo:list y suelta los vínculos con sesiones que ya no existen', async () => {
    useSessions.setState({ sessions: [session('s1', 'w1')] })
    await boot([newTodo('viva', 'p1', NOW, 'a'), { ...newTodo('muerta', 'p1', NOW, 'b'), sessionId: 's-gone' }, { ...newTodo('ok', 'p1', NOW, 'c'), sessionId: 's1' }])
    const { todos, loaded, cursor } = useTodos.getState()
    expect(loaded).toBe(true)
    expect(todos.map((t) => t.sessionId)).toEqual([null, null, 's1'])
    expect(cursor).toBe('a')
  })

  it('persiste con todo:save tras 300 ms de silencio, una sola vez por ráfaga', async () => {
    await boot()
    const s = useTodos.getState()
    s.add('uno', 'p1')
    s.add('dos', 'p1')
    expect(invoke).not.toHaveBeenCalledWith('todo:save', expect.anything())
    await vi.advanceTimersByTimeAsync(299)
    expect(invoke).not.toHaveBeenCalledWith('todo:save', expect.anything())
    await vi.advanceTimersByTimeAsync(1)
    const saves = invoke.mock.calls.filter((c) => c[0] === 'todo:save')
    expect(saves).toHaveLength(1)
    expect((saves[0][1] as Todo[]).map((t) => t.text)).toEqual(['uno', 'dos'])
  })

  it('add ignora texto vacío y deja el cursor en la nueva', async () => {
    await boot()
    expect(useTodos.getState().add('   ', 'p1')).toBeNull()
    const t = useTodos.getState().add('  tarea  ', 'p1')
    expect(t?.text).toBe('tarea')
    expect(useTodos.getState().cursor).toBe(t?.id)
  })

  it('X con Hecho plegado baja el cursor a la siguiente; D borra y ⌘Z la devuelve', async () => {
    await boot([newTodo('a', 'p1', NOW, 'a'), newTodo('b', 'p1', NOW + 1, 'b'), newTodo('c', 'p1', NOW + 2, 'c')])
    const s = useTodos.getState()
    s.setCursor('a')
    s.toggleDone('a')
    expect(useTodos.getState().cursor).toBe('b')
    useTodos.getState().remove('b')
    expect(useTodos.getState().todos.map((t) => t.id)).toEqual(['a', 'c'])
    expect(useTodos.getState().cursor).toBe('c')
    useTodos.getState().undoRemove()
    expect(useTodos.getState().todos.map((t) => t.id).sort()).toEqual(['a', 'b', 'c'])
    expect(useTodos.getState().cursor).toBe('b')
    expect(useTodos.getState().undo).toBeNull()
  })

  it('session:exit suelta el vínculo sin marcar hecha', async () => {
    await boot([{ ...newTodo('a', 'p1', NOW, 'a'), sessionId: 's1' }])
    emit('session:exit', 's1', 0)
    expect(useTodos.getState().todos[0]).toMatchObject({ sessionId: null, done: false })
  })

  it('⏎ sin agente abre el launcher con el workspace del proyecto en espera', async () => {
    await boot([newTodo('hacer algo', 'p2', NOW, 'a')])
    useUi.setState({ overlay: 'todo' })
    useTodos.getState().launch('a')
    expect(useSessions.getState().currentWorkspaceId).toBe('w2')
    expect(useUi.getState().overlay).toBe('launcher')
    expect(useTodos.getState().pendingLaunch).toEqual({ todoId: 'a', workspaceId: 'w2' })
  })

  it('takePendingLaunch devuelve y limpia la espera; linkLaunched vincula y escribe el prompt saneado', async () => {
    await boot([newTodo('hacer algo\x1b[201~\r', 'p2', NOW, 'a')])
    useTodos.getState().launch('a')
    const pending = useTodos.getState().takePendingLaunch()
    expect(pending).toEqual({ todoId: 'a', workspaceId: 'w2' })
    expect(useTodos.getState().pendingLaunch).toBeNull()
    expect(useTodos.getState().takePendingLaunch()).toBeNull()
    useTodos.getState().linkLaunched('a', session('s9', 'w2'))
    expect(useTodos.getState().todos[0].sessionId).toBe('s9')
    // El texto se escribe como primer prompt cuando la TUI pidió bracketed paste y se calmó, sin caracteres de control.
    emit('session:data', 's9', '\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(2500)
    expect(send).toHaveBeenCalledWith('session:write', 's9', 'hacer algo[201~')
    vi.advanceTimersByTime(200)
    expect(send).toHaveBeenLastCalledWith('session:write', 's9', '\r')
  })

  it('una sesión ajena que aparece mientras se espera no se vincula', async () => {
    await boot([newTodo('a', 'p1', NOW, 'a')])
    useTodos.getState().launch('a')
    useSessions.setState({ sessions: [session('ajena', 'w1')] })
    expect(useTodos.getState().todos[0].sessionId).toBeNull()
    expect(useTodos.getState().pendingLaunch).toEqual({ todoId: 'a', workspaceId: 'w1' })
    expect(send).not.toHaveBeenCalled()
  })

  it('el launcher cerrado sin crear nada (Esc u otro overlay) deja de esperar', async () => {
    await boot([newTodo('a', 'p1', NOW, 'a')])
    useTodos.getState().launch('a')
    useUi.getState().closeOverlay()
    expect(useTodos.getState().pendingLaunch).toBeNull()
    useTodos.getState().launch('a')
    useUi.getState().openOverlay('palette')
    expect(useTodos.getState().pendingLaunch).toBeNull()
  })

  it('una terminal pelada o un navegador no se vinculan ni reciben el texto', async () => {
    await boot([newTodo('rm -rf', 'p1', NOW, 'a')])
    useTodos.getState().linkLaunched('a', session('sh', 'w1', 'shell'))
    useTodos.getState().linkLaunched('a', session('br', 'w1', 'browser'))
    expect(useTodos.getState().todos[0].sessionId).toBeNull()
    emit('session:data', 'sh', '\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(9000)
    expect(send).not.toHaveBeenCalled()
  })

  it('cargar no dispara todo:save si nada cambió; podar hechas viejas sí', async () => {
    await boot([newTodo('a', 'p1', NOW, 'a'), { ...newTodo('d', 'p1', NOW, 'd'), done: true, doneAt: NOW - 1000 }])
    await vi.advanceTimersByTimeAsync(1000)
    expect(invoke).not.toHaveBeenCalledWith('todo:save', expect.anything())
    stop()
    useTodos.setState({ todos: [], loaded: false })
    await boot([newTodo('a', 'p1', NOW, 'a'), { ...newTodo('old', 'p1', NOW, 'old'), done: true, doneAt: NOW - 8 * 24 * 3600_000 }])
    await vi.advanceTimersByTimeAsync(1000)
    const saves = invoke.mock.calls.filter((c) => c[0] === 'todo:save')
    expect(saves).toHaveLength(1)
    expect((saves[0][1] as Todo[]).map((t) => t.id)).toEqual(['a'])
  })
})
