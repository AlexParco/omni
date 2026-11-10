import type { DiffFile, DiffLine } from '@shared/types'

/**
 * Navegación pura por un diff (ARCHITECTURE §3.16): el cursor de la revisión es una terna de
 * índices `{ file, hunk, line }` sobre `WorkspaceDiff.files`. Sin React ni stores: el store la
 * orquesta y los tests la cubren. Los archivos sin hunks (binarios, vacíos) existen para la
 * navegación por archivo pero no tienen líneas: ahí `hunk` y `line` valen 0 y `lineAt` es `null`.
 */
export interface DiffCursor {
  file: number
  hunk: number
  line: number
}

/** Línea aplanada: su posición en el diff. El orden de la lista es el de lectura. */
export type FlatLine = DiffCursor

/** Todas las líneas del diff en orden de lectura. */
export function flattenLines(files: readonly DiffFile[]): FlatLine[] {
  const out: FlatLine[] = []
  files.forEach((f, file) => f.hunks.forEach((h, hunk) => h.lines.forEach((_, line) => out.push({ file, hunk, line }))))
  return out
}

const same = (a: DiffCursor, b: DiffCursor): boolean => a.file === b.file && a.hunk === b.hunk && a.line === b.line
/** Orden de lectura: por archivo, luego hunk, luego línea. */
const before = (a: DiffCursor, b: DiffCursor): boolean => a.file < b.file || (a.file === b.file && (a.hunk < b.hunk || (a.hunk === b.hunk && a.line < b.line)))

export function fileAt(files: readonly DiffFile[], cursor: DiffCursor | null): DiffFile | null {
  return cursor ? (files[cursor.file] ?? null) : null
}

export function lineAt(files: readonly DiffFile[], cursor: DiffCursor | null): DiffLine | null {
  return cursor ? (files[cursor.file]?.hunks[cursor.hunk]?.lines[cursor.line] ?? null) : null
}

/** Cursor inicial: la primera línea del diff, o el primer archivo si ninguno tiene líneas; `null` sin archivos. */
export function firstCursor(files: readonly DiffFile[]): DiffCursor | null {
  if (files.length === 0) return null
  return flattenLines(files)[0] ?? { file: 0, hunk: 0, line: 0 }
}

/**
 * Cursor válido para un diff nuevo (recarga): se queda si su línea sigue existiendo; si no, baja a
 * la línea más cercana de su archivo, o al primer archivo.
 */
export function clampCursor(files: readonly DiffFile[], cursor: DiffCursor | null): DiffCursor | null {
  if (cursor === null) return firstCursor(files)
  if (lineAt(files, cursor)) return cursor
  const file = files[cursor.file]
  if (!file) return firstCursor(files)
  if (file.hunks.length === 0) return { file: cursor.file, hunk: 0, line: 0 }
  const hunk = Math.min(cursor.hunk, file.hunks.length - 1)
  const line = Math.min(cursor.line, file.hunks[hunk].lines.length - 1)
  return { file: cursor.file, hunk, line: Math.max(0, line) }
}

/** Línea siguiente o anterior en orden de lectura, cruzando hunks y archivos; en los extremos se queda. */
export function cursorAfterLine(files: readonly DiffFile[], cursor: DiffCursor | null, delta: number): DiffCursor | null {
  const flat = flattenLines(files)
  if (cursor === null) return firstCursor(files)
  if (flat.length === 0) return cursor
  const i = flat.findIndex((l) => same(l, cursor))
  if (i === -1) {
    // El cursor está en un archivo sin líneas (binario): la primera línea que viene, o la última que quedó atrás.
    const next = flat.find((l) => l.file > cursor.file)
    const prev = [...flat].reverse().find((l) => l.file < cursor.file)
    return (delta > 0 ? (next ?? prev) : (prev ?? next)) ?? cursor
  }
  return flat[Math.max(0, Math.min(flat.length - 1, i + delta))]
}

/** Primera línea del hunk siguiente o anterior (cruzando archivos); en los extremos se queda. */
export function cursorAfterHunk(files: readonly DiffFile[], cursor: DiffCursor | null, delta: number): DiffCursor | null {
  const starts = flattenLines(files).filter((l) => l.line === 0)
  if (cursor === null) return firstCursor(files)
  if (starts.length === 0) return cursor
  const here = { file: cursor.file, hunk: cursor.hunk, line: 0 }
  if (delta > 0) return starts.find((s) => before(here, s)) ?? cursor
  return [...starts].reverse().find((s) => before(s, here)) ?? cursor
}

/** Primera línea del archivo siguiente o anterior (también los que no tienen líneas); en los extremos se queda. */
export function cursorAfterFile(files: readonly DiffFile[], cursor: DiffCursor | null, delta: number): DiffCursor | null {
  if (cursor === null) return firstCursor(files)
  if (files.length === 0) return cursor
  const file = Math.max(0, Math.min(files.length - 1, cursor.file + delta))
  return file === cursor.file ? cursor : { file, hunk: 0, line: 0 }
}

/** Cursor sobre la primera línea de un archivo (clic en el aside). */
export function cursorForFile(files: readonly DiffFile[], file: number): DiffCursor | null {
  return files[file] ? { file, hunk: 0, line: 0 } : null
}
