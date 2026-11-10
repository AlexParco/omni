import type { DiffFile, DiffLine, TestsResult, WorkspaceDiff } from '@shared/types'

/**
 * Lógica pura de la revisión (ARCHITECTURE §3.16): a qué línea se pega un comentario, cómo se
 * agrupan, cómo se formatean para mandarlos al agente y qué dice la línea de estado de la cabecera.
 * Sin React, sin IPC: el store la orquesta y los tests la cubren.
 */

export type CommentSide = 'new' | 'old'

export interface ReviewComment {
  id: string
  path: string
  /** Número de línea en el lado `side`: el nuevo para añadidas y contexto, el viejo para borradas. */
  line: number
  side: CommentSide
  /** Texto de la línea al comentar: por él se re-ancla tras una recarga. */
  lineText: string
  text: string
  /** Ya se escribió al agente (o se copió al portapapeles). */
  sent: boolean
  /** Tras una recarga su línea ya no está en el diff: se lista en el aside, no se pinta en el cuerpo, y se envía con la línea vieja. */
  stale: boolean
}

/** Dónde se ancla un comentario: lado, número y texto de la línea bajo el cursor (el texto permite re-anclar al renumerar). */
export interface CommentAnchor {
  path: string
  line: number
  side: CommentSide
  lineText: string
}

/** Una línea borrada solo existe en el lado viejo; el resto se comenta sobre el nuevo. */
export function anchorOf(path: string, line: DiffLine): CommentAnchor | null {
  if (line.kind === 'del') return line.old === null ? null : { path, line: line.old, side: 'old', lineText: line.text }
  return line.new === null ? null : { path, line: line.new, side: 'new', lineText: line.text }
}

/**
 * Vuelve a anclar los comentarios sobre un diff recargado (el agente renumera al editar): por
 * `(path, side, texto de la línea)`, eligiendo la coincidencia más cercana a la línea vieja. Sin
 * coincidencia, el comentario queda `stale` con su línea vieja; si reaparece, vuelve a estar al día.
 */
export function reanchorComments(files: readonly DiffFile[], comments: readonly ReviewComment[]): ReviewComment[] {
  return comments.map((c) => {
    const candidates: number[] = []
    for (const f of files) {
      if (f.path !== c.path) continue
      for (const h of f.hunks) for (const l of h.lines) {
        const a = anchorOf(f.path, l)
        if (a && a.side === c.side && a.lineText === c.lineText) candidates.push(a.line)
      }
    }
    if (candidates.length === 0) return c.stale ? c : { ...c, stale: true }
    const line = candidates.reduce((best, n) => (Math.abs(n - c.line) < Math.abs(best - c.line) ? n : best))
    return line === c.line && !c.stale ? c : { ...c, line, stale: false }
  })
}

export function sameAnchor(a: CommentAnchor, b: CommentAnchor): boolean {
  return a.path === b.path && a.line === b.line && a.side === b.side
}

/** Comentarios pegados a esa línea (los desfasados no se pintan en el cuerpo), en orden de creación. */
export function commentsAt(comments: readonly ReviewComment[], anchor: CommentAnchor): ReviewComment[] {
  return comments.filter((c) => !c.stale && sameAnchor(c, anchor))
}

export function newComment(anchor: CommentAnchor, text: string, id: string = crypto.randomUUID()): ReviewComment {
  return { id, ...anchor, text: text.trim(), sent: false, stale: false }
}

export const pendingComments = (comments: readonly ReviewComment[]): ReviewComment[] => comments.filter((c) => !c.sent)

/**
 * Texto que se escribe al agente: `Revisión de omni/<name>:` y una viñeta `- path:line: texto` por
 * comentario; las líneas extra de un comentario van sangradas bajo su viñeta. Un comentario
 * desfasado va con su línea vieja y la marca `(desfasado)`.
 */
export function formatComments(branch: string, comments: readonly ReviewComment[]): string {
  const bullets = comments.map((c) => {
    const [first = '', ...rest] = c.text.split('\n')
    const where = c.stale ? `${c.path}:${c.line} (desfasado)` : `${c.path}:${c.line}`
    return [`- ${where}: ${first}`, ...rest.map((l) => `  ${l}`)].join('\n')
  })
  return [`Revisión de ${branch}:`, ...bullets].join('\n')
}

/** Primera línea de un comentario, para el aside. */
export const firstLine = (text: string): string => text.split('\n')[0] ?? ''

/** `+34 −9`, con el signo menos tipográfico. */
export const statText = (additions: number, deletions: number): string => `+${additions} −${deletions}`

export const TESTS_LABEL: Record<TestsResult['status'], string> = { pass: 'tests ok', fail: 'tests fallaron', running: 'tests corriendo' }

export function testsLabel(tests: TestsResult | null | undefined): string {
  return tests ? TESTS_LABEL[tests.status] : 'tests sin correr'
}

/** Totales del diff, sumando archivo a archivo (`stat` de main puede ir 5 s por detrás). */
export function totalsOf(files: readonly DiffFile[]): { files: number; additions: number; deletions: number } {
  return files.reduce((acc, f) => ({ files: acc.files + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }), { files: 0, additions: 0, deletions: 0 })
}

/** Línea mono de la cabecera: `omni/x → main · 3 archivos · +34 −9 · tests ok`. */
export function statusLine(diff: Pick<WorkspaceDiff, 'branch' | 'base' | 'files'>, tests: TestsResult | null | undefined): string {
  const t = totalsOf(diff.files)
  const files = t.files === 1 ? '1 archivo' : `${t.files} archivos`
  return `${diff.branch} → ${diff.base} · ${files} · ${statText(t.additions, t.deletions)} · ${testsLabel(tests)}`
}

/** Etiqueta del botón de enviar: `Enviar 1 comentario` / `Enviar 3 comentarios`. */
export function sendLabel(pending: number): string {
  if (pending === 0) return 'Enviar comentarios'
  return pending === 1 ? 'Enviar 1 comentario' : `Enviar ${pending} comentarios`
}

/** Fence que no choca con el contenido: uno más largo que la racha de backticks más larga del texto. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return '`'.repeat(longest + 1)
}

/** Diff unificado de un archivo, como lo pinta GitHub en un bloque ```diff. */
function fileDiffText(f: DiffFile): string {
  return f.hunks.map((h) => [h.header, ...h.lines.map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)].join('\n')).join('\n')
}

const STATUS_WORD: Record<DiffFile['status'], string> = { M: 'modificado', A: 'nuevo', D: 'borrado', R: 'renombrado' }

/**
 * Revisión en Markdown para pegar en un PR: resumen (`rama → base`, totales, tests), archivos con sus
 * cambios, los comentarios por archivo con su línea y el diff de cada archivo en un `<details>` plegado
 * (GitHub lo renderiza). Los comentarios desfasados llevan su marca. Pura: exportada para tests.
 */
export function reviewMarkdown(diff: Pick<WorkspaceDiff, 'branch' | 'base' | 'files' | 'truncated'>, comments: readonly ReviewComment[], tests: TestsResult | null | undefined): string {
  const t = totalsOf(diff.files)
  const out: string[] = [`## Revisión de \`${diff.branch}\` → \`${diff.base}\``, '']
  out.push(`${t.files === 1 ? '1 archivo' : `${t.files} archivos`} · ${statText(t.additions, t.deletions)} · ${testsLabel(tests)}`)
  if (tests?.status === 'fail' && tests.summary) out.push('', `> ${tests.summary}`)
  out.push('', '### Archivos', '')
  for (const f of diff.files) out.push(`- \`${f.path}\` (${STATUS_WORD[f.status]}, ${f.binary ? 'binario' : statText(f.additions, f.deletions)})`)
  if (comments.length > 0) {
    out.push('', '### Comentarios')
    const byFile = new Map<string, ReviewComment[]>()
    for (const c of comments) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c])
    for (const [path, list] of byFile) {
      out.push('', `**\`${path}\`**`, '')
      for (const c of [...list].sort((a, b) => a.line - b.line)) {
        const [first = '', ...rest] = c.text.split('\n')
        out.push(`- Línea ${c.line}${c.side === 'old' ? ' (borrada)' : ''}${c.stale ? ' (desfasado)' : ''}: ${first}`, ...rest.map((l) => `  ${l}`))
        if (c.lineText.trim()) out.push(`  > \`${c.lineText.trim().replace(/`/g, "'")}\``)
      }
    }
  }
  const textual = diff.files.filter((f) => !f.binary && f.hunks.length > 0)
  if (textual.length > 0) {
    out.push('', '### Diff')
    for (const f of textual) {
      const body = fileDiffText(f)
      const fence = fenceFor(body)
      out.push('', `<details><summary><code>${f.path}</code> ${statText(f.additions, f.deletions)}</summary>`, '', `${fence}diff`, body, fence, '', '</details>')
    }
  }
  if (diff.truncated) out.push('', '_El diff se cortó por tamaño: faltan archivos._')
  return out.join('\n') + '\n'
}
