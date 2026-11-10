import type { JSX } from 'react'
import './highlight.css'

/** Tramo resaltado `[inicio, fin)` sobre el texto. */
export type HighlightRange = readonly [number, number]

/**
 * Texto con las coincidencias de una búsqueda en `<mark>`: sin fondo, en blanco y peso 500 sobre el
 * gris del texto que lo rodea. Los rangos vienen ordenados y sin solaparse (los produce `fuzzyMatch`).
 */
export function Highlight({ text, ranges }: { text: string; ranges: readonly HighlightRange[] }): JSX.Element {
  const parts: JSX.Element[] = []
  let at = 0
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(<span key={`t${i}`}>{text.slice(at, start)}</span>)
    if (end > start) parts.push(<mark key={`m${i}`}>{text.slice(start, end)}</mark>)
    at = Math.max(at, end)
  })
  if (at < text.length) parts.push(<span key="tail">{text.slice(at)}</span>)
  return <span className="highlight">{parts}</span>
}
