import type { JSX, ReactNode } from 'react'
import './toolbar.css'

interface Props {
  children: ReactNode
  /** Nombre accesible del grupo de herramientas. */
  label: string
}

/**
 * Barra flotante de herramientas (markup del navegador): una pastilla con relleno que agrupa
 * `IconButton`, `ColorSwatch` y `Toggle`, separados por `ToolbarSep`. No roba el foco al hacer clic,
 * así el lienzo de abajo sigue recibiendo las teclas.
 */
export function Toolbar({ children, label }: Props): JSX.Element {
  return (
    <div className="toolbar" role="toolbar" aria-label={label} onMouseDown={(e) => e.preventDefault()}>
      {children}
    </div>
  )
}

/** Separador vertical entre grupos de la barra. */
export function ToolbarSep(): JSX.Element {
  return <span className="toolbar__sep" role="separator" aria-orientation="vertical" />
}
