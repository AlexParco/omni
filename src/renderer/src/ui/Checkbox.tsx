import type { JSX } from 'react'
import { CheckMark } from './icons'
import './checkbox.css'

/** `todo` casilla vacía, `done` relleno con ✓, `working` anillo ámbar con un punto (su agente trabaja). */
export type CheckboxState = 'todo' | 'done' | 'working'

/**
 * Casilla de estado de una tarea (widget To-do), 16px. Sin `onToggle` es decorativa: la fila que la
 * contiene es la que se marca y se anuncia. Con `onToggle` es un botón (camino con mouse equivalente
 * a la tecla), fuera del orden de tabulación y sin robar el foco a la lista. Estado por `data-state`.
 */
export function Checkbox({ state, title, label, onToggle }: { state: CheckboxState; title?: string; label?: string; onToggle?: () => void }): JSX.Element {
  const mark = state === 'done' && <CheckMark size={11} strokeWidth={2.5} />
  if (!onToggle)
    return (
      <span className="checkbox" data-state={state} aria-hidden="true" title={title}>
        {mark}
      </span>
    )
  return (
    <button
      type="button"
      className="checkbox"
      data-state={state}
      aria-label={label ?? (state === 'done' ? 'Marcar como pendiente' : 'Marcar como hecha')}
      title={title ?? label}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      {mark}
    </button>
  )
}
