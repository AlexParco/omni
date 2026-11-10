import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListeningProcess, Workspace } from '@shared/types'
import { advertisedUrl, extraPorts, groupPorts, homeOf, inWorkspace, loopbackOnly, portPlace, portUrl, samePortOrigin, uptimeLabel, visiblePortIds, workspaceOfPort } from './ports-logic'
import { PORTS_IDLE_REFRESH_MS, PORTS_OPEN_REFRESH_MS, STOP_ARM_MS, usePorts } from './ports'
import { useUi } from './ui'

const invoke = vi.fn()
vi.mock('@/lib/omni', () => ({
  omni: { invoke: (...args: unknown[]) => invoke(...args), send: vi.fn(), on: () => () => {} }
}))
vi.mock('@/panes/terminal/terminal-host', () => ({ getTerminal: () => undefined, blurTerminals: () => {} }))
vi.mock('./browser', () => ({ liveBrowserId: () => null, useBrowser: { getState: () => ({ states: {}, blur: vi.fn(), navigate: vi.fn() }) } }))
vi.mock('./notify', () => ({ enterSession: vi.fn() }))

const proc = (pid: number, port: number, patch: Partial<ListeningProcess> = {}): ListeningProcess => ({
  pid,
  ports: [port],
  hosts: ['*'],
  name: 'nuxt dev',
  command: 'node nuxt dev',
  cwd: '/Users/ana/web',
  repo: null,
  startedAt: null,
  sessionId: null,
  inOmni: false,
  self: false,
  kind: 'dev',
  ...patch
})

const LIST = [
  proc(10, 3000, { repo: { name: 'web', branch: 'dev', worktree: false, sub: '' } }),
  proc(11, 3100, { repo: { name: 'web', branch: 'feature/pagos', worktree: true, sub: '' }, ports: [3100, 24678] }),
  proc(12, 7123, { name: 'node dist/main.js', repo: { name: 'menu', branch: 'dev', worktree: false, sub: 'service' } }),
  proc(20, 5000, { kind: 'system', name: 'ControlCenter', cwd: '/' })
]

describe('ports-logic', () => {
  it('groupPorts separa dev y sistema y filtra por todas las palabras (puerto, repo, rama)', () => {
    expect(groupPorts(LIST).dev.map((p) => p.pid)).toEqual([10, 11, 12])
    expect(groupPorts(LIST).system.map((p) => p.pid)).toEqual([20])
    expect(groupPorts(LIST, 'pagos').dev.map((p) => p.pid)).toEqual([11])
    expect(groupPorts(LIST, '71').dev.map((p) => p.pid)).toEqual([12])
    expect(groupPorts(LIST, 'web feature').dev.map((p) => p.pid)).toEqual([11])
    expect(groupPorts(LIST, 'control').system.map((p) => p.pid)).toEqual([20])
  })

  it('visiblePortIds esconde Sistema plegado', () => {
    expect(visiblePortIds(groupPorts(LIST), false)).toEqual(['10', '11', '12'])
    expect(visiblePortIds(groupPorts(LIST), true)).toEqual(['10', '11', '12', '20'])
  })

  it('portPlace: repo/sub · rama, si no la carpeta con ~, y nada para el sistema', () => {
    expect(portPlace(LIST[1])).toBe('web · feature/pagos')
    expect(portPlace(LIST[2])).toBe('menu/service · dev')
    expect(portPlace(proc(1, 1, { cwd: '/Users/ana/tmp/x' }), '/Users/ana')).toBe('~/tmp/x')
    expect(portPlace(LIST[3])).toBe('')
  })

  it('etiquetas: URL, puertos de más, tiempo arriba, loopback, home', () => {
    expect(portUrl(LIST[1])).toBe('http://localhost:3100')
    expect(extraPorts(LIST[1])).toBe('+ 24678')
    expect(extraPorts(LIST[0])).toBe('')
    const now = 10 * 86400_000
    expect(uptimeLabel(now - 20_000, now)).toBe('recién')
    expect(uptimeLabel(now - 14 * 60_000, now)).toBe('14m')
    expect(uptimeLabel(now - 3 * 3600_000, now)).toBe('3h')
    expect(uptimeLabel(now - 3 * 86400_000, now)).toBe('3d')
    expect(uptimeLabel(null, now)).toBe('')
    expect(loopbackOnly({ hosts: ['127.0.0.1', '::1'] })).toBe(true)
    expect(loopbackOnly({ hosts: ['*'] })).toBe(false)
    expect(homeOf(['/Users/ana/web'])).toBe('/Users/ana')
  })

  it('workspaceOfPort: el de su sesión, si no la ruta más larga que contiene el cwd', () => {
    const ws = (id: string, path: string): Workspace => ({ id, projectId: 'p', name: id, path, kind: 'local' })
    const all = [ws('a', '/Users/ana/web'), ws('b', '/Users/ana/web/apps/admin'), ws('c', '/Users/ana/menu')]
    expect(workspaceOfPort({ cwd: '/Users/ana/web/apps/admin/src', sessionId: null }, all, null)?.id).toBe('b')
    expect(workspaceOfPort({ cwd: '/Users/ana/webx', sessionId: null }, all, null)).toBeNull()
    expect(workspaceOfPort({ cwd: '/', sessionId: 's' }, all, 'c')?.id).toBe('c')
  })

  it('samePortOrigin reconoce localhost, 127.0.0.1 y ::1 con el mismo puerto', () => {
    expect(samePortOrigin('http://localhost:3000/login', 3000)).toBe(true)
    expect(samePortOrigin('http://127.0.0.1:3000', 3000)).toBe(true)
    expect(samePortOrigin('http://[::1]:3000', 3000)).toBe(true)
    expect(samePortOrigin('http://localhost:3001', 3000)).toBe(false)
    expect(samePortOrigin('https://example.com:3000', 3000)).toBe(false)
    expect(samePortOrigin('', 3000)).toBe(false)
  })
})

describe('usePorts', () => {
  let focused = true
  let stop: () => void = () => {}

  beforeEach(() => {
    vi.useFakeTimers()
    invoke.mockReset()
    invoke.mockImplementation(async (channel: string) => (channel === 'ports:list' ? LIST : { ok: true, forced: false }))
    usePorts.setState({ list: [], loaded: false, cursor: null, query: '', systemOpen: false, armed: null, stopping: {}, notice: null })
    useUi.setState({ overlay: null })
    focused = true
    vi.stubGlobal('document', { hasFocus: () => focused })
  })

  afterEach(() => {
    stop()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('al arrancar pide la lista y deja el cursor en el primer servicio', async () => {
    stop = usePorts.getState().init()
    await vi.advanceTimersByTimeAsync(0)
    expect(usePorts.getState().loaded).toBe(true)
    expect(usePorts.getState().cursor).toBe('10')
  })

  it('cerrado repide cada 10 s solo con foco; abierto, cada 2 s', async () => {
    stop = usePorts.getState().init()
    await vi.advanceTimersByTimeAsync(0)
    invoke.mockClear()
    await vi.advanceTimersByTimeAsync(PORTS_IDLE_REFRESH_MS)
    expect(invoke).toHaveBeenCalledTimes(1)
    focused = false
    await vi.advanceTimersByTimeAsync(PORTS_IDLE_REFRESH_MS)
    expect(invoke).toHaveBeenCalledTimes(1)
    useUi.setState({ overlay: 'ports' })
    await vi.advanceTimersByTimeAsync(PORTS_OPEN_REFRESH_MS * 3)
    expect(invoke).toHaveBeenCalledTimes(4)
  })

  it('el cursor no entra en Sistema plegado y el filtro lo asienta en lo que coincide', async () => {
    await usePorts.getState().refresh()
    usePorts.getState().moveCursor(5)
    expect(usePorts.getState().cursor).toBe('12')
    usePorts.getState().setQuery('control')
    expect(usePorts.getState().cursor).toBe('20')
    usePorts.getState().setQuery('')
    expect(usePorts.getState().cursor).toBe('10')
  })

  it('detener pide una segunda X antes de STOP_ARM_MS y entonces llama ports:stop con pid y puerto', async () => {
    await usePorts.getState().refresh()
    await usePorts.getState().stop('11')
    expect(usePorts.getState().armed).toBe('11')
    expect(invoke).not.toHaveBeenCalledWith('ports:stop', 11, 3100)
    await vi.advanceTimersByTimeAsync(STOP_ARM_MS + 10)
    expect(usePorts.getState().armed).toBeNull()
    await usePorts.getState().stop('11')
    await usePorts.getState().stop('11')
    expect(invoke).toHaveBeenCalledWith('ports:stop', 11, 3100)
    expect(usePorts.getState().notice).toMatch(/Detenido :3100/)
  })

  it('omni mismo no se detiene', async () => {
    invoke.mockImplementation(async () => [proc(30, 9229, { self: true })])
    await usePorts.getState().refresh()
    await usePorts.getState().stop('30')
    expect(usePorts.getState().armed).toBeNull()
    expect(usePorts.getState().notice).toMatch(/omni mismo/)
  })
})

describe('ports-logic: como Orca', () => {
  it('advertisedUrl toma la URL que el servidor anunció para ese puerto, sin colores', () => {
    const vite = '\x1b[32m  ➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttps://localhost:\x1b[1m5173\x1b[22m/app/\x1b[39m\n  ➜  Network: use --host'
    expect(advertisedUrl(vite, 5173)).toBe('https://localhost:5173/app/')
    expect(advertisedUrl('Listening on http://0.0.0.0:3000.', 3000)).toBe('http://localhost:3000')
    expect(advertisedUrl('old http://localhost:3000/a\nnew http://localhost:3000/b', 3000)).toBe('http://localhost:3000/b')
    expect(advertisedUrl('http://localhost:3001', 3000)).toBeNull()
    expect(advertisedUrl('https://example.com:3000', 3000)).toBeNull()
  })

  it('groupPorts separa los del workspace actual (por sesión o por carpeta) del resto', () => {
    const ws: Workspace[] = [{ id: 'w1', projectId: 'p', name: 'web', path: '/Users/ana/web', kind: 'local' }, { id: 'w2', projectId: 'q', name: 'menu', path: '/Users/ana/menu', kind: 'local' }]
    const list = [proc(1, 3000, { cwd: '/Users/ana/web' }), proc(2, 3100, { cwd: '/tmp/x', sessionId: 's1' }), proc(3, 7000, { cwd: '/Users/ana/menu' })]
    const here = inWorkspace('w1', ws, [{ id: 's1', agent: 'shell', workspaceId: 'w1', cwd: '/', createdAt: 0 }])
    const g = groupPorts(list, '', here)
    expect(g.here.map((p) => p.pid)).toEqual([1, 2])
    expect(g.dev.map((p) => p.pid)).toEqual([3])
    expect(visiblePortIds(g, false)).toEqual(['1', '2', '3'])
    expect(groupPorts(list, '', inWorkspace(null, ws, [])).here).toEqual([])
  })
})
