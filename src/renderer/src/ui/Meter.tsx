import type { JSX } from 'react'
import './meter.css'

/** Nivel de una cuota: `high` desde el 80 %, `full` desde el 95 %. */
export type MeterLevel = 'ok' | 'high' | 'full'

export function meterLevel(percent: number): MeterLevel {
  return percent >= 95 ? 'full' : percent >= 80 ? 'high' : 'ok'
}

/**
 * Barra fina de cuánto se usó de un tope (0–100), para el widget Uso (§3.25). El color sube a naranja
 * y a rojo con el nivel, pero nunca va solo: quien la usa escribe el porcentaje al lado.
 */
export function Meter({ value, label }: { value: number; label: string }): JSX.Element {
  const v = Math.min(100, Math.max(0, value))
  return (
    <span className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-label={label} data-level={meterLevel(v)}>
      <span className="meter__fill" style={{ width: `${v}%` }} />
    </span>
  )
}
