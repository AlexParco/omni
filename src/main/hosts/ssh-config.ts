import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { SshConfigHost } from '@shared/types'
import { exec as localExec, type Exec } from '../exec'
import { assertTarget, sshBinary } from './ssh'

/**
 * Hosts importables de `~/.ssh/config` (para el picker de "Agregar host"). Solo se leen los
 * archivos de config (siguiendo `Include`); nunca las llaves. Cada alias se resuelve con `ssh -G`,
 * que aplica `Match`, `Include` y valores por defecto igual que OpenSSH.
 */

/** Línea relevante de un archivo de config, en orden: un alias de `Host` o un patrón de `Include`. */
export type SshConfigEntry = { kind: 'host'; alias: string } | { kind: 'include'; pattern: string }

/** Separa una línea de config en palabras, respetando comillas dobles (`Host "mi host"`). */
function tokens(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2] ?? '')
  return out
}

/**
 * `Host`/`Include` de un archivo, en orden de aparición (un `Include` se expande donde está, como
 * en OpenSSH). Los alias con comodines (`*`, `?`) o negados (`!`) no se importan. Pura.
 */
export function parseSshConfig(text: string): SshConfigEntry[] {
  const entries: SshConfigEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    // `Clave valor` o `Clave=valor`.
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line)
    if (!match) continue
    const key = (match[1] ?? '').toLowerCase()
    const values = tokens(match[2] ?? '')
    if (key === 'host') {
      for (const alias of values) if (!/[*?!]/.test(alias)) entries.push({ kind: 'host', alias })
    } else if (key === 'include') {
      for (const pattern of values) entries.push({ kind: 'include', pattern })
    }
  }
  return entries
}

/** Salida de `ssh -G <alias>` → `user@hostname:port`. Pura. */
export function parseSshG(stdout: string): { hostname: string; user: string | null; port: number } {
  const values = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+(.*)$/.exec(line.trim())
    const key = (match?.[1] ?? '').toLowerCase()
    if (match && !values.has(key)) values.set(key, match[2] ?? '')
  }
  const port = Number(values.get('port') ?? '22')
  return { hostname: values.get('hostname') ?? '', user: values.get('user') ?? null, port: Number.isFinite(port) ? port : 22 }
}

function globToRegExp(segment: string): RegExp {
  let re = ''
  for (const ch of segment) {
    if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** Expande un patrón de `Include` (`~`, relativo a `~/.ssh`, comodines `*`/`?` por segmento). Ordenado como glob(3). */
export async function expandInclude(pattern: string, home: string): Promise<string[]> {
  let path = pattern.startsWith('~/') ? join(home, pattern.slice(2)) : pattern
  if (!isAbsolute(path)) path = join(home, '.ssh', path)
  const segments = path.split('/').filter((s) => s !== '')
  let bases = ['/']
  for (const segment of segments) {
    const next: string[] = []
    if (!/[*?]/.test(segment)) {
      for (const base of bases) next.push(join(base, segment))
    } else {
      const re = globToRegExp(segment)
      for (const base of bases) {
        const names = await fs.readdir(base).catch(() => [] as string[])
        for (const name of names.sort()) if (re.test(name) && (segment.startsWith('.') || !name.startsWith('.'))) next.push(join(base, name))
      }
    }
    bases = next
  }
  return bases
}

/** Alias de `~/.ssh/config` y sus `Include` (recursivos, sin ciclos), en orden de aparición. */
export async function readConfigAliases(home = homedir()): Promise<string[]> {
  const aliases: string[] = []
  const seen = new Set<string>()
  const visit = async (file: string, depth: number): Promise<void> => {
    if (depth > 16 || seen.has(file)) return
    seen.add(file)
    const text = await fs.readFile(file, 'utf8').catch(() => null)
    if (text === null) return
    for (const entry of parseSshConfig(text)) {
      if (entry.kind === 'host') {
        if (!aliases.includes(entry.alias)) aliases.push(entry.alias)
      } else {
        for (const included of await expandInclude(entry.pattern, home)) await visit(included, depth + 1)
      }
    }
  }
  await visit(join(home, '.ssh', 'config'), 0)
  return aliases
}

export interface ListSshConfigOptions {
  home?: string
  exec?: Exec
  sshBin?: string
}

/**
 * Hosts importables: alias sin comodines, resueltos con `ssh -G`. Un alias que `ssh -G` no sabe
 * resolver se muestra tal cual (sigue siendo un destino válido para `ssh`).
 */
export async function listSshConfigHosts(opts: ListSshConfigOptions = {}): Promise<SshConfigHost[]> {
  const home = opts.home ?? homedir()
  const run = opts.exec ?? localExec
  const bin = opts.sshBin ?? sshBinary()
  const aliases = (await readConfigAliases(home)).filter((alias) => {
    try {
      assertTarget(alias)
      return true
    } catch {
      return false
    }
  })
  return Promise.all(
    aliases.map(async (alias): Promise<SshConfigHost> => {
      const result = await run(bin, ['-G', alias], { cwd: home, timeoutMs: 5_000 }).catch(() => null)
      if (!result || result.code !== 0) return { alias, resolved: alias }
      const { hostname, user, port } = parseSshG(result.stdout)
      return { alias, resolved: `${user ? `${user}@` : ''}${hostname || alias}:${port}` }
    })
  )
}
