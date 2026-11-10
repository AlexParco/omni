import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedSession } from '@shared/daemon'
import type { AgentDef, AgentId, SessionInfo, Workspace } from '@shared/types'
import {
  currentClaudeChats,
  type Candidate,
  type Exec,
  ResumeResolver,
  remoteRecovery,
  claudeProjectDir,
  hermesIdTime,
  launchCommand,
  parseCodexMeta,
  pickCandidate,
  resumeCommand,
  reviveSessions,
  uuidV7Time
} from './revive'
import type { CreateOptions, SessionBackend } from './session-backend'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** UUIDv7 con la hora `ms` en sus primeros 48 bits, como los ids de Codex. */
function uuidV7(ms: number): string {
  const hex = ms.toString(16).padStart(12, '0') + '7' + randomBytes(10).toString('hex').slice(0, 19)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Id de Hermes con la hora local de `ms`. */
function hermesId(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_abc123`
}

const agent = (id: AgentId, command: string | null = id): AgentDef => ({ id, name: id, badge: id, command })

const saved = (agentId: AgentId, extra: Partial<SavedSession> = {}): SavedSession => ({ id: `s-${agentId}`, agent: agentId, workspaceId: 'w1', cwd: '/proj', createdAt: 1_700_000_000_000, ...extra })

describe('helpers puros', () => {
  it('claudeProjectDir: todo lo no alfanumérico pasa a guion', () => {
    expect(claudeProjectDir('/Users/yo/mi.proyecto_x')).toBe('-Users-yo-mi-proyecto-x')
  })

  it('uuidV7Time: los primeros 48 bits son la hora; otra forma es null', () => {
    const t = 1_761_000_000_123
    expect(uuidV7Time(uuidV7(t))).toBe(t)
    expect(uuidV7Time('123e4567-e89b-42d3-a456-426614174000')).toBeNull()
    expect(uuidV7Time('nope')).toBeNull()
  })

  it('hermesIdTime: hora local del id; otra forma es null', () => {
    expect(hermesIdTime('20261022_093015_abcdef')).toBe(new Date(2026, 9, 22, 9, 30, 15).getTime())
    expect(hermesIdTime('2026-10-22_abc')).toBeNull()
  })

  describe('pickCandidate', () => {
    const T = 1_000_000
    const c = (id: string, at: number, cwd = '/a'): Candidate => ({ id, cwd, at })

    it('misma carpeta (o su variante) y la más cercana a T', () => {
      expect(pickCandidate([c('lejos', T + 30_000), c('cerca', T + 500), c('otra', T, '/b')], ['/a'], T, new Set())).toBe('cerca')
      expect(pickCandidate([c('real', T, '/private/a')], ['/a', '/private/a'], T, new Set())).toBe('real')
    })

    it('ventana [T−2 s, T+60 s]; openEnded acepta cualquier momento posterior', () => {
      expect(pickCandidate([c('antes', T - 2_001)], ['/a'], T, new Set())).toBeNull()
      expect(pickCandidate([c('borde', T - 2_000)], ['/a'], T, new Set())).toBe('borde')
      expect(pickCandidate([c('tarde', T + 60_001)], ['/a'], T, new Set())).toBeNull()
      expect(pickCandidate([c('tarde', T + 3_600_000)], ['/a'], T, new Set(), true)).toBe('tarde')
      expect(pickCandidate([c('antes', T - 2_001)], ['/a'], T, new Set(), true)).toBeNull()
    })

    it('excluye las reclamadas', () => {
      expect(pickCandidate([c('x', T), c('y', T + 5_000)], ['/a'], T, new Set(['x']))).toBe('y')
    })
  })

  describe('parseCodexMeta', () => {
    const line = (payload: Record<string, unknown>, type = 'session_meta'): string =>
      JSON.stringify({ type, payload: { id: 'c1', cwd: '/a', timestamp: '2026-10-22T10:00:00.000Z', ...payload } })

    it('session_meta interactiva → candidato', () => {
      expect(parseCodexMeta(line({ originator: 'codex-tui', thread_source: 'user' }))).toEqual({ id: 'c1', cwd: '/a', at: Date.parse('2026-10-22T10:00:00.000Z') })
      expect(parseCodexMeta(line({ originator: 'codex_cli_rs' }))?.id).toBe('c1')
    })

    it('descarta forks, exec, otros originators, thread_source no user y basura', () => {
      expect(parseCodexMeta(line({ forked_from_id: 'c0' }))).toBeNull()
      expect(parseCodexMeta(line({ source: 'exec' }))).toBeNull()
      expect(parseCodexMeta(line({ originator: 'vscode' }))).toBeNull()
      expect(parseCodexMeta(line({ thread_source: 'subagent' }))).toBeNull()
      expect(parseCodexMeta(line({}, 'response_item'))).toBeNull()
      expect(parseCodexMeta(line({ timestamp: 'nunca' }))).toBeNull()
      expect(parseCodexMeta('{ roto')).toBeNull()
      expect(parseCodexMeta(null)).toBeNull()
    })
  })

  it('launchCommand: Claude recibe --session-id con su uuid; el resto igual; shell null', () => {
    const l = launchCommand(agent('claude'))
    expect(l.resumeId).toMatch(UUID_RE)
    expect(l.command).toBe(`claude --session-id ${l.resumeId}`)
    expect(launchCommand(agent('codex'))).toEqual({ command: 'codex' })
    expect(launchCommand(agent('shell', null))).toEqual({ command: null })
  })

  it('resumeCommand: cada agente con su flag de retomar', () => {
    expect(resumeCommand(agent('claude'), 'u1', saved('claude'))).toEqual({ command: 'claude --resume u1', resumeId: 'u1' })
    expect(resumeCommand(agent('codex'), 'c1', saved('codex'))).toEqual({ command: 'codex resume c1', resumeId: 'c1' })
    expect(resumeCommand(agent('opencode'), 'o1', saved('opencode'))).toEqual({ command: 'opencode -s o1', resumeId: 'o1' })
    expect(resumeCommand(agent('hermes'), 'h1', saved('hermes'))).toEqual({ command: 'hermes --resume h1', resumeId: 'h1' })
    expect(resumeCommand(agent('shell', null), null, saved('shell'))).toEqual({ command: null })
  })

  it('resumeCommand sin conversación: Claude conserva su --session-id; los demás arrancan limpios', () => {
    expect(resumeCommand(agent('claude'), null, saved('claude', { resumeId: 'u9' }))).toEqual({ command: 'claude --session-id u9', resumeId: 'u9' })
    const fresh = resumeCommand(agent('claude'), null, saved('claude'))
    expect(fresh.resumeId).toMatch(UUID_RE)
    expect(resumeCommand(agent('codex'), null, saved('codex'))).toEqual({ command: 'codex' })
    expect(resumeCommand(agent('goose'), null, saved('goose'))).toEqual({ command: 'goose' })
  })
})

describe('ResumeResolver', () => {
  let home: string
  let cwd: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'omni-revive-home-'))
    // Carpeta que no existe: cwdVariants se queda con la ruta tal cual (sin /private de macOS).
    cwd = '/no/existe/proyecto'
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const noExec: Exec = () => Promise.reject(new Error('no debería llamarse'))

  it('Claude: transcript en ~/.claude/projects → lo retoma; sin transcript → null', async () => {
    const r = new ResumeResolver({ home, exec: noExec })
    const dir = join(home, '.claude', 'projects', claudeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'u1.jsonl'), '{}\n')
    expect(await r.find(saved('claude', { cwd, resumeId: 'u1' }), new Set())).toBe('u1')
    expect(await r.find(saved('claude', { cwd, resumeId: 'u2' }), new Set())).toBeNull()
    expect(await r.find(saved('claude', { cwd }), new Set())).toBeNull()
  })

  describe('Codex', () => {
    const T = new Date(2026, 9, 22, 10, 0, 0).getTime()

    function rollout(at: number, rolloutCwd = cwd, extra: Record<string, unknown> = {}): string {
      const id = uuidV7(at)
      const d = new Date(at)
      const dir = join(home, '.codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
      mkdirSync(dir, { recursive: true })
      const meta = { type: 'session_meta', payload: { id, cwd: rolloutCwd, timestamp: new Date(at).toISOString(), originator: 'codex-tui', ...extra } }
      writeFileSync(join(dir, `rollout-2026-10-22T10-00-00-${id}.jsonl`), JSON.stringify(meta) + '\n{"type":"x"}\n')
      return id
    }

    it('dos candidatas en la misma carpeta: gana la más cercana y respeta claimed', async () => {
      const r = new ResumeResolver({ home, exec: noExec })
      const near = rollout(T + 800)
      const far = rollout(T + 20_000)
      rollout(T + 100, '/otra/carpeta')
      rollout(T + 200, cwd, { source: 'exec' })
      rollout(T + 120_000)
      const s = saved('codex', { cwd, createdAt: T })
      expect(await r.find(s, new Set())).toBe(near)
      expect(await r.find(s, new Set([near]))).toBe(far)
      expect(await r.find(s, new Set([near, far]))).toBeNull()
    })

    it('con resumeId guardado solo comprueba que el archivo exista en cualquier fecha', async () => {
      const r = new ResumeResolver({ home, exec: noExec })
      const old = rollout(T - 30 * 86_400_000)
      expect(await r.find(saved('codex', { cwd, createdAt: T, resumeId: old }), new Set())).toBe(old)
      expect(await r.find(saved('codex', { cwd, createdAt: T, resumeId: uuidV7(T) }), new Set())).toBeNull()
    })
  })

  /** `exec` falso que registra el SQL y responde con `rows`. */
  function fakeSqlite(rows: Record<string, unknown>[]): { exec: Exec; calls: string[][] } {
    const calls: string[][] = []
    const exec: Exec = (file, args) => {
      calls.push([file, ...args])
      return Promise.resolve({ code: 0, stdout: JSON.stringify(rows) })
    }
    return { exec, calls }
  }

  function touchDb(...parts: string[]): string {
    const file = join(home, ...parts)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '')
    return file
  }

  describe('OpenCode', () => {
    const T = 1_761_000_000_000

    it('sin base → null sin llamar a sqlite', async () => {
      expect(await new ResumeResolver({ home, exec: noExec }).find(saved('opencode', { cwd, createdAt: T }), new Set())).toBeNull()
    })

    it('consulta por carpeta y elige la fila más cercana (sin tope hacia adelante)', async () => {
      const db = touchDb('.local', 'share', 'opencode', 'opencode.db')
      const { exec, calls } = fakeSqlite([
        { id: 'o-tarde', cwd, at: T + 3_600_000 },
        { id: 'o-cerca', cwd, at: T + 90_000 },
        { id: 'o-otra', cwd: '/x', at: T }
      ])
      const r = new ResumeResolver({ home, exec })
      expect(await r.find(saved('opencode', { cwd, createdAt: T }), new Set())).toBe('o-cerca')
      expect(calls[0][0]).toBe('/usr/bin/sqlite3')
      expect(calls[0]).toContain(`file:${db}?mode=ro`)
      const sql = calls[0][calls[0].length - 1]
      expect(sql).toContain(`'${cwd}'`)
      expect(sql).toMatch(/from session /)
      expect(await r.find(saved('opencode', { cwd, createdAt: T }), new Set(['o-cerca']))).toBe('o-tarde')
    })

    it('con resumeId: existe si sqlite devuelve la fila', async () => {
      touchDb('.local', 'share', 'opencode', 'opencode.db')
      const yes = fakeSqlite([{ id: 'o1' }])
      expect(await new ResumeResolver({ home, exec: yes.exec }).find(saved('opencode', { cwd, resumeId: 'o1' }), new Set())).toBe('o1')
      expect(yes.calls[0][yes.calls[0].length - 1]).toContain("'o1'")
      const no = fakeSqlite([])
      expect(await new ResumeResolver({ home, exec: no.exec }).find(saved('opencode', { cwd, resumeId: 'o1' }), new Set())).toBeNull()
    })

    it('sqlite que falla o devuelve basura → null', async () => {
      touchDb('.local', 'share', 'opencode', 'opencode.db')
      const failing: Exec = () => Promise.resolve({ code: 1, stdout: '' })
      const junk: Exec = () => Promise.resolve({ code: 0, stdout: 'no es json' })
      expect(await new ResumeResolver({ home, exec: failing }).find(saved('opencode', { cwd, createdAt: T }), new Set())).toBeNull()
      expect(await new ResumeResolver({ home, exec: junk }).find(saved('opencode', { cwd, createdAt: T }), new Set())).toBeNull()
    })
  })

  describe('Hermes', () => {
    const T = new Date(2026, 9, 22, 10, 0, 0, 400).getTime()

    it('usa la hora local del id y la carpeta; escapa comillas en el SQL', async () => {
      touchDb('.hermes', 'state.db')
      const quoted = "/no/existe/o'brien"
      const near = hermesId(T + 3_000)
      const { exec, calls } = fakeSqlite([
        { id: hermesId(T + 120_000), cwd: quoted },
        { id: near, cwd: quoted },
        { id: 'sin-forma', cwd: quoted }
      ])
      const r = new ResumeResolver({ home, exec })
      expect(await r.find(saved('hermes', { cwd: quoted, createdAt: T }), new Set())).toBe(near)
      const sql = calls[0][calls[0].length - 1]
      expect(sql).toContain("'/no/existe/o''brien'")
      expect(sql).toMatch(/from sessions /)
    })

    it('id con segundos truncados justo antes del lanzamiento sigue valiendo', async () => {
      touchDb('.hermes', 'state.db')
      // Lanzado a T−2,2 s el id dice T−2,4 s (trunca): fuera de [T−2 s, …] sin el segundo de tolerancia.
      const id = hermesId(T - 2_200)
      const { exec } = fakeSqlite([{ id, cwd }])
      expect(await new ResumeResolver({ home, exec }).find(saved('hermes', { cwd, createdAt: T }), new Set())).toBe(id)
    })

    it('con resumeId: se comprueba la fila', async () => {
      touchDb('.hermes', 'state.db')
      const { exec, calls } = fakeSqlite([{ id: 'h1' }])
      expect(await new ResumeResolver({ home, exec }).find(saved('hermes', { cwd, resumeId: 'h1' }), new Set())).toBe('h1')
      expect(calls[0][calls[0].length - 1]).toContain("where id = 'h1'")
    })
  })

  it('agentes sin conversación (goose, shell) → null', async () => {
    const r = new ResumeResolver({ home, exec: noExec })
    expect(await r.find(saved('goose', { cwd }), new Set())).toBeNull()
    expect(await r.find(saved('shell', { cwd }), new Set())).toBeNull()
  })
})

describe('reviveSessions', () => {
  let home: string
  let cwd: string

  interface CreateCall {
    agent: AgentId
    path: string
    args?: string[]
    opts?: CreateOptions
  }

  /** Backend falso con lo que usa `reviveSessions`: orphans, dismiss, list, create. */
  function fakeBackend(orphans: SavedSession[], live: Partial<SessionInfo>[] = [], failOn: string[] = []) {
    const dismissed: string[] = []
    const created: CreateCall[] = []
    const impl: Pick<SessionBackend, 'orphans' | 'dismiss' | 'list' | 'create'> = {
      orphans: () => Promise.resolve(orphans),
      dismiss: (ids) => {
        dismissed.push(...ids)
        return Promise.resolve()
      },
      list: () => Promise.resolve(live.map((s, i) => ({ id: `live${i}`, agent: 'shell', workspaceId: 'w1', cwd: '/', createdAt: 0, ...s }))),
      create: (a, ws, args, opts) => {
        if (opts?.id && failOn.includes(opts.id)) return Promise.reject(new Error('pty agotado'))
        created.push({ agent: a.id, path: ws.path, args, opts })
        return Promise.resolve({ id: opts?.id ?? 'nuevo', agent: a.id, workspaceId: ws.id, cwd: ws.path, createdAt: 0, resumeId: opts?.resumeId, restored: true })
      }
    }
    return { backend: impl as unknown as SessionBackend, dismissed, created }
  }

  const AGENTS: Record<string, AgentDef> = {
    shell: agent('shell', null),
    claude: agent('claude'),
    codex: agent('codex'),
    browser: agent('browser', null)
  }

  function deps(backend: SessionBackend, extra: { enabled?: boolean; workspaces?: Record<string, Workspace> } = {}) {
    const workspaces = extra.workspaces ?? { w1: { id: 'w1', projectId: 'p1', name: 'main', path: cwd, kind: 'local' } }
    return {
      backend,
      enabled: extra.enabled ?? true,
      workspace: (id: string) => workspaces[id],
      findAgent: (id: string) => AGENTS[id],
      resolver: new ResumeResolver({ home, exec: () => Promise.resolve({ code: 1, stdout: '' }) }),
      log: () => undefined
    }
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'omni-revive-home-'))
    cwd = mkdtempSync(join(tmpdir(), 'omni-revive-cwd-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('sin huérfanas no hace nada', async () => {
    const f = fakeBackend([])
    expect(await reviveSessions(deps(f.backend))).toEqual({ sessions: [], resumed: 0 })
    expect(f.dismissed).toEqual([])
  })

  it('ajuste apagado: descarta todas', async () => {
    const f = fakeBackend([saved('shell', { id: 'a', cwd }), saved('claude', { id: 'b', cwd })])
    expect(await reviveSessions(deps(f.backend, { enabled: false }))).toEqual({ sessions: [], resumed: 0 })
    expect(f.dismissed).toEqual(['a', 'b'])
    expect(f.created).toEqual([])
  })

  it('workspace borrado, agente browser o desconocido → descartadas', async () => {
    const f = fakeBackend([
      saved('shell', { id: 'sin-ws', workspaceId: 'borrado', cwd }),
      saved('browser', { id: 'nav', cwd }),
      saved('hermes', { id: 'desconocido', cwd })
    ])
    await reviveSessions(deps(f.backend))
    expect(f.dismissed).toEqual(['sin-ws', 'nav', 'desconocido'])
    expect(f.created).toEqual([])
  })

  it('carpeta que ya no existe: cae al path del workspace; si tampoco existe, se descarta', async () => {
    const f = fakeBackend([saved('shell', { id: 'a', cwd: join(cwd, 'borrada') })])
    await reviveSessions(deps(f.backend))
    expect(f.created[0].path).toBe(cwd)
    const g = fakeBackend([saved('shell', { id: 'b', cwd: '/no/existe' })])
    await reviveSessions(deps(g.backend, { workspaces: { w1: { id: 'w1', projectId: 'p1', name: 'x', path: '/tampoco', kind: 'local' } } }))
    expect(g.dismissed).toEqual(['b'])
  })

  it('shell: se crea con su id, sin comando y con la pantalla guardada', async () => {
    const f = fakeBackend([saved('shell', { id: 'a', cwd, args: ['--x'] })])
    const r = await reviveSessions(deps(f.backend))
    expect(r.resumed).toBe(0)
    expect(r.sessions.map((s) => s.id)).toEqual(['a'])
    expect(f.created).toEqual([{ agent: 'shell', path: cwd, args: ['--x'], opts: { id: 'a', command: null, resumeId: undefined, restored: true, restoreScreen: true } }])
  })

  it('Claude con transcript: claude --resume <id>, sin pantalla guardada, cuenta como retomada', async () => {
    const dir = join(home, '.claude', 'projects', claudeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'u1.jsonl'), '{}\n')
    const f = fakeBackend([saved('claude', { id: 'c', cwd, resumeId: 'u1' })])
    const r = await reviveSessions(deps(f.backend))
    expect(r.resumed).toBe(1)
    expect(f.created[0].opts).toEqual({ id: 'c', command: 'claude --resume u1', resumeId: 'u1', restored: true, restoreScreen: false })
  })

  it('Claude con chat en curso distinto (tras /resume): manda el override, no el resumeId del registro', async () => {
    const dir = join(home, '.claude', 'projects', claudeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'u1.jsonl'), '{}\n')
    writeFileSync(join(dir, 'u9.jsonl'), '{}\n')
    const f = fakeBackend([saved('claude', { id: 'c', cwd, resumeId: 'u1' })])
    const r = await reviveSessions({ ...deps(f.backend), resumeOverrides: { c: 'u9' } })
    expect(r.resumed).toBe(1)
    expect(f.created[0].opts).toMatchObject({ command: 'claude --resume u9', resumeId: 'u9' })
  })

  it('Claude sin transcript: arranca limpio con el mismo --session-id y la pantalla guardada', async () => {
    const f = fakeBackend([saved('claude', { id: 'c', cwd, resumeId: 'u2' })])
    const r = await reviveSessions(deps(f.backend))
    expect(r.resumed).toBe(0)
    expect(f.created[0].opts).toEqual({ id: 'c', command: 'claude --session-id u2', resumeId: 'u2', restored: true, restoreScreen: true })
  })

  it('si create falla, se descarta esa y sigue con la siguiente', async () => {
    const f = fakeBackend([saved('shell', { id: 'a', cwd, createdAt: 1 }), saved('shell', { id: 'b', cwd, createdAt: 2 })], [], ['a'])
    const r = await reviveSessions(deps(f.backend))
    expect(r.sessions.map((s) => s.id)).toEqual(['b'])
    expect(f.dismissed).toEqual(['a'])
  })

  it('una conversación ya usada por una sesión viva no se retoma otra vez', async () => {
    const T = new Date(2026, 9, 22, 10, 0, 0).getTime()
    const id = uuidV7(T + 500)
    const d = new Date(T)
    const dir = join(home, '.codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
    mkdirSync(dir, { recursive: true })
    const meta = { type: 'session_meta', payload: { id, cwd, timestamp: new Date(T + 500).toISOString(), originator: 'codex-tui' } }
    writeFileSync(join(dir, `rollout-x-${id}.jsonl`), JSON.stringify(meta) + '\n')

    const used = fakeBackend([saved('codex', { id: 'x', cwd, createdAt: T })], [{ resumeId: id }])
    const r = await reviveSessions(deps(used.backend))
    expect(r.resumed).toBe(0)
    expect(used.created[0].opts).toMatchObject({ command: 'codex', restoreScreen: true })

    // Control: sin la sesión viva, la misma huérfana sí la retoma.
    const free = fakeBackend([saved('codex', { id: 'x', cwd, createdAt: T })])
    expect((await reviveSessions(deps(free.backend))).resumed).toBe(1)
    expect(free.created[0].opts?.command).toBe(`codex resume ${id}`)
  })

  it('dos huérfanas de Codex en la misma carpeta no retoman la misma conversación', async () => {
    const T = new Date(2026, 9, 22, 10, 0, 0).getTime()
    const id = uuidV7(T + 500)
    const d = new Date(T)
    const dir = join(home, '.codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `rollout-x-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: new Date(T + 500).toISOString() } }) + '\n')
    const f = fakeBackend([saved('codex', { id: 'a', cwd, createdAt: T }), saved('codex', { id: 'b', cwd, createdAt: T + 1000 })])
    const r = await reviveSessions(deps(f.backend))
    expect(r.resumed).toBe(1)
    expect(f.created.map((c) => c.opts?.command)).toEqual([`codex resume ${id}`, 'codex'])
  })
})

describe('currentClaudeChats', () => {
  const info = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, agent: 'claude', workspaceId: 'w1', cwd: '/', createdAt: 0, ...extra })

  it('solo los Claude locales cuyo chat en curso cambió', async () => {
    const chats: Record<number, string> = { 10: 'nuevo', 20: 'igual', 30: 'remoto', 40: 'shell' }
    const find = async (_t: Map<number, number>, pid: number): Promise<string | null> => chats[pid] ?? null
    const sessions = [info('a', { resumeId: 'viejo' }), info('b', { resumeId: 'igual' }), info('c', { remote: true }), info('d', { agent: 'shell' }), info('e')]
    const out = await currentClaudeChats(sessions, { a: 10, b: 20, c: 30, d: 40 }, new Map(), find)
    expect(out).toEqual({ a: 'nuevo' })
  })
})

describe('remoteRecovery', () => {
  const info = (id: string): SessionInfo => ({ id, agent: 'claude', workspaceId: 'w', cwd: '/srv', createdAt: 0 })

  it('tras un kick revive lo pendiente de cada host y avisa lo revivido', async () => {
    vi.useFakeTimers()
    try {
      let pending = ['vps']
      const added: SessionInfo[][] = []
      const revive = vi.fn(async () => {
        pending = []
        return [info('s1')]
      })
      const r = remoteRecovery({ pendingHosts: async () => pending, revive, added: (l) => added.push(l), delaysMs: [100, 200], log: () => {} })
      r.kick()
      await vi.advanceTimersByTimeAsync(100)
      expect(revive).toHaveBeenCalledWith('vps')
      expect(added).toEqual([[info('s1')]])
      // Nada pendiente: no vuelve a intentar.
      await vi.advanceTimersByTimeAsync(1000)
      expect(revive).toHaveBeenCalledTimes(1)
      r.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('con el host caído reintenta con las esperas y se rinde al agotarlas; un kick nuevo reinicia la cuenta', async () => {
    vi.useFakeTimers()
    try {
      const revive = vi.fn(async () => [] as SessionInfo[])
      const r = remoteRecovery({ pendingHosts: async () => ['vps'], revive, added: () => {}, delaysMs: [100, 200], log: () => {} })
      r.kick()
      await vi.advanceTimersByTimeAsync(100)
      expect(revive).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(200)
      expect(revive).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(5000)
      expect(revive).toHaveBeenCalledTimes(2)
      r.kick()
      await vi.advanceTimersByTimeAsync(100)
      expect(revive).toHaveBeenCalledTimes(3)
      r.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('un revive que falla no corta los demás hosts', async () => {
    vi.useFakeTimers()
    try {
      const added: SessionInfo[][] = []
      const revive = vi.fn(async (host: string) => {
        if (host === 'a') throw new Error('sin conexión')
        return [info('b1')]
      })
      const r = remoteRecovery({ pendingHosts: async () => ['a', 'b'], revive, added: (l) => added.push(l), delaysMs: [50], log: () => {} })
      r.kick()
      await vi.advanceTimersByTimeAsync(50)
      expect(revive).toHaveBeenCalledTimes(2)
      expect(added).toEqual([[info('b1')]])
      r.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
