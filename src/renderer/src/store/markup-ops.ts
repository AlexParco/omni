/**
 * Operaciones del markup (ARCHITECTURE §3.9): el dibujo es una lista de operaciones vectoriales en
 * px de la captura; deshacer y rehacer mueven operaciones entre `ops` y `undone`. Limpiar y borrar
 * también son operaciones (`clear`, `erase`), así se deshacen igual que un trazo. Puro, sin DOM: el
 * lienzo (`panes/browser/markup-draw.ts`) solo pinta `visibleOps()`.
 */

export type MarkupTool = 'pen' | 'highlighter' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'eraser'
/** Nombre del color: el valor real sale de `--mark-<nombre>` en tokens.css. */
export type MarkupColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'white'
export type MarkupSize = 's' | 'm' | 'l'

export interface Point {
  x: number
  y: number
}

interface Styled {
  color: MarkupColor
  size: MarkupSize
}

/** Trazo libre (lápiz o resaltador). */
export interface PathOp extends Styled {
  kind: 'path'
  tool: 'pen' | 'highlighter'
  points: Point[]
}
/** Figura entre dos puntos (flecha, rectángulo, elipse). */
export interface ShapeOp extends Styled {
  kind: 'shape'
  tool: 'arrow' | 'rect' | 'ellipse'
  from: Point
  to: Point
}
export interface TextOp extends Styled {
  kind: 'text'
  at: Point
  text: string
}
/** Borra la operación con ese índice absoluto en `ops` (borrador por objeto). */
export interface EraseOp {
  kind: 'erase'
  target: number
}
/** Papelera: oculta todo lo anterior; deshacer lo trae de vuelta. */
export interface ClearOp {
  kind: 'clear'
}

export type MarkupOp = PathOp | ShapeOp | TextOp | EraseOp | ClearOp
/** Operaciones que pintan algo. */
export type DrawOp = PathOp | ShapeOp | TextOp

export interface MarkupHistory {
  ops: MarkupOp[]
  /** Deshechas, la última deshecha al final. */
  undone: MarkupOp[]
}

export const EMPTY_HISTORY: MarkupHistory = { ops: [], undone: [] }

export const MARKUP_COLORS: readonly MarkupColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'white']
export const MARKUP_TOOLS: readonly MarkupTool[] = ['pen', 'highlighter', 'arrow', 'rect', 'ellipse', 'text', 'eraser']

/** Grosor del trazo en px lógicos por talla; el resaltador va más ancho (`highlighterWidth`). */
export function strokeWidth(size: MarkupSize): number {
  return size === 's' ? 2 : size === 'm' ? 4 : 8
}
export function highlighterWidth(size: MarkupSize): number {
  return strokeWidth(size) * 4
}
/** Tamaño de fuente del texto en px lógicos por talla. */
export function fontSize(size: MarkupSize): number {
  return size === 's' ? 14 : size === 'm' ? 20 : 28
}

/** Añade una operación; rehacer se pierde (como en cualquier editor). */
export function pushOp(h: MarkupHistory, op: MarkupOp): MarkupHistory {
  return { ops: [...h.ops, op], undone: [] }
}

export function undo(h: MarkupHistory): MarkupHistory {
  if (h.ops.length === 0) return h
  return { ops: h.ops.slice(0, -1), undone: [...h.undone, h.ops[h.ops.length - 1]] }
}

export function redo(h: MarkupHistory): MarkupHistory {
  if (h.undone.length === 0) return h
  return { ops: [...h.ops, h.undone[h.undone.length - 1]], undone: h.undone.slice(0, -1) }
}

export function canUndo(h: MarkupHistory): boolean {
  return h.ops.length > 0
}
export function canRedo(h: MarkupHistory): boolean {
  return h.undone.length > 0
}

/** Papelera: no hace nada si ya no se ve nada. */
export function clearOps(h: MarkupHistory): MarkupHistory {
  return visibleOps(h.ops).length === 0 ? h : pushOp(h, { kind: 'clear' })
}

/** Índice absoluto en `ops` de cada operación visible, en orden de pintado. */
export function visibleIndices(ops: readonly MarkupOp[]): number[] {
  let start = 0
  const erased = new Set<number>()
  ops.forEach((op, i) => {
    if (op.kind === 'clear') start = i + 1
    else if (op.kind === 'erase') erased.add(op.target)
  })
  const out: number[] = []
  for (let i = start; i < ops.length; i++) {
    const op = ops[i]
    if (op.kind === 'erase' || op.kind === 'clear' || erased.has(i)) continue
    out.push(i)
  }
  return out
}

/** Operaciones que hay que pintar ahora (tras la última papelera y sin las borradas). */
export function visibleOps(ops: readonly MarkupOp[]): DrawOp[] {
  return visibleIndices(ops).map((i) => ops[i] as DrawOp)
}

/** Borrador: una operación `erase` por cada operación visible que el punto toca. Sin tocar nada, no cambia. */
export function eraseAt(h: MarkupHistory, point: Point, radius: number): MarkupHistory {
  const hits = visibleIndices(h.ops).filter((i) => hitTest(h.ops[i] as DrawOp, point, radius))
  if (hits.length === 0) return h
  return hits.reduce((acc, target) => pushOp(acc, { kind: 'erase', target }), h)
}

/** Caja que ocupa una operación (sin el grosor del trazo). */
export function boundsOf(op: DrawOp): { x: number; y: number; width: number; height: number } {
  if (op.kind === 'path') {
    const xs = op.points.map((p) => p.x)
    const ys = op.points.map((p) => p.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
  }
  if (op.kind === 'shape') {
    const x = Math.min(op.from.x, op.to.x)
    const y = Math.min(op.from.y, op.to.y)
    return { x, y, width: Math.abs(op.to.x - op.from.x), height: Math.abs(op.to.y - op.from.y) }
  }
  // Texto: caja aproximada por la fuente (0.6 em por carácter), con el punto como esquina superior izquierda.
  const em = fontSize(op.size)
  return { x: op.at.x, y: op.at.y, width: Math.max(em * 0.6, op.text.length * em * 0.6), height: em * 1.2 }
}

/** `true` si el punto toca la operación: un trazo por cercanía a sus puntos, lo demás por su caja. */
export function hitTest(op: DrawOp, point: Point, radius: number): boolean {
  if (op.kind === 'path') {
    const r = radius + (op.tool === 'highlighter' ? highlighterWidth(op.size) : strokeWidth(op.size)) / 2
    return op.points.some((p) => Math.hypot(p.x - point.x, p.y - point.y) <= r)
  }
  const b = boundsOf(op)
  return point.x >= b.x - radius && point.x <= b.x + b.width + radius && point.y >= b.y - radius && point.y <= b.y + b.height + radius
}
