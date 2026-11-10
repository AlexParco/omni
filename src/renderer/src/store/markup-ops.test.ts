import { describe, expect, it } from 'vitest'
import { EMPTY_HISTORY, canRedo, canUndo, clearOps, eraseAt, hitTest, pushOp, redo, undo, visibleOps, type MarkupOp, type PathOp, type ShapeOp, type TextOp } from './markup-ops'

const pen = (points: Array<[number, number]>): PathOp => ({ kind: 'path', tool: 'pen', color: 'red', size: 'm', points: points.map(([x, y]) => ({ x, y })) })
const rect = (x1: number, y1: number, x2: number, y2: number): ShapeOp => ({ kind: 'shape', tool: 'rect', color: 'blue', size: 's', from: { x: x1, y: y1 }, to: { x: x2, y: y2 } })
const text = (x: number, y: number, t: string): TextOp => ({ kind: 'text', color: 'white', size: 'm', at: { x, y }, text: t })

describe('pushOp / undo / redo', () => {
  it('deshacer y rehacer mueven la última operación y conservan el orden', () => {
    const a = pen([[0, 0]])
    const b = rect(0, 0, 10, 10)
    let h = pushOp(pushOp(EMPTY_HISTORY, a), b)
    expect(visibleOps(h.ops)).toEqual([a, b])
    h = undo(h)
    expect(visibleOps(h.ops)).toEqual([a])
    expect(canRedo(h)).toBe(true)
    h = redo(h)
    expect(visibleOps(h.ops)).toEqual([a, b])
    expect(canRedo(h)).toBe(false)
  })

  it('una operación nueva tras deshacer borra lo que había para rehacer', () => {
    let h = undo(pushOp(EMPTY_HISTORY, pen([[1, 1]])))
    h = pushOp(h, rect(0, 0, 5, 5))
    expect(canRedo(h)).toBe(false)
    expect(visibleOps(h.ops)).toHaveLength(1)
  })

  it('deshacer y rehacer sin nada no cambian el historial', () => {
    expect(undo(EMPTY_HISTORY)).toBe(EMPTY_HISTORY)
    expect(redo(EMPTY_HISTORY)).toBe(EMPTY_HISTORY)
    expect(canUndo(EMPTY_HISTORY)).toBe(false)
  })
})

describe('clearOps', () => {
  it('limpiar oculta todo y se deshace como cualquier operación', () => {
    const a = pen([[0, 0]])
    let h = clearOps(pushOp(pushOp(EMPTY_HISTORY, a), rect(0, 0, 1, 1)))
    expect(visibleOps(h.ops)).toEqual([])
    h = undo(h)
    expect(visibleOps(h.ops)).toHaveLength(2)
    // Lo dibujado después de limpiar se ve; lo anterior no.
    h = pushOp(clearOps(h), a)
    expect(visibleOps(h.ops)).toEqual([a])
  })

  it('limpiar sin nada visible no agrega operaciones', () => {
    expect(clearOps(EMPTY_HISTORY)).toBe(EMPTY_HISTORY)
    const h = clearOps(pushOp(EMPTY_HISTORY, pen([[0, 0]])))
    expect(clearOps(h)).toBe(h)
  })
})

describe('eraseAt / hitTest', () => {
  it('el borrador quita solo lo que toca y deshacer lo devuelve', () => {
    const a = pen([
      [10, 10],
      [20, 20]
    ])
    const b = rect(100, 100, 150, 150)
    let h = pushOp(pushOp(EMPTY_HISTORY, a), b)
    const untouched = eraseAt(h, { x: 500, y: 500 }, 6)
    expect(untouched).toBe(h)
    h = eraseAt(h, { x: 21, y: 19 }, 6)
    expect(visibleOps(h.ops)).toEqual([b])
    h = undo(h)
    expect(visibleOps(h.ops)).toEqual([a, b])
  })

  it('las figuras y el texto se tocan por su caja; un punto puede borrar varias', () => {
    const r = rect(0, 0, 50, 50)
    const t = text(40, 40, 'hola')
    expect(hitTest(r, { x: 25, y: 25 }, 0)).toBe(true)
    expect(hitTest(r, { x: 60, y: 60 }, 4)).toBe(false)
    expect(hitTest(t, { x: 45, y: 45 }, 0)).toBe(true)
    const h = eraseAt(pushOp(pushOp(EMPTY_HISTORY, r), t), { x: 45, y: 45 }, 0)
    expect(visibleOps(h.ops)).toEqual([])
    expect(h.ops.filter((o: MarkupOp) => o.kind === 'erase')).toHaveLength(2)
  })
})
