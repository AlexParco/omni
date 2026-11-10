import type { JSX } from 'react'
import { ChevronDown, ICON_SM } from './icons'
import './select.css'

export interface SelectOption {
  value: string
  label: string
}

interface Props {
  value: string
  options: SelectOption[]
  /** Nombre accesible cuando no hay etiqueta visible al lado (p. ej. dentro de un `Field`). */
  label: string
  disabled?: boolean
  onChange(value: string): void
}

/**
 * Selector de una opción (perfil, viewport) para formularios: un `<select>` nativo con relleno
 * suave y chevron, sin borde. Es tabulable: vive en diálogos, donde el teclado va por Tab.
 */
export function Select({ value, options, label, disabled, onChange }: Props): JSX.Element {
  return (
    <span className="select" data-disabled={disabled || undefined}>
      <select className="select__input" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown {...ICON_SM} aria-hidden="true" className="select__chevron" />
    </span>
  )
}
