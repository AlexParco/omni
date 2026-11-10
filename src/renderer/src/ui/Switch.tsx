import type { JSX } from 'react'
import './switch.css'

interface Props {
  on: boolean
  /** Nombre accesible: el mismo texto que la etiqueta de su fila. */
  label: string
  onChange(on: boolean): void
}

/**
 * Interruptor de encendido/apagado para ajustes (`role="switch"`). Pista rellena, sin bordes; el
 * pomo se desliza. Tabulable y con Espacio/⏎ como un botón.
 */
export function Switch({ on, label, onChange }: Props): JSX.Element {
  return (
    <button type="button" className="switch" role="switch" aria-checked={on} aria-label={label} data-on={on || undefined} onClick={() => onChange(!on)}>
      <span className="switch__knob" aria-hidden="true" />
    </button>
  )
}
