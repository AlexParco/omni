import type { JSX, ReactNode } from 'react'
import './toggle.css'

interface Props {
  on: boolean
  children: ReactNode
  /** Conteo a la derecha de la etiqueta (p. ej. entradas de consola por nivel); 0 no se pinta. */
  count?: number
  title?: string
  onClick(): void
}

/**
 * Chip conmutable (filtros, vistas): relleno suave cuando está encendido, nunca borde. Como
 * `IconButton`, no es tabulable ni roba el foco al pulsarlo.
 */
export function Toggle({ on, children, count, title, onClick }: Props): JSX.Element {
  return (
    <button className="toggle" data-on={on || undefined} aria-pressed={on} tabIndex={-1} title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
      {count !== undefined && count > 0 && <span className="toggle__count">{count}</span>}
    </button>
  )
}
