import { execFile } from 'node:child_process'

export interface ExecOptions {
  cwd: string
  timeoutMs: number
  /** Tope de salida capturada (stdout y stderr por separado). Por defecto 8 MB. */
  maxBuffer?: number
  env?: NodeJS.ProcessEnv
}

export interface ExecResult {
  /** Código de salida; `null` si el proceso murió por señal (p. ej. timeout). */
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Corre un ejecutable con argumentos (nunca por shell) y devuelve su salida con el código. Solo
 * rechaza si el proceso no pudo arrancar; un código distinto de 0 es un resultado normal, lo
 * interpreta quien llama. Inyectable en tests.
 */
export type Exec = (cmd: string, args: string[], opts: ExecOptions) => Promise<ExecResult>

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024

export const exec: Exec = (cmd, args, opts) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER, env: opts.env, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) {
          resolvePromise({ code: 0, stdout, stderr })
          return
        }
        // Salió con código ≠ 0: resultado normal. Murió por señal (timeout): código null y se anota.
        if (typeof err.code === 'number') {
          resolvePromise({ code: err.code, stdout, stderr })
          return
        }
        if (err.killed || err.signal) {
          resolvePromise({ code: null, stdout, stderr: `${stderr}\n${cmd} cancelado a los ${Math.round(opts.timeoutMs / 1000)} s` })
          return
        }
        // No arrancó (ENOENT) o desbordó el buffer: eso sí es una excepción.
        reject(err)
      }
    )
  })

/**
 * Error con mensaje humano para el renderer. `git` y `gh` hablan por stderr; se recorta a la
 * última línea útil para no pegar un volcado en la UI.
 */
export function failure(prefix: string, result: ExecResult): Error {
  const lines = (result.stderr || result.stdout).split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const detail = lines.at(-1) ?? `código ${result.code ?? 'señal'}`
  return new Error(`${prefix}: ${detail}`)
}
