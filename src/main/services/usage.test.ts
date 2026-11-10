import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_USAGE_URL, CODEX_USAGE_URL, LIMITS_TTL_MS, claudePlan, parseClaudeUsage, parseCodexLogLimits, parseCodexUsage, toMs, UsageService, windowLabel } from './usage'

describe('parsers', () => {
  it('toMs entiende ISO, segundos y milisegundos', () => {
    expect(toMs('2026-10-24T09:00:00Z')).toBe(Date.parse('2026-10-24T09:00:00Z'))
    expect(toMs(1787067087)).toBe(1787067087000)
    expect(toMs(1787067087000)).toBe(1787067087000)
    expect(toMs(null)).toBeNull()
  })

  it('windowLabel: 5 h, Semana y días', () => {
    expect(windowLabel(300)).toBe('5 h')
    expect(windowLabel(10_080)).toBe('Semana')
    expect(windowLabel(43_200)).toBe('30 días')
  })

  it('parseClaudeUsage: 5 h, semana y topes semanales por modelo sin repetir', () => {
    const limits = parseClaudeUsage({
      five_hour: { utilization: 62.4, resets_at: '2026-10-21T18:50:00Z' },
      seven_day: { utilization: 24, resets_at: '2026-10-24T09:00:00Z' },
      seven_day_opus: null,
      limits: [{ kind: 'weekly_scoped', percent: 8, resets_at: '2026-10-24T09:00:00Z', scope: { model: { display_name: 'Fable' } } }, { kind: 'other', percent: 50 }],
      seven_day_fable: { utilization: 99 }
    })
    expect(limits.map((l) => [l.id, l.label, l.usedPercent])).toEqual([
      ['session', '5 h', 62.4],
      ['weekly', 'Semana', 24],
      ['model:fable', 'Fable', 8]
    ])
    expect(limits[0].resetsAt).toBe(Date.parse('2026-10-21T18:50:00Z'))
    expect(parseClaudeUsage('nada')).toEqual([])
  })

  it('claudePlan: Max 20x, Pro, nada', () => {
    expect(claudePlan({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })).toBe('Max 20x')
    expect(claudePlan({ subscriptionType: 'pro' })).toBe('Pro')
    expect(claudePlan({})).toBeNull()
  })

  it('parseCodexUsage ordena la ventana corta primero y lee el plan', () => {
    const r = parseCodexUsage({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 83, limit_window_seconds: 604_800, reset_at: 1787067087 }, secondary_window: { used_percent: 15, limit_window_seconds: 18_000, reset_at: 1786000000 } } })
    expect(r.plan).toBe('Plus')
    expect(r.limits.map((l) => [l.id, l.label, l.usedPercent])).toEqual([
      ['session', '5 h', 15],
      ['weekly', 'Semana', 83]
    ])
  })

  it('parseCodexLogLimits lee la línea token_count con su hora', () => {
    const line = JSON.stringify({ timestamp: '2026-08-11T15:31:19Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 40, window_minutes: 10080, resets_at: 1787067087 }, secondary: null, plan_type: 'plus' } } })
    expect(parseCodexLogLimits(line)).toEqual({ plan: 'Plus', at: Date.parse('2026-08-11T15:31:19Z'), limits: [{ id: 'weekly', label: 'Semana', usedPercent: 40, windowMinutes: 10080, resetsAt: 1787067087000 }] })
    expect(parseCodexLogLimits('{"payload":{}}')).toBeNull()
    expect(parseCodexLogLimits('roto')).toBeNull()
  })
})

describe('UsageService', () => {
  let home = ''
  let now = Date.parse('2026-10-21T15:00:00Z')
  const keychain = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-claude', expiresAt: now + 3_600_000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } })
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file.endsWith('security')) return { code: 0, stdout: keychain }
    if (args.some((a) => a.includes('opencode.db'))) return { code: 0, stdout: '[{"usd":0.5,"tokens":1200}]' }
    if (args.some((a) => a.includes('state.db'))) return { code: 0, stdout: '[{"usd":0.37,"tokens":800}]' }
    return { code: 1, stdout: '' }
  })
  type Res = { ok: boolean; status: number; json(): Promise<unknown> }
  const fetch = vi.fn(async (url: string, init: { headers: Record<string, string> }): Promise<Res> => {
    if (url === CLAUDE_USAGE_URL) return { ok: init.headers.Authorization === 'Bearer tok-claude', status: 401, json: async () => ({ five_hour: { utilization: 11, resets_at: '2026-10-21T18:50:00Z' } }) }
    if (url === CODEX_USAGE_URL) return { ok: init.headers['ChatGPT-Account-Id'] === 'acc', status: 403, json: async () => ({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1 } } }) }
    throw new Error('url inesperada')
  })
  const service = (): UsageService => new UsageService({ cost: async () => ({ today: 3, bySession: {}, byAgent: { claude: { usd: 2.5, tokens: 1000 }, codex: { usd: 0.5, tokens: 10 } } }), fetch, exec, home, now: () => now, keychain: true })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'omni-usage-'))
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'tok-codex', account_id: 'acc' } }))
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
    writeFileSync(join(home, '.local', 'share', 'opencode', 'opencode.db'), '')
    mkdirSync(join(home, '.hermes'), { recursive: true })
    writeFileSync(join(home, '.hermes', 'state.db'), '')
    exec.mockClear()
    fetch.mockClear()
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('junta hoy de cada agente, plan y topes en vivo, y marca Goose como ausente', async () => {
    const r = await service().report()
    const by = Object.fromEntries(r.agents.map((a) => [a.agent, a]))
    expect(r.agents.map((a) => a.agent)).toEqual(['claude', 'codex', 'opencode', 'goose', 'hermes'])
    expect(by.claude).toMatchObject({ found: true, plan: 'Max 20x', today: { usd: 2.5, tokens: 1000 }, limitsError: null, stale: false })
    expect(by.claude.limits[0]).toMatchObject({ id: 'session', usedPercent: 11 })
    expect(by.codex).toMatchObject({ plan: 'Plus', limits: [{ id: 'session', usedPercent: 20 }] })
    expect(by.opencode.today).toEqual({ usd: 0.5, tokens: 1200 })
    expect(by.hermes.today).toEqual({ usd: 0.37, tokens: 800 })
    expect(by.goose).toMatchObject({ found: false, today: null })
    expect(r.todayUsd).toBeCloseTo(2.5 + 0.5 + 0.5 + 0.37, 9)
  })

  it('cachea los topes un minuto y force los vuelve a pedir', async () => {
    const s = service()
    await s.report()
    await s.report()
    expect(fetch).toHaveBeenCalledTimes(2)
    await s.report(true)
    expect(fetch).toHaveBeenCalledTimes(4)
    now += LIMITS_TTL_MS + 1
    await s.report()
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it('login vencido de Claude: no llama a la red y lo dice', async () => {
    exec.mockImplementationOnce(async () => ({ code: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: now - 1, subscriptionType: 'pro' } }) }))
    const claude = (await service().report()).agents[0]
    expect(claude).toMatchObject({ plan: 'Pro', limits: [], limitsError: expect.stringContaining('venció') })
    expect(fetch.mock.calls.some(([u]) => u === CLAUDE_USAGE_URL)).toBe(false)
  })

  it('Codex sin red cae a los últimos topes de sus logs, marcados como viejos; el error no lleva el token', async () => {
    fetch.mockImplementation(async (url: string): Promise<Res> => {
      if (url === CODEX_USAGE_URL) throw new Error('offline tok-codex')
      return { ok: false, status: 500, json: async () => ({}) }
    })
    const day = join(home, '.codex', 'sessions', '2026', '10', '20')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, 'rollout-a.jsonl'), JSON.stringify({ timestamp: '2026-10-20T10:00:00Z', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 55, window_minutes: 300, resets_at: 1 }, plan_type: 'plus' } } }) + '\n')
    const r = await service().report()
    const codex = r.agents[1]
    expect(codex).toMatchObject({ stale: true, plan: 'Plus', limitsAt: Date.parse('2026-10-20T10:00:00Z'), limits: [{ id: 'session', usedPercent: 55 }], limitsError: 'Sin conexión con OpenAI' })
    expect(JSON.stringify(r)).not.toMatch(/tok-/)
    expect(r.agents[0].limitsError).toBe('Claude Code: el servidor respondió 500')
  })
})
