import type { JSX, MouseEvent, ReactNode } from 'react'
import { X } from './icons'
import './tabs.css'

/** Barra horizontal de tabs. Hace scroll si no caben; el hijo con `TabsEnd` se pega a la derecha. */
export function Tabs({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="tabs" role="tablist">
      {children}
    </div>
  )
}

interface TabProps {
  active: boolean
  children: ReactNode
  title?: string
  onSelect(): void
  /** Si se pasa, el tab activo muestra la × y el clic central cierra. */
  onClose?: () => void
  closeLabel?: string
}

/** Un tab: botón de selección y, si es el activo y se puede, botón de cierre como hermano (nunca anidado). */
export function Tab({ active, children, title, onSelect, onClose, closeLabel = 'Cerrar' }: TabProps): JSX.Element {
  return (
    <div className="tab" data-active={active || undefined} role="presentation">
      <button
        className="tab__main"
        role="tab"
        aria-selected={active}
        title={title}
        onClick={onSelect}
        onAuxClick={(e: MouseEvent) => {
          if (e.button === 1) onClose?.()
        }}
      >
        {children}
      </button>
      {active && onClose && (
        <button
          className="tab__close"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

/** Botón de acción en la barra (p. ej. `+`). */
export function TabAction({ label, title, onClick, children }: { label: string; title?: string; onClick(): void; children: ReactNode }): JSX.Element {
  return (
    <button className="tab tab--action" aria-label={label} title={title ?? label} onClick={onClick}>
      {children}
    </button>
  )
}

/** Contenido fijo al extremo derecho de la barra (ruta, rama). */
export function TabsEnd({ children, title }: { children: ReactNode; title?: string }): JSX.Element {
  return (
    <div className="tabs__end" title={title}>
      {children}
    </div>
  )
}

/** Nombre del tab: una línea con elipsis. */
export function TabLabel({ children }: { children: ReactNode }): JSX.Element {
  return <span className="tab__label">{children}</span>
}
