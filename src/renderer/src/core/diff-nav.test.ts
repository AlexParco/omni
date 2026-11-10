import { describe, expect, it } from 'vitest'
import type { DiffFile, DiffLine } from '@shared/types'
import { clampCursor, cursorAfterFile, cursorAfterHunk, cursorAfterLine, cursorForFile, fileAt, firstCursor, flattenLines, lineAt } from './diff-nav'

const ctx = (n: number): DiffLine => ({ kind: 'ctx', old: n, new: n, text: `ctx ${n}` })
const add = (n: number): DiffLine => ({ kind: 'add', old: null, new: n, text: `add ${n}` })
const del = (n: number): DiffLine => ({ kind: 'del', old: n, new: null, text: `del ${n}` })
const file = (path: string, hunks: DiffLine[][], extra: Partial<DiffFile> = {}): DiffFile => ({
  path,
  status: 'M',
  additions: 0,
  deletions: 0,
  binary: false,
  hunks: hunks.map((lines, i) => ({ header: `@@ -${i} +${i} @@`, lines })),
  ...extra
})

/** a.ts: dos hunks (3 + 2 líneas); logo.png: binario sin hunks; b.ts: un hunk de 2 líneas. */
const FILES: DiffFile[] = [file('a.ts', [[ctx(1), add(2), del(3)], [ctx(10), add(11)]]), file('logo.png', [], { binary: true, status: 'A' }), file('b.ts', [[del(5), add(5)]])]

describe('diff-nav · aplanado y lectura', () => {
  it('flattenLines recorre archivos, hunks y líneas en orden de lectura', () => {
    expect(flattenLines(FILES)).toEqual([
      { file: 0, hunk: 0, line: 0 },
      { file: 0, hunk: 0, line: 1 },
      { file: 0, hunk: 0, line: 2 },
      { file: 0, hunk: 1, line: 0 },
      { file: 0, hunk: 1, line: 1 },
      { file: 2, hunk: 0, line: 0 },
      { file: 2, hunk: 0, line: 1 }
    ])
  })

  it('firstCursor es la primera línea; sin líneas, el primer archivo; sin archivos, null', () => {
    expect(firstCursor(FILES)).toEqual({ file: 0, hunk: 0, line: 0 })
    expect(firstCursor([file('x.png', [], { binary: true })])).toEqual({ file: 0, hunk: 0, line: 0 })
    expect(firstCursor([])).toBeNull()
  })

  it('lineAt y fileAt leen bajo el cursor; un binario tiene archivo pero no línea', () => {
    expect(lineAt(FILES, { file: 0, hunk: 1, line: 1 })).toEqual(add(11))
    expect(fileAt(FILES, { file: 1, hunk: 0, line: 0 })?.path).toBe('logo.png')
    expect(lineAt(FILES, { file: 1, hunk: 0, line: 0 })).toBeNull()
    expect(lineAt(FILES, null)).toBeNull()
  })
})

describe('diff-nav · líneas', () => {
  it('J K recorren líneas cruzando hunks y archivos, y en los extremos se quedan', () => {
    let c = firstCursor(FILES)
    c = cursorAfterLine(FILES, c, -1)
    expect(c).toEqual({ file: 0, hunk: 0, line: 0 })
    c = cursorAfterLine(FILES, { file: 0, hunk: 0, line: 2 }, 1)
    expect(c).toEqual({ file: 0, hunk: 1, line: 0 })
    c = cursorAfterLine(FILES, { file: 0, hunk: 1, line: 1 }, 1)
    expect(c).toEqual({ file: 2, hunk: 0, line: 0 })
    c = cursorAfterLine(FILES, { file: 2, hunk: 0, line: 1 }, 1)
    expect(c).toEqual({ file: 2, hunk: 0, line: 1 })
    expect(cursorAfterLine(FILES, { file: 2, hunk: 0, line: 0 }, -1)).toEqual({ file: 0, hunk: 1, line: 1 })
  })

  it('desde un binario, J va a la primera línea que sigue y K a la última que quedó atrás', () => {
    expect(cursorAfterLine(FILES, { file: 1, hunk: 0, line: 0 }, 1)).toEqual({ file: 2, hunk: 0, line: 0 })
    expect(cursorAfterLine(FILES, { file: 1, hunk: 0, line: 0 }, -1)).toEqual({ file: 0, hunk: 1, line: 1 })
  })

  it('sin cursor arranca en la primera línea; sin líneas se queda donde está', () => {
    expect(cursorAfterLine(FILES, null, 1)).toEqual({ file: 0, hunk: 0, line: 0 })
    const only = [file('x.png', [], { binary: true })]
    expect(cursorAfterLine(only, { file: 0, hunk: 0, line: 0 }, 1)).toEqual({ file: 0, hunk: 0, line: 0 })
  })
})

describe('diff-nav · hunks y archivos', () => {
  it('] [ saltan al principio del hunk siguiente o anterior, cruzando archivos', () => {
    expect(cursorAfterHunk(FILES, { file: 0, hunk: 0, line: 1 }, 1)).toEqual({ file: 0, hunk: 1, line: 0 })
    expect(cursorAfterHunk(FILES, { file: 0, hunk: 1, line: 1 }, 1)).toEqual({ file: 2, hunk: 0, line: 0 })
    expect(cursorAfterHunk(FILES, { file: 2, hunk: 0, line: 1 }, 1)).toEqual({ file: 2, hunk: 0, line: 1 })
    expect(cursorAfterHunk(FILES, { file: 2, hunk: 0, line: 1 }, -1)).toEqual({ file: 0, hunk: 1, line: 0 })
    expect(cursorAfterHunk(FILES, { file: 0, hunk: 1, line: 1 }, -1)).toEqual({ file: 0, hunk: 0, line: 0 })
    expect(cursorAfterHunk(FILES, { file: 0, hunk: 0, line: 2 }, -1)).toEqual({ file: 0, hunk: 0, line: 2 })
    // Desde el binario, el hunk anterior es el último de a.ts y el siguiente el de b.ts.
    expect(cursorAfterHunk(FILES, { file: 1, hunk: 0, line: 0 }, -1)).toEqual({ file: 0, hunk: 1, line: 0 })
    expect(cursorAfterHunk(FILES, { file: 1, hunk: 0, line: 0 }, 1)).toEqual({ file: 2, hunk: 0, line: 0 })
  })

  it('} { cambian de archivo (los binarios cuentan) y en los extremos se quedan', () => {
    expect(cursorAfterFile(FILES, { file: 0, hunk: 1, line: 1 }, 1)).toEqual({ file: 1, hunk: 0, line: 0 })
    expect(cursorAfterFile(FILES, { file: 1, hunk: 0, line: 0 }, 1)).toEqual({ file: 2, hunk: 0, line: 0 })
    expect(cursorAfterFile(FILES, { file: 2, hunk: 0, line: 1 }, 1)).toEqual({ file: 2, hunk: 0, line: 1 })
    expect(cursorAfterFile(FILES, { file: 0, hunk: 0, line: 2 }, -1)).toEqual({ file: 0, hunk: 0, line: 2 })
    expect(cursorForFile(FILES, 2)).toEqual({ file: 2, hunk: 0, line: 0 })
    expect(cursorForFile(FILES, 9)).toBeNull()
  })

  it('clampCursor conserva el cursor si su línea existe y si no baja a la más cercana', () => {
    expect(clampCursor(FILES, { file: 0, hunk: 1, line: 1 })).toEqual({ file: 0, hunk: 1, line: 1 })
    expect(clampCursor(FILES, { file: 0, hunk: 1, line: 7 })).toEqual({ file: 0, hunk: 1, line: 1 })
    expect(clampCursor(FILES, { file: 0, hunk: 5, line: 7 })).toEqual({ file: 0, hunk: 1, line: 1 })
    expect(clampCursor(FILES, { file: 9, hunk: 0, line: 0 })).toEqual({ file: 0, hunk: 0, line: 0 })
    expect(clampCursor(FILES, { file: 1, hunk: 3, line: 3 })).toEqual({ file: 1, hunk: 0, line: 0 })
    expect(clampCursor([], { file: 0, hunk: 0, line: 0 })).toBeNull()
    expect(clampCursor(FILES, null)).toEqual({ file: 0, hunk: 0, line: 0 })
  })
})
