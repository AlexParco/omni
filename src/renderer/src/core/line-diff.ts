import { diffArrays } from 'diff'

/**
 * Diff por líneas entre la base (HEAD o la base del worktree) y el buffer del editor (ARCHITECTURE
 * §3.19). Myers sobre líneas (el paquete `diff`), agrupado en hunks contiguos: un bloque borrado
 * seguido de uno añadido es un solo hunk `mod`. Los rangos son índices de línea base 0, fin
 * exclusivo: `[start, end)` en el texto actual y `[baseStart, baseEnd)` en la base. Un hunk `del`
 * tiene `start === end` (las líneas borradas irían justo antes de `start`); uno `add` tiene
 * `baseStart === baseEnd`.
 */
export type HunkKind = 'add' | 'del' | 'mod'

export interface LineHunk {
  start: number
  end: number
  baseStart: number
  baseEnd: number
  kind: HunkKind
}

/** Líneas de un texto: `''` no tiene líneas y un salto final no abre una línea vacía de más. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Hunks del texto actual respecto a la base, en orden de aparición. Sin cambios → `[]`. */
export function lineDiff(base: string, current: string): LineHunk[] {
  return hunksOf(splitLines(base), splitLines(current))
}

export function hunksOf(baseLines: string[], lines: string[]): LineHunk[] {
  const hunks: LineHunk[] = []
  let line = 0
  let baseLine = 0
  let open: LineHunk | null = null
  const close = (): void => {
    if (open) hunks.push(open)
    open = null
  }
  for (const change of diffArrays(baseLines, lines)) {
    const n = change.count ?? change.value.length
    if (change.removed) {
      if (!open) open = { start: line, end: line, baseStart: baseLine, baseEnd: baseLine, kind: 'del' }
      open.baseEnd = baseLine + n
      open.kind = open.end > open.start ? 'mod' : 'del'
      baseLine += n
    } else if (change.added) {
      if (!open) open = { start: line, end: line, baseStart: baseLine, baseEnd: baseLine, kind: 'add' }
      open.end = line + n
      open.kind = open.baseEnd > open.baseStart ? 'mod' : 'add'
      line += n
    } else {
      close()
      line += n
      baseLine += n
    }
  }
  close()
  return hunks
}

/** Líneas del hunk en el texto actual (vacío para un `del`). */
export function hunkLines(lines: string[], hunk: LineHunk): string[] {
  return lines.slice(hunk.start, hunk.end)
}

/** Líneas que el hunk quitó de la base (vacío para un `add`). */
export function hunkBaseLines(baseLines: string[], hunk: LineHunk): string[] {
  return baseLines.slice(hunk.baseStart, hunk.baseEnd)
}
