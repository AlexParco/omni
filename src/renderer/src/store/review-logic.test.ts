import { describe, expect, it } from 'vitest'
import type { DiffFile } from '@shared/types'
import { anchorOf, commentsAt, formatComments, newComment, pendingComments, reanchorComments, reviewMarkdown, sendLabel, statText, statusLine, testsLabel, totalsOf } from './review-logic'

const file = (path: string, additions: number, deletions: number): DiffFile => ({ path, status: 'M', additions, deletions, binary: false, hunks: [] })

describe('review-logic · anclas y comentarios', () => {
  it('una línea añadida o de contexto se ancla al lado nuevo; una borrada al viejo', () => {
    expect(anchorOf('a.ts', { kind: 'add', old: null, new: 12, text: 'x' })).toEqual({ path: 'a.ts', line: 12, side: 'new', lineText: 'x' })
    expect(anchorOf('a.ts', { kind: 'ctx', old: 3, new: 4, text: 'y' })).toEqual({ path: 'a.ts', line: 4, side: 'new', lineText: 'y' })
    expect(anchorOf('a.ts', { kind: 'del', old: 7, new: null, text: 'z' })).toEqual({ path: 'a.ts', line: 7, side: 'old', lineText: 'z' })
    expect(anchorOf('a.ts', { kind: 'del', old: null, new: null, text: '' })).toBeNull()
  })

  it('newComment recorta el texto y nace sin enviar; commentsAt filtra por ancla exacta', () => {
    const a = newComment({ path: 'a.ts', line: 12, side: 'new', lineText: 'x' }, '  falta el await \n', 'c1')
    const b = newComment({ path: 'a.ts', line: 12, side: 'old', lineText: 'x' }, 'otro', 'c2')
    expect(a).toEqual({ id: 'c1', path: 'a.ts', line: 12, side: 'new', lineText: 'x', text: 'falta el await', sent: false, stale: false })
    expect(commentsAt([a, b], { path: 'a.ts', line: 12, side: 'new', lineText: 'x' })).toEqual([a])
    // Un desfasado no se pinta bajo ninguna línea.
    expect(commentsAt([{ ...a, stale: true }], { path: 'a.ts', line: 12, side: 'new', lineText: 'x' })).toEqual([])
    expect(pendingComments([a, { ...b, sent: true }])).toEqual([a])
  })

  it('formatComments arma el mensaje al agente con una viñeta por comentario y sangra las líneas extra', () => {
    const text = formatComments('omni/cc-51', [
      newComment({ path: 'src/client.ts', line: 48, side: 'new', lineText: '' }, 'falta el await', 'c1'),
      newComment({ path: 'src/client.ts', line: 60, side: 'old', lineText: '' }, 'esto no se borra\nlo usa el worker', 'c2'),
      { ...newComment({ path: 'src/client.ts', line: 70, side: 'new', lineText: '' }, 'ya no está', 'c3'), stale: true }
    ])
    expect(text).toBe('Revisión de omni/cc-51:\n- src/client.ts:48: falta el await\n- src/client.ts:60: esto no se borra\n  lo usa el worker\n- src/client.ts:70 (desfasado): ya no está')
  })
})

describe('review-logic · re-anclar al recargar', () => {
  const lines = (...rows: Array<[DiffFile['hunks'][number]['lines'][number]['kind'], number | null, number | null, string]>): DiffFile['hunks'][number]['lines'] => rows.map(([kind, old, nw, text]) => ({ kind, old, new: nw, text }))
  const withLines = (path: string, ls: DiffFile['hunks'][number]['lines']): DiffFile => ({ ...file(path, 0, 0), hunks: [{ header: '@@', lines: ls }] })
  const c = newComment({ path: 'a.ts', line: 48, side: 'new', lineText: 'await client.get()' }, 'falta el catch', 'c1')

  it('una inserción arriba renumera: el comentario sigue a su texto', () => {
    const files = [withLines('a.ts', lines(['add', null, 10, 'import x'], ['ctx', 47, 50, 'const a'], ['add', null, 51, 'await client.get()']))]
    expect(reanchorComments(files, [c])).toEqual([{ ...c, line: 51, stale: false }])
  })

  it('con el texto repetido gana la coincidencia más cercana a la línea vieja', () => {
    const files = [withLines('a.ts', lines(['add', null, 3, 'await client.get()'], ['add', null, 46, 'await client.get()'], ['add', null, 90, 'await client.get()']))]
    expect(reanchorComments(files, [c])[0].line).toBe(46)
  })

  it('línea borrada del diff: queda desfasado con su línea vieja, y vuelve a estar al día si reaparece', () => {
    const gone = [withLines('a.ts', lines(['add', null, 48, 'otra cosa']))]
    const stale = reanchorComments(gone, [c])
    expect(stale).toEqual([{ ...c, stale: true }])
    expect(stale[0].line).toBe(48)
    // El lado también cuenta: el mismo texto como línea borrada no es la misma línea.
    expect(reanchorComments([withLines('a.ts', lines(['del', 48, null, 'await client.get()']))], [c])[0].stale).toBe(true)
    // Otro archivo con el mismo texto tampoco.
    expect(reanchorComments([withLines('b.ts', lines(['add', null, 48, 'await client.get()']))], [c])[0].stale).toBe(true)
    const back = reanchorComments([withLines('a.ts', lines(['add', null, 52, 'await client.get()']))], stale)
    expect(back).toEqual([{ ...c, line: 52, stale: false }])
  })

  it('sin cambios devuelve el mismo objeto (no repinta por gusto)', () => {
    const files = [withLines('a.ts', lines(['add', null, 48, 'await client.get()']))]
    expect(reanchorComments(files, [c])[0]).toBe(c)
  })
})

describe('review-logic · cabecera', () => {
  it('statusLine suma archivo a archivo y pinta el estado de los tests', () => {
    const diff = { branch: 'omni/cc-51', base: 'main', files: [file('a.ts', 30, 4), file('b.ts', 4, 5)] }
    expect(statusLine(diff, { status: 'pass', summary: '', at: 0 })).toBe('omni/cc-51 → main · 2 archivos · +34 −9 · tests ok')
    expect(statusLine({ ...diff, files: [file('a.ts', 1, 0)] }, null)).toBe('omni/cc-51 → main · 1 archivo · +1 −0 · tests sin correr')
    expect(totalsOf(diff.files)).toEqual({ files: 2, additions: 34, deletions: 9 })
  })

  it('etiquetas: tests, stat y botón de enviar', () => {
    expect(testsLabel({ status: 'fail', summary: '', at: 0 })).toBe('tests fallaron')
    expect(testsLabel({ status: 'running', summary: '', at: 0 })).toBe('tests corriendo')
    expect(statText(3, 0)).toBe('+3 −0')
    expect(sendLabel(0)).toBe('Enviar comentarios')
    expect(sendLabel(1)).toBe('Enviar 1 comentario')
    expect(sendLabel(4)).toBe('Enviar 4 comentarios')
  })
})

describe('reviewMarkdown', () => {
  const diff = {
    branch: 'omni/login',
    base: 'main',
    truncated: false,
    files: [
      { path: 'src/a.ts', status: 'M' as const, additions: 1, deletions: 1, binary: false, hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [{ kind: 'ctx' as const, old: 1, new: 1, text: 'const x = 1' }, { kind: 'del' as const, old: 2, new: null, text: 'return `a`' }, { kind: 'add' as const, old: null, new: 2, text: 'return ```b```' }] }] },
      { path: 'logo.png', status: 'A' as const, additions: 0, deletions: 0, binary: true, hunks: [] }
    ]
  }
  const comments = [
    { id: '1', path: 'src/a.ts', line: 2, side: 'new' as const, lineText: 'return ```b```', text: 'esto rompe\nel caso vacío', sent: false, stale: false },
    { id: '2', path: 'src/a.ts', line: 1, side: 'new' as const, lineText: 'const x = 1', text: 'nombre poco claro', sent: true, stale: true }
  ]

  it('resumen, archivos, comentarios por archivo en orden de línea y diff plegado', () => {
    const md = reviewMarkdown(diff, comments, { status: 'fail', summary: '1 failed', at: 0 })
    expect(md).toContain('## Revisión de `omni/login` → `main`')
    expect(md).toContain('2 archivos · +1 −1 · tests fallaron')
    expect(md).toContain('> 1 failed')
    expect(md).toContain('- `src/a.ts` (modificado, +1 −1)')
    expect(md).toContain('- `logo.png` (nuevo, binario)')
    expect(md.indexOf('Línea 1 (desfasado): nombre poco claro')).toBeLessThan(md.indexOf('Línea 2: esto rompe'))
    expect(md).toContain('  el caso vacío')
    expect(md).toContain('<details><summary><code>src/a.ts</code> +1 −1</summary>')
    // El fence es más largo que cualquier racha de backticks del diff: el bloque no se corta.
    expect(md).toContain('````diff\n@@ -1,2 +1,2 @@\n const x = 1\n-return `a`\n+return ```b```\n````')
    expect(md).not.toContain('<code>logo.png</code>')
  })

  it('sin comentarios no hay sección; un diff truncado lo avisa', () => {
    const md = reviewMarkdown({ ...diff, truncated: true }, [], null)
    expect(md).not.toContain('### Comentarios')
    expect(md).toContain('tests sin correr')
    expect(md).toContain('El diff se cortó por tamaño')
  })
})
