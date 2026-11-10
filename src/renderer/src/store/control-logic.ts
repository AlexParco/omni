import type { ControlCommandType, DocKind } from '@shared/types'
import { normalizeUrl } from '@shared/url'

/**
 * Lógica pura del socket de control (ARCHITECTURE §3.21): validación de los argumentos de cada
 * comando que main reenvía al renderer y etiqueta de quién lo pidió para la franja del pane.
 * Sin stores ni IPC: todo se prueba en Node.
 */

/** Argumentos ya validados, por tipo de comando. */
export type ControlArgs =
  | { type: 'open'; path: string; kind: 'file' | 'dir' }
  | { type: 'browser'; url: string; workspaceId: string | null }
  | { type: 'capture'; url: string; sessionId: string | null }
  | { type: 'diff'; workspaceId: string }
  | { type: 'focus'; sessionId: string }
  | { type: 'show'; sessionId: string }
  | { type: 'todo'; text: string }
  | { type: 'notify'; title: string; body: string }
  | { type: 'statuses' }

export type ParsedArgs = { ok: true; args: ControlArgs } | { ok: false; error: string }

/** Cuánto dura el aviso `MCP · <agente>` / `CLI` en la franja (igual que las capturas). */
export const CONTROL_NOTICE_MS = 3000

const str = (args: Record<string, unknown>, key: string): string | null => {
  const v = args[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/** URL navegable por el pane: `http(s)` tras normalizar lo escrito (main además aplica su lista de permitidas). */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url)
}

/**
 * `open` sin `kind` explícito: una última parte con extensión (`a.ts`, `.env`) se toma por archivo; lo demás por
 * carpeta. Main manda `kind` cuando puede comprobarlo en disco; esto solo cubre el caso en que no llegue.
 */
export function guessKind(path: string): 'file' | 'dir' {
  const last = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return /^\.?[^.]+\.[^.]+$|^\.[^.]+$/.test(last) ? 'file' : 'dir'
}

/** Extensiones que `open` abre como vista previa (§3.20) en vez de editor. */
const PREVIEW_EXT = new Set(['md', 'markdown', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'])

/** Qué pane abre `open` para un archivo: `preview` para Markdown, imágenes y PDF; `editor` para el resto. */
export function docKindFor(path: string): DocKind {
  const last = path.split(/[\\/]/).pop() ?? ''
  const ext = last.includes('.') ? (last.split('.').pop() ?? '').toLowerCase() : ''
  return PREVIEW_EXT.has(ext) ? 'preview' : 'editor'
}

/** Valida los argumentos de un comando; el error ya es texto para el humano que lo pidió. */
export function parseArgs(type: ControlCommandType, args: Record<string, unknown>): ParsedArgs {
  switch (type) {
    case 'open': {
      const path = str(args, 'path')
      if (!path) return { ok: false, error: 'open: falta la ruta (path)' }
      const kind = args.kind === 'file' || args.kind === 'dir' ? args.kind : guessKind(path)
      return { ok: true, args: { type, path, kind } }
    }
    case 'browser':
    case 'capture': {
      const raw = str(args, 'url')
      if (!raw) return { ok: false, error: `${type}: falta la dirección (url)` }
      const url = normalizeUrl(raw)
      if (!isWebUrl(url)) return { ok: false, error: `${type}: la dirección no es http(s): ${raw}` }
      if (type === 'browser') return { ok: true, args: { type, url, workspaceId: str(args, 'workspaceId') } }
      return { ok: true, args: { type, url, sessionId: str(args, 'sessionId') } }
    }
    case 'diff': {
      const workspaceId = str(args, 'workspaceId')
      if (!workspaceId) return { ok: false, error: 'diff: falta el workspace (workspaceId)' }
      return { ok: true, args: { type, workspaceId } }
    }
    case 'focus':
    case 'show': {
      const sessionId = str(args, 'sessionId')
      if (!sessionId) return { ok: false, error: `${type}: falta la sesión (sessionId)` }
      return { ok: true, args: { type, sessionId } }
    }
    case 'todo': {
      const text = str(args, 'text')
      if (!text) return { ok: false, error: 'todo: falta el texto (text)' }
      return { ok: true, args: { type, text } }
    }
    case 'notify': {
      const title = str(args, 'title')
      if (!title) return { ok: false, error: 'notify: falta el título (title)' }
      return { ok: true, args: { type, title, body: str(args, 'body') ?? '' } }
    }
    case 'statuses':
      return { ok: true, args: { type } }
    case 'list':
    case 'send':
      return { ok: false, error: `${type}: lo resuelve main, no el renderer` }
    default:
      return { ok: false, error: `comando desconocido: ${String(type)}` }
  }
}

/** Misma página a efectos de reutilizar un navegador: se ignoran mayúsculas del esquema/host, la barra final y el `#`. */
export function sameUrl(a: string, b: string): boolean {
  const norm = (u: string): string => {
    const noHash = u.split('#')[0] ?? ''
    const m = /^([a-z]+:\/\/[^/?]+)(.*)$/i.exec(noHash)
    const [, host = noHash, rest = ''] = m ?? []
    return host.toLowerCase() + rest.replace(/\/+$/, '')
  }
  return norm(a) === norm(b)
}

/** Etiqueta de la franja: `CLI` para la línea de comandos, `MCP · <agente>` para el bus. */
export function fromLabel(from: string): string {
  const clean = from.trim()
  if (clean === '' || clean === 'cli') return 'CLI'
  if (clean === 'mcp') return 'MCP'
  if (clean.startsWith('mcp:')) {
    const agent = clean.slice(4).trim()
    return agent ? `MCP · ${agent}` : 'MCP'
  }
  return clean
}

/** Texto del aviso en la franja: la etiqueta de quién lo pidió y, si hay, qué pasó. */
export function noticeText(from: string, detail?: string): string {
  const label = fromLabel(from)
  return detail ? `${label} · ${detail}` : label
}

/**
 * Mensaje humano de un error: Electron envuelve los de IPC ("Error invoking remote method '…': Error: …");
 * se queda con lo último. Sin mensaje, el texto por defecto.
 */
export function humanError(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  const last = raw.split(/Error: /).pop()?.trim() ?? ''
  return last || fallback
}
