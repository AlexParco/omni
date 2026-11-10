import type { JSX, MouseEvent, ReactNode } from 'react'
import './nav-item.css'

interface NavItemProps {
  /** Icono de 16px a la izquierda (de `ui/icons`). */
  icon: ReactNode
  children: ReactNode
  /** Conteo en gris junto a la etiqueta (tareas pendientes, puertos abiertos). No va al final: ahí va el atajo y se confundían. */
  count?: number
  /** Contenido al final de la fila: el atajo (`Kbd`). */
  end?: ReactNode
  /** Vista o sección en pantalla: relleno suave, sin marco. */
  active?: boolean
  disabled?: boolean
  title?: string
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
}

/**
 * Fila de navegación del sidebar (Worktrees, Broadcast, Tareas, Puertos). Es un botón que no entra al orden de
 * tabulación ni roba el foco: el teclado sigue en la lista o en la terminal.
 */
export function NavItem({ icon, children, count, end, active, disabled, title, onClick }: NavItemProps): JSX.Element {
  return (
    <button
      className="nav-item"
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      tabIndex={-1}
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span className="nav-item__icon">{icon}</span>
      <span className="nav-item__label">
        {children}
        {count !== undefined && count > 0 && <span className="nav-item__count">{count}</span>}
      </span>
      {end && <span className="nav-item__end">{end}</span>}
    </button>
  )
}
