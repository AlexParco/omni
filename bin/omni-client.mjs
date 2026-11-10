// Cliente del socket de control de omni (`~/.config/omni/app.sock`, ARCHITECTURE §3.21).
// Lo comparten la CLI (`omni.mjs`) y el servidor MCP (`omni-mcp.mjs`). Sin dependencias.
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Error de "omni no está abierto": el socket no existe o nadie escucha. */
export class NotOpenError extends Error {
  constructor() {
    super('omni no está abierto')
    this.name = 'NotOpenError'
    this.code = 'NOT_OPEN'
  }
}

/** Ruta del socket; `OMNI_SOCK` la cambia (pruebas, varios perfiles). */
export function controlSockPath(env = process.env) {
  return env.OMNI_SOCK || join(homedir(), '.config', 'omni', 'app.sock')
}

/**
 * Manda un comando `{ type, from, ...args }` y devuelve `{ ok, result | error }`. Rechaza con
 * `NotOpenError` si no hay socket, o con un `Error` si la conexión se corta o vence `timeoutMs`.
 */
export function sendCommand(sock, command, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = 1
    let rest = ''
    let done = false
    const conn = createConnection(sock)
    const finish = (fn, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      conn.destroy()
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error(`omni no respondió en ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
    conn.setNoDelay(true)
    // `id` al final: un `command` con su propio `id` no pisa el nuestro.
    conn.once('connect', () => conn.write(JSON.stringify({ ...command, id }) + '\n'))
    conn.on('data', (chunk) => {
      rest += chunk.toString('utf8')
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg && msg.id === id) {
          finish(resolve, { ok: msg.ok === true, result: msg.result, error: typeof msg.error === 'string' ? msg.error : undefined })
          return
        }
      }
    })
    conn.once('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') finish(reject, new NotOpenError())
      else finish(reject, err)
    })
    conn.once('close', () => finish(reject, new Error('omni cerró la conexión sin responder')))
  })
}
