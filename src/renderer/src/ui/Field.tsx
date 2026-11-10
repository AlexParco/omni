import type { JSX, ReactNode } from 'react'
import './field.css'

interface Props {
  label: string
  /** Qué hace y qué valores admite. */
  description?: ReactNode
  /** El control, a la derecha. */
  children: ReactNode
}

/** Fila de un formulario de ajustes: etiqueta y descripción a la izquierda, control a la derecha. */
export function Field({ label, description, children }: Props): JSX.Element {
  return (
    <div className="field">
      <div className="field__text">
        <div className="field__label">{label}</div>
        {description && <div className="field__desc">{description}</div>}
      </div>
      <div className="field__control">{children}</div>
    </div>
  )
}
