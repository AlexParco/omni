import type { JSX, KeyboardEvent, Ref } from 'react'
import './text-area.css'

interface Props {
  value: string
  placeholder?: string
  /** Nombre accesible cuando no hay etiqueta visible al lado. */
  label: string
  autoFocus?: boolean
  /** Filas visibles iniciales; crece con el texto hasta `max-height`. */
  rows?: number
  onChange(value: string): void
  /** ⌘⏎ con el texto escrito. */
  onSubmit?(value: string): void
  /** Esc. */
  onCancel?(): void
  ref?: Ref<HTMLTextAreaElement>
}

/**
 * Campo de texto de varias líneas (compositor de un comentario de la revisión): relleno suave, sin
 * borde, ⏎ es salto de línea, ⌘⏎ confirma y Esc cancela. Es tabulable: vive dentro de una vista
 * donde el teclado de la app se apaga mientras se escribe (`useKeyboard` ignora las teclas sueltas
 * en un campo de texto).
 */
export function TextArea({ value, placeholder, label, autoFocus, rows = 3, onChange, onSubmit, onCancel, ref }: Props): JSX.Element {
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && e.metaKey && onSubmit) {
      e.preventDefault()
      onSubmit(value)
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault()
      onCancel()
    }
  }
  return (
    <textarea
      ref={ref}
      className="text-area"
      aria-label={label}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      rows={rows}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  )
}
