import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Broadcast, Project, SessionInfo, Workspace, WorkspaceDiff, WorktreeStatus } from '@shared/types'
import { DIFF_DEBOUNCE_MS, KILL_TIMEOUT_MS, SAVE_DEBOUNCE_MS, candidateStatus, currentCandidate, currentRound, runningRounds, useBroadcast, visibleRounds } from './broadcast'
import { useLayout } from './layout'
import { providedReviewTarget } from './review-target'
import { WORKING_WINDOW_MS, useSessions } from './sessions'
import { useUi } from './ui'
import { useWorktrees } from './worktrees'

const invoke = vi.fn()
const send = vi.fn()
const writeWhenSettled = vi.fn()
const reviewOpen = vi.fn()
const focusTerminal = vi.fn()
/** Suscriptores a eventos de main por canal: el test dispara `worktree:changed` a mano. */
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
  screenLines: () => null,
  disposeTerminal: vi.fn(),
  getTerminal: () => ({ focus: focusTerminal }),
  blurTerminals: () => useUi.getState().setFocus('list')
}))
vi.mock('./browser', () => ({ liveBrowserId: () => null, useBrowser: { getState: () => ({ blur: vi.fn() }) } }))
vi.mock('./session-write', () => ({ writeWhenSettled: (...args: unknown[]) => writeWhenSettled(...args), writeToSession: vi.fn() }))
vi.mock('./review', () => ({ useReview: { getState: () => ({ open: (...args: unknown[]) => reviewOpen(...args) }) } }))

const NOW = 1_700_000_000_000
const CLAUDE: AgentDef = { id: 'claude', name: 'Claude Code', badge: 'CC', command: 'claude' }
const CODEX: AgentDef = { id: 'codex', name: 'Codex', badge: 'CX', command: 'codex' }
const project = (id: string, testCommand: string | null = null): Project => ({ id, name: id, locations: [{ id, name: 'Local', path: `/x/${id}` }], testCommand })
const local = (projectId: string): Workspace => ({ id: `local-${projectId}`, projectId, name: projectId, path: `/x/${projectId}`, kind: 'local' })
const wt = (id: string, projectId = 'a'): Workspace => ({ id, projectId, name: id, path: `/wt/${id}`, kind: 'worktree' })
const session = (id: string, workspaceId: string, agent: SessionInfo['agent'] = 'claude'): SessionInfo => ({ id, agent, workspaceId, cwd: '/x', createdAt: NOW })
const status = (files = 0): WorktreeStatus => ({ branch: 'omni/x', base: 'main', dirty: false, stat: { files, additions: files, deletions: 0 }, tests: null })
const round = (id: string, extra: Partial<Broadcast> = {}): Broadcast => ({ id, projectId: 'a', prompt: 'Agrega rate limit', createdAt: NOW, candidates: [], chosen: null, state: 'running', ...extra })

let projectList: { projects: Project[]; workspaces: Workspace[] }
let saved: Broadcast[]
let nextSession = 1
let stop: () => void = () => {}

const emit = (channel: string, ...args: unknown[]): void => (listeners[channel] ?? []).forEach((cb) => cb(...args))
const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined)
/** Deja correr una operación con varios `await` y temporizadores cortos (salidas simuladas de sesiones). */
const settle = async <T,>(p: Promise<T>): Promise<T> => {
  await vi.advanceTimersByTimeAsync(200)
  return p
}
/** Main mata la sesión y un instante después llega `session:exit`: la sesión sale de `sessions`. */
const killsAfter = (ms: number): void => {
  send.mockImplementation((channel: string, id: string) => {
    if (channel !== 'session:kill') return
    setTimeout(() => useSessions.setState((st) => ({ sessions: st.sessions.filter((x) => x.id !== id) })), ms)
  })
}
const calls = (channel: string) => invoke.mock.calls.filter((c) => c[0] === channel)
const diffOf = (paths: string[]): WorkspaceDiff => ({ base: 'main', branch: 'omni/x', truncated: false, files: paths.map((path) => ({ path, status: 'M', additions: 2, deletions: 1, binary: false, hunks: [] })) })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  invoke.mockReset()
  send.mockReset()
  killsAfter(10)
  writeWhenSettled.mockReset()
  reviewOpen.mockReset()
  focusTerminal.mockReset()
  Object.keys(listeners).forEach((k) => delete listeners[k])
  projectList = { projects: [project('a', 'pnpm test')], workspaces: [local('a')] }
  saved = []
  nextSession = 1
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'broadcast:list') return saved
    if (channel === 'broadcast:save') {
      saved = args[0] as Broadcast[]
      return undefined
    }
    if (channel === 'project:list') return projectList
    if (channel === 'worktree:status') return status()
    if (channel === 'worktree:create') {
      const opts = args[1] as { name?: string }
      const ws = wt(opts.name ?? 'x', String(args[0]))
      projectList = { ...projectList, workspaces: [...projectList.workspaces, ws] }
      return ws
    }
    if (channel === 'session:create') {
      const input = args[0] as { agent: SessionInfo['agent']; workspaceId: string }
      return session(`s${nextSession++}`, input.workspaceId, input.agent)
    }
    if (channel === 'session:history') return 'hola\r\n\x1b[32m✔ listo\x1b[0m\r\n'
    if (channel === 'git:diff') return diffOf(['src/a.ts', 'package.json'])
    if (channel === 'git:merge') {
      // Main borra el worktree mergeado y su rama.
      projectList = { ...projectList, workspaces: projectList.workspaces.filter((w) => w.id !== args[0]) }
      return { commit: 'abcdef1234' }
    }
    if (channel === 'git:discard') {
      projectList = { ...projectList, workspaces: projectList.workspaces.filter((w) => w.id !== args[0]) }
      return undefined
    }
    return undefined
  })
  useBroadcast.setState({ rounds: [], loaded: false, cursor: { roundId: null, candidate: 0 }, diffs: {}, summaries: {}, promptOpen: false, draft: '', launching: false, error: null, notice: null })
  useWorktrees.setState({ statuses: {}, firstSeen: {}, cursor: null, targetProjectId: null, discardId: null, launchInNew: false, pendingLaunch: null, error: null })
  useSessions.setState({ agents: [CLAUDE, CODEX], projects: projectList.projects, workspaces: projectList.workspaces, sessions: [], activity: {}, attention: {}, busy: {}, titles: {}, currentWorkspaceId: 'local-a', cursor: 'p:a', ready: true })
  useLayout.setState({ tabs: [], activeTab: {} })
  useUi.setState({ overlay: null, view: 'fleet', focus: 'list', launchTarget: 'tab' })
})

afterEach(() => {
  stop()
  vi.useRealTimers()
})

/** Arranca el store con las rondas guardadas y deja que `broadcast:list` responda. */
async function boot(rounds: Broadcast[] = [], workspaces: Workspace[] = projectList.workspaces, sessions: SessionInfo[] = []): Promise<void> {
  saved = rounds
  projectList = { ...projectList, workspaces }
  useSessions.setState({ workspaces, sessions })
  stop = useBroadcast.getState().init()
  await flush()
}

const b = () => useBroadcast.getState()
const s = () => useSessions.getState()

describe('useBroadcast · carga y sincronización', () => {
  it('al arrancar pide broadcast:list y poda los candidatos cuyo worktree ya no existe', async () => {
    await boot([round('r1', { candidates: [{ workspaceId: 'w1', sessionId: 's1', agent: 'claude' }, { workspaceId: 'gone', sessionId: null, agent: 'codex' }], chosen: 'gone' })], [local('a'), wt('w1')], [session('s1', 'w1')])
    expect(calls('broadcast:list')).toHaveLength(1)
    const r = b().rounds[0]
    expect(r.candidates.map((c) => c.workspaceId)).toEqual(['w1'])
    expect(r.chosen).toBeNull()
    // Lo podado se guarda (con debounce).
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(saved[0].candidates).toHaveLength(1)
  })

  it('una sesión muerta deja al candidato sin agente y la ronda pasa a lista cuando todos se callan', async () => {
    await boot([round('r1', { candidates: [{ workspaceId: 'w1', sessionId: 's1', agent: 'claude' }, { workspaceId: 'w2', sessionId: 's2', agent: 'codex' }] })], [local('a'), wt('w1'), wt('w2')], [session('s1', 'w1'), session('s2', 'w2')])
    useSessions.setState({ activity: { s1: { lastOutput: NOW } } })
    await flush()
    expect(b().rounds[0].state).toBe('running')
    // s2 muere; s1 sigue trabajando.
    useSessions.setState({ sessions: [session('s1', 'w1')] })
    await flush()
    expect(b().rounds[0].candidates[1].sessionId).toBeNull()
    expect(b().rounds[0].state).toBe('running')
    // Pasa la ventana de "trabajando": nadie trabaja → lista.
    await vi.advanceTimersByTimeAsync(WORKING_WINDOW_MS + 100)
    expect(b().rounds[0].state).toBe('done')
    expect(runningRounds(b())).toBe(0)
    // Al callarse, la tarjeta repide el diff del candidato (con debounce) y el resumen.
    await vi.advanceTimersByTimeAsync(DIFF_DEBOUNCE_MS)
    expect(calls('git:diff').map((c) => c[1])).toContain('w1')
    expect(b().diffs.w1?.files.map((f) => f.path)).toEqual(['src/a.ts', 'package.json'])
    expect(b().summaries.s1).toBe('✔ listo')
  })

  it('las rondas se listan por proyecto actual, la más nueva arriba, y el cursor cae en la primera', async () => {
    await boot([round('old', { createdAt: NOW - 10 }), round('new'), round('other', { projectId: 'b' })])
    expect(visibleRounds(b(), s()).map((r) => r.id)).toEqual(['new', 'old'])
    expect(currentRound(b(), s())?.id).toBe('new')
    b().moveRound(1)
    expect(currentRound(b(), s())?.id).toBe('old')
    b().moveRound(1)
    expect(currentRound(b(), s())?.id).toBe('new')
  })

  it('worktree:changed de un candidato repide su diff', async () => {
    await boot([round('r1', { candidates: [{ workspaceId: 'w1', sessionId: null, agent: 'claude' }] })], [local('a'), wt('w1')])
    emit('worktree:changed', 'w1')
    await vi.advanceTimersByTimeAsync(DIFF_DEBOUNCE_MS)
    expect(calls('git:diff').map((c) => c[1])).toEqual(['w1'])
    emit('worktree:changed', 'ajeno')
    await vi.advanceTimersByTimeAsync(DIFF_DEBOUNCE_MS)
    expect(calls('git:diff')).toHaveLength(1)
  })
})

describe('useBroadcast · crear', () => {
  it('create: un worktree por agente, el agente lanzado ahí con el prompt como primer mensaje, la ronda guardada', async () => {
    await boot()
    useUi.getState().setFocus('terminal')
    b().open()
    expect(useUi.getState().view).toBe('broadcast')
    expect(useUi.getState().focus).toBe('list')
    await b().create({ prompt: '  Agrega rate limit  ', agents: ['claude', 'claude', 'codex'] })
    expect(calls('worktree:create').map((c) => (c[2] as { name: string }).name)).toEqual(['cc-1', 'cc-2', 'cx-1'])
    expect(calls('session:create').map((c) => c[1])).toEqual([
      { agent: 'claude', workspaceId: 'cc-1' },
      { agent: 'claude', workspaceId: 'cc-2' },
      { agent: 'codex', workspaceId: 'cx-1' }
    ])
    expect(writeWhenSettled.mock.calls).toEqual([
      ['s1', 'Agrega rate limit'],
      ['s2', 'Agrega rate limit'],
      ['s3', 'Agrega rate limit']
    ])
    const r = b().rounds[0]
    expect(r.prompt).toBe('Agrega rate limit')
    expect(r.candidates).toEqual([
      { workspaceId: 'cc-1', sessionId: 's1', agent: 'claude' },
      { workspaceId: 'cc-2', sessionId: 's2', agent: 'claude' },
      { workspaceId: 'cx-1', sessionId: 's3', agent: 'codex' }
    ])
    expect(r.state).toBe('running')
    expect(b().cursor).toEqual({ roundId: r.id, candidate: 0 })
    expect(b().launching).toBe(false)
    // Cada agente tiene su tab y el workspace actual vuelve a donde estaba (la vista sigue en pantalla).
    expect(useLayout.getState().tabs.map((t) => t.workspaceId)).toEqual(['cc-1', 'cc-2', 'cx-1'])
    expect(s().currentWorkspaceId).toBe('local-a')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(saved).toHaveLength(1)
    expect(saved[0].candidates).toHaveLength(3)
  })

  it('si ningún worktree se puede crear, la ronda no queda y el error sí', async () => {
    await boot()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'broadcast:list') return []
      if (channel === 'project:list') return projectList
      if (channel === 'worktree:create') throw new Error("Error invoking remote method 'worktree:create': Error: el proyecto no es un repo git")
      return undefined
    })
    await b().create({ prompt: 'x', agents: ['claude'] })
    expect(b().rounds).toHaveLength(0)
    expect(b().error).toBe('el proyecto no es un repo git')
    expect(calls('session:create')).toHaveLength(0)
  })

  it('sin prompt o sin agentes no hace nada', async () => {
    await boot()
    await b().create({ prompt: '   ', agents: ['claude'] })
    await b().create({ prompt: 'x', agents: [] })
    expect(calls('worktree:create')).toHaveLength(0)
    expect(b().rounds).toHaveLength(0)
  })
})

describe('useBroadcast · elegir, diff y navegación', () => {
  const two = (): Broadcast => round('r1', { candidates: [{ workspaceId: 'w1', sessionId: 's1', agent: 'claude' }, { workspaceId: 'w2', sessionId: 's2', agent: 'codex' }] })

  it('H/L recorren los candidatos con wrap-around y S elige o deselige', async () => {
    await boot([two()], [local('a'), wt('w1'), wt('w2')], [session('s1', 'w1'), session('s2', 'w2', 'codex')])
    b().open()
    expect(currentCandidate(b(), s())?.workspaceId).toBe('w1')
    b().moveCandidate(1)
    expect(currentCandidate(b(), s())?.workspaceId).toBe('w2')
    b().moveCandidate(1)
    expect(currentCandidate(b(), s())?.workspaceId).toBe('w1')
    b().moveCandidate(-1)
    b().choose()
    expect(b().rounds[0].chosen).toBe('w2')
    b().choose()
    expect(b().rounds[0].chosen).toBeNull()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(calls('broadcast:save').length).toBeGreaterThan(0)
  })

  it('D abre la revisión del candidato; ⇧D la del segundo con la rama del primero (o del elegido) como base', async () => {
    useWorktrees.setState({ statuses: { w1: { ...status(), branch: 'omni/w1' } } })
    await boot([two()], [local('a'), wt('w1'), wt('w2')])
    b().open()
    b().diffCandidate()
    expect(reviewOpen).toHaveBeenLastCalledWith('w1')
    b().diffBetween()
    expect(reviewOpen).toHaveBeenLastCalledWith('w2', 'omni/w1')
    // Elegido w2 y cursor en w1: base = rama del elegido; sin estado aún, `omni/<name>`.
    b().moveCandidate(1)
    b().choose()
    b().moveCandidate(-1)
    b().diffBetween()
    expect(reviewOpen).toHaveBeenLastCalledWith('w1', 'omni/w2')
    // Con la vista en pantalla, ⌘D (`review.open`) apunta al candidato bajo el cursor.
    expect(providedReviewTarget()).toBe('w1')
    useUi.getState().setView('fleet')
    expect(providedReviewTarget()).toBeNull()
  })

  it('⏎ entra al agente del candidato y vuelve a la flota; sin agente abre el launcher en su worktree', async () => {
    await boot([two()], [local('a'), wt('w1'), wt('w2')], [session('s1', 'w1')])
    useLayout.getState().openTab('w1', 's1')
    b().open()
    b().enterCandidate()
    expect(useUi.getState().view).toBe('fleet')
    expect(useUi.getState().focus).toBe('terminal')
    expect(focusTerminal).toHaveBeenCalled()
    b().open()
    b().moveCandidate(1)
    b().enterCandidate()
    expect(useUi.getState().overlay).toBe('launcher')
    expect(useWorktrees.getState().pendingLaunch).toEqual({ workspaceId: 'w2', prompt: 'Agrega rate limit' })
  })

  it('X pasa por la confirmación de Worktrees; al desaparecer el worktree, el candidato sale de la ronda', async () => {
    await boot([two()], [local('a'), wt('w1'), wt('w2')])
    b().open()
    b().discardCandidate()
    expect(useUi.getState().overlay).toBe('confirmDiscard')
    expect(useWorktrees.getState().discardId).toBe('w1')
    await useWorktrees.getState().confirmDiscard('w1')
    await flush()
    expect(b().rounds[0].candidates.map((c) => c.workspaceId)).toEqual(['w2'])
  })

  it('candidateStatus: estado del agente o null si murió', () => {
    const st = { sessions: [session('s1', 'w1')], activity: { s1: { lastOutput: NOW } }, attention: {}, busy: {} }
    expect(candidateStatus(st, { sessionId: 's1' }, NOW)).toBe('working')
    expect(candidateStatus(st, { sessionId: 's1' }, NOW + WORKING_WINDOW_MS)).toBe('idle')
    expect(candidateStatus(st, { sessionId: 'muerta' }, NOW)).toBeNull()
    expect(candidateStatus(st, { sessionId: null }, NOW)).toBeNull()
  })
})

describe('useBroadcast · merge y relanzar', () => {
  const two = (chosen: string | null = 'w2'): Broadcast => round('r1', { candidates: [{ workspaceId: 'w1', sessionId: 's1', agent: 'claude' }, { workspaceId: 'w2', sessionId: 's2', agent: 'codex' }], chosen })

  it('⇧M mergea el elegido, mata sus agentes, descarta el resto y marca la ronda merged', async () => {
    await boot([two()], [local('a'), wt('w1'), wt('w2')], [session('s1', 'w1'), session('s2', 'w2', 'codex')])
    b().open()
    await settle(b().mergeChosen())
    expect(calls('git:merge').map((c) => c[1])).toEqual(['w2'])
    expect(calls('git:discard').map((c) => c[1])).toEqual(['w1'])
    expect(send.mock.calls.filter((c) => c[0] === 'session:kill').map((c) => c[1])).toEqual(['s2', 's1'])
    expect(b().rounds[0].state).toBe('merged')
    // Mergeada: solo queda el elegido como historial; sus worktrees ya no existen y la vista no lo recorre.
    expect(b().rounds[0].candidates.map((c) => c.workspaceId)).toEqual(['w2'])
    expect(currentCandidate(b(), s())).toBeUndefined()
    expect(b().notice).toBe('Merge hecho: abcdef1')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(saved[0].state).toBe('merged')
  })

  it('sin elegido no hay merge; un error de git:merge queda en error y la ronda sigue viva', async () => {
    await boot([two(null)], [local('a'), wt('w1'), wt('w2')])
    b().open()
    await b().mergeChosen()
    expect(calls('git:merge')).toHaveLength(0)
    b().moveCandidate(1)
    b().choose()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'git:merge') throw new Error('el repo tiene cambios sin commit')
      if (channel === 'project:list') return projectList
      return undefined
    })
    await b().mergeChosen()
    expect(b().error).toBe('el repo tiene cambios sin commit')
    // Sin agentes vivos la ronda está `done`, pero no `merged`: los candidatos siguen ahí.
    expect(b().rounds[0].state).toBe('done')
    expect(b().rounds[0].candidates).toHaveLength(2)
    expect(calls('git:discard')).toHaveLength(0)
  })

  it('R descarta los no elegidos y lanza de nuevo sus agentes con el mismo prompt', async () => {
    await boot([two()], [local('a'), wt('w1'), wt('w2')], [session('s1', 'w1'), session('s2', 'w2', 'codex')])
    b().open()
    const aliveAtDiscard: string[][] = []
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'git:discard') aliveAtDiscard.push(s().sessions.map((x) => x.id))
      return base?.(channel, ...args)
    })
    await settle(b().relaunch())
    expect(calls('git:discard').map((c) => c[1])).toEqual(['w1'])
    expect(send.mock.calls.filter((c) => c[0] === 'session:kill').map((c) => c[1])).toEqual(['s1'])
    // El worktree se tira recién cuando su agente salió.
    expect(aliveAtDiscard).toEqual([['s2']])
    expect(calls('worktree:create').map((c) => (c[2] as { name: string }).name)).toEqual(['cc-1'])
    expect(writeWhenSettled).toHaveBeenCalledWith('s1', 'Agrega rate limit')
    const r = b().rounds[0]
    expect(r.candidates.map((c) => c.workspaceId)).toEqual(['w2', 'cc-1'])
    expect(r.chosen).toBe('w2')
    expect(r.state).toBe('running')
    expect(b().launching).toBe(false)
  })
})

describe('useBroadcast · segunda vuelta', () => {
  const two = (): Broadcast => round('r1', { candidates: [{ workspaceId: 'w1', sessionId: 's1', agent: 'claude' }, { workspaceId: 'w2', sessionId: 's2', agent: 'codex' }] })

  it('una ronda lanzando está en marcha aunque aún no tenga agentes, y una sesión recién nacida sin salida cuenta como trabajando', async () => {
    await boot()
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'worktree:create') await new Promise((r) => setTimeout(r, 1000))
      return base?.(channel, ...args)
    })
    const p = b().create({ prompt: 'x', agents: ['claude'] })
    await flush()
    expect(b().rounds[0].candidates).toHaveLength(0)
    // Algo cambia en sessions mientras se crea el worktree: la ronda sigue en marcha, no "lista".
    useSessions.setState({ attention: {} })
    await vi.advanceTimersByTimeAsync(WORKING_WINDOW_MS + 100)
    expect(b().rounds[0].state).toBe('running')
    await settle(p)
    expect(b().rounds[0].candidates).toHaveLength(1)
    expect(b().rounds[0].state).toBe('running')
    // Sesión viva sin actividad: trabajando si acaba de nacer, reposo si es restaurada de antes.
    const st = { sessions: [session('n', 'w1')], activity: {}, attention: {}, busy: {} }
    expect(candidateStatus(st, { sessionId: 'n' }, NOW + 100)).toBe('working')
    expect(candidateStatus(st, { sessionId: 'n' }, NOW + WORKING_WINDOW_MS)).toBe('idle')
  })

  it('si init se reinicia a mitad de create, el worktree recién creado se tira y su agente muere', async () => {
    await boot()
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'session:create') await new Promise((r) => setTimeout(r, 500))
      return base?.(channel, ...args)
    })
    const p = b().create({ prompt: 'x', agents: ['claude'] })
    await vi.advanceTimersByTimeAsync(100)
    expect(calls('worktree:create')).toHaveLength(1)
    stop()
    stop = () => {}
    await vi.advanceTimersByTimeAsync(600)
    await p
    expect(send.mock.calls.filter((c) => c[0] === 'session:kill').map((c) => c[1])).toEqual(['s1'])
    expect(calls('git:discard').map((c) => c[1])).toEqual(['cc-1'])
    expect(b().rounds[0].candidates).toHaveLength(0)
    expect(writeWhenSettled).not.toHaveBeenCalled()
  })

  it('un candidato sin agente se enlaza con la primera sesión agente nueva de su worktree (no con un shell)', async () => {
    await boot([round('r1', { candidates: [{ workspaceId: 'w1', sessionId: null, agent: 'claude' }] })], [local('a'), wt('w1')])
    useSessions.setState({ sessions: [session('sh', 'w1', 'shell')] })
    await flush()
    expect(b().rounds[0].candidates[0].sessionId).toBeNull()
    useSessions.setState({ sessions: [session('sh', 'w1', 'shell'), session('n1', 'w1')] })
    await flush()
    expect(b().rounds[0].candidates[0].sessionId).toBe('n1')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(saved[0].candidates[0].sessionId).toBe('n1')
  })

  it('si una sesión matada no sale, el descarte espera hasta el tope y sigue', async () => {
    send.mockImplementation(() => undefined)
    await boot([two()], [local('a'), wt('w1'), wt('w2')], [session('s1', 'w1'), session('s2', 'w2', 'codex')])
    b().open()
    b().moveCandidate(1)
    b().choose()
    const p = b().relaunch()
    await vi.advanceTimersByTimeAsync(KILL_TIMEOUT_MS - 100)
    expect(calls('git:discard')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(calls('git:discard').map((c) => c[1])).toEqual(['w1'])
    await settle(p)
    expect(b().launching).toBe(false)
  })

  it('el cursor y H/L solo recorren candidatos con worktree', async () => {
    await boot([round('r1', { candidates: [{ workspaceId: 'w1', sessionId: null, agent: 'claude' }, { workspaceId: 'w2', sessionId: null, agent: 'codex' }], state: 'merged' })], [local('a'), wt('w2')])
    b().open()
    expect(currentCandidate(b(), s())?.workspaceId).toBe('w2')
    b().moveCandidate(1)
    expect(currentCandidate(b(), s())?.workspaceId).toBe('w2')
    expect(b().cursor.candidate).toBe(0)
  })
})
