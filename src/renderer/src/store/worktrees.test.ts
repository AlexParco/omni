import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Project, SessionInfo, Workspace, WorktreeStatus } from '@shared/types'
import { useLayout } from './layout'
import { useQuickOpen } from './quickopen'
import { providedReviewTarget } from './review-target'
import { WORKING_WINDOW_MS, useSessions } from './sessions'
import { useUi } from './ui'
import { AUTO_TESTS_MIN_WORKING_MS, NOTICE_MS, currentRow, errorText, keptWorktreesNotice, projectIsRepo, statusFingerprint, useWorktrees, visibleRows, worktreeCount } from './worktrees'

const invoke = vi.fn()
const send = vi.fn()
const writeWhenSettled = vi.fn()
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
vi.mock('./session-write', () => ({ writeWhenSettled: (...args: unknown[]) => writeWhenSettled(...args) }))

const NOW = 1_700_000_000_000
const CLAUDE: AgentDef = { id: 'claude', name: 'Claude Code', badge: 'CC', command: 'claude' }
const project = (id: string, testCommand: string | null = null): Project => ({ id, name: id, locations: [{ id, name: 'Local', path: `/x/${id}` }], testCommand })
const local = (projectId: string): Workspace => ({ id: `local-${projectId}`, projectId, name: projectId, path: `/x/${projectId}`, kind: 'local' })
const wt = (id: string, projectId: string): Workspace => ({ id, projectId, name: id, path: `/wt/${id}`, kind: 'worktree' })
const session = (id: string, workspaceId: string, agent: SessionInfo['agent'] = 'claude'): SessionInfo => ({ id, agent, workspaceId, cwd: '/x', createdAt: NOW })
const status = (files: number, dirty = false, tests: WorktreeStatus['tests'] = null): WorktreeStatus => ({ branch: 'omni/x', base: 'main', dirty, stat: { files, additions: files, deletions: 0 }, tests })

/** Lo que main contesta por canal; el test lo ajusta por caso. */
let projectList: { projects: Project[]; workspaces: Workspace[] }
let statuses: Record<string, WorktreeStatus>
let stop: () => void = () => {}

const emit = (channel: string, ...args: unknown[]): void => (listeners[channel] ?? []).forEach((cb) => cb(...args))
const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined)
const calls = (channel: string) => invoke.mock.calls.filter((c) => c[0] === channel)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  invoke.mockReset()
  send.mockReset()
  writeWhenSettled.mockReset()
  focusTerminal.mockReset()
  Object.keys(listeners).forEach((k) => delete listeners[k])
  projectList = { projects: [project('a')], workspaces: [local('a')] }
  statuses = {}
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'project:list') return projectList
    if (channel === 'worktree:status') return statuses[String(args[0])] ?? status(0)
    if (channel === 'worktree:create') {
      const opts = args[1] as { name?: string; issue?: number }
      const name = opts.name ?? `issue-${opts.issue}-titulo`
      const ws = wt(name, String(args[0]))
      projectList = { ...projectList, workspaces: [...projectList.workspaces, ws] }
      return ws
    }
    if (channel === 'worktree:remove') {
      projectList = { ...projectList, workspaces: projectList.workspaces.filter((w) => w.id !== args[0]) }
      return undefined
    }
    if (channel === 'git:issue') return { number: args[1], title: 'Rate limit por IP', url: `https://github.com/o/r/issues/${String(args[1])}` }
    if (channel === 'project:remove') return { keptWorktrees: [] }
    return undefined
  })
  useWorktrees.setState({ statuses: {}, errors: {}, firstSeen: {}, cursor: null, targetProjectId: null, discardId: null, launchInNew: false, pendingLaunch: null, error: null, notice: null })
  useQuickOpen.setState({ branches: {} })
  useSessions.setState({ agents: [CLAUDE], projects: projectList.projects, workspaces: projectList.workspaces, sessions: [], activity: {}, attention: {}, busy: {}, currentWorkspaceId: 'local-a', cursor: 'p:a', ready: true })
  useLayout.setState({ tabs: [], activeTab: {} })
  useUi.setState({ overlay: null, view: 'fleet', focus: 'list', launchTarget: 'tab' })
})

afterEach(() => {
  stop()
  vi.useRealTimers()
})

/** Arranca el store con la lista de proyectos ya cargada en `sessions`. */
async function boot(workspaces: Workspace[] = projectList.workspaces, projects: Project[] = projectList.projects): Promise<void> {
  projectList = { projects, workspaces }
  useSessions.setState({ projects, workspaces })
  stop = useWorktrees.getState().init()
  await flush()
}

/** La sesión escupe salida cada 600 ms durante `ms` (por encima del throttle de actividad) y luego se calla hasta pasar a idle. */
async function work(id: string, ms: number): Promise<void> {
  for (let t = 0; t <= ms; t += 600) {
    useSessions.getState().onData(id, 'x')
    await vi.advanceTimersByTimeAsync(Math.min(600, ms - t + 1))
  }
  await vi.advanceTimersByTimeAsync(WORKING_WINDOW_MS + 1)
}

const rows = () => visibleRows(useWorktrees.getState(), useSessions.getState())

describe('useWorktrees · estado', () => {
  it('al arrancar pide el estado de cada worktree y anota cuándo lo vio', async () => {
    statuses.w1 = status(3)
    await boot([local('a'), wt('w1', 'a')])
    expect(calls('worktree:status').map((c) => c.slice(1))).toEqual([['w1']])
    expect(useWorktrees.getState().statuses.w1.stat.files).toBe(3)
    expect(useWorktrees.getState().firstSeen.w1).toBe(NOW)
    expect(worktreeCount(useSessions.getState())).toBe(1)
  })

  it('los worktrees de un proyecto oculto no cuentan ni se listan salvo con showHidden', () => {
    const s = { workspaces: [local('a'), wt('w1', 'a')], projects: [{ id: 'a', name: 'a', locations: [{ id: 'a', name: 'Local', path: '/x/a' }], hidden: true as const }], sessions: [] }
    expect(worktreeCount(s, false)).toBe(0)
    expect(worktreeCount(s, true)).toBe(1)
    expect(visibleRows({ statuses: {}, firstSeen: {} }, s, false)).toEqual([])
    expect(visibleRows({ statuses: {}, firstSeen: {} }, s, true).map((r) => r.workspace.id)).toEqual(['w1'])
  })

  it('worktree:changed recarga proyectos y el estado del worktree avisado', async () => {
    await boot()
    expect(rows()).toHaveLength(0)
    projectList = { ...projectList, workspaces: [local('a'), wt('w1', 'a')] }
    statuses.w1 = status(1, false, { status: 'pass', summary: '12 passed', at: NOW })
    emit('worktree:changed', 'w1')
    await flush()
    expect(useSessions.getState().workspaces.map((w) => w.id)).toEqual(['local-a', 'w1'])
    expect(useWorktrees.getState().statuses.w1.tests?.status).toBe('pass')
    expect(rows().map((r) => r.workspace.id)).toEqual(['w1'])
  })

  it('un worktree que desaparece se lleva su estado, su marca y el cursor pasa al vecino', async () => {
    statuses.w1 = status(1)
    statuses.w2 = status(2)
    await boot([local('a'), wt('w1', 'a'), wt('w2', 'a')])
    useWorktrees.getState().setCursor('w1')
    projectList = { ...projectList, workspaces: [local('a'), wt('w2', 'a')] }
    emit('worktree:changed', null)
    await flush()
    expect(useWorktrees.getState().statuses.w1).toBeUndefined()
    expect(useWorktrees.getState().firstSeen.w1).toBeUndefined()
    expect(currentRow(useWorktrees.getState(), useSessions.getState())?.workspace.id).toBe('w2')
  })

  it('refresh con error de main deja el motivo en errors[id] y un refresh bueno lo limpia', async () => {
    await boot([local('a'), wt('w1', 'a')])
    invoke.mockImplementationOnce(async () => {
      throw new Error("Error invoking remote method 'worktree:status': Error: fatal: not a git repository")
    })
    await useWorktrees.getState().refresh('w1')
    expect(useWorktrees.getState().errors.w1).toBe('fatal: not a git repository')
    await useWorktrees.getState().refresh('w1')
    expect(useWorktrees.getState().errors.w1).toBeUndefined()
    // `fresh` salta la caché de main.
    await useWorktrees.getState().refresh('w1', true)
    expect(calls('worktree:status').at(-1)?.slice(1)).toEqual(['w1', true])
  })

  it('errorText limpia el prefijo que Electron antepone al mensaje de main', () => {
    expect(errorText(new Error("Error invoking remote method 'worktree:create': Error: el proyecto no es un repo git"))).toBe('el proyecto no es un repo git')
    expect(errorText(new Error('ya existe'))).toBe('ya existe')
    expect(errorText('')).toBe('No se pudo completar')
  })

  it('projectIsRepo lee la rama cacheada del workspace local; sin dato es null', async () => {
    await boot()
    expect(projectIsRepo(useSessions.getState(), 'a')).toBeNull()
    useQuickOpen.setState({ branches: { 'local-a': { name: null, at: NOW } } })
    expect(projectIsRepo(useSessions.getState(), 'a')).toBe(false)
    useQuickOpen.setState({ branches: { 'local-a': { name: 'main', at: NOW } } })
    expect(projectIsRepo(useSessions.getState(), 'a')).toBe(true)
    useWorktrees.getState().probeRepo('a')
    expect(projectIsRepo(useSessions.getState(), 'zzz')).toBeNull()
  })

  it('projectIsRepo con varias ubicaciones: manda la ubicación actual; desde otro proyecto o un worktree, la primera', () => {
    const api: Workspace = { id: 'api-a', projectId: 'a', name: 'api', path: '/x/api', kind: 'folder' }
    const first: Workspace = { ...local('a'), kind: 'folder' }
    const s = { workspaces: [first, api, wt('w9', 'a'), local('b')], currentWorkspaceId: 'api-a' }
    const branches = { 'local-a': { name: 'main', at: NOW }, 'api-a': { name: null, at: NOW } }
    expect(projectIsRepo(s, 'a', branches)).toBe(false)
    expect(projectIsRepo({ ...s, currentWorkspaceId: 'w9' }, 'a', branches)).toBe(true)
    expect(projectIsRepo({ ...s, currentWorkspaceId: 'local-b' }, 'a', branches)).toBe(true)
    expect(projectIsRepo({ workspaces: [] }, 'a', branches)).toBeNull()
  })

  it('setNotice se borra solo; keptWorktreesNotice resume lo que main conserva', async () => {
    await boot()
    expect(keptWorktreesNotice([])).toBeNull()
    expect(keptWorktreesNotice(['/u/.config/omni/worktrees/a/cc-1'])).toBe('Se conserva 1 worktree con cambios en /u/.config/omni/worktrees/a')
    expect(keptWorktreesNotice(['/w/a/x', '/w/a/y'])).toBe('Se conservan 2 worktrees con cambios en /w/a')
    useWorktrees.getState().setNotice('hola')
    expect(useWorktrees.getState().notice).toBe('hola')
    await vi.advanceTimersByTimeAsync(NOTICE_MS + 1)
    expect(useWorktrees.getState().notice).toBeNull()
  })
})

describe('useWorktrees · navegación', () => {
  it('open saca el teclado de la terminal, pone la vista y J/K recorren con wrap-around', async () => {
    statuses.w1 = status(1)
    statuses.w2 = status(1)
    await boot([local('a'), wt('w1', 'a'), wt('w2', 'a')])
    useUi.getState().setFocus('terminal')
    useWorktrees.getState().open()
    expect(useUi.getState().view).toBe('worktrees')
    expect(useUi.getState().focus).toBe('list')
    // Misma antigüedad y sin agente: manda el orden de la lista (w1, w2).
    const w = useWorktrees.getState()
    expect(currentRow(w, useSessions.getState())?.workspace.id).toBe('w1')
    w.moveCursor(1)
    expect(useWorktrees.getState().cursor).toBe('w2')
    useWorktrees.getState().moveCursor(1)
    expect(useWorktrees.getState().cursor).toBe('w1')
    useWorktrees.getState().moveCursor(-1)
    expect(useWorktrees.getState().cursor).toBe('w2')
    useWorktrees.getState().back()
    expect(useUi.getState().view).toBe('fleet')
    // Al abrir se pide la rama del workspace local de cada proyecto (para N / I).
    expect(calls('workspace:branch').map((c) => c[1])).toEqual(['local-a'])
  })

  it('con la vista en pantalla, el cursor es el destino de review.open; fuera de ella no ofrece nada', async () => {
    statuses.w1 = status(1)
    statuses.w2 = status(1)
    await boot([local('a'), wt('w1', 'a'), wt('w2', 'a')])
    expect(providedReviewTarget()).toBeNull()
    useWorktrees.getState().open()
    useWorktrees.getState().setCursor('w2')
    expect(providedReviewTarget()).toBe('w2')
    useWorktrees.getState().back()
    expect(providedReviewTarget()).toBeNull()
    stop()
    useUi.getState().setView('worktrees')
    expect(providedReviewTarget()).toBeNull()
  })

  it('enterAgent entra al pane del agente del worktree y vuelve a la flota', async () => {
    await boot([local('a'), wt('w1', 'a')])
    useSessions.setState({ sessions: [session('s1', 'w1')] })
    useLayout.getState().openTab('w1', 's1')
    useUi.getState().setView('worktrees')
    useWorktrees.getState().enterAgent('w1')
    expect(useUi.getState().view).toBe('fleet')
    expect(useUi.getState().focus).toBe('terminal')
    expect(focusTerminal).toHaveBeenCalled()
    expect(useSessions.getState().currentWorkspaceId).toBe('w1')
  })
})

describe('useWorktrees · crear', () => {
  it('create normaliza el nombre, pide worktree:create, recarga y deja el cursor en el nuevo', async () => {
    await boot()
    const ws = await useWorktrees.getState().create('a', ' Rate Limit ')
    expect(ws?.id).toBe('rate-limit')
    expect(calls('worktree:create')[0].slice(1)).toEqual(['a', { name: 'rate-limit', locationId: 'local-a' }])
    expect(useSessions.getState().workspaces.some((w) => w.id === 'rate-limit')).toBe(true)
    expect(useWorktrees.getState().cursor).toBe('rate-limit')
    expect(useWorktrees.getState().error).toBeNull()
  })

  it('create con nombre vacío o error de main deja el motivo en error y devuelve null', async () => {
    await boot()
    expect(await useWorktrees.getState().create('a', '   ')).toBeNull()
    expect(useWorktrees.getState().error).toBe('El nombre no puede estar vacío')
    invoke.mockImplementationOnce(async () => {
      throw new Error("Error invoking remote method 'worktree:create': Error: el proyecto no es un repo git")
    })
    expect(await useWorktrees.getState().create('a', 'x')).toBeNull()
    expect(useWorktrees.getState().error).toBe('el proyecto no es un repo git')
  })

  it('createForLaunch nombra <badge>-<n> con el primer número libre del proyecto actual', async () => {
    await boot([local('a'), wt('cc-1', 'a')])
    const ws = await useWorktrees.getState().createForLaunch('claude')
    expect(ws?.name).toBe('cc-2')
    expect(calls('worktree:create')[0][2]).toEqual({ name: 'cc-2', locationId: 'local-a' })
  })

  it('remove borra el worktree (⇧⏎ abortado) y recarga', async () => {
    await boot([local('a'), wt('cc-1', 'a')])
    await useWorktrees.getState().remove('cc-1')
    expect(calls('worktree:remove')[0][1]).toBe('cc-1')
    expect(useSessions.getState().workspaces.map((w) => w.id)).toEqual(['local-a'])
  })

  it('createFromIssue resuelve el issue, crea el worktree y abre el launcher con el prompt en espera', async () => {
    await boot()
    const ws = await useWorktrees.getState().createFromIssue('a', 41)
    expect(ws?.id).toBe('issue-41-titulo')
    expect(calls('git:issue')[0].slice(1)).toEqual(['a', 41])
    expect(calls('worktree:create')[0].slice(1)).toEqual(['a', { issue: 41, locationId: 'local-a' }])
    expect(useUi.getState().overlay).toBe('launcher')
    expect(useSessions.getState().currentWorkspaceId).toBe('issue-41-titulo')
    expect(useWorktrees.getState().pendingLaunch).toEqual({ workspaceId: 'issue-41-titulo', prompt: 'Issue #41: Rate limit por IP\nhttps://github.com/o/r/issues/41' })
  })

  it('si gh falla, createFromIssue no crea nada y deja el error', async () => {
    await boot()
    invoke.mockImplementationOnce(async () => {
      throw new Error('gh no está autenticado o el repo no es de GitHub')
    })
    expect(await useWorktrees.getState().createFromIssue('a', 41)).toBeNull()
    expect(calls('worktree:create')).toHaveLength(0)
    expect(useWorktrees.getState().error).toBe('gh no está autenticado o el repo no es de GitHub')
    expect(useUi.getState().overlay).toBeNull()
  })

  it('el launcher toma lo pendiente y escribe el prompt del issue cuando el agente se calma; cerrar el launcher lo cancela', async () => {
    await boot([local('a'), wt('w1', 'a')])
    useWorktrees.getState().launchIn('w1', 'Issue #41: x\nurl')
    const pending = useWorktrees.getState().takePendingLaunch()
    expect(pending).toEqual({ workspaceId: 'w1', prompt: 'Issue #41: x\nurl' })
    expect(useWorktrees.getState().takePendingLaunch()).toBeNull()
    useWorktrees.getState().linkLaunched(pending!, session('s1', 'w1'))
    expect(writeWhenSettled).toHaveBeenCalledWith('s1', 'Issue #41: x\nurl')
    // Una terminal pelada no recibe el prompt: correría como comando.
    useWorktrees.getState().linkLaunched(pending!, session('s2', 'w1', 'shell'))
    expect(writeWhenSettled).toHaveBeenCalledTimes(1)

    useWorktrees.getState().launchIn('w1')
    useWorktrees.getState().setLaunchInNew(true)
    expect(useUi.getState().overlay).toBe('launcher')
    useUi.getState().closeOverlay()
    expect(useWorktrees.getState().pendingLaunch).toBeNull()
    expect(useWorktrees.getState().launchInNew).toBe(false)
  })
})

describe('useWorktrees · descartar y tests', () => {
  it('discard abre confirmDiscard; confirmDiscard mata sus sesiones, llama git:discard y recarga', async () => {
    statuses.w1 = status(2)
    await boot([local('a'), wt('w1', 'a')])
    useSessions.setState({ sessions: [session('s1', 'w1')] })
    useWorktrees.getState().discard('w1')
    expect(useUi.getState().overlay).toBe('confirmDiscard')
    expect(useWorktrees.getState().discardId).toBe('w1')
    projectList = { ...projectList, workspaces: [local('a')] }
    await useWorktrees.getState().confirmDiscard('w1')
    expect(send).toHaveBeenCalledWith('session:kill', 's1')
    expect(calls('git:discard')[0][1]).toBe('w1')
    expect(useSessions.getState().workspaces.map((w) => w.id)).toEqual(['local-a'])
    expect(useWorktrees.getState().discardId).toBeNull()
    expect(useWorktrees.getState().statuses.w1).toBeUndefined()
  })

  it('runTests marca corriendo al toque y pide worktree:runTests', async () => {
    statuses.w1 = status(2)
    await boot([local('a'), wt('w1', 'a')])
    await useWorktrees.getState().runTests('w1')
    expect(calls('worktree:runTests')[0][1]).toBe('w1')
    expect(useWorktrees.getState().statuses.w1.tests?.status).toBe('running')
  })

  it('statusFingerprint cambia con el diff y con dirty', () => {
    expect(statusFingerprint(status(2))).toBe('2:2:0:0')
    expect(statusFingerprint(status(2, true))).toBe('2:2:0:1')
    expect(statusFingerprint(status(3))).not.toBe(statusFingerprint(status(2)))
  })

  it('un agente que trabaja 6 s seguidos y se calla corre los tests con estado fresco; un solo chunk no', async () => {
    statuses.w1 = status(2)
    await boot([local('a'), wt('w1', 'a')], [project('a', 'pnpm test')])
    useSessions.setState({ sessions: [session('s1', 'w1')] })
    // Un chunk suelto y silencio: no es "terminó de trabajar".
    useSessions.getState().onData('s1', 'hola')
    await vi.advanceTimersByTimeAsync(WORKING_WINDOW_MS + 1)
    expect(calls('worktree:runTests')).toHaveLength(0)
    // Seis segundos de salida seguida y luego la pausa: sí.
    await work('s1', 6000)
    expect(calls('worktree:runTests').map((c) => c[1])).toEqual(['w1'])
    expect(calls('worktree:status').at(-1)?.slice(1)).toEqual(['w1', true])
  })

  it('la racha se corta al pasar a idle: dos rachas cortas separadas por una pausa no suman', async () => {
    statuses.w1 = status(2)
    await boot([local('a'), wt('w1', 'a')], [project('a', 'pnpm test')])
    useSessions.setState({ sessions: [session('s1', 'w1')] })
    await work('s1', 3000)
    await work('s1', 3000)
    expect(calls('worktree:runTests')).toHaveLength(0)
    expect(AUTO_TESTS_MIN_WORKING_MS).toBe(5000)
  })

  it('una segunda pausa sin cambios en el diff no repite los tests; con cambios nuevos sí', async () => {
    statuses.w1 = status(2)
    await boot([local('a'), wt('w1', 'a')], [project('a', 'pnpm test')])
    useSessions.setState({ sessions: [session('s1', 'w1')] })
    await work('s1', 6000)
    expect(calls('worktree:runTests')).toHaveLength(1)
    // Main publica el resultado; el diff no cambió.
    statuses.w1 = status(2, false, { status: 'pass', summary: 'ok', at: NOW })
    await work('s1', 6000)
    expect(calls('worktree:runTests')).toHaveLength(1)
    statuses.w1 = status(3, false, { status: 'pass', summary: 'ok', at: NOW })
    await work('s1', 6000)
    expect(calls('worktree:runTests')).toHaveLength(2)
  })

  it('shell, navegador, editor y preview no disparan tests aunque vivan en un worktree', async () => {
    statuses.w1 = status(2)
    await boot([local('a'), wt('w1', 'a')], [project('a', 'pnpm test')])
    useSessions.setState({ sessions: [session('sh', 'w1', 'shell'), session('br', 'w1', 'browser'), session('ed', 'w1', 'editor'), session('pv', 'w1', 'preview')] })
    for (const id of ['sh', 'br', 'ed', 'pv']) await work(id, 6000)
    expect(calls('worktree:runTests')).toHaveLength(0)
  })

  it('sin comando de tests, sin cambios, con tests corriendo o fuera de un worktree no se lanza nada', async () => {
    statuses.w1 = status(0)
    statuses.w2 = status(3, false, { status: 'running', summary: '', at: NOW })
    statuses.w3 = status(3)
    await boot([local('a'), wt('w1', 'a'), wt('w2', 'a'), local('b'), wt('w3', 'b')], [project('a', 'pnpm test'), project('b')])
    useSessions.setState({ sessions: [session('s1', 'w1'), session('s2', 'w2'), session('s3', 'local-a'), session('s4', 'w3')] })
    for (const id of ['s1', 's2', 's3', 's4']) await work(id, 6000)
    expect(calls('worktree:runTests')).toHaveLength(0)
    // Ahora el worktree sin cambios tiene cambios: sí corre.
    statuses.w1 = status(1)
    await work('s1', 6000)
    expect(calls('worktree:runTests').map((c) => c[1])).toEqual(['w1'])
  })

  it('setTestCommand guarda (vacío = null) y recarga proyectos', async () => {
    await boot()
    projectList = { ...projectList, projects: [project('a', 'pnpm test')] }
    await useWorktrees.getState().setTestCommand('a', ' pnpm test ')
    expect(calls('project:setTestCommand')[0].slice(1)).toEqual(['a', 'pnpm test'])
    expect(useSessions.getState().projects[0].testCommand).toBe('pnpm test')
    await useWorktrees.getState().setTestCommand('a', '')
    expect(calls('project:setTestCommand')[1].slice(1)).toEqual(['a', null])
  })
})
