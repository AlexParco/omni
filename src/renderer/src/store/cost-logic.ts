import type { CostSummary } from '@shared/types'

/** Dólares con dos decimales: `$18.60`. */
function usd(value: number): string {
  return `$${value.toFixed(2)}`
}

/**
 * Tokens abreviados: `620`, `1.5k`, `62k`, `1.2M`. Un decimal solo por debajo de 10 unidades
 * (`9.5k`, `1.2M`), que es donde aporta; el `.0` sobrante se recorta.
 */
export function formatTokens(tokens: number): string {
  const scaled = (n: number, unit: string): string => {
    const tenth = Math.round(n * 10) / 10
    return `${tenth < 10 ? tenth : Math.round(n)}${unit}`
  }
  if (tokens < 1_000) return Math.round(tokens).toString()
  if (tokens < 1_000_000) return scaled(tokens / 1_000, 'k')
  return scaled(tokens / 1_000_000, 'M')
}

/**
 * Etiqueta del costo del día para la barra de título: `$18.60+`. El `+` siempre va, porque es un
 * piso (ARCHITECTURE §3.17). `null` si no hay resumen o no hay nada que mostrar (0).
 */
export function todayLabel(summary: CostSummary | null): string | null {
  if (!summary || !(summary.today > 0)) return null
  return `${usd(summary.today)}+`
}

/**
 * Etiqueta del costo de una sesión para el detalle del quick open: `$3.10 · 62k`. `null` si la
 * sesión no aparece en el resumen o no tiene nada registrado.
 */
export function sessionCostLabel(summary: CostSummary | null, sessionId: string): string | null {
  const cost = summary?.bySession[sessionId]
  if (!cost || (!(cost.usd > 0) && !(cost.tokens > 0))) return null
  return `${usd(cost.usd)} · ${formatTokens(cost.tokens)}`
}
