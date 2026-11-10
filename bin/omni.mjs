#!/usr/bin/env node
// CLI `omni` sobre el socket de control (ARCHITECTURE §3.21). Sin dependencias; Node 22.
import { pathToFileURL } from 'node:url'
import { controlSockPath, sendCommand } from './omni-client.mjs'

export const USAGE = `uso: omni <comando> [...] [--json]

  list                                   sesiones abiertas
  send <sesión|título> "texto" [--submit] escribe en la terminal del agente (⏎ con --submit)
  open <ruta>                            abre un proyecto o, si es archivo, un editor
  browser <url>                          abre un pane navegador
  capture <url>                          captura la página y devuelve la ruta del PNG
  diff <worktree>                        abre la revisión del worktree
  focus <sesión>                         entra al pane de la sesión
  todo "texto"                           nueva tarea
  notify "título" "cuerpo"               aviso en la app

--json imprime la respuesta tal cual. Sin omni abierto: "omni no está abierto" y salida 2.`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Argumentos → `{ kind: 'command', type, args, json }`, `{ kind: 'help' }` o `{ kind: 'error', message }`.
 * Pura: exportada para tests.
 */
export function parseArgs(argv) {
  const positional = []
  let json = false
  let submit = false
  for (const a of argv) {
    if (a === '--json') json = true
    else if (a === '--submit') submit = true
    else if (a === '-h' || a === '--help') return { kind: 'help' }
    else if (a.startsWith('--')) return { kind: 'error', message: `opción desconocida: ${a}` }
    else positional.push(a)
  }
  const [type, ...rest] = positional
  if (!type) return { kind: 'help' }
  const need = (n, what) => (rest.length < n ? { kind: 'error', message: `${type}: falta ${what}` } : null)
  switch (type) {
    case 'list':
      return { kind: 'command', type, args: {}, json }
    case 'send': {
      const missing = need(2, rest.length === 0 ? 'la sesión y el texto' : 'el texto')
      if (missing) return missing
      const [target, ...words] = rest
      const key = UUID.test(target) ? 'sessionId' : 'title'
      return { kind: 'command', type, args: { [key]: target, text: words.join(' '), submit }, json }
    }
    case 'open':
      return need(1, 'la ruta') ?? { kind: 'command', type, args: { path: rest[0] }, json }
    case 'browser':
    case 'capture':
      return need(1, 'la url') ?? { kind: 'command', type, args: { url: rest[0] }, json }
    case 'diff':
      return need(1, 'el worktree') ?? { kind: 'command', type, args: { workspaceId: rest[0] }, json }
    case 'focus':
      return need(1, 'la sesión') ?? { kind: 'command', type, args: { sessionId: rest[0] }, json }
    case 'todo':
      return need(1, 'el texto') ?? { kind: 'command', type, args: { text: rest.join(' ') }, json }
    case 'notify':
      return need(1, 'el título') ?? { kind: 'command', type, args: { title: rest[0], body: rest.slice(1).join(' ') }, json }
    default:
      return { kind: 'error', message: `comando desconocido: ${type}` }
  }
}

const STATUS_LABEL = { working: 'trabajando', question: 'pregunta', idle: 'listo' }

/** Salida humana y compacta de un resultado. Pura: exportada para tests. */
export function formatResult(type, result) {
  if (type === 'list') {
    const rows = Array.isArray(result) ? result : []
    if (rows.length === 0) return 'sin sesiones'
    // Estado (trabajando / pregunta / listo) y título solo si la ventana de omni contestó.
    return rows
      .map((r) => {
        const state = r.status ? pad(STATUS_LABEL[r.status] ?? r.status, 10) + '  ' : ''
        const where = `${r.project}${r.workspace ? '/' + r.workspace : ''}`
        return `${String(r.id).slice(0, 8)}  ${pad(r.badge ?? r.agent, 4)}  ${state}${where}  ${r.title ? r.title + '  ' : ''}${r.path ?? ''}`.trimEnd()
      })
      .join('\n')
  }
  if (result === undefined || result === null) return 'ok'
  if (typeof result === 'string') return result
  if (typeof result !== 'object') return String(result)
  return Object.entries(result)
    .map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
    .join('\n')
}

function pad(s, n) {
  const t = String(s ?? '')
  return t.length >= n ? t : t + ' '.repeat(n - t.length)
}

export async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  const parsed = parseArgs(argv)
  if (parsed.kind === 'help') {
    out.write(USAGE + '\n')
    return 0
  }
  if (parsed.kind === 'error') {
    err.write(`${parsed.message}\n${USAGE}\n`)
    return 1
  }
  let reply
  try {
    reply = await sendCommand(controlSockPath(), { type: parsed.type, from: 'cli', ...parsed.args })
  } catch (e) {
    if (e && e.code === 'NOT_OPEN') {
      err.write('omni no está abierto\n')
      return 2
    }
    err.write(`${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
  if (parsed.json) {
    out.write(JSON.stringify(reply) + '\n')
    return reply.ok ? 0 : 1
  }
  if (!reply.ok) {
    err.write(`${reply.error ?? 'error'}\n`)
    return 1
  }
  out.write(formatResult(parsed.type, reply.result) + '\n')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code))
}
