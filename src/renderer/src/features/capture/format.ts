import type { CaptureAttachments, CapturePayload } from '@shared/types'
import { sanitizeForPty } from '@/store/session-write'

// `sanitizeForPty` vive en `store/session-write.ts` (la aplica `writeToSession`); se reexporta para quien ya la usaba desde aquí.
export { sanitizeForPty }

/**
 * Texto que se escribe en la terminal del agente: el mensaje y, debajo, los adjuntos elegidos en
 * texto plano (ruta de la imagen, URL y viewport, selector del elemento, bloques ```html y ```css,
 * cola de consola). Puro: lo usa el diálogo "Enviar al agente" para enviar y para copiar.
 */
export function formatCapturePayload(payload: CapturePayload, attachments: CaptureAttachments, message: string): string {
  const lines: string[] = []
  const text = message.trim()
  if (text) lines.push(text, '')
  if (attachments.image) lines.push(`Imagen: ${payload.capture.path}`)
  if (attachments.context) lines.push(`URL: ${payload.url} · viewport ${payload.viewport.width}×${payload.viewport.height}`)
  const el = payload.element
  if (el) lines.push(`Elemento: ${el.selector} (${Math.round(el.rect.width)}×${Math.round(el.rect.height)})`)
  if (el && attachments.html && el.html) lines.push('```html', el.html.trimEnd(), '```')
  if (el && attachments.css && el.css) lines.push('```css', el.css.trimEnd(), '```')
  if (attachments.console && payload.consoleTail.length > 0) lines.push(`Consola (últimas ${payload.consoleTail.length}):`, ...payload.consoleTail)
  // Sin adjuntos y sin mensaje no hay nada que mandar; con mensaje solo, va el mensaje.
  return sanitizeForPty(lines.join('\n')).replace(/\n+$/, '')
}

/** Etiqueta corta del paquete para la cabecera del diálogo: `table.endpoints · 1084×212`, `captura · 1180×640` o `captura con dibujo · 1180×640` (px de la imagen). */
export function describeCapture(payload: CapturePayload, kind: 'capture' | 'markup' = 'capture'): string {
  const el = payload.element
  if (el) return `${el.selector} · ${Math.round(el.rect.width)}×${Math.round(el.rect.height)}`
  return `${kind === 'markup' ? 'captura con dibujo' : 'captura'} · ${payload.capture.width}×${payload.capture.height}`
}
