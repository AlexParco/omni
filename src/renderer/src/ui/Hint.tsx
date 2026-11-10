import type { JSX, ReactNode } from 'react'
import { Kbd } from './Kbd'
import './hint.css'

/**
 * Tecla + qué hace. Para footers y pies de overlays. `quiet` deja la tecla sin caja, en un gris más
 * claro que la descripción: en una fila larga de atajos las cajas se volvían ruido.
 */
export function Hint({ kbd, children, on, quiet }: { kbd: string; children: ReactNode; on?: boolean; quiet?: boolean }): JSX.Element {
  return (
    <span className="hint" data-on={on || undefined} data-quiet={quiet || undefined}>
      <Kbd>{kbd}</Kbd> {children}
    </span>
  )
}
