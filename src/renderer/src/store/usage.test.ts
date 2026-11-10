import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentUsage } from '@shared/types'
import { meterLevel } from '@/ui/Meter'
import { agoLabel, resetLabel, resetTitle, splitAgents, tightest, usd } from './usage-logic'
import { useUsage } from './usage'

const invoke = vi.fn()
vi.mock('@/lib/omni', () => ({ omni: { invoke: (...args: unknown[]) => invoke(...args), send: vi.fn(), on: () => () => {} } }))

const agent = (id: AgentUsage['agent'], patch: Partial<AgentUsage> = {}): AgentUsage => ({ agent: id, found: true, today: { usd: 0, tokens: 0 }, plan: null, limits: [], limitsAt: null, stale: false, limitsError: null, ...patch })

describe('usage-logic', () => {
  const now = new Date(2026, 9, 21, 10, 0, 0).getTime()

  it('resetLabel: minutos, horas, día de la semana y fecha', () => {
    expect(resetLabel(null, now)).toBe('')
    expect(resetLabel(now - 1, now)).toBe('ahora')
    expect(resetLabel(now + 25 * 60_000, now)).toBe('25m')
    expect(resetLabel(now + 100 * 60_000, now)).toBe('1h 40m')
    expect(resetLabel(now + 3 * 3_600_000, now)).toBe('3h')
    expect(resetLabel(new Date(2026, 9, 24, 9, 0).getTime(), now)).toBe('sáb 9:00')
    expect(resetLabel(new Date(2026, 10, 20, 11, 2).getTime(), now)).toBe('20 nov')
    expect(resetTitle(new Date(2026, 9, 24, 9, 5).getTime())).toBe('Se reinicia el sáb 24 oct a las 9:05')
    // 3:59:59.9 es la de las 4:00.
    expect(resetLabel(new Date(2026, 9, 24, 3, 59, 59, 900).getTime(), now)).toBe('sáb 4:00')
  })

  it('usd, agoLabel y nivel de la barra', () => {
    expect(usd(18.6)).toBe('$18.60')
    expect(agoLabel(now - 30_000, now)).toBe('recién')
    expect(agoLabel(now - 3 * 3_600_000, now)).toBe('hace 3h')
    expect([meterLevel(79), meterLevel(80), meterLevel(95)]).toEqual(['ok', 'high', 'full'])
  })

  it('splitAgents deja los ausentes aparte y tightest encuentra el tope que más aprieta', () => {
    const list = [agent('claude', { limits: [{ id: 'session', label: '5 h', usedPercent: 62, windowMinutes: 300, resetsAt: null }] }), agent('goose', { found: false }), agent('codex', { limits: [{ id: 'weekly', label: 'Semana', usedPercent: 83, windowMinutes: 10080, resetsAt: null }] })]
    expect(splitAgents(list).present.map((a) => a.agent)).toEqual(['claude', 'codex'])
    expect(splitAgents(list).missing.map((a) => a.agent)).toEqual(['goose'])
    expect(tightest(list)).toEqual({ agent: 'codex', label: 'Semana', usedPercent: 83 })
    expect(tightest([agent('opencode')])).toBeNull()
  })
})

describe('useUsage', () => {
  beforeEach(() => {
    invoke.mockReset()
    useUsage.setState({ report: null, loading: false })
  })

  it('refresh pide usage:get, guarda el reporte y pasa force', async () => {
    const report = { agents: [agent('claude')], todayUsd: 1, at: 1 }
    invoke.mockResolvedValue(report)
    await useUsage.getState().refresh()
    expect(invoke).toHaveBeenCalledWith('usage:get', false)
    expect(useUsage.getState()).toMatchObject({ report, loading: false })
    await useUsage.getState().refresh(true)
    expect(invoke).toHaveBeenLastCalledWith('usage:get', true)
  })

  it('si main falla se queda el último reporte', async () => {
    const report = { agents: [], todayUsd: 2, at: 1 }
    useUsage.setState({ report })
    invoke.mockRejectedValue(new Error('caído'))
    await useUsage.getState().refresh()
    expect(useUsage.getState()).toMatchObject({ report, loading: false })
  })
})
