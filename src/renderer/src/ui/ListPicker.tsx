import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Kbd } from './Kbd'
import './overlay.css'
import './list-picker.css'

export interface PickerItem {
  id: string
  label: string
  /** Icono de 20px: un componente de lucide o texto corto. */
  icon?: ReactNode
  /** Texto gris a la derecha, p. ej. el comando que lanza. */
  hint?: string
  /** Atajo a mostrar. */
  kbd?: string
  group?: string
  /** Acción destructiva: se pinta en rojo. */
  danger?: boolean
  /** No disponible (el `hint` dice por qué): se pinta apagado y ni ⏎ ni el clic lo eligen. */
  disabled?: boolean
}

/** Modificadores con los que se eligió (⌥⏎ en el launcher = sin pedir permisos). */
export interface PickMods {
  alt: boolean
  shift: boolean
}

interface Props {
  items: PickerItem[]
  placeholder: string
  onPick(item: PickerItem, mods: PickMods): void
  onClose(): void
  footer?: ReactNode
  /** `false` oculta el campo de filtro (menús cortos y confirmaciones). */
  filter?: boolean
  /** `false`: los grupos se separan con una línea, sin título (menú contextual al estilo macOS). */
  groupLabels?: boolean
}

const optionId = (id: string): string => `opt-${id.replace(/[^a-z0-9_-]/gi, '-')}`

/**
 * Lista navegable por teclado con filtro: ↑↓ o C-j/C-k mueven, ⏎ elige, Esc cierra.
 * Base de la paleta ⌘K, del menú ⌘T y de las confirmaciones. Escribir filtra por etiqueta.
 * Patrón combobox: el foco DOM vive siempre en el input (o en la lista si no hay filtro);
 * los ítems no son tabulables y se anuncian por `aria-activedescendant`. Tab no sale del overlay.
 * Al cerrar devuelve el foco a quien lo tenía (normalmente la terminal), salvo que otro ya lo tomara.
 */
export function ListPicker({ items, placeholder, onPick, onClose, footer, filter = true, groupLabels = true }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items
  }, [items, query])

  useEffect(() => setIndex(0), [query])

  // Quién tenía el foco antes de abrir, para devolvérselo al cerrar. Se guarda en ref porque en
  // StrictMode el efecto se monta dos veces y la segunda vez el foco ya está en el propio picker.
  const prevFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && !active.closest('.overlay')) prevFocus.current = active
    ;(filter ? inputRef.current : listRef.current)?.focus()
    return () => {
      const prev = prevFocus.current
      if (prev?.isConnected && (document.activeElement === document.body || document.activeElement === null)) prev.focus()
    }
  }, [filter])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, visible])

  const move = (delta: number): void => setIndex((i) => (visible.length ? (i + delta + visible.length) % visible.length : 0))

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Tab') return e.preventDefault()
    if (e.key === 'Escape') {
      e.preventDefault()
      return onClose()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (visible[index] && !visible[index].disabled) onPick(visible[index], { alt: e.altKey, shift: e.shiftKey })
      return
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'j' || e.key === 'n'))) {
      e.preventDefault()
      move(1)
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'k' || e.key === 'p'))) {
      e.preventDefault()
      move(-1)
    }
  }

  const activeId = visible[index] ? optionId(visible[index].id) : undefined
  let lastGroup: string | undefined
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="picker"
        data-menu={filter ? undefined : true}
        role="dialog"
        aria-modal="true"
        aria-label={placeholder}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {filter ? (
          <div className="picker__input">
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls="picker-list"
              aria-activedescendant={activeId}
              aria-autocomplete="list"
              value={query}
              placeholder={placeholder}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        ) : (
          <div className="picker__title">{placeholder}</div>
        )}
        <div id="picker-list" className="picker__list" ref={listRef} role="listbox" tabIndex={-1} aria-activedescendant={filter ? undefined : activeId}>
          {visible.length === 0 && <div className="picker__empty">Nada que coincida.</div>}
          {visible.map((item, i) => {
            const showGroup = item.group && item.group !== lastGroup
            lastGroup = item.group
            return (
              <div key={item.id} role="presentation">
                {showGroup && (
                  <>
                    {i > 0 && <div className="picker__sep" />}
                    {groupLabels && (
                      <div className="picker__group" role="presentation">
                        {item.group}
                      </div>
                    )}
                  </>
                )}
                <div
                  id={optionId(item.id)}
                  role="option"
                  aria-selected={i === index}
                  className="picker__item"
                  data-active={i === index || undefined}
                  data-danger={item.danger || undefined}
                  data-disabled={item.disabled || undefined}
                  aria-disabled={item.disabled || undefined}
                  onMouseEnter={() => setIndex(i)}
                  onClick={(e) => {
                    if (!item.disabled) onPick(item, { alt: e.altKey, shift: e.shiftKey })
                  }}
                >
                  {item.icon && <span className="picker__icon">{item.icon}</span>}
                  <span className="picker__label">{item.label}</span>
                  {item.hint && <span className="picker__hint">{item.hint}</span>}
                  {item.kbd && <Kbd>{item.kbd}</Kbd>}
                </div>
              </div>
            )
          })}
        </div>
        {footer && <div className="picker__foot">{footer}</div>}
      </div>
    </div>
  )
}
