import { describe, expect, it } from 'vitest'
import type { CostSummary } from '@shared/types'
import { formatTokens, sessionCostLabel, todayLabel } from './cost-logic'

const summary = (today: number, bySession: CostSummary['bySession'] = {}): CostSummary => ({ today, bySession, byAgent: {} })

describe('formatTokens', () => {
  it('abrevia en k y M, con un decimal solo por debajo de 10 unidades', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(620)).toBe('620')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_000)).toBe('1k')
    expect(formatTokens(1_500)).toBe('1.5k')
    expect(formatTokens(9_940)).toBe('9.9k')
    expect(formatTokens(9_960)).toBe('10k')
    expect(formatTokens(62_400)).toBe('62k')
    expect(formatTokens(999_600)).toBe('1000k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_250_000)).toBe('1.3M')
    expect(formatTokens(12_700_000)).toBe('13M')
  })
})

describe('todayLabel', () => {
  it('pinta dos decimales y el + del piso', () => {
    expect(todayLabel(summary(18.6))).toBe('$18.60+')
    expect(todayLabel(summary(0.005))).toBe('$0.01+')
    expect(todayLabel(summary(1234.567))).toBe('$1234.57+')
  })

  it('es null sin resumen o con costo cero', () => {
    expect(todayLabel(null)).toBeNull()
    expect(todayLabel(summary(0))).toBeNull()
    expect(todayLabel(summary(-1))).toBeNull()
    expect(todayLabel(summary(Number.NaN))).toBeNull()
  })
})

describe('sessionCostLabel', () => {
  const s = summary(10, { a: { usd: 3.1, tokens: 62_400 }, b: { usd: 0, tokens: 0 }, c: { usd: 0, tokens: 800 } })

  it('pinta dólares y tokens abreviados separados por ·', () => {
    expect(sessionCostLabel(s, 'a')).toBe('$3.10 · 62k')
  })

  it('con tokens pero sin dólares igual se muestra (modelo sin precio conocido)', () => {
    expect(sessionCostLabel(s, 'c')).toBe('$0.00 · 800')
  })

  it('es null sin resumen, sin la sesión o con todo en cero', () => {
    expect(sessionCostLabel(null, 'a')).toBeNull()
    expect(sessionCostLabel(s, 'zzz')).toBeNull()
    expect(sessionCostLabel(s, 'b')).toBeNull()
  })
})
