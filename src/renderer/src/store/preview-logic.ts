/**
 * Lógica pura de la vista previa (ARCHITECTURE §3.20): qué tipo de archivo es una ruta, cómo se
 * resuelve un enlace relativo de un documento y cómo se traduce una ruta del workspace al protocolo
 * `omni-file://<workspaceId>/<ruta relativa>` que sirve main. Sin DOM ni IPC: se prueba en Node.
 */

export type PreviewKind = 'md' | 'image' | 'pdf' | 'other'

const MD = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'])

/** Pasos de zoom de una imagen (`+` y `-` saltan al siguiente; `0` vuelve a ajustar al pane). */
export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 8
export const ZOOM_FACTOR = 1.25

/** Extensión en minúsculas, sin el punto; `''` si no tiene. */
export function extOf(path: string): string {
  const name = baseName(path)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function baseName(path: string): string {
  const clean = path.replace(/\/+$/, '')
  return clean.slice(clean.lastIndexOf('/') + 1)
}

export function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/** Qué sabe pintar el pane con esa ruta. */
export function kindOf(path: string): PreviewKind {
  const ext = extOf(path)
  if (MD.has(ext)) return 'md'
  if (IMAGE.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  return 'other'
}

/** Normaliza `.` y `..` de una ruta absoluta (sin tocar disco). */
export function normalizePath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** `child` es `parent` o está dentro de él (por texto; main hace la comprobación real con realpath). */
export function isInside(parent: string, child: string): boolean {
  const p = normalizePath(parent)
  const c = normalizePath(child)
  return c === p || c.startsWith(p === '/' ? '/' : p + '/')
}

/**
 * Esquemas que DOMPurify deja en `href`/`src` del Markdown pintado: web (`http(s)`, `mailto`, `tel`),
 * el protocolo del workspace (`omni-file:`) y las rutas relativas o anclas (sin esquema). Todo lo demás
 * (`javascript:`, `data:`, `file:`, `vbscript:`…) se quita del atributo.
 */
export const ALLOWED_URI = /^(?:(?:https?|mailto|tel|omni-file):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i

/** `true` si DOMPurify dejaría ese `href`/`src` (misma regla que `ALLOWED_URI`). */
export function isAllowedUri(uri: string): boolean {
  return ALLOWED_URI.test(uri.trim())
}

/** Un enlace con esquema (`https:`, `mailto:`…) que no apunta a un archivo del workspace. */
export function isExternal(href: string): boolean {
  // Dos letras como mínimo: `C:/x` es una ruta, no un esquema.
  return /^[a-z][a-z0-9+.-]+:/i.test(href) && !href.startsWith('omni-file:')
}

/** Separa un href en ruta y fragmento (`#anchor`), sin query. */
export function splitHref(href: string): { path: string; hash: string } {
  const h = href.indexOf('#')
  const raw = h === -1 ? href : href.slice(0, h)
  const hash = h === -1 ? '' : href.slice(h + 1)
  const q = raw.indexOf('?')
  return { path: q === -1 ? raw : raw.slice(0, q), hash }
}

/**
 * Ruta absoluta a la que apunta un href relativo desde un documento: relativo al directorio del
 * documento; con `/` inicial, a la raíz (`rootPath`, el workspace: así los README con enlaces
 * "desde el repo" funcionan como en GitHub). Decodifica `%20` y similares. `null` si no es un archivo.
 */
export function resolveRelative(docPath: string, href: string, rootPath?: string): string | null {
  const { path } = splitHref(href.trim())
  if (path === '' || isExternal(path)) return null
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    /* un `%` suelto: se usa tal cual */
  }
  if (decoded.startsWith('/')) return normalizePath(rootPath ? rootPath + decoded : decoded)
  return normalizePath(dirName(docPath) + '/' + decoded)
}

/** Ruta del archivo relativa al workspace, con `/`; `null` si está fuera. */
export function relativeTo(workspacePath: string, absPath: string): string | null {
  if (!isInside(workspacePath, absPath)) return null
  const root = normalizePath(workspacePath)
  const abs = normalizePath(absPath)
  return abs === root ? '' : abs.slice(root === '/' ? 1 : root.length + 1)
}

/** URL `omni-file://<workspaceId>/<ruta relativa>` (segmentos codificados); `null` fuera del workspace. */
export function toFileUrl(workspaceId: string, workspacePath: string, absPath: string): string | null {
  const rel = relativeTo(workspacePath, absPath)
  if (rel === null) return null
  const encoded = rel.split('/').map(encodeURIComponent).join('/')
  return `omni-file://${workspaceId}/${encoded}`
}

/** Etiqueta de tipo para la franja: `Markdown`, `PNG 1280×800`, `PDF`, o la extensión. */
export function typeLabel(path: string, dims: { width: number; height: number } | null = null): string {
  const kind = kindOf(path)
  if (kind === 'md') return 'Markdown'
  if (kind === 'pdf') return 'PDF'
  const ext = extOf(path).toUpperCase() || 'Archivo'
  if (kind === 'image' && dims) return `${ext} ${dims.width}×${dims.height}`
  return ext
}

/** Zoom siguiente (`dir` +1 acerca, −1 aleja) desde el zoom efectivo actual, acotado. */
export function stepZoom(current: number, dir: 1 | -1): number {
  const next = dir === 1 ? current * ZOOM_FACTOR : current / ZOOM_FACTOR
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 1000) / 1000))
}

/** `125 %`, o `Ajustar` cuando la imagen se ajusta al pane (`zoom` nulo). */
export function zoomLabel(zoom: number | null): string {
  return zoom === null ? 'Ajustar' : `${Math.round(zoom * 100)} %`
}

/** Dominio de un enlace externo para el aviso "Enlace copiado"; el href entero si no es URL. */
export function hostOf(href: string): string {
  try {
    return new URL(href).host || href
  } catch {
    return href
  }
}

/** Id de un encabezado a partir de su texto (como GitHub): minúsculas, guiones, sin signos. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}
