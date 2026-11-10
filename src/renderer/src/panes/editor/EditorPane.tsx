import { useEffect, useRef, type CSSProperties, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { commands } from '@/core/commands/registry'
import { hintFor } from '@/features/palette/Palette'
import { useDocs } from '@/store/docs'
import { useSessions, workspaceOf } from '@/store/sessions'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { Badge } from '@/ui/Badge'
import { Button } from '@/ui/Button'
import { Dot } from '@/ui/Dot'
import { Empty } from '@/ui/Empty'
import { Hint } from '@/ui/Hint'
import { CircleAlert, File, Folder, ICON_SM, TriangleAlert } from '@/ui/icons'
import { Row, RowLabel } from '@/ui/Row'
import { TextArea } from '@/ui/TextArea'
import { attachEditor, detachEditor, getEditor, setComposerText, treeRows, treeSetCursor } from './editor-host'
import { changesLabel, diagnosticsLabel, hunkAt, langOf, relPath } from './editor-logic'
import { useEditor, type LspStatus } from './editor-store'
import './editor.css'

interface Props {
  sessionId: string
  /** Pane con el foco del layout. */
  focused: boolean
}

/**
 * Pane de editor (ARCHITECTURE §3.19): cabecera con los cambios del agente y sus acciones, el árbol
 * lateral (`⌘E`) y el hueco donde `editor-host` reparenta CodeMirror. El compositor de un comentario
 * se pinta por portal dentro del widget que CodeMirror cuelga bajo el hunk.
 */
export function EditorPane({ sessionId, focused }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const uiFocus = useUi((s) => s.focus)
  const session = useSessions((s) => s.sessions.find((x) => x.id === sessionId))
  const workspacePath = useSessions((s) => (session ? workspaceOf(s, session.workspaceId)?.path : undefined))
  const path = session?.args?.[0] ?? ''
  const doc = useEditor((s) => s.docs[sessionId])
  const dirty = useDocs((s) => s.dirty[sessionId] === true)
  const fontSize = useSettings((s) => s.settings.terminalFontSize)
  const composer = doc?.composer ?? null
  const tree = doc?.tree ?? null

  useEffect(() => {
    if (!hostRef.current || !session || !path) return
    attachEditor(sessionId, session.workspaceId, path, hostRef.current)
    return () => detachEditor(sessionId)
  }, [sessionId, session?.workspaceId, path])

  // Si este pane tiene el foco del layout y la intención es "terminal", toma el teclado (como TerminalPane).
  useEffect(() => {
    if (focused && uiFocus === 'terminal') getEditor(sessionId)?.focus()
  }, [sessionId, focused, uiFocus])

  // Tamaño de fuente de la terminal: CodeMirror vuelve a medir al cambiar.
  useEffect(() => {
    getEditor(sessionId)?.fit()
  }, [sessionId, fontSize])

  // El árbol y el compositor toman el teclado al abrirse (el widget entra al DOM un frame después).
  useEffect(() => {
    if (tree) treeRef.current?.focus()
  }, [tree !== null])
  useEffect(() => {
    if (!composer) return
    const frame = requestAnimationFrame(() => composerRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [composer !== null])

  const rel = workspacePath ? relPath(workspacePath, path) : path
  const lang = langOf(path)
  const hunks = doc?.hunks ?? []
  const diagnostics = doc?.diagnostics ?? []
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const tools = doc?.diagnosticTools ?? []
  const current = doc ? hunkAt(hunks, doc.line, doc.lineCount) : null
  const inWorktree = useSessions((s) => (session ? workspaceOf(s, session.workspaceId)?.kind === 'worktree' : false))
  const rows = tree && session ? treeRows({ workspaceId: session.workspaceId }, tree.dir, tree.entries) : []
  const treeDir = tree && workspacePath ? relPath(workspacePath, tree.dir) || '.' : (tree?.dir ?? '')

  return (
    <div className="editor" data-session-id={sessionId} data-mode={doc?.mode ?? 'NORMAL'} data-dirty={dirty || undefined} style={{ '--editor-font-size': `${fontSize}px` } as CSSProperties}>
      <div className="editor__bar" onMouseDown={(e) => e.preventDefault()}>
        {hunks.length > 0 ? (
          <span className="editor__changes" title="Líneas que difieren de la base del repo (HEAD o la base del worktree)">
            <Dot status="question" />
            {changesLabel(hunks.length)}
            {current !== null && <span className="editor__changes-pos">{`${current + 1}/${hunks.length}`}</span>}
          </span>
        ) : (
          <span className="editor__changes" data-muted>
            {!doc?.loaded ? 'Cargando' : doc.base === null ? 'Sin base en el repo' : 'Sin cambios del agente'}
          </span>
        )}
        {diagnostics.length > 0 && (
          <button type="button" className="editor__diagnostics" data-severity={errors > 0 ? 'error' : 'warning'} tabIndex={-1} title={`${diagnosticsLabel(diagnostics)} de ${tools.join(' y ')} · ]d [d para recorrerlos`} onMouseDown={(e) => e.preventDefault()} onClick={() => void commands.run('editor.diagnostic.next')}>
            {errors > 0 ? <CircleAlert {...ICON_SM} aria-hidden="true" /> : <TriangleAlert {...ICON_SM} aria-hidden="true" />}
            {diagnosticsLabel(diagnostics)}
          </button>
        )}
        <span className="editor__actions">
          {doc?.base != null && (
            <Button quiet on={doc.changesOnly} kbd={hintFor('editor.changesOnly', 'terminal')} title={doc.changesOnly ? 'Mostrar el archivo entero' : 'Plegar lo que no cambió'} onClick={() => void commands.run('editor.changesOnly')}>
              Solo cambios
            </Button>
          )}
          <Button quiet kbd={hintFor('review.open', 'terminal')} title={inWorktree ? 'Revisar el worktree' : 'Solo en un worktree'} onClick={() => void commands.run('editor.diff')}>
            Diff
          </Button>
          <Button quiet kbd={hintFor('editor.sendContext', 'terminal')} title="Mandar el archivo, sus cambios y sus errores al agente del workspace" disabled={hunks.length === 0 && diagnostics.length === 0} onClick={() => void commands.run('editor.sendContext')}>
            Al agente
          </Button>
        </span>
        <span className="editor__end">
          {doc?.notice && <Badge title={doc.notice}>{doc.notice}</Badge>}
          {doc?.changedOnDisk && (
            <Badge tone="mark" title="El archivo cambió en disco y el buffer tiene cambios sin guardar">
              cambió en disco · R recargar
            </Badge>
          )}
          <span className="editor__lang" data-lsp={doc?.lsp?.state} title={lspTitle(doc?.lsp ?? null, path)}>
            {doc?.lsp?.state === 'ready' ? doc.lsp.name : doc?.lsp?.state === 'error' ? `${lang.name} · sin servidor` : lang.name}
          </span>
          <Badge tone={doc?.mode === 'INSERT' ? 'solid' : 'soft'} title="Modo de vim">
            {doc?.mode ?? 'NORMAL'}
          </Badge>
        </span>
      </div>
      <div className="editor__body">
        {tree && (
          <div ref={treeRef} className="editor__tree" role="listbox" aria-label="Archivos del workspace" tabIndex={-1}>
            <div className="editor__tree-head" title={tree.dir}>
              {treeDir}
            </div>
            <div className="editor__tree-rows">
              {rows.map((row, i) => (
                <Row
                  key={row.key}
                  id={`tree-${sessionId}-${i}`}
                  level={row.dir ? 1 : 2}
                  cursor={i === tree.cursor}
                  active={row.path === path}
                  title={row.path}
                  onClick={() => {
                    treeSetCursor(sessionId, i)
                    void commands.run('editor.tree.enter')
                  }}
                >
                  {row.dir ? <Folder {...ICON_SM} aria-hidden="true" /> : <File {...ICON_SM} aria-hidden="true" />}
                  <RowLabel>{row.name}</RowLabel>
                </Row>
              ))}
              {!tree.loading && rows.length === 0 && <Empty title="Carpeta vacía" />}
            </div>
          </div>
        )}
        <div className="editor__host" data-selectable>
          <div ref={hostRef} className="editor__view" />
          {doc?.error && (
            <div className="editor__error">
              <Empty title="No se pudo abrir el archivo">{doc.error}</Empty>
            </div>
          )}
        </div>
      </div>
      {composer &&
        createPortal(
          <div className="editor__composer" data-selectable>
            <div className="editor__composer-head">{`${rel}:${composer.line + 1}`}</div>
            <TextArea ref={composerRef} value={composer.text} label="Comentario para el agente" placeholder="Qué cambiar en este bloque" onChange={(text) => setComposerText(sessionId, text)} onSubmit={() => void commands.run('editor.sendComment')} onCancel={() => void commands.run('editor.cancelComment')} />
            <div className="editor__composer-foot">
              <Hint kbd="⌘⏎">enviar al agente</Hint>
              <Hint kbd="Esc">cancelar</Hint>
            </div>
          </div>,
          composer.el
        )}
    </div>
  )
}

/** Tooltip del lenguaje: qué servidor lo atiende y sus teclas, o por qué no hay (§3.19b). */
function lspTitle(lsp: LspStatus | null, path: string): string {
  if (!lsp) return path
  if (lsp.state === 'error') return `${lsp.name} no arrancó: ${lsp.error ?? 'error desconocido'}. Los errores salen de tsc y eslint al guardar.`
  return `${lsp.name} · F12 o gd definición · ⇧F12 o gr referencias · F2 renombrar · errores en vivo`
}
