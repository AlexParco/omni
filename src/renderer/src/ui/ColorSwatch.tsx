import type { JSX } from 'react'
import './color-swatch.css'

interface Props {
  /** Nombre del color: el valor sale de `--mark-<nombre>` en tokens.css. */
  color: string
  /** Nombre accesible ("Rojo"). */
  label: string
  on: boolean
  onClick(): void
}

/**
 * Muestra de color del markup: un punto redondo; elegido = relleno suave detrás y el punto algo más
 * grande (`data-on`), nunca un anillo. Como `IconButton`, no es tabulable ni roba el foco.
 */
export function ColorSwatch({ color, label, on, onClick }: Props): JSX.Element {
  return (
    <button
      type="button"
      className="swatch"
      data-on={on || undefined}
      aria-label={label}
      aria-pressed={on}
      title={label}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <span className="swatch__dot" style={{ background: `var(--mark-${color})` }} />
    </button>
  )
}
