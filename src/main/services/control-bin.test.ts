import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { controlSockPath, NotOpenError, sendCommand } from '../../../bin/omni-client.mjs'
import { BROWSER_TOOLS } from '../../../bin/omni-browser-mcp.mjs'
import { createMcpServer, fromOf, PROTOCOL_VERSION, TOOLS } from '../../../bin/omni-mcp.mjs'
import { formatResult, main, parseArgs } from '../../../bin/omni.mjs'
import { decodeLine, encodeLine, LineSplitter } from '../../daemon/protocol'
import { shellQuote } from '../ipc'

/* ---------- CLI ---------- */

describe('omni (CLI) parseArgs', () => {
  it('cada subcomando con sus argumentos; --json y --submit en cualquier posición', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' })
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseArgs(['list', '--json'])).toEqual({ kind: 'command', type: 'list', args: {}, json: true })
    expect(parseArgs(['send', 'cc', 'hola', 'mundo', '--submit'])).toEqual({ kind: 'command', type: 'send', args: { title: 'cc', text: 'hola mundo', submit: true }, json: false })
    expect(parseArgs(['send', 'aaaa1111-0000-4000-8000-000000000001', 'x'])).toMatchObject({ args: { sessionId: 'aaaa1111-0000-4000-8000-000000000001', text: 'x', submit: false } })
    expect(parseArgs(['open', '/tmp/x'])).toEqual({ kind: 'command', type: 'open', args: { path: '/tmp/x' }, json: false })
    expect(parseArgs(['browser', 'example.com'])).toMatchObject({ type: 'browser', args: { url: 'example.com' } })
    expect(parseArgs(['--json', 'capture', 'http://localhost:3000'])).toMatchObject({ type: 'capture', args: { url: 'http://localhost:3000' }, json: true })
    expect(parseArgs(['diff', 'w1'])).toMatchObject({ type: 'diff', args: { workspaceId: 'w1' } })
    expect(parseArgs(['focus', 's1'])).toMatchObject({ type: 'focus', args: { sessionId: 's1' } })
    expect(parseArgs(['todo', 'comprar', 'pan'])).toMatchObject({ type: 'todo', args: { text: 'comprar pan' } })
    expect(parseArgs(['notify', 'Listo', 'el', 'deploy'])).toMatchObject({ type: 'notify', args: { title: 'Listo', body: 'el deploy' } })
  })

  it('errores humanos: falta un argumento, comando u opción desconocidos', () => {
    expect(parseArgs(['send'])).toEqual({ kind: 'error', message: 'send: falta la sesión y el texto' })
    expect(parseArgs(['send', 'cc'])).toEqual({ kind: 'error', message: 'send: falta el texto' })
    expect(parseArgs(['open'])).toEqual({ kind: 'error', message: 'open: falta la ruta' })
    expect(parseArgs(['notify'])).toEqual({ kind: 'error', message: 'notify: falta el título' })
    expect(parseArgs(['dance'])).toEqual({ kind: 'error', message: 'comando desconocido: dance' })
    expect(parseArgs(['list', '--verbose'])).toEqual({ kind: 'error', message: 'opción desconocida: --verbose' })
  })

  it('formatResult: lista compacta, objetos por líneas, strings tal cual', () => {
    expect(formatResult('list', [])).toBe('sin sesiones')
    expect(formatResult('list', [{ id: 'aaaa1111-0000', badge: 'CC', project: 'demo', workspace: 'Local', path: '/demo' }])).toBe('aaaa1111  CC    demo/Local  /demo')
    expect(formatResult('list', [{ id: 'aaaa1111-0000', badge: 'CC', project: 'demo', workspace: 'Local', path: '/demo', status: 'working', title: 'Refactor' }])).toBe('aaaa1111  CC    trabajando  demo/Local  Refactor  /demo')
    expect(formatResult('list', [{ id: 'bbbb2222-0000', badge: 'CX', project: 'demo', workspace: '', path: '/demo', status: 'question' }])).toBe('bbbb2222  CX    pregunta    demo  /demo')
    expect(formatResult('capture', { path: '/x.png', width: 10, height: 5 })).toBe('path: /x.png\nwidth: 10\nheight: 5')
    expect(formatResult('open', 'abierto')).toBe('abierto')
    expect(formatResult('focus', undefined)).toBe('ok')
  })

  it('main sin socket: "omni no está abierto" y salida 2; ayuda a stdout con 0; error de uso con 1', async () => {
    const out: string[] = []
    const err: string[] = []
    const io = [{ write: (s: string) => out.push(s) }, { write: (s: string) => err.push(s) }] as const
    const dir = mkdtempSync(join(tmpdir(), 'omni-cli-'))
    const prev = process.env.OMNI_SOCK
    process.env.OMNI_SOCK = join(dir, 'nope.sock')
    try {
      expect(await main(['list'], io[0], io[1])).toBe(2)
      expect(err.join('')).toBe('omni no está abierto\n')
      expect(await main([], io[0], io[1])).toBe(0)
      expect(out.join('')).toContain('uso: omni')
      expect(await main(['open'], io[0], io[1])).toBe(1)
    } finally {
      if (prev === undefined) delete process.env.OMNI_SOCK
      else process.env.OMNI_SOCK = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('shellQuote y controlSockPath', () => {
    expect(shellQuote('/Users/yo/omni/bin/omni-mcp.mjs')).toBe('/Users/yo/omni/bin/omni-mcp.mjs')
    expect(shellQuote("/Users/yo/mi app/it's.mjs")).toBe("'/Users/yo/mi app/it'\\''s.mjs'")
    expect(controlSockPath({ OMNI_SOCK: '/tmp/x.sock' })).toBe('/tmp/x.sock')
    expect(controlSockPath({})).toMatch(/\.config\/omni\/app\.sock$/)
  })
})

/* ---------- cliente del socket con un servidor falso ---------- */

describe('omni-client sendCommand', () => {
  let dir: string
  let sock: string
  let server: Server
  let seen: Record<string, unknown>[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'omni-cli-sock-'))
    sock = join(dir, 'app.sock')
    seen = []
    server = createServer((socket) => {
      const splitter = new LineSplitter()
      socket.on('data', (chunk) => {
        for (const line of splitter.push(chunk)) {
          const msg = decodeLine(line)
          if (!msg) continue
          seen.push(msg)
          if (msg.type === 'list') socket.write(encodeLine({ id: msg.id, ok: true, result: [{ id: 's1' }] }))
          else if (msg.type === 'focus') socket.write(encodeLine({ id: msg.id, ok: false, error: 'no hay pane' }))
          else if (msg.type === 'notify') socket.destroy()
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('manda el comando con id y devuelve ok/result/error; corte y timeout rechazan; sin socket → NotOpenError', async () => {
    expect(await sendCommand(sock, { type: 'list', from: 'cli' })).toEqual({ ok: true, result: [{ id: 's1' }], error: undefined })
    expect(seen[0]).toEqual({ id: 1, type: 'list', from: 'cli' })
    // Un `id` colado en el comando no pisa el del cliente.
    expect(await sendCommand(sock, { id: 99, type: 'list' })).toMatchObject({ ok: true })
    expect(seen[1]).toEqual({ id: 1, type: 'list' })
    expect(await sendCommand(sock, { type: 'focus', sessionId: 's9' })).toEqual({ ok: false, result: undefined, error: 'no hay pane' })
    await expect(sendCommand(sock, { type: 'notify', title: 'x' })).rejects.toThrow('omni cerró la conexión sin responder')
    await expect(sendCommand(sock, { type: 'todo', text: 'x' }, { timeoutMs: 100 })).rejects.toThrow('omni no respondió en 0 s')
    await expect(sendCommand(join(dir, 'nope.sock'), { type: 'list' })).rejects.toBeInstanceOf(NotOpenError)
  })
})

/* ---------- MCP ---------- */

describe('omni-browser-mcp', () => {
  it('se presenta como omni-browser y cada herramienta va a un page.<op> que main conoce', async () => {
    const server = createMcpServer({ call: vi.fn(async () => ({ ok: true })), tools: BROWSER_TOOLS, name: 'omni-browser' })
    expect(await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).toMatchObject({ result: { serverInfo: { name: 'omni-browser' } } })
    const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = (list?.result as { tools: { name: string }[] }).tools.map((t) => t.name)
    expect(names).toEqual(['tabs', 'navigate', 'read_page', 'click', 'type', 'press_key', 'scroll', 'screenshot', 'draw', 'console', 'eval', 'wait_for'])
    const { PAGE_OPS } = await import('./browser-agent')
    expect(BROWSER_TOOLS.map((t) => t.command.replace('page.', '')).sort()).toEqual([...PAGE_OPS].sort())
  })

  it('una captura vuelve como contenido image más el resto como texto', async () => {
    const call = vi.fn(async () => ({ ok: true, result: { image: { data: 'QUJD', mimeType: 'image/jpeg' }, width: 800, height: 600, url: 'https://x.test/' } }))
    const server = createMcpServer({ call, from: 'mcp:claude', tools: BROWSER_TOOLS, name: 'omni-browser' })
    const r = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screenshot', arguments: {} } })
    expect(call).toHaveBeenCalledWith({ type: 'page.screenshot', from: 'mcp:claude' })
    expect(r).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }, { type: 'text', text: JSON.stringify({ width: 800, height: 600, url: 'https://x.test/' }, null, 2) }] }
    })
  })
})

describe('omni-mcp', () => {
  it('initialize, initialized (sin respuesta), ping, tools/list con las 8 herramientas y método desconocido', async () => {
    const server = createMcpServer({ call: vi.fn(async () => ({ ok: true })) })
    expect(await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } } })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'omni', version: '0.0.1' } }
    })
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await server.handle({ jsonrpc: '2.0', id: 2, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
    const list = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    const tools = (list?.result as { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }).tools
    expect(tools.map((t) => t.name)).toEqual(['omni_list_sessions', 'omni_send', 'omni_open', 'omni_open_browser', 'omni_capture', 'omni_open_diff', 'omni_todo', 'omni_notify'])
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.inputSchema).toMatchObject({ type: 'object' })
      expect('command' in t).toBe(false)
    }
    expect(TOOLS.map((t) => t.command)).toEqual(['list', 'send', 'open', 'browser', 'capture', 'diff', 'todo', 'notify'])
    expect(await server.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).toEqual({ jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'method not found: resources/list' } })
    expect(await server.handle({ jsonrpc: '2.0', method: 'resources/list' })).toBeNull()
    // Sin id es una notificación: ni respuesta ni ejecución, aunque sea tools/call.
    const call = vi.fn(async () => ({ ok: true }))
    const quiet = createMcpServer({ call })
    expect(await quiet.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'omni_todo', arguments: { text: 'x' } } })).toBeNull()
    expect(await quiet.handle({ jsonrpc: '2.0', method: 'tools/list' })).toBeNull()
    expect(call).not.toHaveBeenCalled()
    expect(await server.handle('basura')).toMatchObject({ error: { code: -32600 } })
  })

  it('tools/call manda el comando con from mcp:<agente> y devuelve content de texto; errores con isError', async () => {
    const call = vi.fn(async (command: Record<string, unknown>) => {
      if (command.type === 'capture') return { ok: true, result: { path: '/c.png', width: 10, height: 5 } }
      if (command.type === 'todo') return { ok: true, result: 'tarea añadida' }
      if (command.type === 'focus') return { ok: false, error: 'no hay sesión s9' }
      throw new NotOpenError()
    })
    const server = createMcpServer({ call, from: 'mcp:claude' })
    const capture = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'omni_capture', arguments: { url: 'http://localhost:3000' } } })
    expect(call).toHaveBeenCalledWith({ type: 'capture', from: 'mcp:claude', url: 'http://localhost:3000' })
    expect(capture).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ path: '/c.png', width: 10, height: 5 }, null, 2) }] } })
    expect(await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'omni_todo', arguments: { text: 'x' } } })).toMatchObject({ result: { content: [{ type: 'text', text: 'tarea añadida' }] } })
    expect(await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'omni_send', arguments: { title: 'cc', text: 'hola' } } })).toMatchObject({ result: { content: [{ type: 'text', text: 'omni is not running' }], isError: true } })
    expect(await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'omni_open_diff', arguments: { workspaceId: 'w1' } } })).toMatchObject({ result: { isError: true } })
    expect(await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } })).toMatchObject({ result: { content: [{ type: 'text', text: 'unknown tool: nope' }], isError: true } })
    // `type`, `from` o `id` dentro de arguments: no están en el esquema, se rechazan sin tocar el socket.
    call.mockClear()
    expect(await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'omni_todo', arguments: { text: 'x', type: 'send', from: 'cli', id: 7 } } })).toMatchObject({
      result: { content: [{ type: 'text', text: 'unexpected argument(s): type, from, id' }], isError: true }
    })
    expect(call).not.toHaveBeenCalled()
    expect(fromOf({ OMNI_MCP_AGENT: 'codex' })).toBe('mcp:codex')
    expect(fromOf({})).toBe('mcp:agent')
  })
})
