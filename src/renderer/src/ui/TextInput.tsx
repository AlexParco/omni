import type { JSX, KeyboardEvent, Ref } from 'react'
import './text-input.css'

interface Props {
  value: string
  placeholder?: string
  /** Nombre accesible cuando no hay etiqueta visible al lado. */
  label: string
  autoFocus?: boolean
  /** Con `autoFocus`, deja el texto seleccionado al abrir (renombrar: se escribe encima, como en Finder). */
  selectOnFocus?: boolean
  onChange(value: string): void
  /** ⏎ con el texto escrito. */
  onSubmit?(value: string): void
  /** Teclas extra (↑↓, Tab para completar): devuelve `true` si la manejó y no debe seguir. */
  onKey?(e: KeyboardEvent<HTMLInputElement>): boolean
  ref?: Ref<HTMLInputElement>
}

/**
 * Campo de texto de una línea para diálogos (nombre de un perfil): relleno suave, sin borde,
 * ⏎ confirma. Es tabulable: vive en diálogos, donde el teclado va por Tab.
 */
export function TextInput({ value, placeholder, label, autoFocus, selectOnFocus, onChange, onSubmit, onKey, ref }: Props): JSX.Element {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (onKey?.(e)) {
      e.preventDefault()
      return
    }
    if (e.key === 'Enter' && onSubmit) {
      e.preventDefault()
      onSubmit(value)
    }
  }
  return (
    <input
      ref={ref}
      className="text-input"
      type="text"
      aria-label={label}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onFocus={selectOnFocus ? (e) => e.currentTarget.select() : undefined}
    />
  )
}
