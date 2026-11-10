import { describe, expect, it } from 'vitest'
import type { CodeDiagnostic, SessionInfo, Workspace } from '@shared/types'
import { hunksOf, lineDiff, splitLines } from '@/core/line-diff'
import { changesLabel, comparisonText, diagnosticRange, diagnosticsLabel, formatComment, formatContext, hunkAt, isSeen, langOf, markSeen, nextHunkIndex, relPath, revertedLines, revertedText, visibleHunks, workspaceAgent, workspaceOfPath } from './editor-logic'

const base = ['a', 'b', 'c', 'd', 'e'].join('\n')
const cur = ['a', 'B', 'c', 'nuevo', 'd'].join('\n')
const lines = splitLines(cur)
const baseLines = splitLines(base)
// mod en [1,2), add en [3,4), del al final (e)
const hunks = lineDiff(base, cur)

describe('hunks vistos (A aceptar)', () => {
  it('el diff de ejemplo tiene tres hunks', () => {
    expect(hunks.map((h) => h.kind)).toEqual(['mod', 'add', 'del'])
  })

  it('aceptar un hunk lo oculta mientras su texto no cambie', () => {
    const seen = markSeen(hunks[0], lines, [])
    expect(isSeen(hunks[0], lines, seen)).toBe(true)
    expect(visibleHunks(hunks, lines, seen)).toHaveLength(2)
    // Se edita la línea del hunk: vuelve a pintarse.
    const edited = [...lines]
    edited[1] = 'B2'
    const again = lineDiff(base, edited.join('\n'))
    expect(isSeen(again[0], edited, seen)).toBe(false)
    expect(visibleHunks(again, edited, seen)).toHaveLength(3)
  })

  it('un hunk aceptado sigue visto aunque se inserten líneas arriba (cambia start, no la base ni el texto)', () => {
    const seen = markSeen(hunks[1], lines, [])
    const shifted = ['arriba', ...lines]
    const again = lineDiff(base, shifted.join('\n'))
    const moved = again.find((h) => h.kind === 'add' && h.baseStart === 3)
    expect(moved?.start).toBe(hunks[1].start + 1)
    expect(moved && isSeen(moved, shifted, seen)).toBe(true)
    expect(visibleHunks(again, shifted, seen).some((h) => h === moved)).toBe(false)
  })

  it('un hunk borrado (sin texto propio) se acepta por su rango de base', () => {
    const seen = markSeen(hunks[2], lines, [])
    expect(seen).toEqual([{ baseStart: 4, baseEnd: 5, text: '' }])
    expect(isSeen(hunks[2], lines, seen)).toBe(true)
    // No se repite al aceptar dos veces.
    expect(markSeen(hunks[2], lines, seen)).toBe(seen)
  })
})

describe('hunk bajo el cursor y navegación', () => {
  it('hunkAt encuentra el hunk de la línea; el del se posa en la línea ante la que se pinta', () => {
    expect(hunkAt(hunks, 1, lines.length)).toBe(0)
    expect(hunkAt(hunks, 3, lines.length)).toBe(1)
    expect(hunkAt(hunks, 0, lines.length)).toBeNull()
    // `del` al final del archivo: start = 5 = lineCount → se ancla a la última línea (4).
    expect(hunkAt(hunks, 4, lines.length)).toBe(2)
  })

  it('nextHunkIndex avanza y retrocede con vuelta', () => {
    expect(nextHunkIndex(hunks, 0, lines.length, 1)).toBe(0)
    expect(nextHunkIndex(hunks, 1, lines.length, 1)).toBe(1)
    expect(nextHunkIndex(hunks, 3, lines.length, 1)).toBe(2)
    expect(nextHunkIndex(hunks, 4, lines.length, 1)).toBe(0)
    expect(nextHunkIndex(hunks, 4, lines.length, -1)).toBe(1)
    expect(nextHunkIndex(hunks, 0, lines.length, -1)).toBe(2)
    expect(nextHunkIndex([], 0, 0, 1)).toBeNull()
  })
})

describe('langOf', () => {
  it('elige por extensión y da el nombre visible', () => {
    expect(langOf('/x/a.ts')).toEqual({ id: 'typescript', name: 'TypeScript' })
    expect(langOf('/x/a.tsx')).toEqual({ id: 'tsx', name: 'TSX' })
    expect(langOf('/x/README.md')).toEqual({ id: 'markdown', name: 'Markdown' })
    expect(langOf('/x/a.YML')).toEqual({ id: 'yaml', name: 'YAML' })
    expect(langOf('/x/Makefile')).toEqual({ id: null, name: 'Texto' })
    expect(langOf('/x/a.toml')).toEqual({ id: null, name: 'TOML' })
  })
})

describe('rutas y workspaces', () => {
  const ws: Workspace[] = [
    { id: 'w1', projectId: 'p', name: 'local', path: '/repo', kind: 'local' },
    { id: 'w2', projectId: 'p', name: 'wt', path: '/repo/.worktrees/wt', kind: 'worktree' }
  ]
  it('relPath recorta la raíz del workspace', () => {
    expect(relPath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relPath('/repo/', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relPath('/repo', '/otro/a.ts')).toBe('/otro/a.ts')
  })
  it('workspaceOfPath prefiere el actual y luego la raíz más larga', () => {
    expect(workspaceOfPath(ws, '/repo/.worktrees/wt/a.ts', null)?.id).toBe('w2')
    expect(workspaceOfPath(ws, '/repo/a.ts', null)?.id).toBe('w1')
    expect(workspaceOfPath(ws, '/repo/.worktrees/wt/a.ts', 'w1')?.id).toBe('w1')
    expect(workspaceOfPath(ws, '/fuera/a.ts', 'w1')).toBeUndefined()
  })
  it('workspaceAgent salta shell, navegador y documentos', () => {
    const s = (id: string, agent: SessionInfo['agent']): SessionInfo => ({ id, agent, workspaceId: 'w1', cwd: '/repo', createdAt: 0 })
    expect(workspaceAgent([s('1', 'shell'), s('2', 'editor'), s('3', 'browser'), s('4', 'claude')], 'w1')?.id).toBe('4')
    expect(workspaceAgent([s('1', 'shell')], 'w1')).toBeUndefined()
  })
})

describe('texto al agente', () => {
  it('formatComment es archivo:línea: texto', () => {
    expect(formatComment('src/a.ts', 12, '  usa const  ')).toBe('src/a.ts:12: usa const')
  })
  it('formatContext lista los hunks con - y +', () => {
    expect(formatContext('src/a.ts', hunks, lines, baseLines)).toBe(
      ['Archivo src/a.ts: 3 cambios respecto a la base', '', '@@ líneas 2-2 (mod) @@', '-b', '+B', '', '@@ líneas 4-4 (add) @@', '+nuevo', '', '@@ antes de la línea 6 (del) @@', '-e'].join('\n')
    )
  })
  it('changesLabel concuerda en número', () => {
    expect(changesLabel(1)).toBe('1 cambio del agente')
    expect(changesLabel(3)).toBe('3 cambios del agente')
  })
})

describe('revertedLines / revertedText', () => {
  it('reemplaza el rango del hunk por la base', () => {
    expect(revertedLines(lines, baseLines, hunks[0])).toEqual(['a', 'b', 'c', 'nuevo', 'd'])
    expect(revertedLines(lines, baseLines, hunks[1])).toEqual(['a', 'B', 'c', 'd'])
    expect(revertedLines(lines, baseLines, hunks[2])).toEqual(['a', 'B', 'c', 'nuevo', 'd', 'e'])
  })
  it('revertedText conserva el salto de línea final tal como estaba', () => {
    expect(revertedText(cur, baseLines, hunks[0])).toBe('a\nb\nc\nnuevo\nd')
    expect(revertedText(`${cur}\n`, baseLines, hunks[0])).toBe('a\nb\nc\nnuevo\nd\n')
    // Revertir el único hunk de un archivo nuevo lo deja vacío; revertir un borrado total sobre un buffer vacío pone salto final.
    const [added] = lineDiff('', 'x\ny\n')
    expect(revertedText('x\ny\n', [], added)).toBe('')
    const [deleted] = lineDiff('x\ny\n', '')
    expect(revertedText('', ['x', 'y'], deleted)).toBe('x\ny\n')
  })
})

describe('diagnósticos', () => {
  const d = (over: Partial<CodeDiagnostic>): CodeDiagnostic => ({ path: '/w/a.ts', line: 1, col: 1, endLine: null, endCol: null, severity: 'error', message: 'm', source: 'tsc', code: 'TS1', ...over })

  it('diagnosticsLabel cuenta errores y avisos sin ceros', () => {
    expect(diagnosticsLabel([])).toBe('')
    expect(diagnosticsLabel([d({}), d({}), d({ severity: 'warning' })])).toBe('2 errores · 1 aviso')
    expect(diagnosticsLabel([d({ severity: 'warning' })])).toBe('1 aviso')
  })

  it('diagnosticRange usa el rango de la herramienta o subraya la palabra desde la columna', () => {
    const text = 'const total = sumar(a)\nfoo\n'
    const starts = [0, 23, 27]
    expect(diagnosticRange(starts, text, { line: 1, col: 7, endLine: null, endCol: null })).toEqual({ from: 6, to: 11 })
    expect(diagnosticRange(starts, text, { line: 1, col: 15, endLine: 1, endCol: 23 })).toEqual({ from: 14, to: 22 })
    // Columna sobre un signo: al menos un carácter.
    expect(diagnosticRange(starts, text, { line: 1, col: 13, endLine: null, endCol: null })).toEqual({ from: 12, to: 13 })
    // Línea fuera del texto: se recorta a la última.
    expect(diagnosticRange(starts, text, { line: 9, col: 1, endLine: null, endCol: null }).from).toBe(27)
  })

  it('formatContext agrega los errores con archivo:línea:col y la herramienta', () => {
    const out = formatContext('src/a.ts', [], ['x'], ['x'], [d({ line: 3, col: 5, message: 'Tipo malo\ndetalle' })])
    expect(out).toBe('Archivo src/a.ts\n\n1 error:\nsrc/a.ts:3:5: [tsc TS1] Tipo malo')
  })
})

describe('comparisonText', () => {
  it('sin hunks aceptados es la base tal cual', () => {
    const base = 'a\nb\n'
    const hunks = hunksOf(splitLines(base), ['a', 'B'])
    expect(comparisonText(base, splitLines(base), ['a', 'B'], hunks, hunks)).toBe(base)
  })

  it('aplica a la base los hunks aceptados para que merge no los vuelva a pintar', () => {
    const base = 'uno\ndos\ntres\ncuatro\n'
    const lines = ['uno', 'DOS', 'tres', 'CUATRO', 'cinco']
    const all = hunksOf(splitLines(base), lines)
    expect(all).toHaveLength(2)
    // Se aceptó el primero (DOS): la comparación ya lo tiene; el segundo sigue pendiente.
    expect(comparisonText(base, splitLines(base), lines, all, [all[1]])).toBe('uno\nDOS\ntres\ncuatro\n')
    expect(comparisonText(base, splitLines(base), lines, all, [])).toBe('uno\nDOS\ntres\nCUATRO\ncinco\n')
  })
})
