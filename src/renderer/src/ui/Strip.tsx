import type { JSX, MouseEvent, ReactNode } from 'react'
import './strip.css'

interface Props {
  children: ReactNode
  /** `live` teclado aquí · `layout` foco del layout sin teclado · `none`. */
  focus: 'live' | 'layout' | 'none'
}

/**
 * Franja de cabecera de un pane: identidad y estado. No es enfocable y no roba el foco al hacer clic,
 * para que el clic enfoque la terminal de abajo.
 */
export function Strip({ children, focus }: Props): JSX.Element {
  return (
    <div className="strip" data-focus={focus} onMouseDown={(e) => e.preventDefault()}>
      {children}
    </div>
  )
}

export function StripTitle({ children, title }: { children: ReactNode; title?: string }): JSX.Element {
  return (
    <span className="strip__title" title={title}>
      {children}
    </span>
  )
}

/** Lo que va pegado a la derecha: estado, flags, acciones. */
export function StripEnd({ children }: { children: ReactNode }): JSX.Element {
  return <span className="strip__end">{children}</span>
}

export function StripActions({ children }: { children: ReactNode }): JSX.Element {
  return <span className="strip__actions">{children}</span>
}

/**
 * Acción con texto dentro de la franja (p. ej. el dev server que levantó la terminal: `localhost:5173`).
 * Siempre visible, a diferencia de `StripActions`: es algo que la sesión ofrece, no una herramienta.
 */
export function StripLink({ icon, children, title, onClick }: { icon?: ReactNode; children: ReactNode; title?: string; onClick: (e: MouseEvent<HTMLButtonElement>) => void }): JSX.Element {
  return (
    <button className="strip__link" tabIndex={-1} title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  )
}
