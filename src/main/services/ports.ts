import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ListeningProcess, PortRepo, PortStopResult } from '@shared/types'
import type { SessionPids } from './session-backend'

/**
 * Puertos en escucha de esta máquina (ARCHITECTURE §3.24): quién escucha (`lsof`), desde qué carpeta
 * y repo, cuánto lleva y de qué sesión de omni salió (subiendo por el árbol de `ps` hasta el shell de
 * una sesión). Solo lee procesos del usuario; detener es SIGTERM al trabajo y SIGKILL si no cae.
 */

/** Una fila de `ps -axo pid,ppid,pgid,etime,command`. */
export interface ProcRow {
  pid: number
  ppid: number
  pgid: number
  /** Segundos desde que arrancó. */
  elapsed: number | null
  command: string
}

/** Lo que dice `lsof` de un proceso que escucha. */
export interface LsofEntry {
  pid: number
  /** Nombre corto de lsof (`node`, `Spotify`; los espacios llegan como `\x20`). */
  name: string
  ports: number[]
  hosts: string[]
}

type Exec = (file: string, args: string[]) => Promise<string>

/** Shells y CLIs de agentes: un grupo de procesos con alguno de ellos dentro no se mata entero. */
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'tcsh', 'csh', 'ksh', 'nu', 'login', 'tmux', 'screen'])
const AGENTS = new Set(['claude', 'codex', 'opencode', 'goose', 'hermes', 'aider'])
/** Intérpretes cuyo nombre útil es el script que corren. */
const RUNTIMES = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'php', 'java', 'tsx', 'ts-node'])
/** Cuánto se espera a que un proceso caiga tras SIGTERM antes de SIGKILL. */
export const STOP_GRACE_MS = 3000
const REPO_CACHE_MS = 30_000
const COMMAND_MAX = 400

/** `13-03:13:46`, `01:18:28` o `34:09` → segundos. `null` si no se entiende. */
export function parseElapsed(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim())
  if (!m) return null
  const [, d, h, min, s] = m
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s)
}

/** Salida de `ps -axo pid=,ppid=,pgid=,etime=,command=` → filas por pid. */
export function parsePs(out: string): Map<number, ProcRow> {
  const rows = new Map<number, ProcRow>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    rows.set(pid, { pid, ppid: Number(m[2]), pgid: Number(m[3]), elapsed: parseElapsed(m[4]), command: m[5].trim() })
  }
  return rows
}

/** `127.0.0.1:8828`, `*:7000`, `[::1]:9999` → `{ host, port }`. */
function splitAddress(name: string): { host: string; port: number } | null {
  const at = name.lastIndexOf(':')
  if (at < 0) return null
  const port = Number(name.slice(at + 1))
  if (!Number.isInteger(port) || port <= 0) return null
  const host = name.slice(0, at).replace(/^\[(.*)\]$/, '$1')
  return { host: host || '*', port }
}

/** Salida de `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → un registro por proceso, puertos sin repetir (IPv4 e IPv6 cuentan una vez). */
export function parseLsof(out: string): LsofEntry[] {
  const byPid = new Map<number, { name: string; ports: Set<number>; hosts: Set<string> }>()
  let current: { name: string; ports: Set<number>; hosts: Set<string> } | null = null
  for (const line of out.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const pid = Number(value)
      current = byPid.get(pid) ?? { name: '', ports: new Set(), hosts: new Set() }
      byPid.set(pid, current)
    } else if (tag === 'c' && current) {
      current.name = value.replace(/\\x20/g, ' ')
    } else if (tag === 'n' && current) {
      const addr = splitAddress(value)
      if (!addr) continue
      current.ports.add(addr.port)
      current.hosts.add(addr.host)
    }
  }
  return [...byPid].filter(([, e]) => e.ports.size > 0).map(([pid, e]) => ({ pid, name: e.name, ports: [...e.ports].sort((a, b) => a - b), hosts: [...e.hosts] }))
}

/** Salida de `lsof -a -d cwd -p … -Fpn` → cwd por pid. */
export function parseCwds(out: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | null = null
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n' && pid !== null) cwds.set(pid, line.slice(1))
  }
  return cwds
}

/** Nombre de la app de macOS en una ruta (`/Applications/Visual Studio Code.app/…` → `Visual Studio Code`). */
function appName(command: string): string | null {
  const m = /\/([^/]+)\.app\//.exec(command)
  return m ? m[1] : null
}

/** Palabra de subcomando (`dev`, `serve`, `start`): minúsculas, sin rutas ni `host:puerto`. */
const SUBCOMMAND = /^[a-z][\w-]*$/

/**
 * Nombre corto para la fila a partir de la línea de comando: el binario de `node_modules/.bin` con
 * su subcomando (`nuxt dev`), el script de un intérprete (`node dist/main.js`, `python -m http.server`)
 * o el nombre de la app (`Spotify`). Si no se entiende, el nombre que dio lsof.
 */
export function describeCommand(command: string, fallback: string): string {
  const app = appName(command)
  if (app) return app
  const tokens = command.split(/\s+/).filter((t) => t !== '')
  if (tokens.length === 0) return fallback
  const exe = basename(tokens[0])
  const rest = tokens.slice(1)
  if (RUNTIMES.has(exe)) {
    const m = rest.indexOf('-m')
    if (exe.startsWith('python') && m >= 0 && rest[m + 1]) return `${exe} -m ${rest[m + 1]}`
    // Código en línea (`node -e "…"`, `python -c "…"`): el código no es un nombre.
    const inline = rest.find((t) => t === '-e' || t === '--eval' || t === '-p' || t === '-c')
    if (inline) return `${exe} ${inline}`
    const at = rest.findIndex((t) => !t.startsWith('-'))
    if (at < 0) return exe
    const script = rest[at]
    const sub = rest[at + 1]
    // Un binario instalado (`node_modules/.bin/nuxt`, `/usr/local/bin/vite`) se nombra por sí mismo.
    if (/(^|\/)(node_modules\/\.bin|bin)\//.test(script)) return sub && SUBCOMMAND.test(sub) ? `${basename(script)} ${sub}` : basename(script)
    const shown = isAbsolute(script) ? basename(script) : script
    return `${exe} ${shown}`
  }
  const sub = rest.find((t) => !t.startsWith('-'))
  return sub && SUBCOMMAND.test(sub) ? `${exe} ${sub}` : exe || fallback
}

/** Pid del primer ancestro (incluido él mismo) que cumple `hit`, subiendo como mucho 64 niveles. */
function walkUp(pid: number, table: Map<number, ProcRow>, hit: (pid: number) => boolean): number | null {
  let at: number | undefined = pid
  for (let i = 0; i < 64 && at !== undefined && at > 1; i++) {
    if (hit(at)) return at
    at = table.get(at)?.ppid
  }
  return null
}

/**
 * De quién es un proceso: la sesión cuyo shell está entre sus ancestros, si no omni a secas (desciende
 * del dueño de los PTY), si no omni mismo (desciende de main sin pasar por un shell de sesión).
 */
export function resolveOwner(pid: number, table: Map<number, ProcRow>, owners: SessionPids, self: number): { sessionId: string | null; inOmni: boolean; self: boolean } {
  const shells = new Map(Object.entries(owners.sessions).map(([id, p]) => [p, id]))
  const hit = walkUp(pid, table, (p) => shells.has(p) || p === owners.root || p === self)
  if (hit === null) return { sessionId: null, inOmni: false, self: false }
  const sessionId = shells.get(hit) ?? null
  if (sessionId) return { sessionId, inOmni: true, self: false }
  if (hit === owners.root && hit !== self) return { sessionId: null, inOmni: true, self: false }
  return { sessionId: null, inOmni: false, self: true }
}

/**
 * ¿Se puede mandar la señal al grupo entero (como hace ⌃C con el trabajo de una terminal)? Solo si el
 * líder del grupo es el proceso o un ancestro suyo y en ese tramo no hay un shell, un agente ni omni: así
 * cae `pnpm dev` con su hijo, pero nunca la terminal ni el agente que lo lanzó.
 */
export function canSignalGroup(pid: number, table: Map<number, ProcRow>, owners: SessionPids, self: number): boolean {
  const row = table.get(pid)
  if (!row || row.pgid <= 1) return false
  const ownGroup = table.get(self)?.pgid
  if (row.pgid === ownGroup) return false
  const protectedPids = new Set([self, ...(owners.root === null ? [] : [owners.root]), ...Object.values(owners.sessions)])
  let at: ProcRow | undefined = row
  for (let i = 0; i < 64 && at; i++) {
    if (protectedPids.has(at.pid)) return false
    const exe = basename(at.command.split(/\s+/)[0] ?? '').replace(/^-/, '')
    if (SHELLS.has(exe) || AGENTS.has(exe)) return false
    if (at.pid === row.pgid) return true
    at = table.get(at.ppid)
  }
  return false
}

/** Primera carpeta hacia arriba con `.git` (directorio o archivo de worktree), sin pasar de `$HOME` ni de `/`. */
async function findGitRoot(cwd: string, home: string): Promise<{ root: string; dotGit: string; isFile: boolean } | null> {
  let dir = cwd
  for (let i = 0; i < 40; i++) {
    const dotGit = join(dir, '.git')
    const info = await stat(dotGit).catch(() => null)
    if (info) return { root: dir, dotGit, isFile: info.isFile() }
    const up = dirname(dir)
    if (up === dir || dir === home) return null
    dir = up
  }
  return null
}

/** Repo, rama y subcarpeta del cwd leyendo `.git` a mano (sin lanzar git por cada proceso). */
export async function readRepo(cwd: string, home = homedir()): Promise<PortRepo | null> {
  const found = await findGitRoot(cwd, home)
  if (!found) return null
  let gitDir = found.dotGit
  let name = basename(found.root)
  if (found.isFile) {
    // Worktree enlazado: `.git` dice `gitdir: <repo>/.git/worktrees/<nombre>`; el nombre es el del repo principal.
    const text = await readFile(found.dotGit, 'utf8').catch(() => '')
    const m = /^gitdir:\s*(.+)$/m.exec(text)
    if (!m) return null
    gitDir = resolve(found.root, m[1].trim())
    const common = dirname(dirname(gitDir))
    if (basename(common) === '.git') name = basename(dirname(common))
  }
  const head = await readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => '')
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)
  return { name, branch: ref ? ref[1].trim() : null, worktree: found.isFile, sub: relative(found.root, cwd) }
}

/** `execFile` que devuelve stdout aunque el comando salga con código distinto de 0 (lsof sin resultados sale con 1). */
const defaultExec: Exec = (file, args) =>
  new Promise((done) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => done(typeof stdout === 'string' ? stdout : ''))
  })

/** ¿Sigue vivo el pid? EPERM (de otro usuario) cuenta como vivo. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface PortScannerOptions {
  /** Pids de las sesiones (`SessionBackend.pids`). */
  owners: () => Promise<SessionPids>
  /** Pid de omni (main); por defecto `process.pid`. */
  self?: number
  exec?: Exec
  /** Carpeta tope para buscar repos; por defecto `$HOME`. */
  home?: string
}

export class PortScanner {
  private readonly self: number
  private readonly exec: Exec
  private readonly home: string
  private repos = new Map<string, { at: number; repo: PortRepo | null }>()

  constructor(private readonly opts: PortScannerOptions) {
    this.self = opts.self ?? process.pid
    this.exec = opts.exec ?? defaultExec
    this.home = opts.home ?? homedir()
  }

  /** Procesos en escucha, servicios de desarrollo primero y por puerto. */
  async list(): Promise<ListeningProcess[]> {
    return (await this.scan()).list
  }

  /**
   * Detiene el proceso que escucha en `port`: comprueba que siga siendo él (un pid reciclado no se
   * mata), SIGTERM al trabajo (o solo al proceso si el grupo incluye una terminal o un agente) y, si
   * en `STOP_GRACE_MS` no cayó, SIGKILL.
   */
  async stop(pid: number, port: number, graceMs = STOP_GRACE_MS): Promise<PortStopResult> {
    if (!Number.isInteger(pid) || pid <= 1 || !Number.isInteger(port)) return { ok: false, forced: false, error: 'Proceso o puerto inválido' }
    const { list, table, owners } = await this.scan()
    const target = list.find((p) => p.pid === pid)
    if (!target || !target.ports.includes(port)) return { ok: false, forced: false, error: `Ya nada escucha en :${port} con ese proceso` }
    if (target.self) return { ok: false, forced: false, error: 'Ese puerto es de omni mismo' }
    const group = canSignalGroup(pid, table, owners, this.self) ? table.get(pid)?.pgid : undefined
    const send = (signal: NodeJS.Signals): void => {
      try {
        process.kill(group ? -group : pid, signal)
      } catch {
        // Ya no existe o no es nuestro: se comprueba abajo.
      }
    }
    send('SIGTERM')
    for (let waited = 0; waited < graceMs && alive(pid); waited += 100) await sleep(100)
    if (!alive(pid)) return { ok: true, forced: false }
    send('SIGKILL')
    for (let waited = 0; waited < 1000 && alive(pid); waited += 100) await sleep(100)
    return alive(pid) ? { ok: false, forced: true, error: `El proceso ${pid} no se dejó detener` } : { ok: true, forced: true }
  }

  private async scan(): Promise<{ list: ListeningProcess[]; table: Map<number, ProcRow>; owners: SessionPids }> {
    const [lsofOut, psOut, owners] = await Promise.all([
      this.exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']),
      this.exec('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,etime=,command=']),
      this.opts.owners().catch((): SessionPids => ({ root: null, sessions: {} }))
    ])
    const entries = parseLsof(lsofOut)
    const table = parsePs(psOut)
    const cwds = entries.length ? parseCwds(await this.exec('lsof', ['-a', '-d', 'cwd', '-p', entries.map((e) => e.pid).join(','), '-Fpn'])) : new Map<number, string>()
    const now = Date.now()
    const list = await Promise.all(
      entries.map(async (e): Promise<ListeningProcess> => {
        const row = table.get(e.pid)
        const command = (row?.command ?? e.name).slice(0, COMMAND_MAX)
        const cwd = cwds.get(e.pid) ?? null
        const owner = resolveOwner(e.pid, table, owners, this.self)
        const kind = owner.inOmni || owner.self || (cwd !== null && cwd !== '/') ? 'dev' : 'system'
        return {
          pid: e.pid,
          ports: e.ports,
          hosts: e.hosts,
          name: describeCommand(command, e.name),
          command,
          cwd,
          repo: cwd && cwd !== '/' ? await this.repo(cwd, now) : null,
          startedAt: row?.elapsed === null || row?.elapsed === undefined ? null : now - row.elapsed * 1000,
          ...owner,
          kind
        }
      })
    )
    list.sort((a, b) => (a.kind === b.kind ? a.ports[0] - b.ports[0] : a.kind === 'dev' ? -1 : 1))
    return { list, table, owners }
  }

  private async repo(cwd: string, now: number): Promise<PortRepo | null> {
    const hit = this.repos.get(cwd)
    if (hit && now - hit.at < REPO_CACHE_MS) return hit.repo
    const repo = await readRepo(cwd, this.home).catch(() => null)
    this.repos.set(cwd, { at: now, repo })
    return repo
  }
}
