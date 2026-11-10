import type { CodeDiagnostic, SessionInfo, Workspace } from '@shared/types'
import { hunkBaseLines, hunkLines, splitLines, type LineHunk } from '@/core/line-diff'

/**
 * Lógica pura del pane de editor (ARCHITECTURE §3.19): qué hunk se considera "visto", en qué hunk
 * está el cursor, qué lenguaje va por extensión y cómo se formatea lo que se manda al agente. Sin
 * CodeMirror ni stores: todo se prueba en Node.
 */

/** Hunk aceptado con `A`: deja de pintarse mientras exista un hunk con el mismo rango de base y el mismo texto. */
export interface SeenHunk {
  baseStart: number
  baseEnd: number
  text: string
}

export function hunkText(lines: string[], hunk: LineHunk): string {
  return hunkLines(lines, hunk).join('\n')
}

export function isSeen(hunk: LineHunk, lines: string[], seen: SeenHunk[]): boolean {
  const text = hunkText(lines, hunk)
  return seen.some((s) => s.baseStart === hunk.baseStart && s.baseEnd === hunk.baseEnd && s.text === text)
}

/** Marca el hunk como visto (sin repetir). */
export function markSeen(hunk: LineHunk, lines: string[], seen: SeenHunk[]): SeenHunk[] {
  if (isSeen(hunk, lines, seen)) return seen
  return [...seen, { baseStart: hunk.baseStart, baseEnd: hunk.baseEnd, text: hunkText(lines, hunk) }]
}

/** Hunks que se pintan: los que no se aceptaron (o cuyo texto volvió a cambiar desde entonces). */
export function visibleHunks(hunks: LineHunk[], lines: string[], seen: SeenHunk[]): LineHunk[] {
  return hunks.filter((h) => !isSeen(h, lines, seen))
}

/**
 * Índice del hunk que contiene la línea del cursor (base 0). Un `del` (sin líneas propias) se
 * considera "en" la línea ante la que se pinta, o la última si borra al final del archivo.
 */
export function hunkAt(hunks: LineHunk[], line: number, lineCount: number): number | null {
  const i = hunks.findIndex((h) => (h.end > h.start ? line >= h.start && line < h.end : line === Math.min(h.start, Math.max(0, lineCount - 1))))
  return i === -1 ? null : i
}

/** Línea donde se posa el cursor para "ir al hunk": su primera línea, o la línea ante la que se pinta un `del`. */
export function hunkAnchorLine(hunk: LineHunk, lineCount: number): number {
  return Math.min(hunk.start, Math.max(0, lineCount - 1))
}

/**
 * Siguiente (`delta` 1) o anterior (`-1`) hunk respecto a la línea del cursor, con vuelta al principio
 * o al final. `null` sin hunks.
 */
export function nextHunkIndex(hunks: LineHunk[], line: number, lineCount: number, delta: 1 | -1): number | null {
  if (hunks.length === 0) return null
  const anchors = hunks.map((h) => hunkAnchorLine(h, lineCount))
  if (delta === 1) {
    const i = anchors.findIndex((a) => a > line)
    return i === -1 ? 0 : i
  }
  for (let i = anchors.length - 1; i >= 0; i--) if (anchors[i] < line) return i
  return anchors.length - 1
}

/* ---------- lenguaje por extensión ---------- */

export type LangId = 'javascript' | 'typescript' | 'jsx' | 'tsx' | 'json' | 'markdown' | 'css' | 'html' | 'python' | 'go' | 'rust' | 'yaml'

export interface LangInfo {
  id: LangId | null
  /** Nombre visible en la franja ("TypeScript"). */
  name: string
}

const LANGS: Record<string, LangInfo> = {
  js: { id: 'javascript', name: 'JavaScript' },
  mjs: { id: 'javascript', name: 'JavaScript' },
  cjs: { id: 'javascript', name: 'JavaScript' },
  jsx: { id: 'jsx', name: 'JSX' },
  ts: { id: 'typescript', name: 'TypeScript' },
  mts: { id: 'typescript', name: 'TypeScript' },
  cts: { id: 'typescript', name: 'TypeScript' },
  tsx: { id: 'tsx', name: 'TSX' },
  json: { id: 'json', name: 'JSON' },
  md: { id: 'markdown', name: 'Markdown' },
  markdown: { id: 'markdown', name: 'Markdown' },
  css: { id: 'css', name: 'CSS' },
  html: { id: 'html', name: 'HTML' },
  htm: { id: 'html', name: 'HTML' },
  py: { id: 'python', name: 'Python' },
  go: { id: 'go', name: 'Go' },
  rs: { id: 'rust', name: 'Rust' },
  yaml: { id: 'yaml', name: 'YAML' },
  yml: { id: 'yaml', name: 'YAML' }
}

export function langOf(path: string): LangInfo {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  return LANGS[ext] ?? { id: null, name: ext ? ext.toUpperCase() : 'Texto' }
}

/* ---------- rutas y workspaces ---------- */

/** Ruta relativa al workspace (con `/`); la absoluta si no cuelga de él. */
export function relPath(workspacePath: string, path: string): string {
  const root = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`
  return path.startsWith(root) ? path.slice(root.length) : path
}

/** Workspace que contiene la ruta: el actual si la contiene, si no el de raíz más larga que la contenga. */
export function workspaceOfPath(workspaces: Workspace[], path: string, currentId: string | null): Workspace | undefined {
  const contains = (w: Workspace): boolean => path === w.path || path.startsWith(w.path.endsWith('/') ? w.path : `${w.path}/`)
  const current = workspaces.find((w) => w.id === currentId)
  if (current && contains(current)) return current
  return workspaces.filter(contains).sort((a, b) => b.path.length - a.path.length)[0]
}

/** Agente del workspace al que se le mandan comentarios: la primera sesión que no es shell, navegador ni documento. */
export function workspaceAgent(sessions: SessionInfo[], workspaceId: string): SessionInfo | undefined {
  return sessions.find((x) => x.workspaceId === workspaceId && x.agent !== 'shell' && x.agent !== 'browser' && x.agent !== 'editor' && x.agent !== 'preview')
}

/* ---------- texto al agente ---------- */

/** `archivo:línea: texto` (línea base 1 de la primera línea del hunk). */
export function formatComment(rel: string, line: number, text: string): string {
  return `${rel}:${line}: ${text.trim()}`
}

/**
 * Archivo, hunks y errores como contexto (`⌥⌘A`): cabecera y, por hunk, sus líneas con `-`/`+`;
 * después, los errores y avisos de tsc/eslint como `archivo:línea:col: [herramienta código] mensaje`.
 */
export function formatContext(rel: string, hunks: LineHunk[], lines: string[], baseLines: string[], diagnostics: readonly CodeDiagnostic[] = []): string {
  const out = hunks.length > 0 ? [`Archivo ${rel}: ${hunks.length} ${hunks.length === 1 ? 'cambio' : 'cambios'} respecto a la base`] : [`Archivo ${rel}`]
  hunks.forEach((h) => {
    const where = h.end > h.start ? `líneas ${h.start + 1}-${h.end}` : `antes de la línea ${h.start + 1}`
    out.push('', `@@ ${where} (${h.kind}) @@`)
    hunkBaseLines(baseLines, h).forEach((l) => out.push(`-${l}`))
    hunkLines(lines, h).forEach((l) => out.push(`+${l}`))
  })
  if (diagnostics.length > 0) {
    out.push('', diagnosticsLabel(diagnostics) + ':')
    diagnostics.forEach((d) => out.push(`${rel}:${d.line}:${d.col}: [${d.source}${d.code ? ` ${d.code}` : ''}] ${d.message.split('\n')[0]}`))
  }
  return out.join('\n')
}

/* ---------- diagnósticos (tsc, eslint) ---------- */

/** `2 errores · 1 aviso` (sin ceros); `''` sin diagnósticos. */
export function diagnosticsLabel(diagnostics: readonly CodeDiagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.length - errors
  const parts: string[] = []
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errores'}`)
  if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? 'aviso' : 'avisos'}`)
  return parts.join(' · ')
}

/**
 * Rango (offsets en el texto) que subraya un diagnóstico: el que da la herramienta, o desde la
 * columna hasta el final de la palabra (tsc solo marca el inicio). Recortado al texto; nunca vacío
 * salvo en una línea vacía.
 */
export function diagnosticRange(lineStarts: readonly number[], text: string, d: Pick<CodeDiagnostic, 'line' | 'col' | 'endLine' | 'endCol'>): { from: number; to: number } {
  const lineFrom = (n: number): number => lineStarts[Math.min(Math.max(n, 1), lineStarts.length) - 1] ?? 0
  const lineEnd = (n: number): number => {
    const next = lineStarts[Math.min(Math.max(n, 1), lineStarts.length)]
    return next === undefined ? text.length : next - 1
  }
  const from = Math.min(lineFrom(d.line) + d.col - 1, lineEnd(d.line))
  if (d.endLine !== null && d.endCol !== null) {
    const to = Math.min(lineFrom(d.endLine) + d.endCol - 1, text.length)
    if (to > from) return { from, to }
  }
  let to = from
  while (to < lineEnd(d.line) && /[\w$]/.test(text[to])) to++
  if (to === from) to = Math.min(from + 1, lineEnd(d.line))
  return { from, to }
}

/* ---------- diff con @codemirror/merge ---------- */

/**
 * Texto contra el que compara el merge view: la base con los hunks ya aceptados (`A`) aplicados,
 * para que lo visto no se vuelva a pintar. `all` son todos los hunks del buffer contra la base y
 * `visible` los que siguen pendientes.
 */
export function comparisonText(baseText: string, baseLines: string[], lines: string[], all: readonly LineHunk[], visible: readonly LineHunk[]): string {
  const accepted = all.filter((h) => !visible.includes(h))
  if (accepted.length === 0) return baseText
  const out = [...baseLines]
  // De abajo arriba: cada reemplazo no mueve los índices de los hunks que quedan por aplicar.
  ;[...accepted].sort((a, b) => b.baseStart - a.baseStart).forEach((h) => out.splice(h.baseStart, h.baseEnd - h.baseStart, ...lines.slice(h.start, h.end)))
  if (out.length === 0) return ''
  return out.join('\n') + (baseText.endsWith('\n') || baseText === '' ? '\n' : '')
}

/** Resumen de la cabecera del pane: `n cambios del agente`. */
export function changesLabel(n: number): string {
  return `${n} ${n === 1 ? 'cambio' : 'cambios'} del agente`
}

/** Texto nuevo tras revertir un hunk: el rango actual se reemplaza por las líneas de la base. */
export function revertedLines(lines: string[], baseLines: string[], hunk: LineHunk): string[] {
  return [...lines.slice(0, hunk.start), ...hunkBaseLines(baseLines, hunk), ...lines.slice(hunk.end)]
}

/**
 * Texto completo del buffer tras revertir el hunk. El salto de línea final se conserva tal como
 * estaba (o se pone uno si el buffer estaba vacío); si no queda ninguna línea, el texto es vacío.
 */
export function revertedText(text: string, baseLines: string[], hunk: LineHunk): string {
  const lines = revertedLines(splitLines(text), baseLines, hunk)
  if (lines.length === 0) return ''
  return lines.join('\n') + (text.endsWith('\n') || text === '' ? '\n' : '')
}
