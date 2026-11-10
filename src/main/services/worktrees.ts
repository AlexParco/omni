import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, promises as fs, realpathSync, rmSync } from 'node:fs'
import { join, posix, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { IssueInfo, Project, ProjectLocation, TestsResult, Workspace, Worktree, WorktreeStatus } from '@shared/types'
import { exec as defaultExec, failure, type Exec, type ExecResult } from '../exec'
import { WORKTREES_ROOT } from '../paths'
import type { Host } from '../hosts/types'

/** Longitud máxima del nombre de un worktree (y de su rama `omni/<name>`). */
export const MAX_NAME = 40

/** El estado (status, shortstat) se recalcula como mucho cada 5 s por worktree. */
export const STATUS_TTL_MS = 5_000

/** Un `testCommand` que pase de esto se cancela y cuenta como fallido. */
export const TESTS_TIMEOUT_MS = 600_000

/** Solo se conserva la cola de la salida de los tests: el resumen es su última línea. */
export const TESTS_TAIL_BYTES = 64 * 1024

/** Tope de lectura de un archivo sin seguimiento al contarle líneas. */
const UNTRACKED_MAX_BYTES = 512 * 1024

const GIT_TIMEOUT_MS = 30_000
const GH_TIMEOUT_MS = 15_000

/** Lo que el servicio necesita del catálogo de proyectos; `ProjectStore` lo cumple (se inyecta, ARCHITECTURE §4). */
export interface WorktreeRegistry {
  project(id: string): Project | undefined
  location(id: string): ProjectLocation | undefined
  worktree(id: string): Worktree | undefined
  worktreesOf(projectId: string): Worktree[]
  addWorktree(worktree: Worktree): void
  removeWorktree(id: string): void
}

/** Resuelve un issue de GitHub en el repo `cwd`. Por defecto `gh issue view`; en tests, una función falsa. */
export type IssueFetcher = (number: number, cwd: string) => Promise<IssueInfo>

/** Corre un comando de shell y devuelve la cola de su salida (stdout + stderr) con el código. */
export type ShellRunner = (command: string, cwd: string, timeoutMs: number) => Promise<{ code: number | null; output: string }>

export interface WorktreeServiceOptions {
  registry: WorktreeRegistry
  root?: string
  exec?: Exec
  shell?: ShellRunner
  issue?: IssueFetcher
  now?: () => number
  newId?: () => string
  /** Tope de los tests; por defecto 10 min. Inyectable en tests. */
  testsTimeoutMs?: number
  /** Hosts remotos (§3.26): un worktree de una ubicación en un servidor vive y corre allí. */
  hosts?: { ensure(hostId: string): Promise<Host> }
}

export type ChangedListener = (workspaceId: string) => void

/** Nombre apto para rama y carpeta: minúsculas, dígitos y guiones, ≤ 40. Vacío si no queda nada. */
export function sanitizeName(raw: string): string {
  const slug = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_NAME)
  return slug.replace(/-+$/, '')
}

/** `issue-<n>-<slug del título>`, recortado a 40 sin dejar un guion colgando. */
export function nameFromIssue(issue: IssueInfo): string {
  return sanitizeName(`issue-${issue.number}-${issue.title}`)
}

/** `git diff --shortstat` → números. Sin cambios git no imprime nada. */
export function parseShortstat(text: string): WorktreeStatus['stat'] {
  const files = /(\d+) files? changed/.exec(text)
  const additions = /(\d+) insertions?\(\+\)/.exec(text)
  const deletions = /(\d+) deletions?\(-\)/.exec(text)
  return { files: files ? Number(files[1]) : 0, additions: additions ? Number(additions[1]) : 0, deletions: deletions ? Number(deletions[1]) : 0 }
}

/** Última línea no vacía de una salida; `''` si no hay. */
export function lastLine(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  return lines.at(-1) ?? ''
}

/** Líneas de un archivo de texto; un binario (NUL en los primeros 8 KB) cuenta 0. */
export function countLines(buf: Buffer): number {
  if (buf.length === 0 || buf.subarray(0, 8000).includes(0)) return 0
  let n = 0
  for (const byte of buf) if (byte === 10) n++
  return buf[buf.length - 1] === 10 ? n : n + 1
}

/** Variables del lanzador que no deben heredar los tests (misma limpieza que los PTY del daemon, más las de npm/Node). */
const STRIPPED_ENV = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS']

/** Env para los tests: el del proceso sin las variables de Electron/Node ni `npm_config_*` (un `pnpm test` dentro de omni no debe heredar config de otro npm). */
export function testsEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || STRIPPED_ENV.includes(k) || k.toLowerCase().startsWith('npm_config_')) continue
    env[k] = v
  }
  env.TERM_PROGRAM = 'omni'
  env.OMNI_SESSION = '1'
  return env
}

/** Pasado el tope, se mata a todo el grupo de procesos (`sh` y lo que haya lanzado), no solo al `sh`. */
function describeTimeout(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`
}

/**
 * `sh -lc <command>` con cwd, en su propio grupo de procesos (`detached`), temporizador propio y
 * solo la cola de la salida en memoria (decodificada por trozos: un multibyte partido no se rompe).
 */
const defaultShell: ShellRunner = (command, cwd, timeoutMs) =>
  new Promise((resolvePromise) => {
    let tail = ''
    const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') }
    const push = (decoder: StringDecoder) => (chunk: Buffer) => {
      tail = (tail + decoder.write(chunk)).slice(-TESTS_TAIL_BYTES)
    }
    let timedOut = false
    let done = false
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      tail = (tail + decoders.out.end() + decoders.err.end()).slice(-TESTS_TAIL_BYTES)
      if (timedOut) resolvePromise({ code: null, output: `${tail}\ntests cancelados a los ${describeTimeout(timeoutMs)}` })
      else resolvePromise({ code, output: signal ? `${tail}\ntests cancelados (${signal})` : tail })
    }
    const child = spawn('sh', ['-lc', command], { cwd, env: testsEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const killGroup = (): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, timeoutMs)
    child.stdout.on('data', push(decoders.out))
    child.stderr.on('data', push(decoders.err))
    child.on('error', (err) => {
      tail = `${tail}\n${err.message}`
      finish(null, null)
    })
    // `close` espera a que se cierren las tuberías; si un nieto las dejó abiertas (un servidor de fondo), basta con `exit` más un respiro.
    child.on('close', finish)
    child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), 1_000))
  })

function parseIssue(raw: string, number: number): IssueInfo {
  const data: unknown = JSON.parse(raw)
  if (typeof data !== 'object' || data === null) throw new Error(`gh devolvió algo raro para el issue #${number}`)
  const { title, url } = data as Record<string, unknown>
  if (typeof title !== 'string' || typeof url !== 'string') throw new Error(`gh devolvió algo raro para el issue #${number}`)
  return { number, title, url }
}

function makeIssueFetcher(exec: Exec): IssueFetcher {
  return async (number, cwd) => {
    let result: ExecResult
    try {
      result = await exec('gh', ['issue', 'view', String(number), '--json', 'number,title,url'], { cwd, timeoutMs: GH_TIMEOUT_MS })
    } catch {
      throw new Error('gh no está instalado')
    }
    if (result.code !== 0) throw failure('gh no está autenticado o el repo no es de GitHub', result)
    return parseIssue(result.stdout, number)
  }
}

/** Dónde corre lo de una ubicación: `host` null = este Mac. */
interface Place {
  exec: Exec
  host: Host | null
}

/** Carpeta de worktrees de omni en un host remoto, relativa a su `$HOME` (igual que en `projects.ts`). */
const REMOTE_WORKTREES_DIR = '.omni/worktrees'

/** Primeros bytes de un archivo del host (para contar líneas de un untracked) sin traerlo entero. */
async function readRemoteHead(host: Host, path: string): Promise<Buffer> {
  try {
    const r = await host.exec('head', ['-c', String(UNTRACKED_MAX_BYTES), '--', path], { cwd: '/', timeoutMs: GIT_TIMEOUT_MS })
    return r.code === 0 ? Buffer.from(r.stdout, 'utf8') : Buffer.alloc(0)
  } catch {
    return Buffer.alloc(0)
  }
}

/** `sh -c <command>` en el shell de login del host, con la cola de la salida como resultado. */
async function remoteShell(place: Place, command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  if (!place.host) throw new Error('sin host')
  const r = await place.host.execLogin('sh', ['-c', `export TERM_PROGRAM=omni OMNI_SESSION=1; ${command}`], { cwd, timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  const output = `${r.stdout}${r.stderr}`.slice(-TESTS_TAIL_BYTES)
  return { code: r.code, output: r.code === null ? `${output}\ntests cancelados a los ${describeTimeout(timeoutMs)}` : output }
}

interface CachedStatus {
  status: WorktreeStatus
  at: number
}

/**
 * Worktrees de git como workspaces (ARCHITECTURE §3.15): crear, borrar, estado con cache, tests
 * del proyecto y limpieza automática. Todo git va por `execFile` con cwd y timeout, nunca por shell.
 * No conoce IPC: avisa por `onChanged` y `main/ipc.ts` lo publica.
 */
export class WorktreeService {
  private readonly registry: WorktreeRegistry
  private readonly root: string
  private readonly exec: Exec
  private readonly shell: ShellRunner
  private readonly fetchIssue: IssueFetcher
  private readonly now: () => number
  private readonly newId: () => string
  private readonly testsTimeoutMs: number
  private readonly hosts: WorktreeServiceOptions['hosts']
  private readonly statusCache = new Map<string, CachedStatus>()
  private readonly tests = new Map<string, TestsResult>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly listeners = new Set<ChangedListener>()

  constructor(opts: WorktreeServiceOptions) {
    this.registry = opts.registry
    this.root = opts.root ?? WORKTREES_ROOT
    this.exec = opts.exec ?? defaultExec
    this.shell = opts.shell ?? defaultShell
    this.fetchIssue = opts.issue ?? makeIssueFetcher(this.exec)
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? randomUUID
    this.testsTimeoutMs = opts.testsTimeoutMs ?? TESTS_TIMEOUT_MS
    this.hosts = opts.hosts
  }

  /**
   * Dónde corre todo lo de una ubicación: este Mac (`exec` local) o su servidor (§3.26), con el `exec`,
   * el shell de login y los archivos de ese host. Un worktree vive siempre en el host de su repo.
   */
  private async place(location: ProjectLocation | undefined): Promise<Place> {
    if (!location?.host) return { exec: this.exec, host: null }
    if (!this.hosts) throw new Error('los worktrees remotos necesitan la conexión con el servidor')
    const host = await this.hosts.ensure(location.host)
    return { exec: host.exec, host }
  }

  private placeOf(worktree: Worktree): Promise<Place> {
    return this.place(this.registry.location(worktree.locationId))
  }

  onChanged(l: ChangedListener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /** `gh issue view` en el repo del proyecto. */
  async issue(projectId: string, number: number): Promise<IssueInfo> {
    const project = this.needProject(projectId)
    if (!Number.isInteger(number) || number <= 0) throw new Error(`número de issue inválido: ${number}`)
    const repo = project.locations.find((l) => !l.host) ?? project.locations[0]
    if (!repo) throw new Error(`${project.name} no tiene carpetas: agrega una ubicación`)
    return this.fetchIssue(number, repo.path)
  }

  /** Ubicación (repo) de la que sale un worktree: la pedida o la primera. Los remotos todavía no (§3.26). */
  private repoOf(project: Project, locationId?: string): ProjectLocation {
    if (project.locations.length === 0) throw new Error(`${project.name} no tiene carpetas: agrega una ubicación`)
    const location = locationId ? project.locations.find((l) => l.id === locationId) : project.locations[0]
    if (!location) throw new Error(`ubicación desconocida: ${locationId}`)
    return location
  }

  /** Crea `omni/<name>` desde la rama actual del proyecto y devuelve el workspace nuevo. */
  async create(projectId: string, opts: { name?: string; issue?: number; locationId?: string } = {}): Promise<Workspace> {
    const project = this.needProject(projectId)
    const repo = this.repoOf(project, opts.locationId)
    const at = await this.place(repo)
    if (!(await this.isRepo(at.exec, repo.path))) throw new Error(project.locations.length > 1 ? `${repo.name} no es un repo git` : 'el proyecto no es un repo git')
    let issue: IssueInfo | undefined
    let name: string
    if (opts.issue !== undefined) {
      // El issue se busca en el repo del que sale el worktree (otra ubicación puede ser otro repo de GitHub).
      if (!Number.isInteger(opts.issue) || opts.issue <= 0) throw new Error(`número de issue inválido: ${opts.issue}`)
      issue = await this.fetchIssue(opts.issue, repo.path)
      name = nameFromIssue(issue)
    } else if (opts.name !== undefined) {
      name = sanitizeName(opts.name)
      if (name === '') throw new Error(`nombre inválido: "${opts.name}"`)
    } else {
      name = this.freeName(projectId)
    }
    const siblings = this.registry.worktreesOf(projectId)
    if (siblings.some((w) => w.name === name)) throw new Error(`ya existe un worktree ${name}`)
    const branch = `omni/${name}`
    if (await this.branchExists(at.exec, repo.path, branch)) throw new Error(`ya existe la rama ${branch}`)
    // En un servidor, bajo `~/.omni/worktrees` del host (la guarda de `rm -rf` exige esa carpeta).
    const root = at.host ? posix.join(await at.host.home(), REMOTE_WORKTREES_DIR) : this.root
    const path = (at.host ? posix.join : join)(root, projectFolder(project), name)
    if (at.host ? (await at.host.fs.stat(path)) !== null : existsSync(path)) throw new Error(`ya existe la carpeta ${path}`)
    const base = await this.baseOf(at.exec, repo.path)
    if (at.host) await at.host.fs.mkdirp(posix.dirname(path))
    else mkdirSync(join(path, '..'), { recursive: true })
    await this.git(at.exec, repo.path, ['worktree', 'add', '-b', branch, path, base])
    const worktree: Worktree = { id: this.newId(), projectId, locationId: repo.id, name, branch, base, path, createdAt: this.now() }
    if (issue) worktree.issue = issue
    // La ubicación puede ser una subcarpeta del repo (`apps/web`): el worktree es del repo entero, pero sus
    // agentes y tests arrancan en la misma subcarpeta (§3.5c).
    const subdir = (await this.git(at.exec, repo.path, ['rev-parse', '--show-prefix'])).trim().replace(/\/+$/, '')
    if (subdir) worktree.subdir = subdir
    this.registry.addWorktree(worktree)
    this.emit(worktree.id)
    return { id: worktree.id, projectId, name, path, kind: 'worktree' }
  }

  /**
   * `git worktree remove --force` + `git branch -D` + fuera del registro. Tolera un repo o carpeta ya
   * borrados. Un path fuera de la raíz de worktrees (un projects.json manipulado) no se toca: solo se
   * olvida y se avisa.
   */
  async remove(workspaceId: string): Promise<void> {
    const worktree = this.need(workspaceId)
    const repo = this.registry.location(worktree.locationId)
    if (repo?.host) return this.removeRemote(worktree, repo)
    if (!isUnderRoot(worktree.path, this.root)) {
      this.forget(workspaceId)
      throw new Error(`ruta fuera de la carpeta de worktrees: ${worktree.path}`)
    }
    if (repo && !repo.host && existsSync(repo.path)) {
      const removed = await this.tryGit(this.exec, repo.path, ['worktree', 'remove', '--force', worktree.path])
      if (!removed) {
        rmSync(worktree.path, { recursive: true, force: true })
        await this.tryGit(this.exec, repo.path, ['worktree', 'prune'])
      }
      await this.tryGit(this.exec, repo.path, ['branch', '-D', worktree.branch])
    } else {
      rmSync(worktree.path, { recursive: true, force: true })
    }
    this.forget(workspaceId)
  }

  /**
   * Borrado en el servidor (§3.26): `git worktree remove` en el repo del host y, si falla, `rm -rf` solo si
   * la ruta cuelga de `.omni/worktrees` (la misma guarda que al leer `projects.json`). Sin conexión no se
   * olvida: el worktree seguiría en el host sin nadie que lo borre.
   */
  private async removeRemote(worktree: Worktree, repo: ProjectLocation): Promise<void> {
    const at = await this.place(repo)
    if (!worktree.path.includes(`/${REMOTE_WORKTREES_DIR}/`)) {
      this.forget(worktree.id)
      throw new Error(`ruta fuera de la carpeta de worktrees: ${worktree.path}`)
    }
    const removed = await this.tryGit(at.exec, repo.path, ['worktree', 'remove', '--force', worktree.path])
    if (!removed) {
      await at.exec('rm', ['-rf', '--', worktree.path], { cwd: '/', timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined)
      await this.tryGit(at.exec, repo.path, ['worktree', 'prune'])
    }
    await this.tryGit(at.exec, repo.path, ['branch', '-D', worktree.branch])
    this.forget(worktree.id)
  }

  /**
   * Al olvidar un proyecto: borra sus worktrees sin cambios (ni commits ni árbol sucio) y deja en
   * disco los que tienen trabajo. Devuelve las rutas conservadas (el registro las olvida igual).
   */
  async removeProjectWorktrees(projectId: string): Promise<string[]> {
    const kept: string[] = []
    for (const worktree of this.registry.worktreesOf(projectId)) {
      let clean = false
      try {
        const status = await this.status(worktree.id, true)
        clean = !status.dirty && status.stat.files === 0
      } catch (err) {
        console.warn(`[omni] no se pudo leer el estado del worktree ${worktree.name}:`, err)
      }
      if (!clean) {
        kept.push(worktree.path)
        this.forget(worktree.id)
        continue
      }
      try {
        await this.remove(worktree.id)
      } catch (err) {
        console.warn(`[omni] no se pudo borrar el worktree ${worktree.name}:`, err)
        kept.push(worktree.path)
      }
    }
    return kept
  }

  /** Estado del worktree; git se consulta como mucho cada 5 s salvo `fresh`. Los tests siempre son los últimos. */
  async status(workspaceId: string, fresh = false): Promise<WorktreeStatus> {
    const worktree = this.need(workspaceId)
    const hit = this.statusCache.get(workspaceId)
    if (!fresh && hit && this.now() - hit.at < STATUS_TTL_MS) return { ...hit.status, tests: this.tests.get(workspaceId) ?? null }
    const at = await this.placeOf(worktree)
    const porcelain = await this.git(at.exec, worktree.path, ['status', '--porcelain'])
    const mergeBase = await this.mergeBase(at.exec, worktree)
    const stat = parseShortstat(await this.git(at.exec, worktree.path, ['diff', '--shortstat', mergeBase]))
    for (const rel of await this.untracked(at.exec, worktree.path)) {
      stat.files++
      stat.additions += countLines(at.host ? await readRemoteHead(at.host, posix.join(worktree.path, rel)) : await readHead(join(worktree.path, rel)))
    }
    const status: WorktreeStatus = { branch: worktree.branch, base: worktree.base, dirty: porcelain.trim() !== '', stat, tests: this.tests.get(workspaceId) ?? null }
    this.statusCache.set(workspaceId, { status, at: this.now() })
    return status
  }

  /**
   * Corre el `testCommand` de la carpeta de origen (o el del proyecto) en el worktree, en su subcarpeta si salió de una. Tira en el acto si no hay comando; si ya hay
   * una corrida, devuelve esa misma. El resultado se publica por `onChanged` (y resuelve la promesa).
   */
  runTests(workspaceId: string): Promise<void> {
    const worktree = this.need(workspaceId)
    // El de la carpeta de origen manda sobre el del proyecto (§3.5c).
    const command = this.registry.location(worktree.locationId)?.testCommand ?? this.registry.project(worktree.projectId)?.testCommand
    if (!command) throw new Error('el proyecto no tiene comando de tests')
    const current = this.running.get(workspaceId)
    if (current) return current
    const remote = this.registry.location(worktree.locationId)?.host !== undefined
    const cwd = worktree.subdir ? (remote ? posix.join : join)(worktree.path, worktree.subdir) : worktree.path
    const run = this.runTestsNow(workspaceId, cwd, command, remote ? this.placeOf(worktree) : null).finally(() => this.running.delete(workspaceId))
    this.running.set(workspaceId, run)
    return run
  }

  /** Último resultado de tests del worktree (o `null`). */
  testsOf(workspaceId: string): TestsResult | null {
    return this.tests.get(workspaceId) ?? null
  }

  /** Borra el worktree si no tiene cambios respecto a su base (ni commits ni árbol sucio). `true` si lo borró. */
  async cleanupIfEmpty(workspaceId: string): Promise<boolean> {
    const worktree = this.registry.worktree(workspaceId)
    // Si la carpeta ya no está (merge o descarte en curso), no hay nada que limpiar ni que avisar.
    if (!worktree || !(await this.exists(worktree)) || this.running.has(workspaceId)) return false
    let status: WorktreeStatus
    try {
      status = await this.status(workspaceId, true)
    } catch (err) {
      // La carpeta puede desaparecer mientras git corría (borrado en paralelo): no es un error.
      if (!(await this.exists(worktree))) return false
      console.warn(`[omni] no se pudo leer el estado del worktree ${workspaceId}:`, err)
      return false
    }
    if (status.dirty || status.stat.files > 0) return false
    await this.remove(workspaceId)
    return true
  }

  private async runTestsNow(workspaceId: string, cwd: string, command: string, remote: Promise<Place> | null): Promise<void> {
    this.tests.set(workspaceId, { status: 'running', summary: '', at: this.now() })
    this.emit(workspaceId)
    // En un servidor, por su shell de login (PATH de nvm/asdf), con el mismo tope de tiempo.
    const result = remote ? await remoteShell(await remote, command, cwd, this.testsTimeoutMs) : await this.shell(command, cwd, this.testsTimeoutMs)
    // Borrado mientras corría: no hay a quién publicarle nada.
    if (!this.registry.worktree(workspaceId)) return
    const passed = result.code === 0
    const summary = lastLine(result.output) || (passed ? 'ok' : `código ${result.code ?? 'señal'}`)
    this.tests.set(workspaceId, { status: passed ? 'pass' : 'fail', summary, at: this.now() })
    this.emit(workspaceId)
  }

  /** Fuera del registro y de las caches, y se avisa. */
  private forget(workspaceId: string): void {
    this.registry.removeWorktree(workspaceId)
    this.statusCache.delete(workspaceId)
    this.tests.delete(workspaceId)
    this.emit(workspaceId)
  }

  private emit(workspaceId: string): void {
    for (const l of this.listeners) l(workspaceId)
  }

  private need(workspaceId: string): Worktree {
    const worktree = this.registry.worktree(workspaceId)
    if (!worktree) throw new Error(`el workspace no es un worktree: ${workspaceId}`)
    return worktree
  }

  private needProject(projectId: string): Project {
    const project = this.registry.project(projectId)
    if (!project) throw new Error(`proyecto desconocido: ${projectId}`)
    return project
  }

  /** Primer `wt-<n>` libre en el proyecto. */
  private freeName(projectId: string): string {
    const taken = new Set(this.registry.worktreesOf(projectId).map((w) => w.name))
    for (let n = 1; ; n++) if (!taken.has(`wt-${n}`)) return `wt-${n}`
  }

  /** La carpeta del worktree sigue en su host (sin conexión con el servidor, se da por que sí). */
  private async exists(worktree: Worktree): Promise<boolean> {
    if (!this.registry.location(worktree.locationId)?.host) return existsSync(worktree.path)
    try {
      return (await (await this.placeOf(worktree)).host?.fs.stat(worktree.path)) != null
    } catch {
      return true
    }
  }

  private async isRepo(exec: Exec, path: string): Promise<boolean> {
    try {
      const r = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: path, timeoutMs: GIT_TIMEOUT_MS })
      return r.code === 0 && r.stdout.trim() === 'true'
    } catch {
      return false
    }
  }

  private async branchExists(exec: Exec, cwd: string, branch: string): Promise<boolean> {
    const r = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return r.code === 0
  }

  /** Rama actual del repo local; en HEAD suelto, `origin/HEAD` (p. ej. `origin/main`) si existe. */
  private async baseOf(exec: Exec, cwd: string): Promise<string> {
    const head = await exec('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    if (head.code === 0 && head.stdout.trim() !== '') return head.stdout.trim()
    const origin = await exec('git', ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    if (origin.code === 0 && origin.stdout.trim() !== '') return origin.stdout.trim()
    throw new Error('el repo está en HEAD suelto y no tiene origin/HEAD: no hay base para el worktree')
  }

  private async mergeBase(exec: Exec, worktree: Worktree): Promise<string> {
    const r = await exec('git', ['merge-base', worktree.base, 'HEAD'], { cwd: worktree.path, timeoutMs: GIT_TIMEOUT_MS })
    if (r.code !== 0) throw failure(`no se encuentra la base ${worktree.base}`, r)
    return r.stdout.trim()
  }

  private async untracked(exec: Exec, cwd: string): Promise<string[]> {
    const out = await this.git(exec, cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
    return out.split('\0').filter((p) => p !== '')
  }

  private async git(exec: Exec, cwd: string, args: string[]): Promise<string> {
    const r = await exec('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS })
    if (r.code !== 0) throw failure(`git ${args[0]} falló`, r)
    return r.stdout
  }

  /** git que puede fallar sin drama (limpieza): `true` si salió con 0. */
  private async tryGit(exec: Exec, cwd: string, args: string[]): Promise<boolean> {
    try {
      return (await exec('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS })).code === 0
    } catch {
      return false
    }
  }
}

/** Carpeta del proyecto bajo la raíz: nombre saneado más un trozo del id, para que dos proyectos con el mismo basename no choquen. */
export function projectFolder(project: Project): string {
  return `${sanitizeName(project.name) || 'proyecto'}-${project.id.slice(0, 8)}`
}

/** `path` (resuelto, con symlinks si existe) cuelga de `root`. Comparte criterio con `ProjectStore`. */
export function isUnderRoot(path: string, root: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const base = real(root)
  return real(path).startsWith(base.endsWith(sep) ? base : base + sep)
}

/** Primeros 512 KB de un archivo; vacío si no se puede leer (borrado entre el listado y la lectura). */
async function readHead(path: string): Promise<Buffer> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(path, 'r')
    const { size } = await handle.stat()
    const buf = Buffer.alloc(Math.min(size, UNTRACKED_MAX_BYTES))
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return Buffer.alloc(0)
  } finally {
    await handle?.close()
  }
}
