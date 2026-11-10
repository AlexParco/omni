import { useEffect, useState, type JSX, type KeyboardEvent, type Ref } from 'react'
import './url-input.css'

interface Props {
  /** Valor real (lo que está cargado). Mientras el usuario edita, el campo guarda su borrador aparte. */
  value: string
  placeholder?: string
  /** Tooltip del campo ("Dirección · ⌘L"): el atajo va aquí, no dentro del campo. */
  title?: string
  /** ⏎ con el texto escrito. */
  onSubmit(text: string): void
  /** Esc: el borrador vuelve a `value`; el padre decide a dónde va el foco. */
  onCancel?(): void
  ref?: Ref<HTMLInputElement>
}

/**
 * Barra de dirección: campo de una línea en mono que selecciona todo al enfocarse, ⏎ confirma y Esc
 * restaura; muestra siempre la URL (o el placeholder en blanco), sin pastillas dentro. Fuera del orden de
 * tabulación (el teclado de omni es por capas). El borrador se resetea cuando `value` cambia por
 * fuera y el campo no tiene el foco (navegación por enlace, atrás, etc.).
 */
export function UrlInput({ value, placeholder, title, onSubmit, onCancel, ref }: Props): JSX.Element {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onSubmit(draft)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(value)
      onCancel?.()
    }
  }

  return (
    <label className="url-bar" data-editing={editing || undefined} title={title}>
      <input
        ref={ref}
        className="url-input"
        type="text"
        tabIndex={-1}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        value={draft}
        placeholder={placeholder}
        onFocus={(e) => {
          setEditing(true)
          e.currentTarget.select()
        }}
        onBlur={() => setEditing(false)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </label>
  )
}
