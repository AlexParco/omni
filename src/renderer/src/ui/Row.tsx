import type { JSX, MouseEvent, ReactNode } from 'react'
import './row.css'

/** Índice de pastilla de color: `--chip-1` … `--chip-6` en `tokens.css`. */
export type ChipColor = 1 | 2 | 3 | 4 | 5 | 6

interface RowProps {
  /** Id DOM, para `aria-activedescendant` del listbox que la contiene. */
  id: string
  children: ReactNode
  /** Fila bajo el cursor vim. */
  cursor?: boolean
  /** Fila que representa lo que está en pantalla (tab mostrado, pane con foco). */
  active?: boolean
  /** Profundidad en el árbol: 0 proyecto, 1 tab, 2 pane. */
  level?: 0 | 1 | 2
  /** Hijo de una carpeta o worktree dentro de un proyecto: un paso más de sangría, para que cuelgue de esa fila y no del proyecto. */
  nested?: boolean
  /** Guía vertical fina a la izquierda: une un bloque de hijos (panes de un tab) con su padre. */
  guide?: boolean
  /** Fila de varias líneas (Worktrees, Broadcast, Puertos: nombre y líneas secundarias): el punto y el icono se alinean con la primera, con `RowLines`/`RowLine`. */
  multiline?: boolean
  /** Estado para tintar el texto (pregunta en naranja). */
  status?: string
  expanded?: boolean
  title?: string
  onClick?: (e: MouseEvent<HTMLDivElement>) => void
  onDoubleClick?: (e: MouseEvent<HTMLDivElement>) => void
}

/**
 * Fila de una lista navegable por teclado (`role="option"`). No es enfocable: la selección es el
 * cursor del store y se anuncia por `aria-selected`. Estados por `data-*`, nunca por clases modificadoras.
 */
export function Row({ id, children, cursor, active, level = 0, nested, guide, multiline, status, expanded, title, onClick, onDoubleClick }: RowProps): JSX.Element {
  return (
    <div
      id={id}
      role="option"
      aria-selected={cursor === true}
      aria-expanded={expanded}
      className="row"
      data-cursor={cursor || undefined}
      data-active={active || undefined}
      data-level={level}
      data-nested={nested || undefined}
      data-guide={guide || undefined}
      data-multiline={multiline || undefined}
      data-status={status}
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {children}
    </div>
  )
}

/** Extremo derecho de la fila (tiempo, punto de estado): columna alineada entre niveles; se esconde cuando aparecen las acciones. */
export function RowEnd({ children }: { children: ReactNode }): JSX.Element {
  return <span className="row__end">{children}</span>
}

/** Texto principal de la fila: una línea, con elipsis. */
export function RowLabel({ children, strong }: { children: ReactNode; strong?: boolean }): JSX.Element {
  return (
    <span className="row__label" data-strong={strong || undefined}>
      {children}
    </span>
  )
}

/** Texto secundario en mono (ruta, rama). Toma el espacio sobrante. */
export function RowMeta({ children }: { children: ReactNode }): JSX.Element {
  return <span className="row__meta">{children}</span>
}

/** Cuerpo de una `Row multiline`: columna de `RowLine` que toma el espacio sobrante. */
export function RowLines({ children }: { children: ReactNode }): JSX.Element {
  return <span className="row__lines">{children}</span>
}

/** Una línea de una `Row multiline`: fila de 20px; `muted` para la línea secundaria (tipo de entrada), 12px en gris. */
export function RowLine({ children, muted }: { children: ReactNode; muted?: boolean }): JSX.Element {
  return (
    <span className="row__line" data-muted={muted || undefined}>
      {children}
    </span>
  )
}

/** Tiempo (espera, última actividad) al extremo de una línea: 12px tabular en gris. */
export function RowTime({ children, title }: { children: ReactNode; title?: string }): JSX.Element {
  return (
    <span className="row__time" title={title}>
      {children}
    </span>
  )
}

/** Conteo pequeño en gris junto a la etiqueta (agentes de un proyecto). */
export function RowCount({ children, title }: { children: ReactNode; title?: string }): JSX.Element {
  return (
    <span className="row__count" title={title}>
      {children}
    </span>
  )
}

/** Acciones al final de la fila: visibles al pasar el mouse o con el cursor encima. */
export function RowActions({ children }: { children: ReactNode }): JSX.Element {
  return <span className="row__actions">{children}</span>
}

/** Pastilla cuadrada de color (22px) con un icono blanco dentro: identidad de un proyecto. */
export function RowChip({ color, children }: { color: ChipColor; children: ReactNode }): JSX.Element {
  return (
    <span className="row__chip" data-chip={color} aria-hidden="true">
      {children}
    </span>
  )
}

/** Color de pastilla estable para un id: el mismo proyecto siempre sale del mismo color. */
export function chipOf(seed: string): ChipColor {
  let h = 5381
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0
  return ((Math.abs(h) % 6) + 1) as ChipColor
}
