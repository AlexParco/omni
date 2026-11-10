import type { JSX } from 'react'
import './kbd.css'

/** Tecla o atajo ya formateado (`⌘K`, `C-a x`). Recibe lo que devuelve `prettyChord`, nunca texto a mano. */
export function Kbd({ children }: { children: string }): JSX.Element {
  return <kbd className="kbd">{children}</kbd>
}
