import { fontSize, highlighterWidth, strokeWidth, type DrawOp, type MarkupColor } from '@/store/markup-ops'

/** Por si el token no está (tests, hojas sin cargar): mismos valores que tokens.css. */
const FALLBACK: Record<MarkupColor, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  white: '#ffffff'
}

/** Opacidad del resaltador. */
const HIGHLIGHT_ALPHA = 0.4

/** Valor CSS de un color del markup (`--mark-<nombre>` en tokens.css). */
export function colorValue(color: MarkupColor): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--mark-${color}`).trim()
  return v || FALLBACK[color]
}

function fontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'sans-serif'
}

/**
 * Pinta las operaciones en un contexto cuya unidad es el px de la captura. `unit` = px de captura
 * por px lógico (devicePixelRatio): grosores y fuentes se escalan con él, las coordenadas ya vienen
 * en px de captura. Lo usa el lienzo en vivo y la composición final (fondo + trazos).
 */
export function drawOps(ctx: CanvasRenderingContext2D, ops: readonly DrawOp[], unit: number): void {
  for (const op of ops) drawOp(ctx, op, unit)
}

export function drawOp(ctx: CanvasRenderingContext2D, op: DrawOp, unit: number): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const color = colorValue(op.color)
  ctx.strokeStyle = color
  ctx.fillStyle = color
  if (op.kind === 'path') drawPath(ctx, op, unit)
  else if (op.kind === 'shape') drawShape(ctx, op, unit)
  else drawText(ctx, op, unit)
  ctx.restore()
}

function drawPath(ctx: CanvasRenderingContext2D, op: Extract<DrawOp, { kind: 'path' }>, unit: number): void {
  const highlighter = op.tool === 'highlighter'
  ctx.lineWidth = (highlighter ? highlighterWidth(op.size) : strokeWidth(op.size)) * unit
  if (highlighter) {
    ctx.globalAlpha = HIGHLIGHT_ALPHA
    ctx.lineCap = 'butt'
  }
  ctx.beginPath()
  op.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  // Un clic sin arrastre deja un punto.
  if (op.points.length === 1) ctx.lineTo(op.points[0].x + 0.01, op.points[0].y)
  ctx.stroke()
}

function drawShape(ctx: CanvasRenderingContext2D, op: Extract<DrawOp, { kind: 'shape' }>, unit: number): void {
  ctx.lineWidth = strokeWidth(op.size) * unit
  const { from, to } = op
  if (op.tool === 'rect') {
    ctx.strokeRect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.abs(to.x - from.x), Math.abs(to.y - from.y))
    return
  }
  if (op.tool === 'ellipse') {
    ctx.beginPath()
    ctx.ellipse((from.x + to.x) / 2, (from.y + to.y) / 2, Math.abs(to.x - from.x) / 2, Math.abs(to.y - from.y) / 2, 0, 0, Math.PI * 2)
    ctx.stroke()
    return
  }
  // Flecha: línea y dos aletas en la punta, proporcionales al grosor.
  const head = Math.max(10 * unit, ctx.lineWidth * 3)
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6))
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6))
  ctx.stroke()
}

function drawText(ctx: CanvasRenderingContext2D, op: Extract<DrawOp, { kind: 'text' }>, unit: number): void {
  ctx.font = `500 ${fontSize(op.size) * unit}px ${fontFamily()}`
  ctx.textBaseline = 'top'
  const lineHeight = fontSize(op.size) * unit * 1.2
  op.text.split('\n').forEach((line, i) => ctx.fillText(line, op.at.x, op.at.y + i * lineHeight))
}
