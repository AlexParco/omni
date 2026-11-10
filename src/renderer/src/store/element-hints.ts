import type { ElementHint } from '@shared/types'

/**
 * Qué pasa al escribir una tecla en modo elemento (estilo Vimium): si completa una letra (o par de
 * letras) elige el hint; si solo es el comienzo de uno de dos letras, queda acumulada; si no
 * coincide con nada, se descarta lo acumulado. Puro, sin estado: el store guarda `typed`.
 */
export type HintStep = { kind: 'pick'; hint: ElementHint } | { kind: 'partial'; typed: string } | { kind: 'none' }

export function stepHint(hints: ElementHint[], typed: string, key: string): HintStep {
  if (!/^[a-z]$/.test(key)) return { kind: 'none' }
  const next = typed + key
  const exact = hints.find((h) => h.hint === next)
  if (exact) return { kind: 'pick', hint: exact }
  if (hints.some((h) => h.hint.startsWith(next))) return { kind: 'partial', typed: next }
  // Sin prefijo: se reinicia; la letra sola puede ser el comienzo de otro hint.
  if (typed && hints.some((h) => h.hint.startsWith(key))) {
    const alone = hints.find((h) => h.hint === key)
    return alone ? { kind: 'pick', hint: alone } : { kind: 'partial', typed: key }
  }
  return { kind: 'none' }
}
