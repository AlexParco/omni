import { createContext, memo, useContext, useEffect, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import { commands } from '@/core/commands/registry'
import { BrowserPane } from '@/panes/browser/BrowserPane'
import { focusBrowserRoot } from '@/panes/browser/browser-host'
import { getEditor } from '@/panes/editor/editor-host'
import { EditorPane } from '@/panes/editor/EditorPane'
import { PreviewPane } from '@/panes/preview/PreviewPane'
import { getTerminal } from '@/panes/terminal/terminal-host'
import { TerminalPane } from '@/panes/terminal/TerminalPane'
import { browserTitle, useBrowser } from '@/store/browser'
import { MIN_SIZE, leaves, sideAt, useLayout, type Leaf, type LayoutNode, type Side, type Split, type Tab } from '@/store/layout'
import { STATUS_LABEL, liveAgent, sessionTitle, skipsPermissions, statusFrom, useSessions } from '@/store/sessions'
import { useClock } from '@/store/clock'
import { usePrefixLabel } from '@/store/settings'
import { useUi } from '@/store/ui'
import { Badge } from '@/ui/Badge'
import { IconButton } from '@/ui/Button'
import { Dot } from '@/ui/Dot'
import { AgentIcon, Columns2, GitCompare, Globe, ICON_SM, Sparkles, Maximize2, Minimize2, Rows2, X } from '@/ui/icons'
import { Strip, StripActions, StripEnd, StripLink, StripTitle } from '@/ui/Strip'
import { devServerOf, usePorts } from '@/store/ports'
import { useHosts } from '@/store/hosts'
import './layout.css'

/** Zona donde caerá el pane arrastrado, en px relativos a `.layout`. */
interface DropZone {
  left: number
  top: number
  width: number
  height: number
}

/** Distancia (px) que hay que mover el mouse sobre la franja para que un clic pase a ser arrastre. */
const DRAG_THRESHOLD = 5

/** Arranca el arrastre de un pane por su franja; lo da el `Layout` del tab. */
type StartPaneDrag = (e: ReactMouseEvent, paneId: string) => void
const PaneDragContext = createContext<StartPaneDrag>(() => {})

/** La mitad `side` de un rectángulo, relativa al origen `base`. */
function halfOf(rect: DOMRect, base: DOMRect, side: Side): DropZone {
  const left = rect.left - base.left
  const top = rect.top - base.top
  if (side === 'left') return { left, top, width: rect.width / 2, height: rect.height }
  if (side === 'right') return { left: left + rect.width / 2, top, width: rect.width / 2, height: rect.height }
  if (side === 'top') return { left, top, width: rect.width, height: rect.height / 2 }
  return { left, top: top + rect.height / 2, width: rect.width, height: rect.height / 2 }
}

/**
 * Pinta el árbol de splits de un tab. Divisores arrastrables; clic en un pane lo enfoca. Arrastrar un
 * pane por su franja y soltarlo sobre otro lo mueve a la mitad de ese pane más cercana al cursor
 * (izquierda, derecha, arriba o abajo); Esc o soltarlo fuera lo cancela.
 */
export const Layout = memo(function Layout({ tab }: { tab: Tab }): JSX.Element {
  const root = tab.zoomedPaneId ? (leaves(tab.root).find((l) => l.id === tab.zoomedPaneId) ?? tab.root) : tab.root
  const ref = useRef<HTMLDivElement>(null)
  const [zone, setZone] = useState<DropZone | null>(null)

  const startDrag: StartPaneDrag = (e, paneId) => {
    // Con zoom solo hay un pane en pantalla: no hay dónde soltar.
    if (e.button !== 0 || tab.zoomedPaneId || leaves(tab.root).length < 2) return
    const startX = e.clientX
    const startY = e.clientY
    let dragging = false
    let target: { paneId: string; side: Side } | null = null

    const onMove = (ev: MouseEvent): void => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
        dragging = true
        document.body.dataset.dragging = 'pane'
        // Las vistas nativas (navegador) van encima del DOM y se tragarían el mouse: se esconden mientras dura.
        useUi.getState().setDragging(true)
      }
      const base = ref.current?.getBoundingClientRect()
      const over = document.elementsFromPoint(ev.clientX, ev.clientY).find((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('pane'))
      const overId = over?.dataset.paneId
      if (!base || !over || !overId || overId === paneId || !ref.current?.contains(over)) {
        target = null
        setZone(null)
        return
      }
      const rect = over.getBoundingClientRect()
      const side = sideAt(rect, ev.clientX, ev.clientY)
      target = { paneId: overId, side }
      setZone(halfOf(rect, base, side))
    }
    const finish = (drop: boolean): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKey, true)
      if (dragging) {
        delete document.body.dataset.dragging
        useUi.getState().setDragging(false)
      }
      setZone(null)
      if (drop && target) useLayout.getState().movePane(tab.id, paneId, target.paneId, target.side)
    }
    const onUp = (): void => finish(true)
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !dragging) return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKey, true)
  }

  return (
    <div className="layout" data-tab-id={tab.id} ref={ref}>
      <PaneDragContext.Provider value={startDrag}>
        <Node node={root} tab={tab} />
      </PaneDragContext.Provider>
      {zone && <div className="pane-drop" style={{ left: zone.left, top: zone.top, width: zone.width, height: zone.height }} />}
    </div>
  )
})

function Node({ node, tab }: { node: LayoutNode; tab: Tab }): JSX.Element {
  if (node.kind === 'leaf') return <Pane leaf={node} tab={tab} />
  return <SplitNode split={node} tab={tab} />
}

/**
 * Un pane: franja con identidad (agente, título, estado, acciones) y el contenido según el agente
 * (terminal o navegador). `data-focus`: `live` teclado aquí · `layout` foco del layout con teclado
 * en la lista · `none`.
 */
function Pane({ leaf, tab }: { leaf: Leaf; tab: Tab }): JSX.Element {
  const focusPane = useLayout((s) => s.focusPane)
  const startDrag = useContext(PaneDragContext)
  const setFocus = useUi((s) => s.setFocus)
  const live = useUi((s) => s.focus === 'terminal')
  const isBrowser = useSessions((s) => s.sessions.find((x) => x.id === leaf.sessionId)?.agent === 'browser')
  const isPreview = useSessions((s) => s.sessions.find((x) => x.id === leaf.sessionId)?.agent === 'preview')
  const isEditor = useSessions((s) => s.sessions.find((x) => x.id === leaf.sessionId)?.agent === 'editor')
  const focused = tab.focusedPaneId === leaf.id
  const zoomed = tab.zoomedPaneId === leaf.id
  const focus = focused ? (live ? 'live' : 'layout') : 'none'
  // Sin leer (§3.14): un pane pintado pertenece al tab activo del workspace actual, pero con otra vista
  // encima (Worktrees, revisión, broadcast) sigue montado sin verse: solo cuenta como visto en Flota y con la ventana activa
  // (en segundo plano nadie lo mira; al volver, este efecto lo marca visto y el aviso se retira).
  const shown = useUi((s) => s.view === 'fleet' && s.windowFocused)
  const lastOutput = useSessions((s) => s.activity[leaf.sessionId]?.lastOutput)
  const markSeen = useSessions((s) => s.markSeen)
  useEffect(() => {
    if (shown) markSeen(leaf.sessionId)
  }, [shown, lastOutput, leaf.sessionId, markSeen])
  return (
    <div
      className="pane"
      data-pane-id={leaf.id}
      data-focus={focus}
      onMouseDown={(e) => {
        // Sin esto, un clic fuera de las filas de xterm (el hueco bajo el prompt) cae en un div no
        // enfocable y el navegador manda el foco a body: la terminal se desenfoca y la app pasa a
        // modo lista. Dentro de xterm no pasa porque xterm ya cancela el mousedown. Un campo de
        // texto (la barra de URL, el texto del markup) sí debe recibir el foco con el clic, y en un
        // bloque `data-selectable` el arrastre tiene que seleccionar texto.
        const editable = e.target instanceof HTMLElement && e.target.closest('input, textarea, [data-selectable]')
        if (!editable) e.preventDefault()
        focusPane(tab.id, leaf.id)
        setFocus('terminal')
        if (isBrowser) {
          // El clic dentro de la página lo ve main (`browser:focus`); el resto del pane deja el foco DOM
          // en su raíz, para que no se quede en la terminal de al lado.
          if (!editable) focusBrowserRoot(leaf.sessionId)
        } else if (isEditor) getEditor(leaf.sessionId)?.focus()
        else getTerminal(leaf.sessionId)?.focus()
        // La franja (fuera de sus botones y enlaces) es el asa para mover el pane a otro lado del tab.
        if (e.target instanceof HTMLElement && e.target.closest('.strip') && !e.target.closest('button, a')) startDrag(e, leaf.id)
      }}
    >
      <PaneStrip sessionId={leaf.sessionId} zoomed={zoomed} focus={focus} />
      {isEditor ? <EditorPane sessionId={leaf.sessionId} focused={focused} /> : isPreview ? <PreviewPane sessionId={leaf.sessionId} focused={focused} /> : isBrowser ? <BrowserPane sessionId={leaf.sessionId} focused={focused} /> : <TerminalPane sessionId={leaf.sessionId} focused={focused} />}
    </div>
  )
}

/** `localhost:5173` de una URL (lo que la franja muestra del servidor). */
function hostPort(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`
  } catch {
    return url
  }
}

/** Franja superior del pane: quién es, cómo está y qué se le puede hacer. Es lo que hace supervisable un split. */
function PaneStrip({ sessionId, zoomed, focus }: { sessionId: string; zoomed: boolean; focus: 'live' | 'layout' | 'none' }): JSX.Element | null {
  const prefix = usePrefixLabel()
  const session = useSessions((s) => s.sessions.find((x) => x.id === sessionId))
  const sessionName = useSessions((s) => (session ? sessionTitle(s, session) : ''))
  const agent = useSessions((s) => (session ? liveAgent(s, session) : null))
  const lastOutput = useSessions((s) => s.activity[sessionId]?.lastOutput)
  const attention = useSessions((s) => s.attention[sessionId] === true)
  const busy = useSessions((s) => s.busy[sessionId] === true)
  const declared = useSessions((s) => s.declared[sessionId])
  // Navegador: título de la página o la URL pelada; y el aviso breve de captura.
  const browserState = useBrowser((s) => (session?.agent === 'browser' ? s.states[sessionId] : undefined))
  const notice = useBrowser((s) => s.notices[sessionId])
  // El pane vive en un worktree: la franja ofrece su revisión (ARCHITECTURE §3.16).
  const inWorktree = useSessions((s) => s.workspaces.find((w) => w.id === session?.workspaceId)?.kind === 'worktree')
  const now = useClock((c) => c.now)
  // Servidor que levantó esta terminal (§3.24): la franja ofrece abrirlo en el navegador de omni.
  const devServer = usePorts((s) => devServerOf(s.list, sessionId))
  const artifact = useSessions((s) => s.artifacts[sessionId])
  const remoteUrl = useSessions((s) => s.remoteUrls[sessionId])
  const hostId = useSessions((s) => s.workspaces.find((w) => w.id === session?.workspaceId)?.host)
  const hostName = useHosts((s) => (hostId ? s.hosts.find((h) => h.id === hostId)?.name : undefined))
  if (!session) return null
  const title = session.agent === 'browser' ? browserTitle(browserState) : sessionName
  const status = statusFrom(lastOutput, attention, now, busy, declared)
  return (
    <Strip focus={focus}>
      <AgentIcon agent={agent ?? session.agent} size={12} />
      <StripTitle title={session.agent === 'browser' ? browserState?.url || title : title}>{title}</StripTitle>
      <StripEnd>
        {notice && <Badge title={notice}>{notice}</Badge>}
        {skipsPermissions(session) && (
          <Badge tone="mark" title={`Lanzado con ${session.args?.join(' ') ?? ''}`}>
            sin permisos
          </Badge>
        )}
        {artifact && (
          <StripLink icon={<Sparkles {...ICON_SM} size={12} aria-hidden="true" />} title={`Abrir ${artifact} en el navegador de omni (${prefix} a)`} onClick={() => void commands.run('pane.openArtifact')}>
            artifact
          </StripLink>
        )}
        {remoteUrl && (
          <StripLink icon={<Globe {...ICON_SM} size={12} aria-hidden="true" />} title={`Reenviar el puerto desde ${hostName ?? 'el servidor'} y abrir en el navegador de omni (${prefix} w)`} onClick={() => void commands.run('pane.openDevServer')}>
            {hostPort(remoteUrl)}
          </StripLink>
        )}
        {devServer && (
          <StripLink icon={<Globe {...ICON_SM} size={12} aria-hidden="true" />} title={`Abrir en el navegador de omni (${prefix} w)`} onClick={() => void commands.run('pane.openDevServer')}>
            localhost:{devServer.ports[0]}
          </StripLink>
        )}
        {/* En reposo no hay nada que avisar: ni punto ni texto (como en el sidebar). */}
        {status !== 'idle' && (
          <>
            <Dot status={status} />
            <span className="strip__status" data-status={status}>
              {STATUS_LABEL[status]}
            </span>
          </>
        )}
        {zoomed && <Badge tone="mark">ZOOM</Badge>}
        <StripActions>
          {inWorktree && (
            <IconButton size="sm" label="Revisar el worktree" title="Revisar el worktree (⌘D)" onClick={() => void commands.run('review.open')}>
              <GitCompare {...ICON_SM} size={13} aria-hidden="true" />
            </IconButton>
          )}
          <IconButton size="sm" label="Split a la derecha" title={`Split a la derecha (${prefix} |)`} onClick={() => void commands.run('pane.split.right')}>
            <Columns2 {...ICON_SM} size={13} aria-hidden="true" />
          </IconButton>
          <IconButton size="sm" label="Split abajo" title={`Split abajo (${prefix} _)`} onClick={() => void commands.run('pane.split.down')}>
            <Rows2 {...ICON_SM} size={13} aria-hidden="true" />
          </IconButton>
          <IconButton size="sm" label={zoomed ? 'Salir del zoom' : 'Zoom'} title={`${zoomed ? 'Salir del zoom' : 'Zoom'} (${prefix} z)`} onClick={() => void commands.run('pane.zoom')}>
            {zoomed ? <Minimize2 {...ICON_SM} size={13} aria-hidden="true" /> : <Maximize2 {...ICON_SM} size={13} aria-hidden="true" />}
          </IconButton>
          <IconButton size="sm" label="Cerrar pane" title="Cerrar pane (⌘W)" onClick={() => void commands.run('pane.close')}>
            <X {...ICON_SM} size={13} aria-hidden="true" />
          </IconButton>
        </StripActions>
      </StripEnd>
    </Strip>
  )
}

function SplitNode({ split, tab }: { split: Split; tab: Tab }): JSX.Element {
  const setSizes = useLayout((s) => s.setSizes)
  const [active, setActive] = useState<number | null>(null)

  const startDrag = (e: ReactMouseEvent<HTMLDivElement>, index: number): void => {
    e.preventDefault()
    const container = e.currentTarget.parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()
    const total = split.dir === 'row' ? rect.width : rect.height
    const before = split.sizes.slice(0, index).reduce((a, b) => a + b, 0)
    const pairSum = split.sizes[index] + split.sizes[index + 1]

    const onMove = (ev: MouseEvent): void => {
      const pos = split.dir === 'row' ? ev.clientX - rect.left : ev.clientY - rect.top
      const frac = Math.min(Math.max(pos / total - before, MIN_SIZE), pairSum - MIN_SIZE)
      const sizes = [...split.sizes]
      sizes[index] = frac
      sizes[index + 1] = pairSum - frac
      setSizes(tab.id, split.id, sizes)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      delete document.body.dataset.dragging
      useUi.getState().setDragging(false)
      setActive(null)
    }
    setActive(index)
    document.body.dataset.dragging = split.dir
    // Las vistas nativas van encima del DOM y se tragarían el mouse: se esconden mientras dura el arrastre.
    useUi.getState().setDragging(true)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** Doble clic en el divisor: reparte a partes iguales entre sus dos vecinos. */
  const equalize = (index: number): void => {
    const pairSum = split.sizes[index] + split.sizes[index + 1]
    const sizes = [...split.sizes]
    sizes[index] = pairSum / 2
    sizes[index + 1] = pairSum / 2
    setSizes(tab.id, split.id, sizes)
  }

  return (
    <div className="split" data-dir={split.dir}>
      {split.children.flatMap((child, i) => {
        const cell = (
          <div key={child.id} className="split__cell" style={{ flex: `${split.sizes[i] * 100} 1 0%` }}>
            <Node node={child} tab={tab} />
          </div>
        )
        if (i === split.children.length - 1) return [cell]
        return [
          cell,
          <div
            key={`${child.id}-div`}
            className="divider"
            data-dir={split.dir}
            data-active={active === i || undefined}
            role="separator"
            aria-orientation={split.dir === 'row' ? 'vertical' : 'horizontal'}
            onMouseDown={(e) => startDrag(e, i)}
            onDoubleClick={() => equalize(i)}
          />
        ]
      })}
    </div>
  )
}
