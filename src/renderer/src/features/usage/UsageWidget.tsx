import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react'
import type { AgentUsage } from '@shared/types'
import { chordOf, prettyChord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { Badge } from '@/ui/Badge'
import { Empty } from '@/ui/Empty'
import { Hint } from '@/ui/Hint'
import { AgentIcon } from '@/ui/icons'
import { Meter, meterLevel } from '@/ui/Meter'
import { Widget } from '@/ui/Widget'
import { useClock } from '@/store/clock'
import { formatTokens } from '@/store/cost-logic'
import { agentOf, useSessions } from '@/store/sessions'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { agoLabel, resetLabel, resetTitle, splitAgents, usd } from '@/store/usage-logic'
import { USAGE_REFRESH_MS, useUsage } from '@/store/usage'
import './usage.css'

/** Cuánto baja o sube la lista con J K. */
const SCROLL_STEP = 64

/** Atajo global vigente de un comando, ya formateado. */
function globalKey(id: string): string | undefined {
  const chord = keymap.chordsFor(id).find((c) => c.layer === 'global')?.chord
  return chord ? prettyChord(chord) : undefined
}

/**
 * Widget Uso (ARCHITECTURE §3.25): cuánto llevas hoy con cada agente y cuánto te queda de su plan. Una
 * tarjeta por agente con rastro en la máquina: icono, nombre, plan y lo de hoy en dólares; debajo, una
 * fila por tope (5 h, semana, semana de un modelo) con su barra, el porcentaje escrito y cuándo se
 * reinicia. Los agentes sin datos van al final, en una línea. `R` vuelve a medir, `J K` desplazan, Esc cierra.
 */
export function UsageWidget(): JSX.Element {
  const report = useUsage((s) => s.report)
  const loading = useUsage((s) => s.loading)
  const refresh = useUsage((s) => s.refresh)
  const sessions = useSessions()
  const closeOverlay = useUi((s) => s.closeOverlay)
  const now = useClock((c) => c.now)
  useSettings((s) => s.settings.keys)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Al abrir se mide; mientras siga abierto, cada minuto.
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), USAGE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const chord = chordOf(e.nativeEvent)
    const act = (fn: () => void): void => {
      e.preventDefault()
      e.stopPropagation()
      fn()
    }
    if (chord === 'escape') return act(closeOverlay)
    if (chord === 'r') return act(() => void refresh(true))
    if (chord === 'j' || chord === 'down') return act(() => listRef.current?.scrollBy({ top: SCROLL_STEP }))
    if (chord === 'k' || chord === 'up') return act(() => listRef.current?.scrollBy({ top: -SCROLL_STEP }))
  }

  const nameOf = (a: AgentUsage): string => agentOf(sessions, a.agent)?.name ?? a.agent

  const renderAgent = (a: AgentUsage): JSX.Element => {
    const name = nameOf(a)
    const tokens = a.today ? `${formatTokens(a.today.tokens)} tokens hoy` : 'omni aún no lee su consumo'
    // Sin uso hoy: el gasto en cero no es dato; la tarjeta queda en una línea (salvo que tenga topes que mostrar).
    const idle = a.today !== null && a.today.tokens === 0 && a.today.usd === 0
    const meta = [idle ? '' : tokens, a.stale && a.limitsAt ? `topes de ${agoLabel(a.limitsAt, now)}` : ''].filter(Boolean).join(' · ')
    return (
      <section key={a.agent} className="usage__agent" data-agent={a.agent} data-idle={idle || undefined} aria-label={name}>
        <div className="usage__head">
          <AgentIcon agent={a.agent} />
          <span className="usage__name">{name}</span>
          {a.plan && <Badge title={`Plan de la cuenta: ${a.plan}`}>{a.plan}</Badge>}
          <span className="usage__today" title="Hoy desde las 00:00, según los logs locales (piso)">
            {idle ? 'sin uso hoy' : a.today ? usd(a.today.usd) : '—'}
          </span>
        </div>
        {a.limits.length > 0 && (
          <div className="usage__limits">
            {a.limits.map((l) => {
              const pct = `${Math.round(l.usedPercent)}%`
              const reset = resetLabel(l.resetsAt, now)
              return (
                <div key={l.id} className="usage__limit" data-level={meterLevel(l.usedPercent)} title={`${l.label}: ${pct} usado. ${resetTitle(l.resetsAt)}`}>
                  <span className="usage__label">{l.label}</span>
                  <Meter value={l.usedPercent} label={`${name}, ${l.label}: ${pct} usado`} />
                  <span className="usage__pct">{pct}</span>
                  <span className="usage__reset">{reset}</span>
                </div>
              )
            })}
          </div>
        )}
        {meta && <p className="usage__meta" title={a.stale && a.limitsError ? `${a.limitsError}: se muestran los últimos topes que dejó en sus logs` : undefined}>
          {meta}
        </p>}
        {a.limitsError && a.limits.length === 0 && <p className="usage__note">{a.limitsError}</p>}
      </section>
    )
  }

  const groups = report ? splitAgents(report.agents) : null
  const total = report ? usd(report.todayUsd) : '—'
  const measured = report ? agoLabel(report.at, now) : ''

  return (
    <Widget
      name="usage"
      title="Uso"
      shortcut={globalKey('usage.toggle')}
      value={total}
      valueLabel="hoy"
      label={`Uso de los agentes, ${total} hoy`}
      rootRef={rootRef}
      onClose={closeOverlay}
      onKeyDown={onKeyDown}
      foot={
        <>
          <Hint kbd="R">{loading ? 'midiendo' : 'actualizar'}</Hint>
          <Hint kbd="J K">desplazar</Hint>
          {measured && <span className="usage__measured">medido {measured}</span>}
        </>
      }
    >
      <div ref={listRef} className="usage__list" aria-busy={loading}>
        {!groups && <Empty title="Midiendo el uso">Logs locales y topes del plan de cada agente</Empty>}
        {groups?.present.map(renderAgent)}
        {groups && groups.missing.length > 0 && (
          <div className="usage__missing">
            <span className="usage__missing-title">Sin datos en esta máquina</span>
            {groups.missing.map((a) => (
              <span key={a.agent} className="usage__missing-agent" data-agent={a.agent}>
                <AgentIcon agent={a.agent} size={14} />
                {nameOf(a)}
              </span>
            ))}
          </div>
        )}
      </div>
    </Widget>
  )
}
