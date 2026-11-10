import { execFile } from 'node:child_process'
import { promises as fs, realpathSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import type { DiffFile, DiffHunk, Project, ProjectLocation, WorkspaceDiff, Worktree } from '@shared/types'
import { exec as defaultExec, failure, type Exec } from '../exec'

/** Más de esto y la rama se vuelve a preguntar a git. */
export const BRANCH_TTL_MS = 10_000

/** Tiempo máximo que se espera a `git rev-parse` antes de darlo por fallido. */
const GIT_TIMEOUT_MS = 2_000

/** Ejecuta un comando y devuelve su stdout; rechaza si falla o expira. Inyectable en tests. */
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<string>

const defaultRunner: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolvePromise(stdout)
    })
  })

interface Cached {
  branch: string | null
  at: number
}

/**
 * Rama git actual de una carpeta (`git rev-parse --abbrev-ref HEAD`) con cache de `BRANCH_TTL_MS`.
 * `null` si no es un repo, está en HEAD suelto, git no está o tarda más de 2 s. Nunca tira: el quick open solo pinta
 * un dato más o menos.
 */
export class BranchCache {
  private readonly cache = new Map<string, Cached>()

  constructor(
    private readonly run: Runner = defaultRunner,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = BRANCH_TTL_MS
  ) {}

  /**
   * Rama de `path`. Con `remote`, la carpeta es del host remoto y git corre allí por su `exec`
   * (cache aparte por host: dos hosts pueden repetir rutas).
   */
  async branch(path: string, remote?: { hostId: string; exec: Exec }): Promise<string | null> {
    const key = remote ? `${remote.hostId}\u0000${path}` : path
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < this.ttlMs) return hit.branch
    let branch: string | null = null
    try {
      const out = (remote ? await remoteStdout(remote.exec, path) : await this.run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], GIT_TIMEOUT_MS)).trim()
      // En HEAD suelto (detached) git responde literalmente `HEAD`: no hay rama que mostrar.
      branch = out === '' || out === 'HEAD' ? null : out
    } catch {
      branch = null
    }
    this.cache.set(key, { branch, at: this.now() })
    return branch
  }
}

/** Por ssh hay un viaje de red de por medio: más margen que en local. */
const REMOTE_GIT_TIMEOUT_MS = 8_000

/** `git -C <ruta> rev-parse --abbrev-ref HEAD` en el host; rechaza si falla, como el `Runner` local. */
async function remoteStdout(exec: Exec, path: string): Promise<string> {
  const r = await exec('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: '/', timeoutMs: REMOTE_GIT_TIMEOUT_MS })
  if (r.code !== 0) throw failure('git rev-parse falló', r)
  return r.stdout
}

/* ---------- revisión: diff y merge de worktrees (ARCHITECTURE §3.16) ---------- */

/** Tope del diff que se manda al renderer; pasado esto se corta en un límite de archivo. */
export const DIFF_MAX_BYTES = 2 * 1024 * 1024

/** Un archivo sin seguimiento se lee hasta aquí para pintarlo como añadido. */
export const UNTRACKED_MAX_BYTES = 512 * 1024

const REVIEW_TIMEOUT_MS = 60_000

/** Lo que el servicio necesita del catálogo (`ProjectStore` lo cumple; se inyecta, ARCHITECTURE §4). */
export interface ReviewRegistry {
  project(id: string): Project | undefined
  location(id: string): ProjectLocation | undefined
  worktree(id: string): Worktree | undefined
}

/** Lo que el servicio necesita de `HostRegistry` para los workspaces remotos (§3.26): conectar si hace falta y su `exec`. */
export interface GitHosts {
  ensure(hostId: string): Promise<{ exec: Exec }>
}

/** Dónde corre el git de un worktree: este Mac o el servidor de su repo (§3.26). */
interface GitPlace {
  exec: Exec
  remote: boolean
}

/** Texto de un error de `git show <ref>:<ruta>` que significa "la ruta no está en esa ref" (archivo nuevo). */
export function isMissingInRef(stderr: string): boolean {
  return /exists on disk, but not in|does not exist in ['"]/.test(stderr)
}

export interface GitServiceOptions {
  registry: ReviewRegistry
  /** Borra el worktree, su rama y su registro (lo hace `WorktreeService`; se cablea en `main/index.ts`). */
  removeWorktree: (workspaceId: string) => Promise<void>
  exec?: Exec
  /** Hosts remotos; sin esto, una ubicación remota da un error humano en vez de correr git local sobre una ruta ajena. */
  hosts?: GitHosts
}

/** `diff --git "a/x y" "b/x y"`: git entrecomilla rutas raras; se desescapa lo básico. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path
  return path.slice(1, -1).replace(/\\(["\\])/g, '$1')
}

/** `--- a/ruta` / `+++ b/ruta` → ruta (o `null` para /dev/null). */
function pathFromMarker(line: string): string | null {
  const raw = unquote(line.slice(4).split('\t')[0] ?? '')
  if (raw === '/dev/null') return null
  return raw.replace(/^[ab]\//, '')
}

/** Cabecera `@@ -a,b +c,d @@`; `b` y `d` valen 1 si faltan. `null` si no es una cabecera. */
export function parseHunkHeader(line: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
  if (!m) return null
  return { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) }
}

/**
 * Parser puro de `git diff --no-color -U3`: un `DiffFile` por `diff --git`, con renombres (`R`),
 * borrados (`D`), añadidos (`A`), binarios sin hunks y varios hunks por archivo. La ruta sale de
 * `rename to` / `+++` / `---`, en ese orden, porque la línea `diff --git` es ambigua con espacios.
 * Las líneas de un hunk se cuentan con los totales de su cabecera: así `---` dentro de un hunk no
 * se confunde con un marcador de archivo.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldLeft = 0
  let newLeft = 0
  let oldLine = 0
  let newLine = 0
  let gitPath = ''
  let fromMarker: string | null = null

  const finishHunk = (): void => {
    hunk = null
    oldLeft = 0
    newLeft = 0
  }

  for (const line of text.split('\n')) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const sign = line[0]
      if (sign === '\\') continue
      if (sign === ' ' || sign === '+' || sign === '-') {
        const body = line.slice(1)
        if (sign === ' ') {
          hunk.lines.push({ kind: 'ctx', old: oldLine++, new: newLine++, text: body })
          oldLeft--
          newLeft--
        } else if (sign === '+') {
          hunk.lines.push({ kind: 'add', old: null, new: newLine++, text: body })
          newLeft--
          if (file) file.additions++
        } else {
          hunk.lines.push({ kind: 'del', old: oldLine++, new: null, text: body })
          oldLeft--
          if (file) file.deletions++
        }
        continue
      }
      // Hunk truncado (diff cortado): se cierra y se sigue con lo que venga.
      finishHunk()
    }

    if (line.startsWith('diff --git ')) {
      finishHunk()
      const rest = line.slice('diff --git '.length)
      const split = rest.indexOf(' b/')
      gitPath = split >= 0 ? unquote(rest.slice(split + 3)) : unquote(rest)
      fromMarker = null
      file = { path: gitPath, status: 'M', additions: 0, deletions: 0, binary: false, hunks: [] }
      files.push(file)
      continue
    }
    if (!file) continue

    if (line.startsWith('new file mode')) file.status = 'A'
    else if (line.startsWith('deleted file mode')) file.status = 'D'
    else if (line.startsWith('rename to ')) {
      file.status = 'R'
      file.path = unquote(line.slice('rename to '.length))
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true
    else if (line.startsWith('--- ')) fromMarker = pathFromMarker(line)
    else if (line.startsWith('+++ ')) {
      const to = pathFromMarker(line)
      if (file.status !== 'R') file.path = to ?? fromMarker ?? gitPath
    } else {
      const header = parseHunkHeader(line)
      if (!header) continue
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      oldLeft = header.oldCount
      newLeft = header.newCount
      oldLine = header.oldStart
      newLine = header.newStart
    }
  }
  return files
}

/** Corta el diff en el último `diff --git` que cabe en `max` BYTES (no caracteres: un diff con acentos pesa más de lo que mide). */
export function truncateDiff(text: string, max = DIFF_MAX_BYTES): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= max) return { text, truncated: false }
  const cut = buf.lastIndexOf('\ndiff --git ', max, 'utf8')
  return { text: cut > 0 ? buf.subarray(0, cut + 1).toString('utf8') : '', truncated: true }
}

/** Un archivo sin seguimiento como `DiffFile` añadido (un solo hunk) o binario sin hunks. */
export function untrackedAsDiff(path: string, content: Buffer): DiffFile {
  if (content.subarray(0, 8000).includes(0)) return { path, status: 'A', additions: 0, deletions: 0, binary: true, hunks: [] }
  if (content.length === 0) return { path, status: 'A', additions: 0, deletions: 0, binary: false, hunks: [] }
  const text = content.toString('utf8')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return {
    path,
    status: 'A',
    additions: lines.length,
    deletions: 0,
    binary: false,
    hunks: [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.map((t, i) => ({ kind: 'add', old: null, new: i + 1, text: t })) }]
  }
}

/**
 * Revisión de un worktree (ARCHITECTURE §3.16): diff contra la base, squash-merge en el local y
 * descarte. No conoce IPC ni a `WorktreeService`: recibe el borrado por opciones.
 */
export class GitService {
  private readonly registry: ReviewRegistry
  private readonly removeWorktree: (workspaceId: string) => Promise<void>
  private readonly exec: Exec
  private readonly hosts: GitHosts | undefined

  constructor(opts: GitServiceOptions) {
    this.registry = opts.registry
    this.removeWorktree = opts.removeWorktree
    this.exec = opts.exec ?? defaultExec
    this.hosts = opts.hosts
  }

  /** El worktree vive en el host de su repo: su git corre ahí (§3.26). */
  private async placeOf(worktree: Worktree): Promise<GitPlace> {
    const host = this.registry.location(worktree.locationId)?.host
    if (!host) return { exec: this.exec, remote: false }
    if (!this.hosts) throw new Error('el worktree está en un servidor sin conexión configurada')
    return { exec: (await this.hosts.ensure(host)).exec, remote: true }
  }

  /**
   * Commits + árbol de trabajo del worktree, más los archivos sin seguimiento como añadidos. Sin `base`,
   * frente al merge-base con la base del worktree (lo que avanzó la base no se arrastra). Con `base`
   * explícita (la rama de otro candidato de broadcast), diff directo contra esa ref: lo que este
   * worktree tiene distinto del otro.
   */
  async diff(workspaceId: string, base?: string): Promise<WorkspaceDiff> {
    const worktree = this.need(workspaceId)
    const at = await this.placeOf(worktree)
    const exec = at.exec
    const explicit = base?.trim() || null
    const against = explicit ?? worktree.base
    assertRefName(against)
    if (explicit && !(await this.refExists(exec, worktree.path, explicit))) throw new Error(`no existe la rama ${explicit}`)
    const from = explicit ?? (await this.mergeBase(exec, worktree, against))
    const raw = await this.git(exec, worktree.path, ['diff', '--no-color', '-U3', '-M', from])
    const cut = truncateDiff(raw)
    const files = parseUnifiedDiff(cut.text)
    let truncated = cut.truncated
    let budget = DIFF_MAX_BYTES - Buffer.byteLength(cut.text)
    for (const rel of await this.untracked(exec, worktree.path)) {
      if (budget <= 0) {
        truncated = true
        break
      }
      const head = at.remote ? await readRemoteHead(exec, posix.join(worktree.path, rel)) : await readHead(join(worktree.path, rel))
      if (head.truncated) truncated = true
      budget -= head.content.length
      files.push(untrackedAsDiff(rel, head.content))
    }
    return { base: against, branch: worktree.branch, files, truncated }
  }

  /**
   * Squash-merge del worktree en el local: exige el local limpio (sin contar untracked) y en una rama
   * real que sea la base (o que siga a la base, si es remota); en el worktree commitea lo pendiente
   * como `wip (omni)`; conflicto o commit fallido → se deshace y se explica. Éxito → devuelve el
   * commit; borrar el worktree es cosa de quien llama (primero mata sus sesiones).
   */
  async merge(workspaceId: string): Promise<{ commit: string }> {
    const worktree = this.need(workspaceId)
    // Repo y worktree están en el mismo host: todo el merge corre ahí.
    const { exec } = await this.placeOf(worktree)
    const project = this.registry.project(worktree.projectId)
    if (!project) throw new Error(`proyecto desconocido: ${worktree.projectId}`)
    // El merge vuelve a la ubicación (repo) de la que salió el worktree.
    const local = this.registry.location(worktree.locationId)?.path ?? project.locations[0]?.path
    if (!local) throw new Error(`${project.name} no tiene carpetas`)
    const dirty = (await this.git(exec, local, ['status', '--porcelain', '--untracked-files=no']))
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.slice(3))
    if (dirty.length > 0) throw new Error(`el repo tiene cambios sin commit: ${dirty.join(', ')}`)
    await this.assertOnBase(exec, local, worktree.base)
    if ((await this.git(exec, worktree.path, ['status', '--porcelain'])).trim() !== '') {
      await this.git(exec, worktree.path, ['add', '-A'])
      await this.git(exec, worktree.path, ['commit', '-q', '-m', 'wip (omni)'])
    }
    const squash = await exec('git', ['merge', '--squash', worktree.branch], { cwd: local, timeoutMs: REVIEW_TIMEOUT_MS })
    if (squash.code !== 0) {
      const conflicts = (await this.git(exec, local, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter((f) => f !== '')
      await exec('git', ['merge', '--abort'], { cwd: local, timeoutMs: REVIEW_TIMEOUT_MS })
      // `--squash` no deja MERGE_HEAD, así que `merge --abort` no siempre aplica: `reset --merge` sí deja el árbol como estaba.
      await exec('git', ['reset', '--merge'], { cwd: local, timeoutMs: REVIEW_TIMEOUT_MS })
      if (conflicts.length > 0) throw new Error(`conflicto en ${conflicts.join(', ')}`)
      throw failure('no se pudo mergear', squash)
    }
    const staged = await exec('git', ['diff', '--cached', '--quiet'], { cwd: local, timeoutMs: REVIEW_TIMEOUT_MS })
    if (staged.code === 0) throw new Error(`el worktree no tiene cambios respecto a ${worktree.base}`)
    const committed = await exec('git', ['commit', '-q', '-m', `${worktree.name} (omni)`], { cwd: local, timeoutMs: REVIEW_TIMEOUT_MS })
    if (committed.code !== 0) {
      // Un hook o una identidad ausente: el índice vuelve a como estaba, nada queda a medias.
      await exec('git', ['reset', '--merge'], { cwd: local, timeoutMs: REVIEW_TIMEOUT_MS })
      throw failure('commit falló', committed)
    }
    const commit = (await this.git(exec, local, ['rev-parse', 'HEAD'])).trim()
    return { commit }
  }

  /**
   * HEAD tiene que ser una rama real: la base misma si existe como rama local, o una que siga a la
   * base si esta es remota (`origin/main`). Así el squash nunca cae en una rama equivocada.
   */
  private async assertOnBase(exec: Exec, local: string, base: string): Promise<void> {
    const head = await exec('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: local, timeoutMs: REVIEW_TIMEOUT_MS })
    const branch = head.stdout.trim()
    if (head.code !== 0 || branch === '') throw new Error('el repo está en HEAD suelto')
    if (await this.refExists(exec, local, `refs/heads/${base}`)) {
      if (branch !== base) throw new Error(`el repo está en ${branch}, no en ${base}`)
      return
    }
    const upstream = await exec('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: local, timeoutMs: REVIEW_TIMEOUT_MS })
    const tracking = upstream.code === 0 ? upstream.stdout.trim() : ''
    if (tracking !== base) throw new Error(`el repo está en ${branch}, que no sigue a ${base}`)
  }

  /**
   * Contenido del archivo en la base del workspace (ARCHITECTURE §3.19): `HEAD` para el workspace
   * local, el merge-base con la base para un worktree. `null` si el archivo no existe en la base
   * (es nuevo). Error humano si el workspace no es un repo o la ruta está fuera.
   */
  async fileAtBase(workspaceId: string, path: string): Promise<string | null> {
    const worktree = this.registry.worktree(workspaceId)
    // Cualquier ubicación del proyecto (la principal o una subcarpeta) es un workspace con su ruta.
    const location = worktree ? undefined : this.registry.location(workspaceId)
    const root = worktree?.path ?? location?.path
    if (root === undefined) throw new Error(`workspace desconocido: ${workspaceId}`)
    // Ubicación remota (§3.26): ruta POSIX del host, comprobada sin `realpath` local, y git por su `exec`.
    if (location?.host) return this.remoteFileAtBase(location.host, root, path)
    if (worktree && this.registry.location(worktree.locationId)?.host) {
      // Worktree en un servidor: la base es su merge-base, calculada allá.
      const { exec } = await this.placeOf(worktree)
      const rel = relativeInsidePosix(root, path)
      if (rel === null) throw new Error(`${path} está fuera del workspace`)
      const ref = await this.mergeBase(exec, worktree)
      const r = await exec('git', ['show', `${ref}:./${rel}`], { cwd: root, timeoutMs: REVIEW_TIMEOUT_MS })
      if (r.code === 0) return r.stdout
      if (isMissingInRef(r.stderr)) return null
      throw failure('no se pudo leer el archivo en la base', r)
    }
    const rel = relativeInside(root, path)
    if (rel === null) throw new Error(`${path} está fuera del workspace`)
    const ref = worktree ? await this.mergeBase(this.exec, worktree) : 'HEAD'
    // `ref:./ruta` es relativa al cwd: vale aunque el workspace sea una subcarpeta del repo.
    const r = await this.exec('git', ['show', `${ref}:./${rel}`], { cwd: root, timeoutMs: REVIEW_TIMEOUT_MS })
    if (r.code === 0) return r.stdout
    if (isMissingInRef(r.stderr)) return null
    if (/not a git repository/i.test(r.stderr)) throw new Error(`${root} no es un repo git`)
    throw failure('no se pudo leer el archivo en la base', r)
  }

  private async remoteFileAtBase(hostId: string, root: string, path: string): Promise<string | null> {
    const rel = relativeInsidePosix(root, path)
    if (rel === null) throw new Error(`${path} está fuera del workspace`)
    if (!this.hosts) throw new Error(`${root} está en un host remoto sin conexión configurada`)
    const { exec } = await this.hosts.ensure(hostId)
    const r = await exec('git', ['-C', root, 'show', `HEAD:./${rel}`], { cwd: '/', timeoutMs: REVIEW_TIMEOUT_MS })
    if (r.code === 0) return r.stdout
    if (isMissingInRef(r.stderr)) return null
    if (/not a git repository/i.test(r.stderr)) throw new Error(`${root} no es un repo git`)
    throw failure('no se pudo leer el archivo en la base', r)
  }

  /** Descartar = borrar el worktree con todo lo que tenga. */
  async discard(workspaceId: string): Promise<void> {
    this.need(workspaceId)
    await this.removeWorktree(workspaceId)
  }

  private need(workspaceId: string): Worktree {
    const worktree = this.registry.worktree(workspaceId)
    if (!worktree) throw new Error(`el workspace no es un worktree: ${workspaceId}`)
    return worktree
  }

  private async mergeBase(exec: Exec, worktree: Worktree, base = worktree.base): Promise<string> {
    assertRefName(base)
    const r = await exec('git', ['merge-base', base, 'HEAD'], { cwd: worktree.path, timeoutMs: REVIEW_TIMEOUT_MS })
    if (r.code !== 0) throw failure(`no se encuentra la base ${base}`, r)
    return r.stdout.trim()
  }

  private async refExists(exec: Exec, cwd: string, ref: string): Promise<boolean> {
    assertRefName(ref)
    const r = await exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, timeoutMs: REVIEW_TIMEOUT_MS })
    return r.code === 0
  }

  private async untracked(exec: Exec, cwd: string): Promise<string[]> {
    const out = await this.git(exec, cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
    return out.split('\0').filter((p) => p !== '')
  }

  private async git(exec: Exec, cwd: string, args: string[]): Promise<string> {
    const r = await exec('git', args, { cwd, timeoutMs: REVIEW_TIMEOUT_MS })
    if (r.code !== 0) throw failure(`git ${args[0]} falló`, r)
    return r.stdout
  }
}

/** Una ref que empieza por `-` la leería git como opción (`--output=…`): nunca se le pasa. */
export function assertRefName(ref: string): void {
  if (ref === '' || ref.startsWith('-')) throw new Error(`rama inválida: ${ref}`)
}

/** Primeros 512 KB de un archivo; vacío si no se puede leer. `truncated` si había más. */
async function readHead(path: string): Promise<{ content: Buffer; truncated: boolean }> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(path, 'r')
    const { size } = await handle.stat()
    const buf = Buffer.alloc(Math.min(size, UNTRACKED_MAX_BYTES))
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return { content: buf.subarray(0, bytesRead), truncated: size > UNTRACKED_MAX_BYTES }
  } catch {
    return { content: Buffer.alloc(0), truncated: false }
  } finally {
    await handle?.close()
  }
}

/** Como `readHead` pero de un archivo del host, con `head -c` (sin traerlo entero). */
async function readRemoteHead(exec: Exec, path: string): Promise<{ content: Buffer; truncated: boolean }> {
  try {
    const r = await exec('head', ['-c', String(UNTRACKED_MAX_BYTES + 1), '--', path], { cwd: '/', timeoutMs: REVIEW_TIMEOUT_MS })
    if (r.code !== 0) return { content: Buffer.alloc(0), truncated: false }
    const buf = Buffer.from(r.stdout, 'utf8')
    return { content: buf.subarray(0, UNTRACKED_MAX_BYTES), truncated: buf.length > UNTRACKED_MAX_BYTES }
  } catch {
    return { content: Buffer.alloc(0), truncated: false }
  }
}

/** Como `relativeInside` pero léxica y POSIX (rutas de un host remoto, sin `realpath` local); `null` si queda fuera o es la raíz. */
export function relativeInsidePosix(root: string, path: string): string | null {
  if (!root.startsWith('/') || !path.startsWith('/') || path.includes('\0')) return null
  const rel = posix.relative(posix.normalize(root), posix.normalize(path))
  if (rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) return null
  return rel
}

/** Ruta de `path` relativa a `root` con `/`, comparando rutas reales; `null` si no existe o queda fuera. */
function relativeInside(root: string, path: string): string | null {
  try {
    const rel = relative(realpathSync(root), realpathSync(path))
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return null
    return rel.split(sep).join('/')
  } catch {
    return null
  }
}
