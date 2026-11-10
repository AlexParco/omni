import { describe, expect, it } from 'vitest'
import type { SavedSession } from '@shared/daemon'
import type { AgentDef, SessionInfo, Workspace } from '@shared/types'
import { claudeTranscriptCheck, reviveRemote, type RemoteHosts } from './revive'
import type { CreateOptions, SessionBackend } from './session-backend'

const WS: Workspace = { id: 'w1', projectId: 'p1', name: 'Local', path: '/home/deploy/api', kind: 'local', host: 'h1' }
const CLAUDE: AgentDef = { id: 'claude', name: 'Claude Code', badge: 'CC', command: 'claude' }
const UUID = '0b6c2f4e-1a2b-4c3d-8e9f-0123456789ab'
const saved = (over: Partial<SavedSession> = {}): SavedSession => ({ id: 's1', agent: 'claude', workspaceId: 'w1', cwd: WS.path, createdAt: 1, resumeId: UUID, ...over })

function backend(orphans: SavedSession[], ready = true) {
  const created: CreateOptions[] = []
  const dismissed: string[] = []
  const impl: Pick<SessionBackend, 'orphans' | 'dismiss' | 'list' | 'create' | 'remoteReady'> = {
    orphans: () => Promise.resolve(orphans),
    dismiss: (ids) => {
      dismissed.push(...ids)
      return Promise.resolve()
    },
    list: () => Promise.resolve([]),
    remoteReady: () => ready,
    create: (_a, ws, _args, opts = {}) => {
      created.push(opts)
      return Promise.resolve({ id: opts.id ?? 'x', agent: 'claude', workspaceId: ws.id, cwd: ws.path, createdAt: 0, remote: true } satisfies SessionInfo)
    }
  }
  return { backend: impl as unknown as SessionBackend, created, dismissed }
}

function hosts(alive: boolean, transcript: boolean, unreachable = false): RemoteHosts & { ran: string[] } {
  const ran: string[] = []
  return {
    ran,
    ensure: () => (unreachable ? Promise.reject(new Error('sin red')) : Promise.resolve({ transport: { run: (cmd: string) => (ran.push(cmd), Promise.resolve({ code: transcript ? 0 : 1 })) } })),
    hasSession: () => Promise.resolve(alive),
    terminalSpawn: (_h, id) => Promise.resolve({ file: 'ssh', args: ['-tt', '--', `dtach ${id}`], reconnect: true })
  }
}

const deps = (b: SessionBackend, h: RemoteHosts) => ({ backend: b, workspace: (id: string) => (id === 'w1' ? WS : undefined), findAgent: () => CLAUDE, hosts: h, enabled: true, log: () => undefined })

describe('reviveRemote', () => {
  it('sesión dtach viva: se engancha con el mismo id sin escribir nada', async () => {
    const b = backend([saved()])
    const r = await reviveRemote(deps(b.backend, hosts(true, false)))
    expect(r.sessions).toHaveLength(1)
    expect(b.created[0]).toMatchObject({ id: 's1', command: null, restored: true, restoreScreen: false })
    expect(b.created[0].spawn?.args).toContain('dtach s1')
  })

  it('host reiniciado: relanza Claude con --resume si su transcript está en el host', async () => {
    const b = backend([saved()])
    const h = hosts(false, true)
    await reviveRemote(deps(b.backend, h))
    expect(b.created[0].command).toBe(`claude --resume ${UUID}`)
    expect(b.created[0].restoreScreen).toBe(true)
    expect(h.ran[0]).toBe(claudeTranscriptCheck(WS.path, UUID))
  })

  it('host inalcanzable: la sesión queda huérfana para el próximo intento (no se descarta)', async () => {
    const b = backend([saved()])
    const r = await reviveRemote(deps(b.backend, hosts(false, false, true)))
    expect(r.sessions).toHaveLength(0)
    expect(b.dismissed).toEqual([])
  })

  it('daemon de otro build: no revive nada (abriría shells locales) ni descarta', async () => {
    const b = backend([saved()], false)
    const r = await reviveRemote(deps(b.backend, hosts(true, true)))
    expect(r.sessions).toHaveLength(0)
    expect(b.created).toHaveLength(0)
    expect(b.dismissed).toEqual([])
  })

  it('claudeTranscriptCheck rechaza un id que no es uuid (va en una línea de shell)', () => {
    expect(() => claudeTranscriptCheck('/x', "a'; rm -rf ~")).toThrow()
  })

  /** Backend con estado: `create` deja la sesión viva en `list` (como el daemon), y rechaza un id vivo. */
  function liveBackend(orphans: SavedSession[]) {
    const live: SessionInfo[] = []
    let creates = 0
    const impl: Pick<SessionBackend, 'orphans' | 'dismiss' | 'list' | 'create' | 'remoteReady'> = {
      orphans: () => Promise.resolve(orphans.filter((o) => !live.some((s) => s.id === o.id))),
      dismiss: () => Promise.resolve(),
      list: () => Promise.resolve([...live]),
      remoteReady: () => true,
      create: (_a, ws, _args, opts = {}) => {
        creates++
        if (live.some((s) => s.id === opts.id)) return Promise.reject(new Error(`la sesión ${opts.id} ya existe`))
        const info: SessionInfo = { id: opts.id ?? 'x', agent: 'claude', workspaceId: ws.id, cwd: ws.path, createdAt: 0, remote: true }
        live.push(info)
        return Promise.resolve(info)
      }
    }
    return { backend: impl as unknown as SessionBackend, live, creates: () => creates }
  }

  /** Hosts cuyo `ensure` tarda (conectar por ssh): da tiempo a que dos revivir se solapen. */
  function slowHosts(ms: number): RemoteHosts {
    const h = hosts(true, false)
    return { ...h, ensure: (id) => new Promise((r) => setTimeout(() => r(h.ensure(id)), ms)) }
  }

  it('dos revivir a la vez (arranque + connected) crean cada sesión una sola vez', async () => {
    const b = liveBackend([saved(), saved({ id: 's2' })])
    const h = slowHosts(30)
    const [a, c] = await Promise.all([reviveRemote(deps(b.backend, h)), reviveRemote({ ...deps(b.backend, h), hostId: 'h1' })])
    expect(b.live.map((s) => s.id).sort()).toEqual(['s1', 's2'])
    expect(a.sessions.length + c.sessions.length).toBe(2)
    expect(b.creates()).toBe(2)
  })

  it('si otra llamada la revivió mientras se conectaba, no se crea de nuevo', async () => {
    const b = liveBackend([saved()])
    const h = hosts(true, false)
    const racing: RemoteHosts = {
      ...h,
      // Mientras esta llamada "conecta", la sesión aparece viva (la revivió otro camino).
      ensure: async (id) => {
        b.live.push({ id: 's1', agent: 'claude', workspaceId: 'w1', cwd: WS.path, createdAt: 0, remote: true })
        return h.ensure(id)
      }
    }
    const r = await reviveRemote(deps(b.backend, racing))
    expect(r.sessions).toHaveLength(0)
    expect(b.creates()).toBe(0)
  })

  it('el daemon rechaza un id ya vivo: no se da el host por caído y las demás se reviven', async () => {
    const b = liveBackend([saved(), saved({ id: 's2' })])
    const h = hosts(true, false)
    const original = b.backend.list.bind(b.backend)
    let calls = 0
    // La comprobación previa a crear `s1` no la ve (carrera), pero el daemon sí la tiene viva.
    b.backend.list = () => {
      calls++
      if (calls === 2) {
        b.live.push({ id: 's1', agent: 'claude', workspaceId: 'w1', cwd: WS.path, createdAt: 0, remote: true })
        return Promise.resolve([])
      }
      return original()
    }
    const r = await reviveRemote(deps(b.backend, h))
    expect(r.sessions.map((s) => s.id)).toEqual(['s2'])
    expect(b.live.map((s) => s.id).sort()).toEqual(['s1', 's2'])
  })
})
