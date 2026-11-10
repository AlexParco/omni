import DOMPurify from 'dompurify'
import { useEffect, useLayoutEffect, useMemo, useRef, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import { commands } from '@/core/commands/registry'
import { hintFor } from '@/features/palette/Palette'
import { useLayout } from '@/store/layout'
import { usePreview, type PreviewDoc } from '@/store/preview'
import { ALLOWED_URI, baseName, toFileUrl, typeLabel, zoomLabel } from '@/store/preview-logic'
import { useSessions } from '@/store/sessions'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { Badge } from '@/ui/Badge'
import { Empty } from '@/ui/Empty'
import { IconButton } from '@/ui/Button'
import { ArrowLeft, Code2, ICON, Minus, Plus } from '@/ui/icons'
import { focusStays } from '@/panes/pane-focus'
import { renderMarkdown } from './markdown'
import { registerPreviewPane, unregisterPreviewPane } from './preview-host'
import './preview.css'

interface Props {
  sessionId: string
  /** Pane con el foco del layout. */
  focused: boolean
}

/** Solo HTML (sin SVG ni MathML en línea) y con `omni-file:` permitido en las imágenes (`ALLOWED_URI`, con tests). */
function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ALLOWED_URI_REGEXP: ALLOWED_URI, FORBID_TAGS: ['style', 'form', 'input', 'button'] })
}

/** URL del archivo por el protocolo, con la versión para que `<img>` y el visor PDF recarguen al cambiar en disco. */
function fileUrl(doc: PreviewDoc): string | null {
  const url = toFileUrl(doc.workspaceId, doc.workspacePath, doc.path)
  return url ? `${url}?v=${doc.version}` : null
}

/**
 * Pane de vista previa (ARCHITECTURE §3.20): barra con atrás, nombre, tipo, aviso, zoom (imágenes) y
 * el botón para abrir el editor del mismo archivo al lado; debajo el documento. Markdown pasa por
 * `markdown-it` y `DOMPurify`; imágenes y PDF llegan por `omni-file://`. El store vigila el archivo
 * mientras el pane está montado (`file:watch`) y escucha `file:changed` una sola vez para todos.
 *
 * Foco: la raíz es enfocable (`tabindex=-1`), como la del navegador; su focus/blur mantienen `ui.focus`.
 */
export function PreviewPane({ sessionId, focused }: Props): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const doc = usePreview((s) => s.docs[sessionId])
  const open = usePreview((s) => s.open)
  const close = usePreview((s) => s.close)
  const live = useUi((s) => s.focus === 'terminal')
  // Los atajos de la barra salen del keymap: se vuelve a pintar cuando el usuario los cambia.
  useSettings((s) => s.settings.keys)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    registerPreviewPane(sessionId, root)
    // `open` vigila el archivo (`file:watch`); `file:changed` lo escucha el store una sola vez para todos los panes.
    void open(sessionId)
    return () => {
      unregisterPreviewPane(sessionId, root)
      close(sessionId)
    }
  }, [sessionId, open, close])

  // Con el foco del layout y la intención en `terminal`, el teclado va a la raíz: al montar (pane
  // nuevo, remontaje por zoom o split) y cuando `pane.next` o la lista caen aquí.
  useEffect(() => {
    const root = rootRef.current
    if (!focused || !live || !root) return
    if (document.activeElement && root.contains(document.activeElement)) return
    if (useUi.getState().overlay !== null) return
    root.focus()
  }, [focused, live])

  // Documento nuevo: arriba del todo. Con `#anchor` pendiente, al encabezado (y se olvida).
  const hash = doc?.pendingHash ?? null
  const text = doc?.kind === 'md' ? doc.text : null
  const docPath = doc?.path
  const workspaceId = doc?.workspaceId
  const workspacePath = doc?.workspacePath
  const kind = doc?.kind
  // Solo se vuelve a pintar el Markdown cuando cambia el texto o el archivo, no con cada aviso o zoom.
  const html = useMemo(() => {
    if (text === null || docPath === undefined || workspaceId === undefined || workspacePath === undefined) return ''
    return sanitize(renderMarkdown(text, { workspaceId, workspacePath, docPath }))
  }, [text, docPath, workspaceId, workspacePath])
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || hash === null) return
    // Tras seguir `otro.md#x` el texto llega después: se espera a que la prosa esté pintada.
    if (kind === 'md' && html === '') return
    if (kind === 'md') body.querySelector(`#${CSS.escape(hash)}`)?.scrollIntoView({ block: 'start' })
    usePreview.getState().clearHash(sessionId)
  }, [sessionId, kind, hash, html])
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [docPath])

  // Zoom efectivo con la imagen ajustada: lo que `+` y `-` toman como punto de partida.
  useEffect(() => {
    const img = imgRef.current
    if (!img || kind !== 'image') return
    const measure = (): void => {
      if (img.naturalWidth > 0 && usePreview.getState().docs[sessionId]?.zoom === null) usePreview.getState().setFitScale(sessionId, img.clientWidth / img.naturalWidth)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(img)
    measure()
    return () => observer.disconnect()
  }, [sessionId, kind, docPath])

  const onFocus = (): void => {
    useUi.getState().setFocus('terminal')
    useLayout.getState().focusSession(sessionId)
    useSessions.getState().syncCursor(sessionId)
  }
  const onBlur = (): void => {
    // Mismo criterio que el textarea de xterm, un tick después: si el foco fue a un overlay o a otro
    // pane no pasa nada; si el pane murió, la intención sigue en `terminal`.
    const root = rootRef.current
    setTimeout(() => {
      // Misma regla que terminal, navegador y editor (`panes/pane-focus.ts`).
      if (focusStays(document.activeElement)) return
      if (!root?.isConnected) return
      useUi.getState().setFocus('list')
    }, 0)
  }
  const onMouseDown = (): void => {
    // El `Pane` de arriba cancela el mousedown fuera de la prosa (para que la terminal de al lado no
    // se desenfoque hacia body); aquí el destino es la propia raíz.
    const root = rootRef.current
    if (root && !root.contains(document.activeElement)) root.focus()
  }
  const onClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href')
    if (href) void usePreview.getState().followLink(sessionId, href)
  }

  const key = (id: string): string | undefined => hintFor(id, 'terminal')
  const tip = (label: string, id: string): string => (key(id) ? `${label} · ${key(id)}` : label)
  const run = (id: string) => () => void commands.run(id)

  const name = doc ? baseName(doc.path) : ''
  const url = doc ? fileUrl(doc) : null
  const zoomed = doc?.zoom !== null && doc?.zoom !== undefined
  const imgStyle = doc && zoomed && doc.dims ? { width: Math.round(doc.dims.width * (doc.zoom ?? 1)) } : undefined

  return (
    <div ref={rootRef} className="preview" tabIndex={-1} data-session-id={sessionId} data-kind={doc?.kind} onFocus={onFocus} onBlur={onBlur} onMouseDown={onMouseDown}>
      <div className="preview__bar">
        <IconButton label="Atrás" title={tip('Atrás', 'preview.back')} disabled={!doc || doc.history.length === 0} onClick={run('preview.back')}>
          <ArrowLeft {...ICON} aria-hidden="true" />
        </IconButton>
        <span className="preview__name" title={doc?.path}>
          {name}
        </span>
        {doc && <Badge title={doc.path}>{typeLabel(doc.path, doc.dims)}</Badge>}
        {doc?.notice && <Badge title={doc.notice}>{doc.notice}</Badge>}
        {doc?.kind === 'image' && (
          <>
            <IconButton label="Alejar" title={tip('Alejar', 'preview.zoomOut')} onClick={run('preview.zoomOut')}>
              <Minus {...ICON} aria-hidden="true" />
            </IconButton>
            <IconButton label="Restablecer el zoom" title={tip('Ajustar al pane', 'preview.zoomReset')} size="auto" on={zoomed} onClick={run('preview.zoomReset')}>
              <span className="preview__zoom">{zoomLabel(doc.zoom)}</span>
            </IconButton>
            <IconButton label="Acercar" title={tip('Acercar', 'preview.zoomIn')} onClick={run('preview.zoomIn')}>
              <Plus {...ICON} aria-hidden="true" />
            </IconButton>
          </>
        )}
        <IconButton label="Abrir en el editor" title={tip('Abrir en el editor', 'preview.toggle')} primary disabled={!doc || doc.kind !== 'md'} onClick={run('preview.toggle')}>
          <Code2 {...ICON} aria-hidden="true" />
        </IconButton>
      </div>
      <div ref={bodyRef} className="preview__body" data-kind={doc?.kind} data-zoomed={zoomed || undefined} onClick={onClick}>
        {!doc ? null : doc.error ? (
          <Empty title="No se pudo mostrar">
            <span className="empty__meta">{doc.error}</span>
          </Empty>
        ) : doc.kind === 'md' ? (
          doc.text === null ? null : <article className="prose" data-selectable dangerouslySetInnerHTML={{ __html: html }} />
        ) : doc.kind === 'image' && url ? (
          <img
            ref={imgRef}
            className="preview__image"
            src={url}
            alt={name}
            style={imgStyle}
            draggable={false}
            onLoad={(e) => usePreview.getState().setDims(sessionId, { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            onError={() => usePreview.getState().notify(sessionId, 'No se pudo cargar la imagen')}
          />
        ) : doc.kind === 'pdf' && url ? (
          // El visor PDF de Chromium es un plugin: no corre dentro de un frame con `sandbox`, así que va en
          // un `<embed>` (sin documento propio ni scripts que aislar) servido por el protocolo del workspace.
          <embed className="preview__pdf" type="application/pdf" src={url} title={name} />
        ) : (
          <Empty title="Sin vista previa">
            <span className="empty__meta">Solo Markdown, imágenes y PDF · {typeLabel(doc.path)}</span>
          </Empty>
        )}
      </div>
    </div>
  )
}
