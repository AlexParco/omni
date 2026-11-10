import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import { ICON_SM, Search } from './icons'
import './overlay.css'
import './dialog.css'

interface Props {
  title: string
  /** Texto pequeño bajo el título (ruta del archivo, ayuda). */
  subtitle?: ReactNode
  /** Caja de filtro en la cabecera: el panel decide qué filtra. */
  filter?: { value: string; placeholder: string; onChange(value: string): void }
  children: ReactNode
  footer?: ReactNode
  /** Panel ancho (820px) para cuerpos a dos columnas. */
  wide?: boolean
  onClose(): void
}

/**
 * Panel modal con contenido libre (ajustes, formularios). Esc cierra, clic fuera cierra, y al
 * cerrar devuelve el foco a quien lo tenía (misma regla que ListPicker). El contenido decide
 * qué es enfocable; el panel solo garantiza que el teclado no se escape a la app.
 */
export function Dialog({ title, subtitle, filter, children, footer, wide, onClose }: Props): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const prevFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && !active.closest('.overlay')) prevFocus.current = active
    // Un hijo con `autoFocus` (TextInput) ya tomó el foco al montarse: se respeta.
    if (!panelRef.current?.contains(document.activeElement)) (filterRef.current ?? panelRef.current)?.focus()
    return () => {
      const prev = prevFocus.current
      if (prev?.isConnected && (document.activeElement === document.body || document.activeElement === null)) prev.focus()
    }
  }, [])

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="dialog"
        data-wide={wide || undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault()
            onClose()
          }
        }}
      >
        <div className="dialog__head">
          <div className="dialog__title">{title}</div>
          {subtitle && <div className="dialog__subtitle">{subtitle}</div>}
          {filter && (
            <label className="dialog__filter">
              <Search {...ICON_SM} aria-hidden="true" />
              <input ref={filterRef} type="search" value={filter.value} placeholder={filter.placeholder} onChange={(e) => filter.onChange(e.target.value)} />
            </label>
          )}
        </div>
        <div className="dialog__body">{children}</div>
        {footer && <div className="dialog__foot">{footer}</div>}
      </div>
    </div>
  )
}

/** Título de bloque dentro del cuerpo del panel. */
export function DialogSection({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="dialog__section">
      <div className="dialog__section-title">{title}</div>
      {children && <div className="dialog__section-desc">{children}</div>}
    </div>
  )
}
