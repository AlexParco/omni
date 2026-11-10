import { posix } from 'node:path'
import { MAX_TEXT_BYTES, type TreeEntry } from '@shared/types'
import type { Host, HostFs } from '../hosts/types'
import { compareTreeEntries, isIgnored, MAX_ENTRIES, parseGitignore, TREE_MAX_ENTRIES, type IgnoreRule } from './files'

/**
 * Archivos de un workspace remoto (ARCHITECTURE §3.26): lo mismo que `files.ts` hace con `node:fs`,
 * pero por el `HostFs` del host. Mismas reglas (2 MB, binarios, dentro del workspace, árbol sin
 * ocultos ni ignorados) para que el renderer no distinga. Las rutas son POSIX del host.
 */

/** Bytes del inicio donde se busca un NUL para dar el archivo por binario (como en local). */
const BINARY_PROBE_BYTES = 8 * 1024

/** Cada cuánto se pregunta el mtime de un archivo remoto vigilado. */
export const REMOTE_POLL_MS = 2_000

/** Tope del listado remoto para el quick open (bytes de salida de `git ls-files`/`find`). */
const LIST_MAX_BYTES = 8 * 1024 * 1024

/** Tiempo máximo del listado remoto: un host lento no deja colgado el índice. */
const LIST_TIMEOUT_MS = 20_000

/** `true` si `path` (absoluta, POSIX) es `root` o cuelga de él, comparando la ruta normalizada (sin `..`). */
export function isInsidePosix(path: string, root: string): boolean {
  if (!path.startsWith('/') || !root.startsWith('/') || path.includes('\0')) return false
  const target = posix.normalize(path)
  const base = posix.normalize(root).replace(/\/+$/, '') || '/'
  if (base === '/') return true
  return target === base || target.startsWith(`${base}/`)
}

/** Lo que tiene que pasar una ruta remota del editor: absoluta, normalizada y dentro del workspace. */
function assertInside(root: string, path: string, what = 'ruta'): string {
  if (!path.startsWith('/')) throw new Error(`la ruta tiene que ser absoluta: ${path}`)
  if (!isInsidePosix(path, root)) throw new Error(`${what} fuera del workspace: ${path}`)
  return posix.normalize(path)
}

/** Ruta real dentro del workspace (un symlink que apunte fuera no pasa), como `isInside` en local. */
async function assertRealInside(fs: HostFs, root: string, path: string, what = 'ruta'): Promise<void> {
  const [realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(path)])
  if (!isInsidePosix(real, realRoot)) throw new Error(`${what} fuera del workspace: ${path}`)
}

/** `readTextFile` en un host remoto: mismo tope, misma detección de binarios, mtime del host. */
export async function readRemoteText(fs: HostFs, root: string, requested: string): Promise<{ text: string; mtime: number }> {
  const path = assertInside(root, requested)
  const name = posix.basename(path)
  const stat = await fs.stat(path)
  if (!stat) throw new Error(`${name} no existe`)
  if (stat.dir) throw new Error(`${name} no es un archivo`)
  if (stat.size > MAX_TEXT_BYTES) throw new Error(`${name} pesa más de 2 MB`)
  await assertRealInside(fs, root, path)
  const content = await fs.readFile(path)
  if (content.subarray(0, BINARY_PROBE_BYTES).includes(0)) throw new Error(`${name} es un archivo binario`)
  return { text: content.toString('utf8'), mtime: stat.mtime }
}

/**
 * `writeTextFile` en un host remoto: escritura atómica del host (tmp + rename, conserva permisos).
 * La ruta final se resuelve y valida aquí y es la que se escribe: un symlink a un archivo que existe
 * escribe en su destino real (si cae dentro del workspace); uno roto o un archivo nuevo se crea en la
 * carpeta real, reemplazando el symlink, nunca donde apunte (podría estar fuera). Devuelve el mtime nuevo.
 */
export async function writeRemoteText(fs: HostFs, root: string, requested: string, text: string): Promise<{ mtime: number }> {
  const path = assertInside(root, requested)
  const stat = await fs.stat(path)
  if (stat?.dir) throw new Error(`${posix.basename(path)} es una carpeta`)
  const [realRoot, target] = await Promise.all([
    fs.realpath(root),
    stat ? fs.realpath(path) : fs.realpath(posix.dirname(path)).then((dir) => posix.join(dir, posix.basename(path)))
  ])
  if (!isInsidePosix(target, realRoot)) throw new Error(`ruta fuera del workspace: ${path}`)
  return { mtime: await fs.writeFile(target, text) }
}

/** Reglas del `.gitignore` raíz del workspace remoto; vacías si no hay o no se puede leer. */
async function remoteRules(fs: HostFs, root: string): Promise<IgnoreRule[]> {
  try {
    return parseGitignore((await fs.readFile(posix.join(root, '.gitignore'))).toString('utf8'))
  } catch {
    return []
  }
}

/**
 * `listTree` en un host remoto: sin ocultos ni ignorados, carpetas primero, orden natural y corte en
 * `max`. La carpeta se valida por ruta normalizada (sin `realpath` por cada carpeta que se abre).
 */
export async function listRemoteTree(fs: HostFs, root: string, requested: string, max = TREE_MAX_ENTRIES): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const dir = assertInside(root, requested, 'carpeta')
  const [rules, dirents] = await Promise.all([remoteRules(fs, root), fs.readdir(dir)])
  const entries: TreeEntry[] = []
  let truncated = false
  for (const entry of dirents) {
    if (entry.name.startsWith('.')) continue
    if (isIgnored(entry.name, entry.dir, rules)) continue
    if (entries.length >= max) {
      truncated = true
      break
    }
    entries.push({ name: entry.name, path: dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`, dir: entry.dir })
  }
  return { entries: entries.sort(compareTreeEntries), truncated }
}

/**
 * Lista los archivos del workspace en el host: `git ls-files` (seguidos + sin seguimiento no
 * ignorados) si es un repo; si no, `find` saltando las carpetas de siempre. Todo en un solo ssh,
 * con la salida cortada en el host (`head -c`) para que un home entero no viaje.
 */
const LIST_SCRIPT = `cd -- "$1" 2>/dev/null || exit 3
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files -co --exclude-standard -z 2>/dev/null | head -c "$2"
else
  find . \\( -name .git -o -name node_modules -o -name out -o -name dist -o -name build -o -name .next -o -name target -o -name coverage -o -name .cache \\) -prune -o -type f -print0 2>/dev/null | head -c "$2"
fi`

/** Salida NUL-separada de `LIST_SCRIPT` → rutas relativas sin lo que el índice local salta. Pura. */
export function parseRemoteList(out: string, max = MAX_ENTRIES): string[] {
  const raw = out.split('\0')
  // Lo que queda tras el último NUL está vacío o es una ruta a medias (salida cortada por `head -c`): se descarta.
  raw.pop()
  const files: string[] = []
  for (const entry of raw) {
    const rel = entry.startsWith('./') ? entry.slice(2) : entry
    if (rel === '') continue
    const parts = rel.split('/')
    const name = parts.pop() as string
    if (parts.some((p) => isIgnored(p, true, [])) || isIgnored(name, false, [])) continue
    files.push(rel)
    if (files.length >= max) break
  }
  return files
}

/** Rutas relativas (con `/`) de los archivos de `root` en el host, hasta `max`. Rechaza si el host falla. */
export async function listRemoteFiles(host: Pick<Host, 'exec'>, root: string, max = MAX_ENTRIES): Promise<string[]> {
  const r = await host.exec('/bin/sh', ['-c', LIST_SCRIPT, 'omni', root, String(LIST_MAX_BYTES)], {
    cwd: '/',
    timeoutMs: LIST_TIMEOUT_MS,
    maxBuffer: LIST_MAX_BYTES + 1024 * 1024
  })
  if (r.code !== 0) throw new Error(r.code === 3 ? `no existe: ${root}` : `no se pudieron listar los archivos de ${root}`)
  return parseRemoteList(r.stdout, max)
}

/* ---------- vigilancia por sondeo ---------- */

type RemoteChanged = (workspaceId: string, path: string, mtime: number) => void

interface Polled {
  workspaceId: string
  path: string
  refs: number
  /** Último mtime visto (`0` = no existe); `null` hasta el primer sondeo. */
  mtime: number | null
  timer: ReturnType<typeof setTimeout> | null
  busy: boolean
}

export interface RemoteWatcherOptions {
  /** `HostFs` del workspace si su host está conectado; `null` si no (ese sondeo se salta, no conecta). */
  fsOf: (workspaceId: string) => HostFs | null
  intervalMs?: number
}

/**
 * Vigila archivos de workspaces remotos (`file:watch` cuando el workspace tiene host): no hay
 * `fs.watch` por ssh, así que se pregunta el mtime cada `intervalMs` mientras alguien lo vigile y se
 * avisa cuando cambia (o cuando el archivo desaparece: mtime `0`, como en local). El primer sondeo
 * solo toma la referencia. Conteo de referencias por (workspace, ruta), como `FileWatcher`.
 */
export class RemoteWatcher {
  private readonly watched = new Map<string, Polled>()
  private readonly listeners = new Set<RemoteChanged>()
  private readonly intervalMs: number

  constructor(private readonly opts: RemoteWatcherOptions) {
    this.intervalMs = opts.intervalMs ?? REMOTE_POLL_MS
  }

  static key(workspaceId: string, path: string): string {
    return `${workspaceId}\u0000${path}`
  }

  watch(workspaceId: string, path: string): void {
    const key = RemoteWatcher.key(workspaceId, path)
    const existing = this.watched.get(key)
    if (existing) {
      existing.refs++
      return
    }
    const entry: Polled = { workspaceId, path, refs: 1, mtime: null, timer: null, busy: false }
    this.watched.set(key, entry)
    void this.poll(key, entry)
  }

  /** `false` si no se vigilaba (para que quien llama sepa que era un archivo local). */
  unwatch(workspaceId: string, path: string): boolean {
    const key = RemoteWatcher.key(workspaceId, path)
    const entry = this.watched.get(key)
    if (!entry) return false
    entry.refs--
    if (entry.refs <= 0) this.drop(key, entry)
    return true
  }

  has(workspaceId: string, path: string): boolean {
    return this.watched.has(RemoteWatcher.key(workspaceId, path))
  }

  /** Claves vigiladas ahora mismo (tests). */
  keys(): string[] {
    return [...this.watched.keys()]
  }

  onChanged(l: RemoteChanged): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  close(): void {
    for (const [key, entry] of [...this.watched]) this.drop(key, entry)
  }

  private async poll(key: string, entry: Polled): Promise<void> {
    if (this.watched.get(key) !== entry || entry.busy) return
    entry.busy = true
    try {
      const fs = this.opts.fsOf(entry.workspaceId)
      if (fs) {
        const stat = await fs.stat(entry.path)
        const mtime = stat && !stat.dir ? stat.mtime : 0
        const before = entry.mtime
        entry.mtime = mtime
        if (before !== null && before !== mtime && this.watched.get(key) === entry) this.listeners.forEach((l) => l(entry.workspaceId, entry.path, mtime))
      }
    } catch {
      // Host caído o ssh lento: se reintenta en el próximo sondeo sin perder la referencia.
    } finally {
      entry.busy = false
    }
    if (this.watched.get(key) !== entry) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.poll(key, entry)
    }, this.intervalMs)
    entry.timer.unref?.()
  }

  private drop(key: string, entry: Polled): void {
    if (this.watched.get(key) !== entry) return
    this.watched.delete(key)
    if (entry.timer) clearTimeout(entry.timer)
  }
}
