import { constants as fsConstants, promises as fs, type FSWatcher, mkdirSync, realpathSync, statSync, watch as fsWatch, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { MAX_TEXT_BYTES, type FileHit, type TreeEntry } from '@shared/types'
import type { Host } from '../hosts/types'
import { listRemoteFiles } from './remote-files'

export { MAX_TEXT_BYTES }

/** Carpetas y nombres que nunca entran al índice, tengan o no `.gitignore`. */
const ALWAYS_IGNORED = new Set(['.git', 'node_modules', 'out', 'dist', 'build', '.next', 'target', 'coverage', '.cache', '.DS_Store'])

/** Tope de entradas por workspace: un monorepo gigante no debe tumbar main. */
export const MAX_ENTRIES = 20_000

/** Tras este tiempo, la siguiente consulta vuelve a recorrer el workspace. */
export const REFRESH_MS = 30_000

/** Regla simple de `.gitignore`: solo las formas que el índice entiende (ARCHITECTURE §3.11). */
export type IgnoreRule = { kind: 'dir'; name: string } | { kind: 'ext'; ext: string } | { kind: 'name'; name: string }

/**
 * Parser mínimo del `.gitignore` raíz: `dir/` (solo carpetas), `*.ext` (por extensión) y nombres
 * sin `/` (cualquier entrada). Negaciones (`!`), comentarios, rutas con `/` en medio y comodines
 * complejos se ignoran: mejor indexar de más que inventar una semántica a medias. Un `/` inicial
 * se descarta (`/dist/` cuenta como `dist/`, aunque git lo anclaría a la raíz).
 */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue
    if (line.startsWith('/')) line = line.slice(1)
    const isDir = line.endsWith('/')
    if (isDir) line = line.slice(0, -1)
    if (line === '' || line.includes('/')) continue
    if (line.startsWith('*.')) {
      const ext = line.slice(2)
      if (ext !== '' && !/[*?[\]]/.test(ext)) rules.push({ kind: 'ext', ext: ext.toLowerCase() })
      continue
    }
    if (/[*?[\]]/.test(line)) continue
    rules.push(isDir ? { kind: 'dir', name: line } : { kind: 'name', name: line })
  }
  return rules
}

/** `true` si una entrada (por nombre) queda fuera del índice. */
export function isIgnored(name: string, isDir: boolean, rules: readonly IgnoreRule[]): boolean {
  if (ALWAYS_IGNORED.has(name)) return true
  const lower = name.toLowerCase()
  for (const rule of rules) {
    if (rule.kind === 'dir' && isDir && rule.name === name) return true
    if (rule.kind === 'name' && rule.name === name) return true
    if (rule.kind === 'ext' && lower.endsWith(`.${rule.ext}`) && lower.length > rule.ext.length + 1) return true
  }
  return false
}

/** Pesos de la puntuación: públicos solo para que los tests no repitan números mágicos. */
export const SCORE = { char: 1, segmentStart: 8, inName: 4, consecutive: 5 } as const

/** Subsecuencia voraz de `query` sobre `rel` a partir de `from`; `null` si no cabe. */
function greedy(query: string, rel: string, from: number, nameStart: number): number | null {
  let score = 0
  let qi = 0
  let last = -2
  for (let i = from; i < rel.length && qi < query.length; i++) {
    if (rel[i] !== query[qi]) continue
    score += SCORE.char
    if (i === 0 || rel[i - 1] === '/') score += SCORE.segmentStart
    if (i >= nameStart) score += SCORE.inName
    if (i === last + 1) score += SCORE.consecutive
    last = i
    qi++
  }
  return qi === query.length ? score : null
}

/**
 * Puntúa `query` como subsecuencia de la ruta relativa (sin distinguir mayúsculas). Suma por cada
 * carácter, más por caer al inicio de un segmento, dentro del nombre de archivo o seguido del
 * anterior. Se prueba también anclado al nombre de archivo para que `index` prefiera `src/index.ts`
 * a `src/i/n/d/e/x`. `null` si no es subsecuencia; consulta vacía → `null`.
 */
export function scoreMatch(query: string, rel: string): number | null {
  const q = query.toLowerCase()
  if (q === '') return null
  const r = rel.toLowerCase()
  const nameStart = r.lastIndexOf('/') + 1
  const whole = greedy(q, r, 0, nameStart)
  const named = nameStart > 0 ? greedy(q, r, nameStart, nameStart) : null
  if (whole === null) return named
  return named === null ? whole : Math.max(whole, named)
}

/** Ordena mejor puntuación primero y, a igual puntuación, ruta más corta y luego alfabética. */
export function compareHits(a: { score: number; rel: string }, b: { score: number; rel: string }): number {
  return b.score - a.score || a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)
}

/** Ruta real (symlinks resueltos) o `null` si no existe o no se puede resolver. */
function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * `true` si `path` es una de las raíces o está dentro de alguna, comparando rutas reales: un
 * symlink dentro del workspace que apunte fuera no pasa. Si algo no existe o no se puede resolver,
 * se rechaza.
 */
export function isInside(path: string, roots: readonly string[]): boolean {
  // Una ruta relativa se resolvería contra el cwd de main: nunca es una ruta de workspace.
  if (!isAbsolute(path)) return false
  const target = realpathOrNull(path)
  if (target === null) return false
  return roots.some((root) => {
    const base = realpathOrNull(root)
    if (base === null) return false
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
  })
}

/** Recorre `root` y devuelve las rutas relativas (con `/`) de los archivos, hasta `max`. */
export async function walkWorkspace(root: string, max = MAX_ENTRIES): Promise<string[]> {
  let rules: IgnoreRule[] = []
  try {
    rules = parseGitignore(await fs.readFile(join(root, '.gitignore'), 'utf8'))
  } catch {
    // Sin .gitignore (o ilegible): solo aplica la lista fija.
  }
  const files: string[] = []
  // Pila iterativa en vez de recursión: en repos profundos ahorra stack y permite cortar en el tope.
  const pending: string[] = ['']
  while (pending.length > 0 && files.length < max) {
    const rel = pending.pop() as string
    let dir: Awaited<ReturnType<typeof fs.opendir>>
    try {
      dir = await fs.opendir(rel === '' ? root : join(root, rel))
    } catch {
      continue
    }
    const subdirs: string[] = []
    try {
      for await (const entry of dir) {
        if (entry.isSymbolicLink()) continue
        const isDir = entry.isDirectory()
        if (!isDir && !entry.isFile()) continue
        if (isIgnored(entry.name, isDir, rules)) continue
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (isDir) subdirs.push(childRel)
        else {
          files.push(childRel)
          if (files.length >= max) break
        }
      }
    } catch {
      // Carpeta que desaparece a medio recorrido: se sigue con lo que hay.
    }
    // Se apilan al revés para recorrer en orden alfabético estable.
    for (let i = subdirs.length - 1; i >= 0; i--) pending.push(subdirs[i])
  }
  return files
}

interface WorkspaceRef {
  id: string
  path: string
  /** Host remoto (§3.26); ausente = este Mac. */
  host?: string
}

/** Lo que el índice necesita de `HostRegistry`: el host si ya está conectado (tira si no; el índice nunca conecta). */
export interface IndexHosts {
  connected(hostId: string): Pick<Host, 'exec'>
}

/** Lo más que una búsqueda espera el primer listado de un host remoto; pasado esto responde sin él. */
export const REMOTE_FIRST_SCAN_WAIT_MS = 1_500

interface WorkspaceIndex {
  files: string[]
  scannedAt: number
  /** Recorrido en curso, para no lanzar dos a la vez sobre el mismo workspace. */
  scanning: Promise<string[]> | null
}

export interface FileIndexOptions {
  /** Workspaces vivos (`ProjectStore.workspaces()`); se cablea en `main/index.ts`. */
  workspaces: () => WorkspaceRef[]
  /** Hosts remotos; sin esto los workspaces remotos no entran al índice. */
  hosts?: IndexHosts
  now?: () => number
  maxEntries?: number
  refreshMs?: number
  remoteWaitMs?: number
}

/**
 * Índice de archivos para el quick open (ARCHITECTURE §3.11). Por workspace, recorrido perezoso al
 * primer uso; si al consultar han pasado más de `refreshMs` desde el último, se vuelve a recorrer
 * en segundo plano y se responde con lo que había. Nunca lee contenido.
 */
export class FileIndex {
  private readonly indexes = new Map<string, WorkspaceIndex>()
  private readonly workspaces: () => WorkspaceRef[]
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly refreshMs: number
  private readonly hosts: IndexHosts | undefined
  private readonly remoteWaitMs: number

  constructor(options: FileIndexOptions) {
    this.workspaces = options.workspaces
    this.now = options.now ?? Date.now
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES
    this.refreshMs = options.refreshMs ?? REFRESH_MS
    this.hosts = options.hosts
    this.remoteWaitMs = options.remoteWaitMs ?? REMOTE_FIRST_SCAN_WAIT_MS
  }

  async search(query: string, limit = 20): Promise<FileHit[]> {
    if (query.trim() === '' || limit <= 0) return []
    const live = this.workspaces()
    this.forget(live)
    const scored: { score: number; rel: string; hit: FileHit }[] = []
    // En paralelo: un host remoto lento no retrasa el recorrido de los locales.
    const lists = await Promise.all(live.map((ws) => (ws.host ? this.remoteFilesOf(ws, ws.host) : this.filesOf(ws))))
    live.forEach((ws, i) => {
      // Rutas remotas son POSIX del host: `join` de node también usa `/` en macOS.
      for (const rel of lists[i]) {
        const score = scoreMatch(query, rel)
        if (score === null) continue
        scored.push({ score, rel, hit: { workspaceId: ws.id, path: join(ws.path, rel), rel } })
      }
    })
    return scored.sort(compareHits).slice(0, limit).map((s) => s.hit)
  }

  /** Fuerza el recorrido de un workspace y espera a que termine (tests y refrescos explícitos). */
  async refresh(workspaceId: string): Promise<void> {
    const ws = this.workspaces().find((w) => w.id === workspaceId)
    if (!ws) return
    if (!ws.host) {
      await this.scan(ws)
      return
    }
    if (!this.hosts) return
    const host = this.hosts.connected(ws.host)
    await this.scan(ws, () => listRemoteFiles(host, ws.path, this.maxEntries))
  }

  /** Lista de rutas relativas del workspace: recorre si no hay índice; refresca en segundo plano si caducó. */
  private async filesOf(ws: WorkspaceRef): Promise<string[]> {
    const index = this.indexes.get(ws.id)
    if (!index) return this.scan(ws)
    if (this.now() - index.scannedAt > this.refreshMs && !index.scanning) void this.scan(ws).catch(() => undefined)
    return index.files
  }

  /**
   * Como `filesOf` para un workspace remoto, pero sin bloquear: solo si su host está conectado (nunca
   * conecta); el primer listado se espera como mucho `remoteWaitMs` y, si no llega, se responde con lo
   * que haya (vacío) y el resultado queda para la próxima consulta. Un fallo deja la lista anterior.
   */
  private async remoteFilesOf(ws: WorkspaceRef, hostId: string): Promise<string[]> {
    const index = this.indexes.get(ws.id)
    let host: Pick<Host, 'exec'>
    try {
      if (!this.hosts) return []
      host = this.hosts.connected(hostId)
    } catch {
      return index?.files ?? []
    }
    if (index && (index.scanning || this.now() - index.scannedAt <= this.refreshMs)) return index.files
    const scanning = this.scan(ws, () => listRemoteFiles(host, ws.path, this.maxEntries)).catch(() => index?.files ?? [])
    if (index) return index.files
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(null), this.remoteWaitMs)
    })
    const first = await Promise.race([scanning, late])
    clearTimeout(timer)
    return first ?? []
  }

  private scan(ws: WorkspaceRef, list: () => Promise<string[]> = () => walkWorkspace(ws.path, this.maxEntries)): Promise<string[]> {
    const existing = this.indexes.get(ws.id)
    if (existing?.scanning) return existing.scanning
    const index: WorkspaceIndex = existing ?? { files: [], scannedAt: 0, scanning: null }
    this.indexes.set(ws.id, index)
    index.scanning = list()
      .then((files) => {
        index.files = files
        index.scannedAt = this.now()
        return files
      })
      .catch((err: unknown) => {
        // Listado remoto fallido: no se reintenta en cada tecla, sino al caducar como siempre.
        index.scannedAt = this.now()
        throw err
      })
      .finally(() => {
        index.scanning = null
      })
    return index.scanning
  }

  /** Suelta los índices de workspaces que ya no existen. */
  private forget(live: WorkspaceRef[]): void {
    const ids = new Set(live.map((w) => w.id))
    for (const id of this.indexes.keys()) if (!ids.has(id)) this.indexes.delete(id)
  }
}

/* ---------- editor: lectura, escritura, árbol y vigilancia (ARCHITECTURE §3.19) ---------- */

/** Bytes del inicio donde se busca un NUL para dar el archivo por binario. */
const BINARY_PROBE_BYTES = 8 * 1024

/** Tope de entradas de una carpeta en el árbol del editor; pasado esto se corta y se avisa con `truncated`. */
export const TREE_MAX_ENTRIES = 2_000

/**
 * `true` si `path` puede escribirse dentro de alguna raíz: si existe, por su ruta real (un symlink
 * que apunte fuera no pasa); si no existe aún, por la ruta real de su carpeta.
 */
export function isInsideForWrite(path: string, roots: readonly string[]): boolean {
  if (realpathOrNull(path) !== null) return isInside(path, roots)
  return isInside(dirname(path), roots)
}

/**
 * Lee un archivo de texto UTF-8 con su mtime. Error humano si pesa más de `MAX_TEXT_BYTES` o si
 * parece binario (un NUL en los primeros 8 KB).
 */
export async function readTextFile(path: string): Promise<{ text: string; mtime: number }> {
  const stat = await fs.stat(path)
  if (!stat.isFile()) throw new Error(`${basename(path)} no es un archivo`)
  if (stat.size > MAX_TEXT_BYTES) throw new Error(`${basename(path)} pesa más de 2 MB`)
  const content = await fs.readFile(path)
  if (content.subarray(0, BINARY_PROBE_BYTES).includes(0)) throw new Error(`${basename(path)} es un archivo binario`)
  return { text: content.toString('utf8'), mtime: stat.mtimeMs }
}

/**
 * Escribe el texto de forma atómica: archivo temporal en la misma carpeta y `rename` encima.
 * Si `path` es un symlink se escribe sobre su destino real (un rename sobre el enlace lo
 * reemplazaría por un archivo normal). Si el archivo existía, conserva sus permisos. Error humano
 * si es una carpeta o no hay permiso de escritura (sobre el archivo, o sobre la carpeta si es nuevo).
 * Devuelve el mtime resultante.
 */
export async function writeTextFile(requested: string, text: string): Promise<{ mtime: number }> {
  const path = await writeTarget(requested)
  const dir = dirname(path)
  const tmp = join(dir, `.${basename(path)}.omni-${process.pid}-${Date.now()}.tmp`)
  let mode: number | undefined
  try {
    const stat = await fs.stat(path)
    if (stat.isDirectory()) throw new Error(`${basename(requested)} es una carpeta`)
    if (!stat.isFile()) throw new Error(`${basename(requested)} no es un archivo`)
    mode = stat.mode
  } catch (err) {
    if (!isNoEntry(err)) throw err
    // Archivo nuevo: permisos por defecto.
  }
  await assertWritable(mode === undefined ? dir : path, basename(requested))
  try {
    await fs.writeFile(tmp, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
    if (mode !== undefined) await fs.chmod(tmp, mode)
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  return { mtime: (await fs.stat(path)).mtimeMs }
}

/** Ruta real si `path` es un symlink (se escribe sobre el destino); la misma si no existe o es un archivo normal. */
async function writeTarget(path: string): Promise<string> {
  try {
    if (!(await fs.lstat(path)).isSymbolicLink()) return path
  } catch {
    return path
  }
  try {
    return await fs.realpath(path)
  } catch {
    throw new Error(`${basename(path)} es un enlace roto`)
  }
}

/** `fs.access(W_OK)` con mensaje humano. */
async function assertWritable(path: string, name: string): Promise<void> {
  try {
    await fs.access(path, fsConstants.W_OK)
  } catch {
    throw new Error(`sin permiso de escritura en ${name}`)
  }
}

function isNoEntry(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

/** Orden natural (`a2` antes que `a10`), sin distinguir mayúsculas. */
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Carpetas primero; dentro de cada grupo, orden natural por nombre. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1
  return naturalCollator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/** Reglas del `.gitignore` raíz del workspace; vacías si no hay o no se puede leer. */
async function workspaceRules(workspacePath: string): Promise<IgnoreRule[]> {
  try {
    return parseGitignore(await fs.readFile(join(workspacePath, '.gitignore'), 'utf8'))
  } catch {
    return []
  }
}

/**
 * Entradas de `dir` para el árbol del editor: sin ocultos (nombre con `.` inicial) ni lo que el
 * índice ignora (lista fija y `.gitignore` raíz del workspace), carpetas primero y orden natural.
 * Se corta en `max` entradas (`truncated`), ordenando lo que cupo. `dir` debe ser absoluta y
 * estar (por ruta real) dentro del workspace; los symlinks se siguen solo si apuntan dentro.
 * Error humano si está fuera o no existe.
 */
export async function listTree(workspacePath: string, dir: string, max = TREE_MAX_ENTRIES): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  if (!isAbsolute(dir)) throw new Error(`la ruta tiene que ser absoluta: ${dir}`)
  if (!isInside(dir, [workspacePath])) throw new Error(`carpeta fuera del workspace: ${dir}`)
  const rules = await workspaceRules(workspacePath)
  const entries: TreeEntry[] = []
  let truncated = false
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    let isDir = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      if (!isInside(path, [workspacePath])) continue
      try {
        isDir = (await fs.stat(path)).isDirectory()
      } catch {
        continue
      }
    } else if (!isDir && !entry.isFile()) continue
    if (isIgnored(entry.name, isDir, rules)) continue
    if (entries.length >= max) {
      truncated = true
      break
    }
    entries.push({ name: entry.name, path, dir: isDir })
  }
  return { entries: entries.sort(compareTreeEntries), truncated }
}

/**
 * Quién pidió vigilar qué (`file:watch` por webContents): si un renderer recarga o muere, sus
 * referencias se sueltan de golpe y el `FileWatcher` no se queda con contadores inflados.
 */
export class WatchLedger {
  private readonly bySender = new Map<number, Map<string, number>>()

  add(sender: number, path: string): void {
    const paths = this.bySender.get(sender) ?? new Map<string, number>()
    paths.set(path, (paths.get(path) ?? 0) + 1)
    this.bySender.set(sender, paths)
  }

  /** `true` si ese remitente tenía una referencia a la ruta (y se descuenta); `false` si no, para no soltar la de otro. */
  remove(sender: number, path: string): boolean {
    const paths = this.bySender.get(sender)
    const count = paths?.get(path) ?? 0
    if (!paths || count === 0) return false
    if (count === 1) paths.delete(path)
    else paths.set(path, count - 1)
    if (paths.size === 0) this.bySender.delete(sender)
    return true
  }

  /** Suelta todo lo del remitente: cada ruta tantas veces como referencias tenía. */
  drop(sender: number): string[] {
    const paths = this.bySender.get(sender)
    this.bySender.delete(sender)
    if (!paths) return []
    const out: string[] = []
    for (const [path, count] of paths) for (let i = 0; i < count; i++) out.push(path)
    return out
  }

  senders(): number[] {
    return [...this.bySender.keys()]
  }
}

/** Lo que `FileWatcher` necesita de `fs.watch`: inyectable en tests. */
export type WatchFn = (dir: string, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher

type ChangedListener = (path: string, mtime: number) => void

export interface FileWatcherOptions {
  watch?: WatchFn
  /** Espera tras el último evento antes de avisar: las escrituras suelen llegar a ráfagas. */
  debounceMs?: number
}

interface Watched {
  refs: number
  watcher: FSWatcher
  timer: ReturnType<typeof setTimeout> | null
}

/** Espera tras el último evento de `fs.watch` antes de emitir `onChanged`. */
export const WATCH_DEBOUNCE_MS = 150

/**
 * Vigila archivos por ruta para el editor (`file:watch` / `file:changed`). Se vigila la carpeta del
 * archivo filtrando por nombre: así se ven también las escrituras atómicas (tmp + rename), que
 * cambian el inodo y un watcher sobre el archivo perdería. Cada ruta lleva conteo de referencias:
 * dos panes sobre el mismo archivo comparten un watcher y el último en soltar lo cierra.
 */
export class FileWatcher {
  private readonly watched = new Map<string, Watched>()
  private readonly listeners = new Set<ChangedListener>()
  private readonly watchFn: WatchFn
  private readonly debounceMs: number

  constructor(opts: FileWatcherOptions = {}) {
    this.watchFn = opts.watch ?? ((dir, listener) => fsWatch(dir, { persistent: false }, listener))
    this.debounceMs = opts.debounceMs ?? WATCH_DEBOUNCE_MS
  }

  watch(path: string): void {
    const existing = this.watched.get(path)
    if (existing) {
      existing.refs++
      return
    }
    const name = basename(path)
    // Sin nombre en el evento (algunas plataformas no lo dan) se asume que fue este archivo.
    const watcher = this.watchFn(dirname(path), (_event, filename) => {
      if (filename === null || filename.toString() === name) this.schedule(path, entry)
    })
    const entry: Watched = { refs: 1, watcher, timer: null }
    watcher.on('error', () => this.drop(path, entry))
    this.watched.set(path, entry)
  }

  unwatch(path: string): void {
    const entry = this.watched.get(path)
    if (!entry) return
    entry.refs--
    if (entry.refs <= 0) this.drop(path, entry)
  }

  /** Rutas vigiladas ahora mismo (tests). */
  paths(): string[] {
    return [...this.watched.keys()]
  }

  onChanged(l: ChangedListener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  close(): void {
    for (const [path, entry] of [...this.watched]) this.drop(path, entry)
  }

  private schedule(path: string, entry: Watched): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (this.watched.get(path) !== entry) return
      this.listeners.forEach((l) => l(path, mtimeOf(path)))
    }, this.debounceMs)
  }

  private drop(path: string, entry: Watched): void {
    if (this.watched.get(path) !== entry) return
    this.watched.delete(path)
    if (entry.timer) clearTimeout(entry.timer)
    entry.watcher.close()
  }
}

/** mtime en ms del archivo; `0` si ya no existe (borrado o a medio reemplazar). */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** Tope de lo que se acepta soltar sin ruta en disco: una captura o un PDF, no un video entero. */
export const MAX_DROP_BYTES = 50 * 1024 * 1024

/** Tope de lo soltado (local o subido a un servidor). */
export function checkDropSize(data: Uint8Array): void {
  if (data.byteLength > MAX_DROP_BYTES) throw new Error(`archivo demasiado grande (${Math.round(data.byteLength / 1024 / 1024)} MB)`)
}

/**
 * Nombre en disco de un archivo soltado: su base sin separadores ni controles, con la hora delante
 * para que dos capturas con el mismo nombre no choquen.
 */
export function dropName(name: string, now = Date.now()): string {
  // macOS nombra las capturas con un espacio angosto antes de AM/PM (U+202F): se normaliza a espacio común.
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\x00-\x1f]/g, '').replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ').trim().slice(0, 120) || 'archivo'
  return `${now}-${base}`
}

/**
 * Escribe en `dir` lo soltado sobre una terminal que no traía ruta propia y devuelve la ruta nueva.
 * El nombre se reduce a su base sin separadores ni controles; un prefijo con la hora evita choques.
 */
export function saveDropped(dir: string, name: string, data: Uint8Array, now = Date.now()): string {
  checkDropSize(data)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, dropName(name, now))
  writeFileSync(path, data, { mode: 0o600 })
  return path
}
