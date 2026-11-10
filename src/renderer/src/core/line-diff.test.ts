import { describe, expect, it } from 'vitest'
import { hunkBaseLines, hunkLines, lineDiff, splitLines } from './line-diff'

describe('splitLines', () => {
  it('vacío no tiene líneas y el salto final no abre una línea de más', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a')).toEqual(['a'])
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\n\n')).toEqual(['a', ''])
  })
})

describe('lineDiff', () => {
  it('sin cambios no hay hunks', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nb\nc\n')).toEqual([])
    expect(lineDiff('', '')).toEqual([])
  })

  it('líneas añadidas: hunk add con base vacía en ese punto', () => {
    expect(lineDiff('a\nc\n', 'a\nb1\nb2\nc\n')).toEqual([{ start: 1, end: 3, baseStart: 1, baseEnd: 1, kind: 'add' }])
  })

  it('líneas borradas: hunk del con start === end', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nc\n')).toEqual([{ start: 1, end: 1, baseStart: 1, baseEnd: 2, kind: 'del' }])
  })

  it('borrado seguido de añadido es un solo hunk mod', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ start: 1, end: 2, baseStart: 1, baseEnd: 2, kind: 'mod' }])
    // Tamaños distintos: dos líneas reemplazan a una.
    expect(lineDiff('a\nb\nc\n', 'a\nx\ny\nc\n')).toEqual([{ start: 1, end: 3, baseStart: 1, baseEnd: 2, kind: 'mod' }])
  })

  it('varios hunks separados por contexto, con desplazamiento acumulado', () => {
    const base = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].join('\n')
    const cur = ['l1', 'nuevo', 'l2', 'l3', 'l5', 'l6', 'fin'].join('\n')
    expect(lineDiff(base, cur)).toEqual([
      { start: 1, end: 2, baseStart: 1, baseEnd: 1, kind: 'add' },
      { start: 4, end: 4, baseStart: 3, baseEnd: 4, kind: 'del' },
      { start: 6, end: 7, baseStart: 6, baseEnd: 6, kind: 'add' }
    ])
  })

  it('archivo nuevo (base vacía) es un único add; vaciado es un único del', () => {
    expect(lineDiff('', 'a\nb\n')).toEqual([{ start: 0, end: 2, baseStart: 0, baseEnd: 0, kind: 'add' }])
    expect(lineDiff('a\nb\n', '')).toEqual([{ start: 0, end: 0, baseStart: 0, baseEnd: 2, kind: 'del' }])
  })

  it('hunkLines y hunkBaseLines devuelven el texto de cada lado', () => {
    const base = 'a\nb\nc\n'
    const cur = 'a\nB\nc\n'
    const [h] = lineDiff(base, cur)
    expect(hunkLines(splitLines(cur), h)).toEqual(['B'])
    expect(hunkBaseLines(splitLines(base), h)).toEqual(['b'])
  })
})
