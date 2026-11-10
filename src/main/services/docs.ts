import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, posix, relative, sep } from 'node:path'
import { MAX_TEXT_BYTES, type DocKind, type SessionInfo, type Workspace } from '@shared/types'

type ExitListener = (id: string, code: number) => void

interface Live {
  info: SessionInfo
  /** Ruta absoluta del archivo, como se recibió (no la real): es lo que el renderer usa para leer y escribir. */
  path: string
  kind: DocKind
}

/**
 * Panes de documento (ARCHITECTURE §3.19, §3.20): editor y vista previa son sesiones sin proceso,
 * como los navegadores (§3.9). Main solo las registra para que sidebar, tabs, launcher y layout
 * las traten como cualquier sesión; el contenido lo lee y escribe el renderer por `file:*`.
 * Se persisten en `state.json` (`docs`) y se recrean al arrancar con el mismo id.
 */
export class DocService {
  private live = new Map<string, Live>()
  private exitListeners = new Set<ExitListener>()

  /**
   * Registra un documento del workspace. `opts.id` recrea uno guardado con su mismo id (el layout
   * guardado sigue válido). La ruta debe ser absoluta, ser un archivo y resolverse (symlinks
   * incluidos) dentro del workspace; para `editor` además no puede pasar de `MAX_TEXT_BYTES` (la
   * vista previa sí abre imágenes y PDF grandes).
   */
  open(workspace: Workspace, path: string, kind: DocKind, opts: { id?: string } = {}): SessionInfo {
    assertOpenable(workspace, path, kind)
    const id = opts.id && !this.live.has(opts.id) ? opts.id : randomUUID()
    const info: SessionInfo = { id, agent: kind, workspaceId: workspace.id, cwd: workspace.path, args: [path], createdAt: Date.now() }
    this.live.set(id, { info, path, kind })
    return info
  }

  list(): SessionInfo[] {
    return [...this.live.values()].map((l) => l.info)
  }

  has(id: string): boolean {
    return this.live.has(id)
  }

  /** Lo que va a `state.json`: id, workspace, ruta y tipo de cada documento vivo. */
  saved(): { id: string; workspaceId: string; path: string; kind: DocKind }[] {
    return [...this.live.values()].map((l) => ({ id: l.info.id, workspaceId: l.info.workspaceId, path: l.path, kind: l.kind }))
  }

  destroy(id: string): void {
    if (!this.live.delete(id)) return
    this.exitListeners.forEach((l) => l(id, 0))
  }

  killAll(): void {
    for (const id of [...this.live.keys()]) this.destroy(id)
  }

  onExit(l: ExitListener): () => void {
    this.exitListeners.add(l)
    return () => this.exitListeners.delete(l)
  }
}

/** Tira con mensaje humano si `path` es relativa, no existe, no es un archivo, está fuera del workspace (por ruta real) o pesa de más para el editor. */
function assertOpenable(workspace: Workspace, path: string, kind: DocKind): void {
  if (!isAbsolute(path)) throw new Error(`la ruta tiene que ser absoluta: ${path}`)
  // Remoto (§3.26): la ruta es del host, no de este Mac. Aquí solo la comprobación léxica; existencia,
  // tamaño y symlinks los valida la lectura (`file:read`, `omni-file://`) contra el host.
  if (workspace.host) {
    const rel = posix.relative(posix.normalize(workspace.path), posix.normalize(path))
    if (rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) throw new Error(`${path} está fuera del workspace ${workspace.name}`)
    return
  }
  let real: string
  let root: string
  try {
    real = realpathSync(path)
    root = realpathSync(workspace.path)
  } catch {
    throw new Error(`no existe el archivo ${path}`)
  }
  const rel = relative(root, real)
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep)) throw new Error(`${path} está fuera del workspace ${workspace.name}`)
  const stat = statSync(real)
  if (!stat.isFile()) throw new Error(`${basename(path)} no es un archivo`)
  if (kind === 'editor' && stat.size > MAX_TEXT_BYTES) throw new Error(`${basename(path)} pesa más de 2 MB: el editor no lo abre`)
}
