import type { JSX, ReactNode } from 'react'
import './badge.css'

interface Props {
  children: ReactNode
  /** `soft` gris sobre fondo de tecla; `solid` relleno claro; `mark` naranja (zoom, pregunta). */
  tone?: 'soft' | 'solid' | 'mark'
  title?: string
}

/** Etiqueta corta en mono: índice de tab (`⌘1`), conteo de panes, flag `Z`. */
export function Badge({ children, tone = 'soft', title }: Props): JSX.Element {
  return (
    <span className="badge" data-tone={tone} title={title}>
      {children}
    </span>
  )
}
