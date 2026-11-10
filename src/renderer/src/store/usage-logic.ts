import type { AgentUsage } from '@shared/types'

/** Dólares con dos decimales: `$18.60`. */
export function usd(value: number): string {
  return `$${value.toFixed(2)}`
}

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** La hora de reinicio al minuto más cercano: los servidores dan `03:59:59.9` para las 4:00. */
const toMinute = (ms: number): Date => new Date(Math.round(ms / 60_000) * 60_000)

/**
 * Cuándo se reinicia un tope, corto y en hora local: dentro de un día, lo que falta (`1h 40m`, `25m`);
 * dentro de la semana, el día y la hora (`jue 9:00`); más lejos, la fecha (`20 nov`). Vacío si no se sabe.
 */
export function resetLabel(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return ''
  const ms = resetsAt - now
  if (ms <= 0) return 'ahora'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const d = toMinute(resetsAt)
  if (ms < 7 * 86_400_000) return `${WEEKDAYS[d.getDay()]} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** Frase completa para el tooltip y el lector de pantalla: `Se reinicia el jue 24 oct a las 9:00`. */
export function resetTitle(resetsAt: number | null): string {
  if (resetsAt === null) return 'Sin hora de reinicio'
  const d = toMinute(resetsAt)
  return `Se reinicia el ${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} a las ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Hace cuánto: `recién`, `hace 3m`, `hace 2h`, `hace 4d`. */
export function agoLabel(at: number | null, now: number): string {
  if (at === null) return ''
  const m = Math.floor(Math.max(0, now - at) / 60_000)
  if (m < 1) return 'recién'
  if (m < 60) return `hace ${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `hace ${h}h` : `hace ${Math.floor(h / 24)}d`
}

/** Los que dejaron rastro en la máquina, en el orden del catálogo; los ausentes, aparte al final. */
export function splitAgents(agents: readonly AgentUsage[]): { present: AgentUsage[]; missing: AgentUsage[] } {
  return { present: agents.filter((a) => a.found), missing: agents.filter((a) => !a.found) }
}

/** El tope que más aprieta (para el resumen del sidebar o un aviso); `null` si no hay topes. */
export function tightest(agents: readonly AgentUsage[]): { agent: AgentUsage['agent']; label: string; usedPercent: number } | null {
  let best: { agent: AgentUsage['agent']; label: string; usedPercent: number } | null = null
  for (const a of agents) for (const l of a.limits) if (!best || l.usedPercent > best.usedPercent) best = { agent: a.agent, label: l.label, usedPercent: l.usedPercent }
  return best
}
