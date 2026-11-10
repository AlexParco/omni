import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { chordOf, type Chord } from '@/core/keys/chord'
import { Button } from '@/ui/Button'
import { Toolbar } from '@/ui/Toolbar'
import { setModeKeyHandler } from './browser-host'

interface Props {
  /** PNG de la página completa, del tamaño exacto del hueco (en px físicos). */
  dataUrl: string
  /** Recorte listo (o la página entera) como data URL PNG a escala real: sigue el paso de dibujo. */
  onDone(dataUrl: string): void
  /** Esc, arrastre demasiado chico o imagen inválida: no hay recorte. */
  onCancel(): void
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Un arrastre menor que esto es un clic: no se guarda nada. */
const MIN_PX = 4
/** Paso de H J K L (mover) y ⇧H ⇧J ⇧K ⇧L (redimensionar), en px CSS. */
const STEP_PX = 24
/** Fracción del hueco que ocupa el rectángulo inicial, centrado. */
const INITIAL_FRACTION = 0.6

function boxOf(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  }
}

/** Mantiene el rectángulo dentro del hueco y con un tamaño mínimo. */
function clamp(b: Box, w: number, h: number): Box {
  const width = Math.min(Math.max(b.width, MIN_PX), w)
  const height = Math.min(Math.max(b.height, MIN_PX), h)
  return {
    x: Math.min(Math.max(b.x, 0), w - width),
    y: Math.min(Math.max(b.y, 0), h - height),
    width,
    height
  }
}

/** Qué hace cada tecla del modo área sobre el rectángulo; `null` si no es suya. */
function nudge(b: Box, chord: Chord): Box | null {
  switch (chord) {
    case 'h':
      return { ...b, x: b.x - STEP_PX }
    case 'l':
      return { ...b, x: b.x + STEP_PX }
    case 'k':
      return { ...b, y: b.y - STEP_PX }
    case 'j':
      return { ...b, y: b.y + STEP_PX }
    case 'shift+h':
      return { ...b, width: b.width - STEP_PX }
    case 'shift+l':
      return { ...b, width: b.width + STEP_PX }
    case 'shift+k':
      return { ...b, height: b.height - STEP_PX }
    case 'shift+j':
      return { ...b, height: b.height + STEP_PX }
    default:
      return null
  }
}

/**
 * Paso 1 de la captura (§3.9): lienzo de recorte sobre el hueco del navegador. La vista nativa está
 * oculta y en su lugar se pinta la captura completa. Arranca con un rectángulo centrado al 60 % que
 * `H J K L` mueven y `⇧H ⇧J ⇧K ⇧L` redimensionan; el arrastre con el mouse lo reemplaza y, al
 * soltar, recorta. `⏎` recorta, `⇧⏎` se queda con la página entera y `Esc` cancela; la barra de abajo
 * ofrece lo mismo con el mouse. Lo de fuera va bajo un scrim, sin marcos. Se recorta con canvas a
 * escala real (`devicePixelRatio`). Las mismas teclas llegan reenviadas por main si la página tenía
 * el teclado (`setModeKeyHandler`).
 */
export function AreaCapture({ dataUrl, onDone, onCancel }: Props): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const [box, setBox] = useState<Box | null>(null)
  const [dragging, setDragging] = useState(false)

  const size = (): { w: number; h: number } => {
    const r = rootRef.current?.getBoundingClientRect()
    return { w: r?.width ?? 0, h: r?.height ?? 0 }
  }

  // El lienzo toma el foco para que las teclas lleguen aquí, y arranca con el rectángulo centrado.
  useLayoutEffect(() => {
    rootRef.current?.focus()
    const { w, h } = size()
    if (w === 0 || h === 0) return
    const width = Math.round(w * INITIAL_FRACTION)
    const height = Math.round(h * INITIAL_FRACTION)
    setBox({
      x: Math.round((w - width) / 2),
      y: Math.round((h - height) / 2),
      width,
      height
    })
  }, [])

  const local = (e: ReactMouseEvent | MouseEvent): { x: number; y: number } => {
    const r = rootRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return {
      x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
      y: Math.min(Math.max(e.clientY - r.top, 0), r.height)
    }
  }

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    // Si subiera al pane, `Layout` movería el foco a la raíz `.browser` y el lienzo perdería las teclas.
    e.stopPropagation()
    rootRef.current?.focus()
    const start = local(e)
    startRef.current = start
    setDragging(true)
    setBox({ ...start, width: 0, height: 0 })
    const onMove = (ev: MouseEvent): void => {
      if (startRef.current) setBox(boxOf(startRef.current, local(ev)))
    }
    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const final = startRef.current ? boxOf(startRef.current, local(ev)) : null
      startRef.current = null
      setDragging(false)
      if (!final || final.width < MIN_PX || final.height < MIN_PX) {
        setBox(null)
        return
      }
      crop(final)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** Recorta en px físicos: la captura es más grande que el hueco por `devicePixelRatio`. */
  const crop = (b: Box): void => {
    const img = imgRef.current
    if (!img || img.naturalWidth === 0 || img.clientWidth === 0) return onCancel()
    const scaleX = img.naturalWidth / img.clientWidth
    const scaleY = img.naturalHeight / img.clientHeight
    const sx = Math.round(b.x * scaleX)
    const sy = Math.round(b.y * scaleY)
    const sw = Math.max(1, Math.round(b.width * scaleX))
    const sh = Math.max(1, Math.round(b.height * scaleY))
    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')
    if (!ctx) return onCancel()
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
    onDone(canvas.toDataURL('image/png'))
  }

  /** Teclas del modo: venga del DOM o reenviada por main. `true` si era suya. */
  const handleChord = (chord: Chord): boolean => {
    if (chord === 'escape') {
      onCancel()
      return true
    }
    if (chord === 'enter') {
      if (box && box.width >= MIN_PX && box.height >= MIN_PX) crop(box)
      return true
    }
    if (chord === 'shift+enter') {
      onDone(dataUrl)
      return true
    }
    const moved = box ? nudge(box, chord) : null
    if (!moved) return false
    const { w, h } = size()
    setBox(clamp(moved, w, h))
    return true
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

  return (
    <div
      ref={rootRef}
      className="area"
      tabIndex={-1}
      role="application"
      aria-label="Recortar un área de la página"
      data-selecting={box !== null || undefined}
      data-dragging={dragging || undefined}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
    >
      <img ref={imgRef} className="area__shot" src={dataUrl} alt="" draggable={false} />
      {box ? (
        <div
          className="area__sel"
          style={{
            left: box.x,
            top: box.y,
            width: box.width,
            height: box.height
          }}
        />
      ) : (
        <div className="area__scrim" />
      )}
      {/* La barra no inicia un arrastre: sus clics son de sus botones. */}
      <div className="area__bar" onMouseDown={(e) => e.stopPropagation()}>
        <Toolbar label="Captura">
          <Button quiet kbd="Esc" title="Cerrar sin capturar" onClick={onCancel}>
            Cancelar
          </Button>
          <Button quiet kbd="⇧⏎" title="Usar la página entera" onClick={() => onDone(dataUrl)}>
            Toda la página
          </Button>
          <Button quiet variant="primary" kbd="⏎" title="Recortar la selección y seguir al dibujo" disabled={!box || box.width < MIN_PX || box.height < MIN_PX} onClick={() => box && crop(box)}>
            Recortar
          </Button>
        </Toolbar>
      </div>
    </div>
  )
}
