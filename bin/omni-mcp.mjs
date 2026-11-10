#!/usr/bin/env node
// Servidor MCP `omni-mcp` por stdio (ARCHITECTURE §3.21): JSON-RPC 2.0, un mensaje por línea,
// protocolo MCP 2025-06-18 a mano (initialize, tools/list, tools/call). Cada herramienta mapea 1:1
// a un comando del socket de control. Sin SDK ni dependencias; Node 22.
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { controlSockPath, sendCommand } from './omni-client.mjs'

export const PROTOCOL_VERSION = '2025-06-18'

const str = (description) => ({ type: 'string', description })

/** Las ocho herramientas; `command` es el tipo del socket y `inputSchema` su JSON Schema. */
export const TOOLS = [
  {
    name: 'omni_list_sessions',
    command: 'list',
    description: 'List the agent sessions open in omni: id, agent, project, workspace, working directory, and when the omni window answers, status (working, question = waiting for the user, idle) and the live title (conversation topic).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'omni_send',
    command: 'send',
    description: 'Type text into the terminal of an agent session. Target it by session id (or unique prefix) or by title: agent name, badge, workspace or project name. Set submit to press Enter.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: str('Session id or unique id prefix.'),
        title: str('Agent name/badge, workspace or project name (exact or unique prefix).'),
        text: str('Text to type. Control characters are stripped.'),
        submit: { type: 'boolean', description: 'Press Enter after the text.' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'omni_open',
    command: 'open',
    description: 'Open a folder as a project in omni, or open a file in an editor pane.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Absolute path of a folder or file.'), kind: { type: 'string', enum: ['file', 'dir'], description: 'Force how to open it.' } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'omni_open_browser',
    command: 'browser',
    description: 'Open a URL in an embedded browser pane.',
    inputSchema: {
      type: 'object',
      properties: { url: str('http(s) URL.'), workspaceId: str('Workspace to open it in; default: the current one.') },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'omni_capture',
    command: 'capture',
    description: 'Load a URL in a browser pane and capture it as PNG. Returns the file path and size.',
    inputSchema: {
      type: 'object',
      properties: { url: str('http(s) URL.'), sessionId: str('Existing browser session to reuse.') },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'omni_open_diff',
    command: 'diff',
    description: 'Open the review (annotated diff) of a worktree workspace.',
    inputSchema: { type: 'object', properties: { workspaceId: str('Worktree workspace id.') }, required: ['workspaceId'], additionalProperties: false }
  },
  {
    name: 'omni_todo',
    command: 'todo',
    description: 'Add a task to the omni to-do widget.',
    inputSchema: { type: 'object', properties: { text: str('Task text.') }, required: ['text'], additionalProperties: false }
  },
  {
    name: 'omni_notify',
    command: 'notify',
    description: 'Show a notification to the user in omni.',
    inputSchema: { type: 'object', properties: { title: str('Title.'), body: str('Body.') }, required: ['title'], additionalProperties: false }
  }
]

/** Quién pide por el bus: `mcp:<agente>` (`OMNI_MCP_AGENT`, p. ej. `claude`). */
export function fromOf(env = process.env) {
  return 'mcp:' + (env.OMNI_MCP_AGENT || 'agent')
}

const defaultCall = (command) => sendCommand(controlSockPath(), command)

/**
 * Servidor sin transporte: `handle(message)` devuelve la respuesta JSON-RPC (o `null` para una
 * notificación). `call(command)` manda al socket; se inyecta en tests.
 */
export function createMcpServer({ call = defaultCall, from = fromOf(), tools = TOOLS, name = 'omni' } = {}) {
  const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
  const result = (id, value) => ({ jsonrpc: '2.0', id, result: value })
  const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2))

  async function callTool(params) {
    const toolName = params && typeof params.name === 'string' ? params.name : ''
    const tool = tools.find((t) => t.name === toolName)
    if (!tool) return { content: [{ type: 'text', text: `unknown tool: ${toolName}` }], isError: true }
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}
    // Solo las claves del esquema: `type`, `from` o `id` colados en `arguments` no deben llegar al socket.
    const allowed = Object.keys(tool.inputSchema.properties ?? {})
    const extra = Object.keys(args).filter((k) => !allowed.includes(k))
    if (extra.length > 0) return { content: [{ type: 'text', text: `unexpected argument(s): ${extra.join(', ')}` }], isError: true }
    let reply
    try {
      reply = await call({ ...args, type: tool.command, from })
    } catch (e) {
      const message = e && e.code === 'NOT_OPEN' ? 'omni is not running' : e instanceof Error ? e.message : String(e)
      return { content: [{ type: 'text', text: message }], isError: true }
    }
    if (!reply.ok) return { content: [{ type: 'text', text: reply.error ?? 'error' }], isError: true }
    // Una captura vuelve como contenido `image` (el agente la ve), con el resto del resultado como texto.
    const r = reply.result
    if (r && typeof r === 'object' && r.image && typeof r.image.data === 'string' && typeof r.image.mimeType === 'string') {
      const { image, ...rest } = r
      return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }, { type: 'text', text: text(rest) }] }
    }
    return { content: [{ type: 'text', text: text(r) }] }
  }

  return {
    async handle(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return error(null, -32600, 'invalid request')
      const { id, method, params } = message
      const hasId = id !== undefined && id !== null
      if (typeof method !== 'string') return hasId ? error(id, -32600, 'invalid request') : null
      // Sin `id` es una notificación: JSON-RPC no responde a notificaciones, y una herramienta sin id no se ejecuta.
      if (!hasId) return null
      switch (method) {
        case 'initialize':
          return result(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name, version: '0.0.1' } })
        case 'ping':
          return result(id, {})
        case 'tools/list':
          return result(id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
        case 'tools/call':
          return result(id, await callTool(params))
        default:
          return error(id, -32601, `method not found: ${method}`)
      }
    }
  }
}

export function main(input = process.stdin, output = process.stdout, server = createMcpServer()) {
  const rl = createInterface({ input, crlfDelay: Infinity })
  let chain = Promise.resolve()
  rl.on('line', (line) => {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n')
      return
    }
    // En orden: una herramienta que tarda (capture) no adelanta a la siguiente respuesta.
    chain = chain
      .then(async () => {
        const response = await server.handle(message)
        if (response) output.write(JSON.stringify(response) + '\n')
      })
      // Un fallo inesperado responde -32603 con el id del pedido y la cola sigue viva.
      .catch((e) => {
        const id = message && typeof message === 'object' && message.id !== undefined ? message.id : null
        output.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }) + '\n')
      })
  })
  rl.on('close', () => chain.then(() => process.exit(0)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
