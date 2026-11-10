import type { JSX } from 'react'
import type { SessionStatus } from '@/store/sessions'
import './dot.css'

export type DotStatus = SessionStatus | 'empty' | 'unread'

/** Punto de estado de 7px. `working` es un aro que gira; `empty`, un aro quieto: workspace sin sesiones; `unread` es azul: sin leer (§3.14). Decorativo: el texto va aparte. */
export function Dot({ status, title }: { status: DotStatus; title?: string }): JSX.Element {
  return <span className="dot" data-status={status} aria-hidden="true" title={title} />
}
