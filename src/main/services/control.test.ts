import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, ControlCommand, ControlResult, SessionInfo } from '@shared/types'
import { decodeLine, encodeLine, LineSplitter } from '../../daemon/protocol'
import { ControlServer, findSession, sanitizeFrom, validateCommand, type ControlBridge, type SessionEntry } from './control'

const agents: AgentDef[] = [
  { id: 'shell', name: 'Terminal', badge: '$', command: null },
  { id: 'claude', name: 'Claude Code', badge: 'CC', command: 'claude' },
  { id: 'codex', name: 'Codex', badge: 'CX', command: 'codex' },
  { id: 'browser', name: 'Navegador', badge: 'WEB', command: null },
  { id: 'editor', name: 'Editor', badge: 'ED', command: null }
]

const sessions: SessionInfo[] = [
  { id: 'aaaa1111-0000-4000-8000-000000000001', agent: 'claude', workspaceId: 'p1', cwd: '/demo', createdAt: 1 },
  { id: 'bbbb2222-0000-4000-8000-000000000002', agent: 'codex', workspaceId: 'w1', cwd: '/wt/feat', createdAt: 2 },
  { id: 'cccc3333-0000-4000-8000-000000000003', agent: 'browser', workspaceId: 'p1', cwd: '/demo', createdAt: 3 },
  { id: 'dddd4444-0000-4000-8000-000000000004', agent: 'shell', workspaceId: 'p1', cwd: '/demo', createdAt: 4 },
  { id: 'eeee5555-0000-4000-8000-000000000005', agent: 'editor', workspaceId: 'p1', cwd: '/demo', createdAt: 5 }
]

const entries: SessionEntry[] = [
  { id: 'aaaa1111', agent: 'claude', agentName: 'Claude Code', badge: 'CC', workspaceId: 'p1', workspace: 'Local', project: 'demo', path: '/demo', createdAt: 1 },
  { id: 'aaaa2222', agent: 'codex', agentName: 'Codex', badge: 'CX', workspaceId: 'w1', workspace: 'feat', project: 'demo', path: '/wt/feat', createdAt: 2 }
]

describe('validateCommand', () => {
  it('exige lo mínimo por tipo y normaliza', () => {
    expect(validateCommand('list', { basura: 1 })).toEqual({ ok: true, args: {} })
    expect(validateCommand('send', { text: 'hola' })).toEqual({ ok: false, error: 'send: falta la sesión (sessionId o title)' })
    expect(validateCommand('send', { title: 'cc' })).toEqual({ ok: false, error: 'send: falta el texto (text)' })
    expect(validateCommand('send', { title: 'cc', text: 'hola', submit: 'yes' })).toEqual({ ok: true, args: { text: 'hola', sessionId: undefined, title: 'cc', submit: false } })
    expect(validateCommand('open', {})).toEqual({ ok: false, error: 'open: falta la ruta (path)' })
    expect(validateCommand('open', { path: '/x', kind: 'file' })).toEqual({ ok: true, args: { path: '/x', kind: 'file' } })
    expect(validateCommand('browser', { url: 'example.com/a' })).toEqual({ ok: true, args: { url: 'https://example.com/a', workspaceId: undefined } })
    expect(validateCommand('capture', { url: 'file:///etc/passwd' })).toEqual({ ok: false, error: 'capture: la dirección no es http(s): file:///etc/passwd' })
    expect(validateCommand('capture', { url: 'http://localhost:3000', sessionId: 's1' })).toEqual({ ok: true, args: { url: 'http://localhost:3000', sessionId: 's1' } })
    expect(validateCommand('diff', { workspaceId: '' })).toEqual({ ok: false, error: 'diff: falta el workspace (workspaceId)' })
    expect(validateCommand('focus', { sessionId: 's' })).toEqual({ ok: true, args: { sessionId: 's' } })
    expect(validateCommand('todo', { text: '  comprar pan ' })).toEqual({ ok: true, args: { text: 'comprar pan' } })
    expect(validateCommand('notify', { title: 'Listo' })).toEqual({ ok: true, args: { title: 'Listo', body: '' } })
    expect(validateCommand('notify', { body: 'x' })).toEqual({ ok: false, error: 'notify: falta el título (title)' })
  })

  it('sanitizeFrom: cli o mcp:<agente>, lo demás es cli', () => {
    expect(sanitizeFrom('mcp:claude')).toBe('mcp:claude')
    expect(sanitizeFrom(' cli ')).toBe('cli')
    expect(sanitizeFrom('mcp:')).toBe('cli')
    expect(sanitizeFrom('root; rm -rf')).toBe('cli')
    expect(sanitizeFrom(7)).toBe('cli')
  })
})

describe('findSession', () => {
  it('id exacto o prefijo único; "título" solo por coincidencia exacta (sin mayúsculas) de agente, badge, workspace o proyecto', () => {
    expect(findSession(entries, { sessionId: 'aaaa2222' })).toMatchObject({ ok: true, entry: { id: 'aaaa2222' } })
    expect(findSession(entries, { sessionId: 'aaaa2' })).toMatchObject({ ok: true, entry: { id: 'aaaa2222' } })
    expect(findSession(entries, { title: 'claude code' })).toMatchObject({ ok: true, entry: { id: 'aaaa1111' } })
    expect(findSession(entries, { title: 'cx' })).toMatchObject({ ok: true, entry: { id: 'aaaa2222' } })
    expect(findSession(entries, { title: 'FEAT' })).toMatchObject({ ok: true, entry: { id: 'aaaa2222' } })
    expect(findSession(entries, { title: 'codex' })).toMatchObject({ ok: true, entry: { id: 'aaaa2222' } })
    // Nada de prefijos en nombres: "co" o "fea" no eligen a nadie.
    expect(findSession(entries, { title: 'fea' })).toEqual({ ok: false, error: 'no hay sesión que coincida con "fea"' })
    expect(findSession(entries, { title: 'Cod' })).toEqual({ ok: false, error: 'no hay sesión que coincida con "Cod"' })
  })

  it('ambigüedad y ausencia con error humano', () => {
    expect(findSession(entries, { sessionId: 'aaaa' })).toMatchObject({ ok: false, error: expect.stringContaining('varias sesiones empiezan por aaaa') })
    expect(findSession(entries, { title: 'demo' })).toMatchObject({ ok: false, error: expect.stringContaining('varias sesiones coinciden con "demo"') })
    expect(findSession(entries, { title: 'goose' })).toEqual({ ok: false, error: 'no hay sesión que coincida con "goose"' })
    expect(findSession(entries, {})).toEqual({ ok: false, error: 'send: falta la sesión (sessionId o title)' })
  })
})

/** Cliente mínimo: manda una línea y devuelve la respuesta con ese id. */
function ask(sock: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const splitter = new LineSplitter()
    const conn = createConnection(sock)
    conn.once('error', reject)
    conn.once('connect', () => conn.write(encodeLine(request)))
    conn.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) {
        const msg = decodeLine(line)
        if (msg && msg.id === request.id) {
          conn.destroy()
          resolve(msg)
        }
      }
    })
  })
}

describe('ControlServer', () => {
  let dir: string
  let sock: string
  let server: ControlServer
  let written: [string, string][]
  let notified: [string, string][]
  let emitted: ControlCommand[]
  let windows: boolean
  let bridge: ControlBridge
  let listSessions: () => Promise<SessionInfo[]>
  /** Respuesta del renderer a `statuses` (lo que `list` le pregunta); `null` = la ventana no contesta. */
  let liveStatuses: Record<string, unknown> | null

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'omni-ctl-'))
    sock = join(dir, 'app.sock')
    written = []
    notified = []
    emitted = []
    windows = true
    listSessions = async () => sessions
    liveStatuses = null
    bridge = {
      sessions: () => listSessions(),
      write: async (id, data) => {
        written.push([id, data])
      },
      sent: (id, from) => notified.push([id, from]),
      workspace: (id) => (id === 'p1' ? { id: 'p1', projectId: 'p1', name: 'Local', path: '/demo', kind: 'local' } : id === 'w1' ? { id: 'w1', projectId: 'p1', name: 'feat', path: '/wt/feat', kind: 'worktree' } : undefined),
      project: (id) => (id === 'p1' ? { id: 'p1', name: 'demo', locations: [{ id: 'p1', name: 'Local', path: '/demo' }] } : undefined),
      agents: () => agents,
      page: (op, args, from) => {
        if (op === 'boom') return { run: async () => Promise.reject(new Error('falló la página')) }
        if (op === 'bad') return { error: 'bad: falta algo' }
        if (op !== 'echo') return null
        return { run: async () => ({ args, from }) }
      },
      emit: (command) => {
        if (!windows) return false
        // `statuses` es el pedido interno de `list`: no cuenta como reenvío de un comando del usuario.
        if (command.type === 'statuses') {
          if (liveStatuses) setImmediate(() => server.resolve(command.id, { ok: true, result: liveStatuses }))
          return true
        }
        emitted.push(command)
        return true
      }
    }
    server = new ControlServer({ sockPath: sock, timeoutMs: 200, captureTimeoutMs: 400 })
    server.attach(bridge)
    await server.start()
  })
  afterEach(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('escucha con permisos 600, resuelve list y send solo, y borra el socket al cerrar', async () => {
    expect(statSync(sock).mode & 0o777).toBe(0o600)
    const list = await ask(sock, { id: 1, type: 'list' })
    expect(list.ok).toBe(true)
    expect(list.result).toEqual([
      { id: sessions[0]?.id, agent: 'claude', agentName: 'Claude Code', badge: 'CC', workspaceId: 'p1', workspace: 'Local', project: 'demo', path: '/demo', createdAt: 1 },
      { id: sessions[1]?.id, agent: 'codex', agentName: 'Codex', badge: 'CX', workspaceId: 'w1', workspace: 'feat', project: 'demo', path: '/wt/feat', createdAt: 2 },
      { id: sessions[2]?.id, agent: 'browser', agentName: 'Navegador', badge: 'WEB', workspaceId: 'p1', workspace: 'Local', project: 'demo', path: '/demo', createdAt: 3 },
      { id: sessions[3]?.id, agent: 'shell', agentName: 'Terminal', badge: '$', workspaceId: 'p1', workspace: 'Local', project: 'demo', path: '/demo', createdAt: 4 },
      { id: sessions[4]?.id, agent: 'editor', agentName: 'Editor', badge: 'ED', workspaceId: 'p1', workspace: 'Local', project: 'demo', path: '/demo', createdAt: 5 }
    ])
    const sent = await ask(sock, { id: 2, type: 'send', title: 'cc', text: 'hola\x1b[201~\rmundo\nfin', submit: true })
    expect(sent).toEqual({ id: 2, ok: true, result: { sessionId: sessions[0]?.id, chars: 20, submitted: true } })
    expect(written).toEqual([[sessions[0]?.id, '\x1b[200~hola[201~mundo\nfin\x1b[201~\r']])
    expect(notified).toEqual([[sessions[0]?.id, 'cli']])
    expect(emitted).toEqual([])
    const web = await ask(sock, { id: 3, type: 'send', title: 'web', text: 'x' })
    expect(web).toMatchObject({ ok: false, error: expect.stringContaining('es un navegador') })
    await server.close()
    expect(existsSync(sock)).toBe(false)
  })

  it('list suma estado y título cuando la ventana contesta; sin respuesta sale igual, sin estado', async () => {
    liveStatuses = { [sessions[0]?.id ?? '']: { status: 'working', title: 'Refactor del login' }, [sessions[1]?.id ?? '']: { status: 'question', title: '' } }
    const list = await ask(sock, { id: 1, type: 'list' })
    const rows = list.result as SessionEntry[]
    expect(rows[0]).toMatchObject({ status: 'working', title: 'Refactor del login' })
    expect(rows[1]).toMatchObject({ status: 'question' })
    expect(rows[1]).not.toHaveProperty('title')
    expect(rows[2]).not.toHaveProperty('status')
  })

  it('send a un shell: vale desde la CLI, el MCP no; a un editor nunca; si write falla, responde el error', async () => {
    expect(await ask(sock, { id: 1, type: 'send', from: 'mcp:claude', title: '$', text: 'ls' })).toEqual({ id: 1, ok: false, error: 'el MCP no escribe en shells ni documentos' })
    expect(written).toEqual([])
    expect(await ask(sock, { id: 2, type: 'send', from: 'cli', title: 'terminal', text: 'ls', submit: true })).toMatchObject({ ok: true, result: { sessionId: sessions[3]?.id } })
    expect(written).toEqual([[sessions[3]?.id, 'ls\r']])
    expect(notified).toEqual([[sessions[3]?.id, 'cli']])
    expect(await ask(sock, { id: 3, type: 'send', from: 'cli', title: 'editor', text: 'x' })).toEqual({ id: 3, ok: false, error: `la sesión eeee5555 (Editor) no es una terminal` })
    expect(await ask(sock, { id: 4, type: 'send', from: 'mcp:codex', title: 'ed', text: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('no es una terminal') })
    expect(await ask(sock, { id: 5, type: 'send', from: 'mcp:codex', title: 'cc', text: 'hola' })).toMatchObject({ ok: true })
    expect(notified.at(-1)).toEqual([sessions[0]?.id, 'mcp:codex'])
    bridge.write = async () => {
      throw new Error('sin conexión con el daemon')
    }
    expect(await ask(sock, { id: 6, type: 'send', title: 'cc', text: 'hola' })).toEqual({ id: 6, ok: false, error: 'sin conexión con el daemon' })
  })

  it('si sessions() rechaza, responde el error (no se cuelga); open mira el disco y reenvía kind', async () => {
    listSessions = async () => {
      throw new Error('daemon caído')
    }
    expect(await ask(sock, { id: 1, type: 'list' })).toEqual({ id: 1, ok: false, error: 'daemon caído' })
    expect(await ask(sock, { id: 2, type: 'send', title: 'cc', text: 'x' })).toEqual({ id: 2, ok: false, error: 'daemon caído' })
    expect(await ask(sock, { id: 3, type: 'open', path: join(dir, 'nope') })).toEqual({ id: 3, ok: false, error: `open: no existe ${join(dir, 'nope')}` })
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')
    const pendingFile = ask(sock, { id: 4, type: 'open', path: file, kind: 'dir' })
    const pendingDir = ask(sock, { id: 5, type: 'open', path: dir })
    await vi.waitFor(() => expect(emitted).toHaveLength(2))
    expect(emitted.map((c) => c.args)).toEqual([{ path: file, kind: 'file' }, { path: dir, kind: 'dir' }])
    server.resolve(emitted[0]?.id ?? 0, { ok: true, result: 'archivo' })
    server.resolve(emitted[1]?.id ?? 0, { ok: true, result: 'carpeta' })
    expect(await pendingFile).toMatchObject({ ok: true, result: 'archivo' })
    expect(await pendingDir).toMatchObject({ ok: true, result: 'carpeta' })
  })

  it('tope de pedidos en vuelo por conexión y corte de una línea sin fin', async () => {
    const replies: Record<string, unknown>[] = []
    await new Promise<void>((resolve) => {
      const splitter = new LineSplitter()
      const conn = createConnection(sock)
      conn.once('connect', () => {
        for (let i = 1; i <= 9; i++) conn.write(encodeLine({ id: i, type: 'focus', sessionId: 's1' }))
      })
      conn.on('data', (chunk) => {
        for (const line of splitter.push(chunk)) {
          const msg = decodeLine(line)
          if (msg) replies.push(msg)
          if (replies.length === 9) {
            conn.destroy()
            resolve()
          }
        }
      })
    })
    // El noveno se rechaza en el acto; los ocho primeros esperan al renderer y vencen.
    expect(replies[0]).toEqual({ id: 9, ok: false, error: 'demasiados pedidos en vuelo (máx. 8)' })
    expect(replies.slice(1).map((r) => r.id).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(replies.slice(1).every((r) => r.ok === false && String(r.error).startsWith('focus: omni no respondió'))).toBe(true)
    const closed = await new Promise<Record<string, unknown> | null>((resolve) => {
      let last: Record<string, unknown> | null = null
      const splitter = new LineSplitter()
      const conn = createConnection(sock)
      conn.once('connect', () => conn.write('x'.repeat(1024 * 1024 + 10)))
      conn.on('data', (chunk) => {
        for (const line of splitter.push(chunk)) last = decodeLine(line)
      })
      conn.on('close', () => resolve(last))
    })
    expect(closed).toEqual({ id: null, ok: false, error: 'línea demasiado larga' })
  })

  it('reenvía lo demás como app:command con `from` saneado y responde con app:commandResult', async () => {
    const pending = ask(sock, { id: 'x1', type: 'todo', from: 'mcp:claude', text: 'comprar pan' })
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    expect(emitted[0]).toEqual({ id: 1, type: 'todo', from: 'mcp:claude', args: { text: 'comprar pan' } })
    const result: ControlResult = { ok: true, result: { todoId: 't1' } }
    server.resolve(1, result)
    expect(await pending).toEqual({ id: 'x1', ok: true, result: { todoId: 't1' } })
    // Un id ya resuelto o desconocido se ignora sin drama.
    server.resolve(1, { ok: false, error: 'tarde' })
    server.resolve(99, { ok: true })
  })

  it('timeout del renderer (más largo para capture), sin ventana, comando desconocido y JSON roto', async () => {
    const t0 = Date.now()
    expect(await ask(sock, { id: 1, type: 'focus', sessionId: 's1' })).toEqual({ id: 1, ok: false, error: 'focus: omni no respondió en 0 s' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190)
    const t1 = Date.now()
    expect(await ask(sock, { id: 2, type: 'capture', url: 'http://localhost' })).toMatchObject({ ok: false, error: 'capture: omni no respondió en 0 s' })
    expect(Date.now() - t1).toBeGreaterThanOrEqual(390)
    windows = false
    expect(await ask(sock, { id: 3, type: 'notify', title: 'hola' })).toEqual({ id: 3, ok: false, error: 'omni no tiene ventana' })
    expect(await ask(sock, { id: 4, type: 'shell', cmd: 'rm -rf /' })).toEqual({ id: 4, ok: false, error: 'comando desconocido: shell' })
    expect(await ask(sock, { id: 5, type: 'open' })).toEqual({ id: 5, ok: false, error: 'open: falta la ruta (path)' })
    const raw = await new Promise<Record<string, unknown>>((resolve) => {
      const splitter = new LineSplitter()
      const conn = createConnection(sock)
      conn.once('connect', () => conn.write('{ esto no es json\n'))
      conn.on('data', (chunk) => {
        for (const line of splitter.push(chunk)) {
          const msg = decodeLine(line)
          if (msg) {
            conn.destroy()
            resolve(msg)
          }
        }
      })
    })
    expect(raw).toEqual({ id: null, ok: false, error: 'línea que no es JSON' })
  })

  it('otro omni vivo en el mismo socket: el segundo no abre ni borra el del primero al cerrar', async () => {
    const second = new ControlServer({ sockPath: sock })
    second.attach(bridge)
    await second.start()
    await second.close()
    expect(existsSync(sock)).toBe(true)
    expect((await ask(sock, { id: 1, type: 'list' })).ok).toBe(true)
  })

  it('un socket huérfano (proceso muerto) se borra al arrancar; si desaparece en caliente se vuelve a escuchar', async () => {
    await server.close()
    // Huérfano de verdad: un proceso aparte escucha y muere con SIGKILL, el archivo queda.
    const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(sock)}, () => console.log('ok')); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()))
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited
    expect(statSync(sock).isSocket()).toBe(true)
    server = new ControlServer({ sockPath: sock, timeoutMs: 200 })
    server.attach(bridge)
    await server.start()
    expect((await ask(sock, { id: 1, type: 'list' })).ok).toBe(true)
    unlinkSync(sock)
    await vi.waitFor(() => expect(existsSync(sock)).toBe(true), { timeout: 8_000, interval: 200 })
    expect((await ask(sock, { id: 2, type: 'list' })).ok).toBe(true)
  }, 15_000)

  it('tras un relisten, si otro ocupó la ruta, close() no borra el socket ajeno', async () => {
    unlinkSync(sock)
    // Otro proceso (aquí un servidor pelado) toma la ruta antes de que el vigilante vuelva a escuchar.
    const foreign = createServer(() => undefined)
    await new Promise<void>((resolve) => foreign.listen(sock, () => resolve()))
    const foreignIno = statSync(sock).ino
    await server.close()
    expect(existsSync(sock)).toBe(true)
    expect(statSync(sock).ino).toBe(foreignIno)
    await new Promise<void>((resolve) => foreign.close(() => resolve()))
    expect(existsSync(sock)).toBe(false)
  })
  it('page.<op>: lo resuelve el puente en main, con from saneado y sin id ni type', async () => {
    expect(await server.handle({ id: 3, type: 'page.echo', from: 'mcp:claude', a: 1 })).toEqual({ ok: true, result: { args: { a: 1 }, from: 'mcp:claude' } })
    expect(await server.handle({ type: 'page.nope' })).toEqual({ ok: false, error: 'comando desconocido: page.nope' })
    expect(await server.handle({ type: 'page.bad' })).toEqual({ ok: false, error: 'bad: falta algo' })
    expect(await server.handle({ type: 'page.boom' })).toEqual({ ok: false, error: 'falló la página' })
    expect(emitted).toEqual([])
  })

  it('show: se reenvía al renderer con la sesión', async () => {
    const pending = server.handle({ type: 'show', sessionId: 's1', from: 'mcp:claude' })
    await new Promise((r) => setTimeout(r, 10))
    expect(emitted.at(-1)).toMatchObject({ type: 'show', from: 'mcp:claude', args: { sessionId: 's1' } })
    server.resolve(emitted.at(-1)?.id ?? 0, { ok: true, result: { sessionId: 's1' } })
    expect(await pending).toEqual({ ok: true, result: { sessionId: 's1' } })
  })
})
