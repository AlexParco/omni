import { useEffect, useRef, type JSX } from 'react'
import { useUi } from '@/store/ui'
import { attachTerminal, detachTerminal, getTerminal } from './terminal-host'

interface Props {
  sessionId: string
  /** Pane con el foco del layout. */
  focused: boolean
}

/** Hueco de React para una terminal. La instancia de xterm vive en terminal-host y se reparenta aquí. */
export function TerminalPane({ sessionId, focused }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const uiFocus = useUi((s) => s.focus)

  useEffect(() => {
    if (!ref.current) return
    attachTerminal(sessionId, ref.current)
    return () => detachTerminal(sessionId)
  }, [sessionId])

  // Si este pane tiene el foco del layout y la intención es "terminal", toma el teclado.
  // Nunca se desenfoca a mano: solo un textarea puede tener el foco y el blur lo maneja el host.
  useEffect(() => {
    if (focused && uiFocus === 'terminal') getTerminal(sessionId)?.focus()
  }, [sessionId, focused, uiFocus])

  return <div ref={ref} className="term-host" />
}
