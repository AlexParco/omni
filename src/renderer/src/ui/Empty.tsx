import type { JSX, ReactNode } from 'react'
import './empty.css'

/** Estado vacío centrado: un icono opcional (decorativo), título, subtítulo y una acción. */
export function Empty({ title, icon, children }: { title: ReactNode; icon?: ReactNode; children?: ReactNode }): JSX.Element {
  return (
    <div className="empty">
      {icon && <div className="empty__icon">{icon}</div>}
      <div className="empty__title">{title}</div>
      {children}
    </div>
  )
}
