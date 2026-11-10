import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { chordOf, type Chord } from '@/core/keys/chord'
import {
  EMPTY_HISTORY,
  MARKUP_COLORS,
  canRedo,
  canUndo,
  clearOps,
  eraseAt,
  fontSize,
  pushOp,
  redo,
  undo,
  visibleOps,
  type DrawOp,
  type MarkupColor,
  type MarkupHistory,
  type MarkupSize,
  type MarkupTool,
  type Point
} from '@/store/markup-ops'
import { Button, IconButton } from '@/ui/Button'
import { ColorSwatch } from '@/ui/ColorSwatch'
import { Circle, Eraser, Highlighter, ICON_SM, MoveUpRight, Pencil, Redo2, Square, Trash2, Type, Undo2 } from '@/ui/icons'
import { Toggle } from '@/ui/Toggle'
import { Toolbar, ToolbarSep } from '@/ui/Toolbar'
import { setModeKeyHandler } from './browser-host'
import { drawOp, drawOps } from './markup-draw'
import './markup.css'

interface Props {
  /** PNG del recorte (px físicos), fondo del lienzo. */
  dataUrl: string
  /** Fondo + dibujo compuestos como data URL PNG a escala real; `drew` dice si quedó algún trazo. */
  onDone(dataUrl: string, drew: boolean): void
  onCancel(): void
}

const TOOLS: Array<{ id: MarkupTool; label: string; key: string; icon: JSX.Element }> = [
  { id: 'pen', label: 'Lápiz', key: 'p', icon: <Pencil {...ICON_SM} aria-hidden="true" /> },
  { id: 'highlighter', label: 'Resaltador', key: 'h', icon: <Highlighter {...ICON_SM} aria-hidden="true" /> },
  { id: 'arrow', label: 'Flecha', key: 'a', icon: <MoveUpRight {...ICON_SM} aria-hidden="true" /> },
  { id: 'rect', label: 'Rectángulo', key: 'r', icon: <Square {...ICON_SM} aria-hidden="true" /> },
  { id: 'ellipse', label: 'Elipse', key: 'o', icon: <Circle {...ICON_SM} aria-hidden="true" /> },
  { id: 'text', label: 'Texto', key: 't', icon: <Type {...ICON_SM} aria-hidden="true" /> },
  { id: 'eraser', label: 'Borrador', key: 'e', icon: <Eraser {...ICON_SM} aria-hidden="true" /> }
]
const COLOR_LABEL: Record<MarkupColor, string> = { red: 'Rojo', orange: 'Naranja', yellow: 'Amarillo', green: 'Verde', blue: 'Azul', white: 'Blanco' }
const SIZES: Array<{ id: MarkupSize; label: string }> = [
  { id: 's', label: 'S' },
  { id: 'm', label: 'M' },
  { id: 'l', label: 'L' }
]
/** Aire alrededor del lienzo dentro del hueco, en px CSS. */
const STAGE_PAD = 16
/** Un arrastre menor que esto (px de captura) no deja figura. */
const MIN_SHAPE_PX = 3
/** Radio del borrador en px lógicos. */
const ERASER_PX = 8

interface Size {
  w: number
  h: number
}

/**
 * Paso 2 de la captura (ARCHITECTURE §3.9): lienzo de dibujo sobre el recorte. La vista nativa está
 * oculta y en su lugar se pinta el recorte, con un `<canvas>` encima donde se dibuja. Dibujar es
 * opcional: "Siguiente" (`⌘⏎`) pasa al diálogo de envío con o sin trazos. El dibujo es una lista
 * de operaciones (`store/markup-ops.ts`, con deshacer y rehacer); el lienzo se repinta entero en cada
 * cambio. Las coordenadas van en px de la captura (escala real), así el PNG final sale 1:1 con la
 * foto. Barra flotante con herramientas, color, grosor y edición; pie con Cancelar y Siguiente.
 * Las teclas llegan por el DOM (el lienzo tiene el foco) o reenviadas por main (`setModeKeyHandler`).
 */
export function Markup({ dataUrl, onDone, onCancel }: Props): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Esc en el campo de texto: el blur que sigue al desmontarlo no debe fijar el texto. */
  const discardText = useRef(false)
  const [natural, setNatural] = useState<Size | null>(null)
  const [wrap, setWrap] = useState<Size>({ w: 0, h: 0 })
  const [tool, setTool] = useState<MarkupTool>('pen')
  const [color, setColor] = useState<MarkupColor>('red')
  const [size, setSize] = useState<MarkupSize>('m')
  const [history, setHistory] = useState<MarkupHistory>(EMPTY_HISTORY)
  const [draft, setDraft] = useState<DrawOp | null>(null)
  const [textEdit, setTextEdit] = useState<{ at: Point; value: string } | null>(null)

  // px de captura por px lógico: la foto viene a escala física.
  const unit = window.devicePixelRatio || 1
  // El lienzo se muestra a 1:1 CSS si cabe, si no se encoge para entrar en el hueco con aire.
  const k = natural ? Math.min(1 / unit, Math.max(0, wrap.w - STAGE_PAD * 2) / natural.w, Math.max(0, wrap.h - STAGE_PAD * 2) / natural.h) : 0
  const box: Size = natural ? { w: Math.round(natural.w * k), h: Math.round(natural.h * k) } : { w: 0, h: 0 }

  useLayoutEffect(() => {
    rootRef.current?.focus()
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWrap({ w: entry.contentRect.width, h: entry.contentRect.height }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Repintado completo: lo visible del historial y el trazo en curso.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !natural) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    drawOps(ctx, visibleOps(history.ops), unit)
    if (draft) drawOp(ctx, draft, unit)
  }, [history, draft, natural, unit])

  const editing = textEdit !== null
  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  /** Punto del mouse en px de la captura. */
  const toNatural = (e: ReactMouseEvent | MouseEvent): Point => {
    const r = canvasRef.current?.getBoundingClientRect()
    if (!r || !natural || r.width === 0) return { x: 0, y: 0 }
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width) * (natural.w / r.width)
    const y = Math.min(Math.max(e.clientY - r.top, 0), r.height) * (natural.h / r.height)
    return { x, y }
  }

  const commitText = (): void => {
    if (!textEdit) return
    if (discardText.current) {
      discardText.current = false
      setTextEdit(null)
      return
    }
    const text = textEdit.value.trim()
    if (text) setHistory((h) => pushOp(h, { kind: 'text', color, size, at: textEdit.at, text }))
    setTextEdit(null)
  }

  const onStageMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !natural) return
    e.preventDefault()
    // Si subiera al pane, `Layout` movería el foco a la raíz `.browser` y el lienzo perdería las teclas.
    e.stopPropagation()
    const start = toNatural(e)
    if (textEdit) {
      commitText()
      if (tool !== 'text') return
    }
    rootRef.current?.focus()
    if (tool === 'text') {
      discardText.current = false
      setTextEdit({ at: start, value: '' })
      return
    }
    if (tool === 'eraser') {
      setHistory((h) => eraseAt(h, start, ERASER_PX * unit))
      const onMove = (ev: MouseEvent): void => setHistory((h) => eraseAt(h, toNatural(ev), ERASER_PX * unit))
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      return
    }
    let current: DrawOp =
      tool === 'pen' || tool === 'highlighter' ? { kind: 'path', tool, color, size, points: [start] } : { kind: 'shape', tool, color, size, from: start, to: start }
    setDraft(current)
    const onMove = (ev: MouseEvent): void => {
      const p = toNatural(ev)
      current = current.kind === 'path' ? { ...current, points: [...current.points, p] } : current.kind === 'shape' ? { ...current, to: p } : current
      setDraft(current)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setDraft(null)
      const tooSmall = current.kind === 'shape' && Math.hypot(current.to.x - current.from.x, current.to.y - current.from.y) < MIN_SHAPE_PX * unit
      if (!tooSmall) setHistory((h) => pushOp(h, current))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** Fondo + dibujo en un PNG a escala real. */
  const finish = (): void => {
    const img = imgRef.current
    if (!img || !natural) return onCancel()
    const canvas = document.createElement('canvas')
    canvas.width = natural.w
    canvas.height = natural.h
    const ctx = canvas.getContext('2d')
    if (!ctx) return onCancel()
    ctx.drawImage(img, 0, 0, natural.w, natural.h)
    // Un texto a medio escribir también va: el lienzo se cierra enseguida, no hace falta pasarlo por `history`.
    const pending = textEdit && textEdit.value.trim() ? [{ kind: 'text' as const, color, size, at: textEdit.at, text: textEdit.value.trim() }] : []
    const ops = [...visibleOps(history.ops), ...pending]
    drawOps(ctx, ops, unit)
    onDone(canvas.toDataURL('image/png'), ops.length > 0)
  }

  /** Teclas del modo: venga del DOM o reenviada por main. `true` si era suya. */
  const handleChord = (chord: Chord): boolean => {
    if (textEdit) {
      // Escribiendo un texto solo Esc (cancela el texto) y ⌘⏎ (copia) son del modo; el resto es del campo.
      if (chord === 'escape') {
        discardText.current = true
        setTextEdit(null)
        rootRef.current?.focus()
        return true
      }
      if (chord === 'cmd+enter') {
        finish()
        return true
      }
      return false
    }
    if (chord === 'escape') {
      onCancel()
      return true
    }
    if (chord === 'cmd+enter') {
      finish()
      return true
    }
    if (chord === 'cmd+z') {
      setHistory(undo)
      return true
    }
    if (chord === 'shift+cmd+z') {
      setHistory(redo)
      return true
    }
    const t = TOOLS.find((x) => x.key === chord)
    if (t) {
      setTool(t.id)
      return true
    }
    return false
  }
  const handleRef = useRef(handleChord)
  handleRef.current = handleChord
  useEffect(() => {
    setModeKeyHandler((chord) => handleRef.current(chord))
    return () => setModeKeyHandler(null)
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (handleChord(chordOf(e.nativeEvent))) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const onImageLoad = (): void => {
    const img = imgRef.current
    if (img && img.naturalWidth > 0) setNatural({ w: img.naturalWidth, h: img.naturalHeight })
  }

  return (
    <div ref={rootRef} className="markup" tabIndex={-1} role="application" aria-label="Markup sobre la página" data-tool={tool} onKeyDown={onKeyDown}>
      <div ref={wrapRef} className="markup__wrap">
        <div className="markup__stage" style={{ width: box.w, height: box.h }} onMouseDown={onStageMouseDown}>
          <img ref={imgRef} className="markup__shot" src={dataUrl} alt="" draggable={false} onLoad={onImageLoad} />
          <canvas ref={canvasRef} className="markup__draw" width={natural?.w ?? 0} height={natural?.h ?? 0} />
          {textEdit && (
            <input
              ref={inputRef}
              className="markup__text"
              style={{ left: textEdit.at.x * k, top: textEdit.at.y * k, fontSize: fontSize(size) * unit * k, color: `var(--mark-${color})` }}
              value={textEdit.value}
              placeholder="Texto"
              spellCheck={false}
              onChange={(e) => setTextEdit({ at: textEdit.at, value: e.target.value })}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.metaKey) {
                  e.preventDefault()
                  e.stopPropagation()
                  commitText()
                  rootRef.current?.focus()
                }
              }}
            />
          )}
        </div>
        <div className="markup__tools">
          <Toolbar label="Herramientas de markup">
            {TOOLS.map((t) => (
              <IconButton key={t.id} label={t.label} title={`${t.label} (${t.key.toUpperCase()})`} on={tool === t.id} onClick={() => setTool(t.id)}>
                {t.icon}
              </IconButton>
            ))}
            <ToolbarSep />
            {MARKUP_COLORS.map((c) => (
              <ColorSwatch key={c} color={c} label={COLOR_LABEL[c]} on={color === c} onClick={() => setColor(c)} />
            ))}
            <ToolbarSep />
            {SIZES.map((s) => (
              <Toggle key={s.id} on={size === s.id} title={`Grosor ${s.label}`} onClick={() => setSize(s.id)}>
                {s.label}
              </Toggle>
            ))}
            <ToolbarSep />
            <IconButton label="Deshacer" title="Deshacer (⌘Z)" disabled={!canUndo(history)} onClick={() => setHistory(undo)}>
              <Undo2 {...ICON_SM} aria-hidden="true" />
            </IconButton>
            <IconButton label="Rehacer" title="Rehacer (⇧⌘Z)" disabled={!canRedo(history)} onClick={() => setHistory(redo)}>
              <Redo2 {...ICON_SM} aria-hidden="true" />
            </IconButton>
            <IconButton label="Limpiar" title="Limpiar todo" disabled={visibleOps(history.ops).length === 0} onClick={() => setHistory(clearOps)}>
              <Trash2 {...ICON_SM} aria-hidden="true" />
            </IconButton>
          </Toolbar>
        </div>
      </div>
      <div className="markup__foot">
        <span className="markup__hint">Dibuja encima si quieres marcar algo</span>
        <Button quiet kbd="Esc" title="Cerrar sin capturar" onClick={onCancel}>
          Cancelar
        </Button>
        <Button quiet variant="primary" kbd="⌘⏎" title="Seguir a enviar o copiar la captura" disabled={!natural} onClick={finish}>
          Siguiente
        </Button>
      </div>
    </div>
  )
}
