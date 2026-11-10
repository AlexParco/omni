import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { exec, type Exec } from '../exec'
import type { Host, HostDirent, HostFs, HostStat } from './types'
import { shCommand } from './shq'

/**
 * Este Mac como `Host`: `node:fs/promises` y el `exec` local de siempre. Los errores de fs se
 * traducen a los mismos mensajes humanos que `RemoteFs` ("no existe: /x").
 */

function code(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined
}

function humanFsError(path: string, err: unknown): Error {
  switch (code(err)) {
    case 'ENOENT':
      return new Error(`no existe: ${path}`)
    case 'EACCES':
    case 'EPERM':
      return new Error(`sin permiso: ${path}`)
    case 'ENOTDIR':
      return new Error(`no es una carpeta: ${path}`)
    case 'EISDIR':
      return new Error(`es una carpeta: ${path}`)
    case 'EEXIST':
      return new Error(`hay un archivo en el camino: ${path}`)
    default:
      return err instanceof Error ? err : new Error(String(err))
  }
}

/** Corre `fn` traduciendo el error de fs a uno humano sobre `path`. */
async function human<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw humanFsError(path, err)
  }
}

/** `HostFs` local. Misma semántica que `RemoteFs`: `stat`/`readdir` siguen symlinks, escritura atómica. */
export const localFs: HostFs = {
  async stat(path: string): Promise<HostStat | null> {
    try {
      const s = await fs.stat(path)
      return { dir: s.isDirectory(), size: s.size, mtime: s.mtimeMs }
    } catch (err) {
      if (code(err) === 'ENOENT' || code(err) === 'ENOTDIR') return null
      throw humanFsError(path, err)
    }
  },

  readFile: (path) => human(path, () => fs.readFile(path)),

  // Escribe sobre el destino si `path` es un symlink y conserva los permisos del archivo existente.
  writeFile: (requested, data) =>
    human(requested, async () => {
      const path = await fs.realpath(requested).catch(() => requested)
      let mode: number | undefined
      const current = await fs.stat(path).catch((err: unknown) => {
        if (code(err) === 'ENOENT') return null
        throw err
      })
      if (current?.isDirectory()) throw new Error(`es una carpeta: ${requested}`)
      if (current) mode = current.mode & 0o7777
      const tmp = join(dirname(path), `.${basename(path)}.omni-${randomBytes(6).toString('hex')}.tmp`)
      try {
        await fs.writeFile(tmp, data, mode === undefined ? {} : { mode })
        if (mode !== undefined) await fs.chmod(tmp, mode)
        await fs.rename(tmp, path)
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
        throw err
      }
      return (await fs.stat(path)).mtimeMs
    }),

  readdir: (path) =>
    human(path, async () => {
      const entries: HostDirent[] = []
      for (const entry of await fs.readdir(path, { withFileTypes: true })) {
        let dir = entry.isDirectory()
        if (entry.isSymbolicLink()) dir = await fs.stat(join(path, entry.name)).then((s) => s.isDirectory(), () => false)
        entries.push({ name: entry.name, dir })
      }
      return entries
    }),

  realpath: (path) => human(path, () => fs.realpath(path)),

  mkdirp: (path) =>
    human(path, async () => {
      await fs.mkdir(path, { recursive: true })
    })
}

/**
 * `execLogin` local: `$SHELL -lc '<exec cmd args…>'`. La línea se arma con `shCommand` (comillado
 * POSIX), nunca concatenando partes sueltas.
 */
export const localExecLogin: Exec = (cmd, args, opts) =>
  exec(process.env.SHELL || '/bin/sh', ['-lc', shCommand([cmd, ...args], opts.cwd)], opts)

export class LocalHost implements Host {
  readonly id = 'local'
  readonly remote = false
  readonly exec: Exec = exec
  readonly execLogin: Exec = localExecLogin
  readonly fs: HostFs = localFs

  async home(): Promise<string> {
    return homedir()
  }
}
