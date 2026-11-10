import { useEffect, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Kbd } from './Kbd'
import './widget.css'

interface Props {
  /** Clase de la feature (`ports`, `usage`) en la tarjeta: sus piezas cuelgan de ella. */
  name: string
  title: string
  /** Atajo que abre y cierra el widget, ya formateado (`⌥⌘P`). */
  shortcut?: string
  /** El número grande de la cabecera (`10`, `$24.10`). */
  value: ReactNode
  /** Qué cuenta el número, debajo (`servicios levantados`, `hoy`). */
  valueLabel: string
  /** Nombre accesible del diálogo. */
  label: string
  /** La tarjeta: recibe el foco al abrir y las teclas mientras está abierto. */
  rootRef: RefObject<HTMLDivElement | null>
  onClose(): void
  onKeyDown(e: KeyboardEvent<HTMLDivElement>): void
  /** Pie: atajos (`Hint`) o el aviso de la última acción. */
  foot: ReactNode
  children: ReactNode
}

/**
 * Widget flotante al estilo de macOS (Puertos §3.24, Uso §3.25): velo, tarjeta de 440 × 560 con material
 * translúcido, cabecera con título, atajo y un número grande, cuerpo de la feature y pie. Al abrir el
 * teclado va a la tarjeta; al cerrar vuelve a quien lo tenía, salvo que otro overlay lo haya tomado.
 */
export function Widget({ name, title, shortcut, value, valueLabel, label, rootRef, onClose, onKeyDown, foot, children }: Props): JSX.Element {
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    const prev = active && !active.closest('.widget-overlay') ? active : null
    if (!rootRef.current?.contains(document.activeElement)) rootRef.current?.focus()
    return () => {
      // Si otro overlay abrió (el launcher, un diálogo), el foco es suyo.
      if (document.querySelector('.overlay, .widget-overlay')) return
      if (prev?.isConnected && (document.activeElement === document.body || document.activeElement === null)) prev.focus()
    }
  }, [rootRef])

  return (
    <div className="widget-overlay" onMouseDown={onClose}>
      <div ref={rootRef} className={`widget ${name}`} role="dialog" aria-modal="true" aria-label={label} data-focus="list" tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="widget__head">
          <span className="widget__title">
            {title}
            {shortcut && <Kbd>{shortcut}</Kbd>}
          </span>
          <span className="widget__value" aria-hidden="true">
            {value}
          </span>
          <span className="widget__sub">{valueLabel}</span>
        </div>
        {children}
        <div className="widget__foot" role="status">
          {foot}
        </div>
      </div>
    </div>
  )
}
