import type { JSX, ReactNode } from 'react'
import { CheckMark } from './icons'
import { Kbd } from './Kbd'
import './check.css'

interface Props {
  on: boolean
  children: ReactNode
  /** Atajo que lo alterna, ya formateado (`⌘1`). */
  kbd?: string
  disabled?: boolean
  title?: string
  onClick(): void
}

/**
 * Casilla de una lista de opciones (adjuntos de una captura): caja a la izquierda, etiqueta y atajo.
 * Como `Toggle`, no es tabulable ni roba el foco al pulsarla: el textarea de al lado sigue escribiendo.
 * Estado por `data-on` y `data-disabled`.
 */
export function Check({ on, children, kbd, disabled, title, onClick }: Props): JSX.Element {
  return (
    <button
      type="button"
      className="check"
      role="checkbox"
      aria-checked={on}
      data-on={on || undefined}
      data-disabled={disabled || undefined}
      tabIndex={-1}
      disabled={disabled}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span className="check__box" aria-hidden="true">
        {on && <CheckMark size={11} strokeWidth={2.5} />}
      </span>
      <span className="check__label">{children}</span>
      {kbd && <Kbd>{kbd}</Kbd>}
    </button>
  )
}
