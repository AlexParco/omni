import type { JSX, MouseEvent, ReactNode } from 'react'
import { Kbd } from './Kbd'
import './button.css'

interface ButtonProps {
  children: ReactNode
  /** `primary` relleno claro; `ghost` solo borde; `danger` texto rojo (acción destructiva, p. ej. borrar datos). */
  variant?: 'primary' | 'ghost' | 'danger'
  /** Atajo a la derecha, ya formateado. */
  kbd?: string
  /** Conmutador encendido (p. ej. Móvil activo): relleno suave, `data-on`. */
  on?: boolean
  title?: string
  disabled?: boolean
  /** `true` lo saca del orden de tabulación y no roba el foco al pulsarlo (barras de un pane). */
  quiet?: boolean
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
}

/** Botón con texto, icono opcional a la izquierda y atajo opcional a la derecha. */
export function Button({ children, variant = 'ghost', kbd, on, title, disabled, quiet, onClick }: ButtonProps): JSX.Element {
  return (
    <button
      className="btn"
      data-variant={variant}
      data-on={on || undefined}
      aria-pressed={on === undefined ? undefined : on}
      title={title}
      disabled={disabled}
      tabIndex={quiet ? -1 : undefined}
      onMouseDown={quiet ? (e) => e.preventDefault() : undefined}
      onClick={onClick}
    >
      {children}
      {kbd && <Kbd>{kbd}</Kbd>}
    </button>
  )
}

interface IconButtonProps {
  /** Nombre accesible; también es el tooltip si no hay `title`. */
  label: string
  title?: string
  children: ReactNode
  /** `auto`: ancho según el contenido (una `Kbd` dentro, p. ej. `⌘←`). */
  size?: 'sm' | 'md' | 'auto'
  disabled?: boolean
  /** Conmutador encendido: `data-on`. */
  on?: boolean
  /** Acción primaria de una barra de iconos (Elemento, Captura): relleno suave fijo, `data-primary`. */
  primary?: boolean
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
}

/**
 * Botón solo-icono. Nunca entra al orden de tabulación (el teclado de omni es por capas, no por Tab)
 * y no roba el foco al pulsarlo, así la terminal o la lista siguen teniendo el teclado.
 */
export function IconButton({ label, title, children, size = 'md', disabled, on, primary, onClick }: IconButtonProps): JSX.Element {
  return (
    <button
      className="icon-btn"
      data-size={size}
      data-on={on || undefined}
      data-primary={primary || undefined}
      aria-pressed={on === undefined ? undefined : on}
      tabIndex={-1}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.(e)
      }}
    >
      {children}
    </button>
  )
}
