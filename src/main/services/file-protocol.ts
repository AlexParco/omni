import { createReadStream, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, posix, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { HostFs } from '../hosts/types'

/** Esquema con el que el renderer lee archivos de un workspace (ARCHITECTURE §3.20). */
export const FILE_SCHEME = 'omni-file'

/** Tipos MIME por extensión. Lo que no esté aquí sale como binario genérico. */
const MIME: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8'
}

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

interface WorkspaceRef {
  id: string
  path: string
  /** Host remoto (§3.26); ausente = este Mac. */
  host?: string
}

/** Tope de lo que se trae de un host remoto para la vista previa (imágenes, PDF): viaja entero por ssh. */
export const REMOTE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024

/** `HostFs` del host remoto (conectando si hace falta) o rechazo si no se pudo. */
export type RemoteFsOf = (hostId: string) => Promise<HostFs>

export interface ResolvedFile {
  /** Ruta absoluta tal como se pide al sistema (dentro del workspace). */
  path: string
  mime: string
}

/**
 * Resuelve `omni-file://<workspaceId>/<ruta relativa>` a un archivo del workspace, o `null` (404)
 * si el workspace no existe, la ruta escapa (`..`, symlink hacia fuera), no existe o no es un
 * archivo. El host de un esquema estándar llega en minúsculas: se compara sin distinguir.
 * El renderer codifica la ruta segmento a segmento con `encodeURIComponent`, así un nombre con
 * `?`, `#`, `%` o espacios viaja como `%3F`, `%23`, `%25`, `%20` y aquí se decodifica entero;
 * la query (`?v=N` para romper la caché tras `file:changed`) y el fragmento no forman parte de
 * la ruta: solo cuenta `pathname`.
 */
export function resolveWorkspaceFile(workspaces: readonly WorkspaceRef[], url: string): ResolvedFile | null {
  const req = parseFileUrl(workspaces, url)
  // Un workspace remoto nunca se resuelve contra el disco de este Mac (la misma ruta podría existir aquí).
  if (!req || req.workspace.host) return null
  const { workspace, rel } = req
  // Se normaliza sobre la raíz y se vuelve a comprobar: `..` que suba por encima queda fuera.
  const target = normalize(join(workspace.path, rel))
  if (!insideByRealpath(workspace.path, target)) return null
  try {
    if (!statSync(target).isFile()) return null
  } catch {
    return null
  }
  return { path: target, mime: mimeOf(target) }
}

/** Workspace y ruta relativa decodificada de una URL `omni-file://`; `null` si no es válida. */
function parseFileUrl(workspaces: readonly WorkspaceRef[], url: string): { workspace: WorkspaceRef; rel: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${FILE_SCHEME}:`) return null
  const host = parsed.hostname.toLowerCase()
  const workspace = workspaces.find((w) => w.id.toLowerCase() === host)
  if (!workspace) return null
  let rel: string
  try {
    rel = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (rel.includes('\0')) return null
  return { workspace, rel }
}

/**
 * Como `resolveWorkspaceFile` para un workspace remoto: ruta POSIX normalizada dentro de la raíz
 * (la raíz misma no), que exista, sea archivo, no pase de `REMOTE_PREVIEW_MAX_BYTES` y cuya ruta real
 * siga dentro. Devuelve sus bytes; `null` → 404, `'too-large'` → 413.
 */
export async function readRemoteWorkspaceFile(fs: HostFs, root: string, rel: string): Promise<{ data: Buffer; mime: string } | 'too-large' | null> {
  const target = posix.normalize(posix.join(root, rel))
  const base = posix.normalize(root).replace(/\/+$/, '')
  if (!target.startsWith(`${base}/`)) return null
  try {
    const stat = await fs.stat(target)
    if (!stat || stat.dir) return null
    if (stat.size > REMOTE_PREVIEW_MAX_BYTES) return 'too-large'
    const [realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(target)])
    if (!real.startsWith(`${realRoot.replace(/\/+$/, '')}/`)) return null
    return { data: await fs.readFile(target), mime: mimeOf(target) }
  } catch {
    return null
  }
}

/** `target` existe y su ruta real cuelga de la ruta real de `root` (la raíz misma no vale). */
function insideByRealpath(root: string, target: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(target))
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)
  } catch {
    return false
  }
}

/**
 * Handler para `protocol.handle(FILE_SCHEME, …)`: busca el workspace en cada petición (el catálogo
 * cambia en caliente) y sirve el archivo en streaming con su MIME; 404 si no se resuelve.
 */
export function createFileProtocolHandler(workspaces: () => readonly WorkspaceRef[]): (request: Request) => Response
export function createFileProtocolHandler(workspaces: () => readonly WorkspaceRef[], remoteFs: RemoteFsOf): (request: Request) => Response | Promise<Response>
export function createFileProtocolHandler(workspaces: () => readonly WorkspaceRef[], remoteFs?: RemoteFsOf): (request: Request) => Response | Promise<Response> {
  const notFound = (): Response => new Response('no encontrado', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  return (request) => {
    const req = parseFileUrl(workspaces(), request.url)
    const hostId = req?.workspace.host
    if (req && hostId) {
      // Remoto (§3.26): se trae entero por ssh (con tope) y se sirve desde memoria.
      if (!remoteFs) return notFound()
      return remoteFs(hostId)
        .then((fs) => readRemoteWorkspaceFile(fs, req.workspace.path, req.rel))
        .catch(() => null)
        .then((file) => {
          if (file === 'too-large') return new Response('demasiado grande para la vista previa remota', { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8' } })
          if (!file) return notFound()
          return new Response(new Uint8Array(file.data), { status: 200, headers: { 'content-type': file.mime } })
        })
    }
    const file = resolveWorkspaceFile(workspaces(), request.url)
    if (!file) return notFound()
    const body = Readable.toWeb(createReadStream(file.path)) as ReadableStream
    return new Response(body, { status: 200, headers: { 'content-type': file.mime } })
  }
}
