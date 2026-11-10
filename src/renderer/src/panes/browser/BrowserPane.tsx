import { useEffect, useRef, useState, type FocusEvent, type JSX, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { commands } from '@/core/commands/registry'
import { hintFor } from '@/features/palette/Palette'
import { useLayout } from '@/store/layout'
import { useSessions } from '@/store/sessions'
import { isBlank, isBrowserPrefixArmed, useBrowser } from '@/store/browser'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { IconButton } from '@/ui/Button'
import { ArrowLeft, ArrowRight, Camera, CodeXml, Ellipsis, ICON, MousePointerClick, RefreshCw, Smartphone, Square } from '@/ui/icons'
import { UrlInput } from '@/ui/UrlInput'
import { AreaCapture } from './AreaCapture'
import { focusStays } from '@/panes/pane-focus'
import { registerBrowserPane, unregisterBrowserPane } from './browser-host'
import { Markup } from './Markup'
import './browser.css'

interface Props {
  sessionId: string
  /** Pane con el foco del layout. */
  focused: boolean
}

/** Por debajo de este ancho de pane los botones secundarios de la cabecera se quedan en icono. */
/** Alto mínimo de la página y de las DevTools al arrastrar el divisor. */
const MIN_SPLIT_PX = 120
/** Proporción del alto que toman las DevTools al abrirse por primera vez. */
const DEVTOOLS_RATIO = 0.4
const DEVTOOLS_RATIO_KEY = 'omni.devtools.ratio'

function readDevtoolsRatio(): number {
  try {
    const n = Number(localStorage.getItem(DEVTOOLS_RATIO_KEY))
    return n > 0.05 && n < 0.95 ? n : DEVTOOLS_RATIO
  } catch {
    return DEVTOOLS_RATIO
  }
}

function writeDevtoolsRatio(ratio: number): void {
  try {
    localStorage.setItem(DEVTOOLS_RATIO_KEY, String(ratio))
  } catch {
    /* sin storage no se recuerda; no pasa nada */
  }
}

/**
 * Pane de navegador (ARCHITECTURE §3.9): cabecera solo de iconos como la barra de Orca (atrás,
 * adelante, URL, Recargar · Móvil · DevTools · Markup · Elemento · Captura · menú `…`; el atajo va en
 * el tooltip, el tamaño del viewport en el menú y en los ajustes), hueco para la vista
 * nativa y, debajo, el hueco de las DevTools acopladas. La página (y las DevTools) las pinta main
 * encima del DOM; aquí se les dice dónde (`browser:bounds`, `browser:devtoolsBounds`) y se esconden
 * cuando algo del renderer debe quedar encima (overlay, arrastre de divisores, recorte, markup).
 * Con un preset de viewport el hueco toma ese tamaño centrado y el pane hace scroll si no cabe.
 *
 * Foco: la raíz es enfocable (`tabindex=-1`) y es donde cae el foco DOM cuando la página tiene el
 * teclado; su focus/blur mantienen `ui.focus` igual que el textarea de xterm.
 */
export function BrowserPane({ sessionId, focused }: Props): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const devtoolsRef = useRef<HTMLDivElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const state = useBrowser((s) => s.states[sessionId])
  const devtools = useBrowser((s) => s.states[sessionId]?.devtools === true)
  const preset = useBrowser((s) => s.states[sessionId]?.viewport ?? null)
  const area = useBrowser((s) => (s.areaCapture?.id === sessionId ? s.areaCapture : null))
  const markup = useBrowser((s) => (s.markup?.id === sessionId ? s.markup : null))
  // Un overlay, un arrastre u otra vista (Worktrees, revisión, broadcast) tapan el hueco: la vista nativa se esconde.
  const covered = useUi((s) => s.overlay !== null || s.dragging || s.view !== 'fleet')
  const setBounds = useBrowser((s) => s.setBounds)
  const setDevtoolsBounds = useBrowser((s) => s.setDevtoolsBounds)
  const focusView = useBrowser((s) => s.focusView)
  const saveCapture = useBrowser((s) => s.saveCapture)
  const cropDone = useBrowser((s) => s.cropDone)
  const endAreaCapture = useBrowser((s) => s.endAreaCapture)
  const endMarkup = useBrowser((s) => s.endMarkup)
  // Los atajos de la cabecera salen del keymap: se vuelve a pintar cuando el usuario los cambia.
  useSettings((s) => s.settings.keys)
  useSettings((s) => s.settings.prefix)
  const [ratio, setRatio] = useState(readDevtoolsRatio)
  const [splitting, setSplitting] = useState(false)
  const hidden = covered || area !== null || markup !== null
  const devtoolsShown = devtools && !hidden

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    registerBrowserPane(sessionId, { root, url: urlRef.current })
    return () => {
      unregisterBrowserPane(sessionId, root)
      // Si el pane se va (cambio de tab, zoom en otro) con un modo activo, el modo se va con él: si no,
      // `useKeyboard` seguiría tragando las teclas de toda la app y main reenviando las de la página.
      const b = useBrowser.getState()
      if (b.elementPick?.id === sessionId) void b.exitElementMode()
      if (b.areaCapture?.id === sessionId) b.endAreaCapture()
      if (b.markup?.id === sessionId) b.endMarkup()
    }
  }, [sessionId])

  // Dónde pintar la vista: rect del hueco en px CSS del renderer. Se vuelve a medir con cada cambio
  // de tamaño, de layout (split, zoom, tab), de ventana o de scroll del pane (viewport fijo que no
  // cabe); `null` mientras algo del DOM debe ir encima.
  useEffect(() => {
    const el = viewRef.current
    const page = pageRef.current
    if (!el || !page || hidden) {
      setBounds(sessionId, null)
      return
    }
    let frame = 0
    const report = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setBounds(sessionId, rectOf(el)))
    }
    const observer = new ResizeObserver(report)
    observer.observe(el)
    observer.observe(page)
    const offLayout = useLayout.subscribe(report)
    window.addEventListener('resize', report)
    page.addEventListener('scroll', report)
    report()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      offLayout()
      window.removeEventListener('resize', report)
      page.removeEventListener('scroll', report)
      setBounds(sessionId, null)
    }
  }, [sessionId, hidden, setBounds])

  // Lo mismo para el hueco de las DevTools acopladas, mientras están abiertas y nada las tapa.
  useEffect(() => {
    const el = devtoolsRef.current
    if (!el || !devtoolsShown) {
      setDevtoolsBounds(sessionId, null)
      return
    }
    let frame = 0
    const report = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setDevtoolsBounds(sessionId, rectOf(el)))
    }
    const observer = new ResizeObserver(report)
    observer.observe(el)
    const offLayout = useLayout.subscribe(report)
    window.addEventListener('resize', report)
    report()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      offLayout()
      window.removeEventListener('resize', report)
      setDevtoolsBounds(sessionId, null)
    }
  }, [sessionId, devtoolsShown, setDevtoolsBounds])

  // Al montar con el foco del layout y la intención en `terminal`, el teclado va a la página (o a la
  // barra si no hay página), igual que TerminalPane enfoca su textarea. Cubre el navegador nuevo y
  // el remontaje por zoom o split: sin esto, tras `prefijo z` el foco DOM moría en body.
  useEffect(() => {
    if (!focused || useUi.getState().focus !== 'terminal') return
    if (isBlank(useBrowser.getState().states[sessionId])) {
      urlRef.current?.focus()
      urlRef.current?.select()
    } else if (isBrowserPrefixArmed()) rootRef.current?.focus()
    else focusView(sessionId)
    // Solo al montar: después, quien enfoca decide (comandos, clic en la página).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const onFocus = (e: FocusEvent<HTMLDivElement>): void => {
    useUi.getState().setFocus('terminal')
    useLayout.getState().focusSession(sessionId)
    useSessions.getState().syncCursor(sessionId)
    // Foco en la raíz misma (no subiendo desde la barra o un lienzo): el teclado va a la página,
    // o a la barra si no hay página. Cubre volver de un overlay (⌘K → Esc) y el prefijo sin tecla
    // enlazada. No mientras hay un prefijo esperando su tecla, ni si la página ya lo tiene, ni en
    // pleno recorte, markup o modo elemento (las teclas se resuelven en el renderer).
    if (e.target !== rootRef.current) return
    const b = useBrowser.getState()
    if (isBrowserPrefixArmed() || b.focused[sessionId] || b.browserMode !== null) return
    if (isBlank(b.states[sessionId])) {
      urlRef.current?.focus()
      urlRef.current?.select()
    } else focusView(sessionId)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Esc cancela el recorte o el markup esté el foco en el lienzo o en la raíz.
    const b = useBrowser.getState()
    if (e.key !== 'Escape') return
    if (b.areaCapture?.id === sessionId) {
      e.preventDefault()
      e.stopPropagation()
      endAreaCapture()
    } else if (b.markup?.id === sessionId) {
      e.preventDefault()
      e.stopPropagation()
      endMarkup()
    }
  }
  const onBlur = (): void => {
    // Mismo criterio que el textarea de xterm, un tick después: si el foco fue a un overlay, a otra
    // terminal o siguió dentro de este pane no pasa nada; si el pane murió, la intención sigue en `terminal`.
    const root = rootRef.current
    setTimeout(() => {
      const active = document.activeElement
      if (focusStays(active)) return
      if (!root?.isConnected) return
      useUi.getState().setFocus('list')
    }, 0)
  }

  /** Divisor página / DevTools: mismo patrón que los splits del layout (vistas ocultas mientras dura). */
  const startSplitDrag = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    const body = bodyRef.current
    if (!body) return
    const rect = body.getBoundingClientRect()
    let next = ratio
    const onMove = (ev: MouseEvent): void => {
      const pageHeight = Math.min(Math.max(ev.clientY - rect.top, MIN_SPLIT_PX), rect.height - MIN_SPLIT_PX)
      next = 1 - pageHeight / rect.height
      setRatio(next)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      delete document.body.dataset.dragging
      useUi.getState().setDragging(false)
      setSplitting(false)
      writeDevtoolsRatio(next)
    }
    setSplitting(true)
    document.body.dataset.dragging = 'col'
    useUi.getState().setDragging(true)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const resetSplit = (): void => {
    setRatio(DEVTOOLS_RATIO)
    writeDevtoolsRatio(DEVTOOLS_RATIO)
  }

  const loading = state?.loading === true
  const blank = isBlank(state)
  const mobile = preset?.mobile === true
  const key = (id: string): string | undefined => hintFor(id, 'terminal')
  const run = (id: string) => () => void commands.run(id)
  /** Tooltip de un botón: "Recargar · ⌘R"; sin atajo, solo la etiqueta. */
  const tip = (label: string, id: string): string => (key(id) ? `${label} · ${key(id)}` : label)

  return (
    <div
      ref={rootRef}
      className="browser"
      tabIndex={-1}
      data-session-id={sessionId}
      data-loading={loading || undefined}
      data-viewport={preset ? preset.id : undefined}
      data-devtools={devtools || undefined}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <div className="browser__bar">
        <IconButton label="Atrás" title={tip('Atrás', 'browser.back')} disabled={!state?.canGoBack} onClick={run('browser.back')}>
          <ArrowLeft {...ICON} aria-hidden="true" />
        </IconButton>
        <IconButton label="Adelante" title={tip('Adelante', 'browser.forward')} disabled={!state?.canGoForward} onClick={run('browser.forward')}>
          <ArrowRight {...ICON} aria-hidden="true" />
        </IconButton>
        <UrlInput ref={urlRef} value={blank ? '' : state.url} placeholder="Dirección" title={tip('Dirección', 'browser.focusUrl')} onSubmit={run('browser.navigate')} onCancel={() => rootRef.current?.focus()} />
        {loading ? (
          <IconButton label="Parar" title={tip('Parar', 'browser.reload')} onClick={run('browser.stop')}>
            <Square {...ICON} size={13} aria-hidden="true" />
          </IconButton>
        ) : (
          <IconButton label="Recargar" title={tip('Recargar', 'browser.reload')} onClick={run('browser.reload')}>
            <RefreshCw {...ICON} aria-hidden="true" />
          </IconButton>
        )}
        <IconButton label="Vista móvil" title={tip('Vista móvil', 'browser.mobile')} on={mobile} onClick={run('browser.mobile')}>
          <Smartphone {...ICON} aria-hidden="true" />
        </IconButton>
        <IconButton label="DevTools" title={tip('DevTools', 'browser.devtools')} on={devtools} onClick={run('browser.devtools')}>
          <CodeXml {...ICON} aria-hidden="true" />
        </IconButton>
        <IconButton label="Elemento" title={tip('Elemento', 'browser.element')} primary disabled={blank} onClick={run('browser.element')}>
          <MousePointerClick {...ICON} aria-hidden="true" />
        </IconButton>
        <IconButton label="Captura" title={tip('Captura', 'browser.capture')} primary disabled={blank} onClick={run('browser.capture')}>
          <Camera {...ICON} aria-hidden="true" />
        </IconButton>
        <IconButton label="Más" title="Más" onClick={run('browser.menu')}>
          <Ellipsis {...ICON} aria-hidden="true" />
        </IconButton>
      </div>
      <div ref={bodyRef} className="browser__body">
        <div ref={pageRef} className="browser__page" style={devtools ? { flex: `${(1 - ratio) * 100} 1 0%` } : undefined}>
          <div ref={viewRef} className="browser__view" data-blank={blank || undefined} style={preset ? { width: preset.width, height: preset.height } : undefined}>
            {area && <AreaCapture dataUrl={area.dataUrl} onDone={(png) => cropDone(sessionId, png)} onCancel={endAreaCapture} />}
          </div>
        </div>
        {devtools && (
          <>
            {/* Mismo divisor que los splits del layout (`layout.css`), horizontal. */}
            <div className="divider" data-dir="col" data-active={splitting || undefined} role="separator" aria-orientation="horizontal" aria-label="Tamaño de las DevTools" onMouseDown={startSplitDrag} onDoubleClick={resetSplit} />
            <div ref={devtoolsRef} className="browser__devtools" style={{ flex: `${ratio * 100} 1 0%` }} />
          </>
        )}
        {markup && <Markup dataUrl={markup.dataUrl} onDone={(png, drew) => void saveCapture(sessionId, png, drew ? 'markup' : 'capture').finally(endMarkup)} onCancel={endMarkup} />}
      </div>
    </div>
  )
}

/** Rect de un elemento en px CSS del renderer, redondeado: lo que main necesita para `setBounds`. */
function rectOf(el: HTMLElement): { x: number; y: number; width: number; height: number } {
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
}
