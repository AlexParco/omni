import { useEffect, useRef, type JSX } from 'react'
import type { DiffFile, DiffHunk, DiffLine } from '@shared/types'
import { commands } from '@/core/commands/registry'
import { cursorForFile, type DiffCursor } from '@/core/diff-nav'
import { prettyChord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { useClock } from '@/store/clock'
import { anchorOf, commentsAt, firstLine, pendingComments, sendLabel, statText, statusLine, type CommentAnchor, type ReviewComment } from '@/store/review-logic'
import { reviewWorkspace, useReview, worktreeAgent } from '@/store/review'
import { agentOf, projectOf, sessionStatus, useSessions } from '@/store/sessions'
import { useSettings } from '@/store/settings'
import { useWorktrees } from '@/store/worktrees'
import { Badge } from '@/ui/Badge'
import { Button } from '@/ui/Button'
import { Dot } from '@/ui/Dot'
import { Empty } from '@/ui/Empty'
import { Hint } from '@/ui/Hint'
import { GitCompare, ICON, ICON_SM, MessageSquare } from '@/ui/icons'
import { Kbd } from '@/ui/Kbd'
import { Row, RowEnd, RowLabel, RowMeta } from '@/ui/Row'
import { TextArea } from '@/ui/TextArea'
import './review.css'

/** Primer atajo de un comando en una capa, ya formateado; nada escrito a mano. */
function keyOf(commandId: string, layer: 'review' | 'global'): string | undefined {
  const chord = keymap.chordsFor(commandId).find((c) => c.layer === layer)?.chord
  return chord ? prettyChord(chord) : undefined
}

/** Teclas de dos comandos pegadas (`] [`), para los hints del pie. */

/** Id DOM de la fila de un archivo en el aside. */
const fileDomId = (i: number): string => `review-file-${i}`
const commentDomId = (id: string): string => `review-comment-${id}`

const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '−', ctx: ' ' }

/**
 * Revisión de un worktree (ARCHITECTURE §3.16): reemplaza el área de panes. Cabecera con el estado del
 * worktree y las acciones, aside de 280 px con archivos y comentarios, cuerpo con los hunks en mono y
 * el compositor bajo la línea del cursor. Las teclas viven en la capa `review` del keymap
 * (`useKeyboard`); aquí solo hay datos, contenedor y clics que corren comandos (o mueven el cursor).
 */
export function ReviewView(): JSX.Element {
  const workspaceId = useReview((s) => s.workspaceId)
  const diff = useReview((s) => s.diff)
  const status = useReview((s) => s.status)
  const loading = useReview((s) => s.loading)
  const error = useReview((s) => s.error)
  const notice = useReview((s) => s.notice)
  const cursor = useReview((s) => s.cursor)
  const comments = useReview((s) => s.comments)
  const composer = useReview((s) => s.composer)
  const setCursor = useReview((s) => s.setCursor)
  const setComposerText = useReview((s) => s.setComposerText)
  const worktreesError = useWorktrees((s) => s.error)
  const workspaces = useSessions((s) => s.workspaces)
  const projects = useSessions((s) => s.projects)
  const sessions = useSessions((s) => s.sessions)
  const agents = useSessions((s) => s.agents)
  const activity = useSessions((s) => s.activity)
  const attention = useSessions((s) => s.attention)
  const busy = useSessions((s) => s.busy)
  const declared = useSessions((s) => s.declared)
  const now = useClock((c) => c.now)
  // Los atajos pintados salen del keymap: se vuelve a pintar cuando el usuario los cambia.
  useSettings((s) => s.settings.keys)
  const rootRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  const ws = reviewWorkspace({ workspaceId }, { workspaces })
  const project = ws ? projectOf({ projects }, ws.projectId) : undefined
  const agent = worktreeAgent({ sessions }, workspaceId)
  const agentDef = agent ? agentOf({ agents }, agent.agent) : undefined
  const agentStatus = agent ? sessionStatus({ activity, attention, busy, declared }, agent.id, now) : null
  const files = diff?.files ?? []
  const pending = pendingComments(comments).length
  const cursorFile = cursor ? files[cursor.file] : undefined
  const editable = cursorFile !== undefined && cursorFile.status !== 'D'

  // El teclado deja la terminal al abrir (`review.open` ya hizo `blurTerminals`); la vista toma el foco DOM.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  // El cursor nunca se sale de la vista al navegar; el compositor toma el foco al abrirse y lo devuelve al cerrarse.
  useEffect(() => {
    bodyRef.current?.querySelector('[data-cursor]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])
  useEffect(() => {
    if (composer) composerRef.current?.focus()
    else rootRef.current?.focus()
  }, [composer !== null])

  const runOnLine = (c: DiffCursor): void => setCursor(c)

  const renderComment = (c: ReviewComment): JSX.Element => (
    <div key={c.id} className="review__comment" data-sent={c.sent || undefined}>
      <MessageSquare {...ICON_SM} size={13} aria-hidden="true" />
      <span className="review__comment-text">{c.text}</span>
      {c.sent && <Badge title="Ya se escribió al agente">enviado</Badge>}
    </div>
  )

  const renderComposer = (): JSX.Element => (
    <div className="review__composer" data-selectable>
      <TextArea ref={composerRef} value={composer?.text ?? ''} label="Comentario" placeholder="Qué cambiar en esta línea" onChange={setComposerText} onSubmit={() => void commands.run('review.saveComment')} onCancel={() => void commands.run('review.cancelComment')} />
      <div className="review__composer-foot">
        <Hint kbd="⌘⏎">guardar</Hint>
        <Hint kbd="Esc">cancelar</Hint>
      </div>
    </div>
  )

  const renderLine = (file: DiffFile, fi: number, hi: number, line: DiffLine, li: number): JSX.Element => {
    const here: DiffCursor = { file: fi, hunk: hi, line: li }
    const isCursor = cursor !== null && cursor.file === fi && cursor.hunk === hi && cursor.line === li
    const anchor = anchorOf(file.path, line)
    const own = anchor ? commentsAt(comments, anchor) : []
    const composing = composer !== null && anchor !== null && composer.path === anchor.path && composer.line === anchor.line && composer.side === anchor.side
    return (
      <div key={li} className="review__line-group">
        <div className="review__line" data-kind={line.kind} data-cursor={isCursor || undefined} onClick={() => runOnLine(here)} onDoubleClick={() => void commands.run('review.comment')}>
          <span className="review__num">{line.old ?? ''}</span>
          <span className="review__num">{line.new ?? ''}</span>
          <span className="review__sign">{SIGN[line.kind]}</span>
          <span className="review__text">{line.text}</span>
        </div>
        {own.map(renderComment)}
        {composing && renderComposer()}
      </div>
    )
  }

  const renderHunk = (file: DiffFile, fi: number, hunk: DiffHunk, hi: number): JSX.Element => (
    <div key={hi} className="review__hunk">
      <div className="review__hunk-head">{hunk.header}</div>
      {hunk.lines.map((line, li) => renderLine(file, fi, hi, line, li))}
    </div>
  )

  const renderFile = (file: DiffFile, fi: number): JSX.Element => (
    <section key={file.path} className="review__file" data-status={file.status} data-cursor-file={cursor?.file === fi || undefined} aria-label={file.path}>
      <header className="review__file-head" onClick={() => setCursor(cursorForFile(files, fi))}>
        <span className="review__status" data-status={file.status}>
          {file.status}
        </span>
        <span className="review__path">{file.path}</span>
        <span className="review__stat">{statText(file.additions, file.deletions)}</span>
      </header>
      {file.binary ? <p className="review__binary">binario, sin diff</p> : file.hunks.map((h, hi) => renderHunk(file, fi, h, hi))}
    </section>
  )

  const renderFileRow = (file: DiffFile, fi: number): JSX.Element => (
    <Row key={file.path} id={fileDomId(fi)} level={1} cursor={cursor?.file === fi} title={`${file.path} · ${statText(file.additions, file.deletions)}`} onClick={() => setCursor(cursorForFile(files, fi))}>
      <span className="review__status" data-status={file.status}>
        {file.status}
      </span>
      <RowLabel>{file.path}</RowLabel>
      <RowEnd>
        <span className="review__stat">{statText(file.additions, file.deletions)}</span>
      </RowEnd>
    </Row>
  )

  /** Cursor sobre la línea de un comentario (clic en el aside); un desfasado no tiene línea. */
  const cursorOf = (c: ReviewComment): DiffCursor | null => {
    if (c.stale) return null
    const anchor: CommentAnchor = c
    for (let fi = 0; fi < files.length; fi++) {
      if (files[fi].path !== anchor.path) continue
      for (let hi = 0; hi < files[fi].hunks.length; hi++) {
        const li = files[fi].hunks[hi].lines.findIndex((l) => {
          const a = anchorOf(anchor.path, l)
          return a !== null && a.line === anchor.line && a.side === anchor.side
        })
        if (li !== -1) return { file: fi, hunk: hi, line: li }
      }
    }
    return null
  }

  const renderCommentRow = (c: ReviewComment): JSX.Element => (
    <Row key={c.id} id={commentDomId(c.id)} level={1} title={`${c.path}:${c.line} · ${c.text}`} onClick={() => setCursor(cursorOf(c) ?? cursor)}>
      <MessageSquare {...ICON_SM} aria-hidden="true" />
      <RowLabel>{firstLine(c.text)}</RowLabel>
      <RowMeta>
        {c.path}:{c.line}
      </RowMeta>
      {(c.sent || c.stale) && (
        <RowEnd>
          {c.stale && <Badge title="Su línea ya no está en el diff: se envía con la línea vieja">desfasado</Badge>}
          {c.sent && <Badge title="Ya se escribió al agente">enviado</Badge>}
        </RowEnd>
      )}
    </Row>
  )

  const problem = error ?? worktreesError

  return (
    <main ref={rootRef} className="review" tabIndex={-1} aria-label="Revisión" data-focus="list">
      <header className="review__head">
        <div className="review__head-row">
          <GitCompare {...ICON} aria-hidden="true" />
          <span className="review__title">Revisión · {project?.name ?? ws?.name ?? ''}</span>
          {agent && (
            <>
              <Badge title={agentDef?.name}>{agentDef?.badge ?? agent.agent}</Badge>
              {agentStatus && <Dot status={agentStatus} />}
            </>
          )}
          {!agent && <span className="review__noagent">sin agente</span>}
          <div className="review__actions">
            <Button quiet kbd={keyOf('review.editor', 'review')} title="Abrir el archivo bajo el cursor con la app del sistema" disabled={!editable} onClick={() => void commands.run('review.editor')}>
              Editor
            </Button>
            <Button quiet variant="danger" kbd={keyOf('review.discard', 'review')} title="Borrar el worktree y su rama" onClick={() => void commands.run('review.discard')}>
              Descartar
            </Button>
            <Button quiet kbd={keyOf('review.send', 'review')} title={agent ? 'Escribir los comentarios pendientes al agente' : 'Sin agente: se copian al portapapeles'} disabled={pending === 0} onClick={() => void commands.run('review.send')}>
              {sendLabel(pending)}
            </Button>
            <Button quiet variant="primary" kbd={keyOf('review.merge', 'review')} title="Squash-merge en el workspace local y limpiar el worktree" disabled={!diff} onClick={() => void commands.run('review.merge')}>
              Merge
            </Button>
          </div>
        </div>
        <div className="review__head-line">{diff ? statusLine(diff, status?.tests) : loading ? 'cargando el diff' : ''}</div>
      </header>

      <div className="review__body">
        <aside className="review__aside">
          <div className="review__aside-title">Archivos</div>
          <div className="review__files" role="listbox" aria-label="Archivos del diff" aria-activedescendant={cursor ? fileDomId(cursor.file) : undefined}>
            {files.map(renderFileRow)}
            {files.length === 0 && !loading && <p className="review__aside-empty">Sin cambios</p>}
          </div>
          <div className="review__aside-title">Comentarios</div>
          <div className="review__comments" role="listbox" aria-label="Comentarios">
            {comments.map(renderCommentRow)}
            {comments.length === 0 && (
              <p className="review__aside-empty">
                <Kbd>{keyOf('review.comment', 'review') ?? 'C'}</Kbd> comenta la línea del cursor
              </p>
            )}
          </div>
        </aside>

        <div ref={bodyRef} className="review__diff" data-selectable aria-label="Diff">
          {files.map(renderFile)}
          {diff?.truncated && <p className="review__truncated">El diff se cortó por tamaño (tope 2 MB): revisa el resto en el editor.</p>}
          {!loading && diff && files.length === 0 && (
            <Empty title="Sin cambios">
              <span>El worktree está igual que su base.</span>
            </Empty>
          )}
          {!loading && !diff && (
            <Empty title={error ? 'No se pudo leer el diff' : 'Sin diff'}>
              <span>{error ?? 'Nada que revisar.'}</span>
            </Empty>
          )}
        </div>
      </div>

      {(problem || notice) && (
        <footer className="review__foot">
          <span className="review__foot-end" data-error={problem ? true : undefined} role="status">
            {problem ?? notice}
          </span>
        </footer>
      )}
    </main>
  )
}
