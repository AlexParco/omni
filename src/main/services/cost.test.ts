import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CostTracker, PRICES, SESSION_SLACK_MS, costOfUsage, encodeCwd, parseClaudeLine, parseCodexLine, priceFor, startOfDay, summarize, type LogRecords, type Usage } from './cost'

/* ---------- fixtures: líneas reales de esta máquina, anonimizadas ---------- */

const CWD = '/Users/dev/private/omni'

const claudeAssistant = (over: { id?: string; requestId?: string; model?: string; timestamp?: string; usage?: Partial<Record<string, number>> } = {}): string =>
  JSON.stringify({
    parentUuid: '61edaa07-3e22-4d81-93e3-d77985e5109d',
    isSidechain: false,
    apiBlockIndex: 0,
    requestId: over.requestId ?? 'req_011Cf5WAZY6gyFRdCByM47TL',
    type: 'assistant',
    uuid: '35b17e5d-563b-4d70-988c-84a51f49af16',
    timestamp: over.timestamp ?? '2026-10-15T16:00:21.250Z',
    cwd: CWD,
    sessionId: 'ae992fbb-3fea-4ff1-80b0-9d3640a7173a',
    version: '2.1.270',
    message: {
      model: over.model ?? 'claude-opus-5-5',
      id: over.id ?? 'msg_011Cf5WAZsx8MpyJswNpbons',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 28619,
        cache_read_input_tokens: 44575,
        output_tokens: 488,
        output_tokens_details: { thinking_tokens: 353 },
        service_tier: 'standard',
        ...over.usage
      }
    }
  })

const claudeUser = (timestamp = '2026-10-15T16:00:14.936Z'): string =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', cwd: CWD, sessionId: 'ae992fbb', timestamp, message: { role: 'user', content: 'hola' } })

const codexMeta = (cwd = CWD, timestamp = '2026-10-15T14:10:55.974Z'): string =>
  JSON.stringify({ timestamp, type: 'session_meta', payload: { id: '019ec152-4965-7242-a3e8-4745845a8a1a', timestamp, cwd, originator: 'codex-tui', cli_version: '0.162.1', model_provider: 'openai' } })

const codexTurn = (model = 'gpt-5.5'): string =>
  JSON.stringify({ timestamp: '2026-10-15T14:11:08.915Z', type: 'turn_context', payload: { turn_id: '019ecc14', cwd: CWD, model, effort: 'medium' } })

const codexTokens = (last: Record<string, number>, timestamp = '2026-10-15T14:11:17.878Z'): string =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 999_999, cached_input_tokens: 999_999, output_tokens: 999_999, reasoning_output_tokens: 0, total_tokens: 999_999 },
        last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0, ...last },
        model_context_window: 258_400
      },
      rate_limits: null
    }
  })

/* ---------- precios ---------- */

describe('priceFor', () => {
  it('elige familia y generación por el nombre del modelo, de lo específico a lo genérico', () => {
    expect(priceFor('claude-fable-5-1')).toBe(PRICES.fable)
    expect(priceFor('claude-mythos-5-1')).toBe(PRICES.fable)
    expect(priceFor('claude-opus-5-5')).toBe(PRICES['opus-5-5'])
    expect(priceFor('claude-opus-5-5[1m]')).toBe(PRICES['opus-5-5'])
    expect(priceFor('claude-opus-5')).toBe(PRICES.opus)
    expect(priceFor('claude-opus-4-1')).toBe(PRICES.opus)
    expect(priceFor('claude-sonnet-5')).toBe(PRICES['sonnet-5'])
    expect(priceFor('claude-sonnet-5-5')).toBe(PRICES['sonnet-5'])
    expect(priceFor('claude-sonnet-4-6')).toBe(PRICES.sonnet)
    expect(priceFor('claude-haiku-5-5')).toBe(PRICES['haiku-5-5'])
    expect(priceFor('claude-haiku-4-5-20251001')).toBe(PRICES.haiku)
    expect(priceFor('gpt-5.5')).toBe(PRICES.gpt)
    expect(priceFor('gpt-5.1-codex-mini')).toBe(PRICES.gpt)
    expect(priceFor('codex')).toBe(PRICES.gpt)
  })

  it('lo desconocido se cobra como sonnet-5', () => {
    expect(priceFor('<synthetic>')).toBe(PRICES['sonnet-5'])
    expect(priceFor('')).toBe(PRICES['sonnet-5'])
  })
})

describe('costOfUsage', () => {
  it('suma tokens × precio por millón', () => {
    const usage: Usage = { input: 1_000_000, output: 100_000, cacheWrite: 200_000, cacheRead: 2_000_000 }
    expect(costOfUsage(usage, 'claude-opus-5-5')).toBeCloseTo(4 + 2 + 1 + 0.4, 6)
    expect(costOfUsage(usage, 'claude-fable-5-1')).toBeCloseTo(10 + 5 + 2.5 + 0.5, 6)
    expect(costOfUsage(usage, 'gpt-5.5')).toBeCloseTo(1.25 + 1 + 0 + 0.25, 6)
  })
})

describe('encodeCwd', () => {
  it('reemplaza todo lo no alfanumérico por guiones, como hace Claude Code', () => {
    expect(encodeCwd('/Users/dev/private/omni')).toBe('-Users-dev-private-omni')
    expect(encodeCwd('/Users/dev/Library/Application Support/Claude')).toBe('-Users-dev-Library-Application-Support-Claude')
    expect(encodeCwd('/Users/dev/a.b_c')).toBe('-Users-dev-a-b-c')
  })
})

/* ---------- parsers ---------- */

describe('parseClaudeLine', () => {
  it('saca usage, modelo, cwd, timestamp y clave de dedup de una respuesta', () => {
    const p = parseClaudeLine(claudeAssistant())
    expect(p).toEqual({
      at: Date.parse('2026-10-15T16:00:21.250Z'),
      cwd: CWD,
      model: 'claude-opus-5-5',
      usage: { input: 2, output: 488, cacheWrite: 28619, cacheRead: 44575 },
      key: 'req_011Cf5WAZY6gyFRdCByM47TL:msg_011Cf5WAZsx8MpyJswNpbons'
    })
  })

  it('una línea de usuario solo aporta cwd y timestamp', () => {
    expect(parseClaudeLine(claudeUser())).toEqual({ at: Date.parse('2026-10-15T16:00:14.936Z'), cwd: CWD })
  })

  it('basura o JSON que no es objeto → null', () => {
    expect(parseClaudeLine('')).toBeNull()
    expect(parseClaudeLine('{not json')).toBeNull()
    expect(parseClaudeLine('[1,2]')).toBeNull()
  })
})

describe('parseCodexLine', () => {
  it('session_meta da cwd, timestamp y un modelo gpt provisional', () => {
    expect(parseCodexLine(codexMeta())).toEqual({ at: Date.parse('2026-10-15T14:10:55.974Z'), cwd: CWD, model: 'codex' })
  })

  it('turn_context fija el modelo del turno', () => {
    expect(parseCodexLine(codexTurn('gpt-5.1-codex-mini'))).toMatchObject({ cwd: CWD, model: 'gpt-5.1-codex-mini' })
  })

  it('token_count usa last_token_usage y descuenta lo cacheado del input (total_token_usage se ignora)', () => {
    const p = parseCodexLine(codexTokens({ input_tokens: 39988, cached_input_tokens: 30080, output_tokens: 298, reasoning_output_tokens: 27 }))
    expect(p).toEqual({ at: Date.parse('2026-10-15T14:11:17.878Z'), usage: { input: 9908, output: 298, cacheWrite: 0, cacheRead: 30080 } })
  })

  it('un token_count vacío (sesión reanudada) no aporta usage con tokens', () => {
    expect(parseCodexLine(codexTokens({}))?.usage).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })
  })
})

/* ---------- resumen ---------- */

describe('summarize', () => {
  const now = Date.parse('2026-10-15T20:00:00')
  const midnight = startOfDay(now)
  const log = (cwd: string, firstAt: number | null, records: Array<[number, number]>): LogRecords => ({
    cwdKey: encodeCwd(cwd),
    firstAt,
    records: records.map(([at, usd]) => ({ at, usd, tokens: 1000 }))
  })

  it('today solo suma lo de hoy; sin sesiones no hay bySession', () => {
    const s = summarize([log('/a', midnight - 10_000, [[midnight - 1, 5], [midnight, 1], [now, 2]])], now, [])
    expect(s).toEqual({ today: 3, bySession: {}, byAgent: {} })
  })

  it('atribuye por cwd a la sesión creada antes de la primera línea, con un minuto de margen', () => {
    const sessions = [
      { id: 's1', cwd: '/a', createdAt: now - 3_600_000 },
      { id: 's2', cwd: '/b', createdAt: now - 3_600_000 }
    ]
    const logs = [
      log('/a', now - 1_800_000, [[now - 1000, 1], [now - 500, 2]]),
      log('/a', now - 3_600_000 - SESSION_SLACK_MS + 1, [[now, 4]]),
      log('/a', now - 7_200_000, [[now, 8]]),
      log('/c', now - 100, [[now, 16]])
    ]
    const s = summarize(logs, now, sessions)
    expect(s.today).toBe(31)
    expect(s.bySession).toEqual({ s1: { usd: 7, tokens: 3000 } })
  })

  it('dos sesiones en el mismo cwd: gana la creada más recientemente antes del log', () => {
    const sessions = [
      { id: 'old', cwd: '/a', createdAt: now - 7_200_000 },
      { id: 'new', cwd: '/a', createdAt: now - 3_600_000 }
    ]
    const logs = [log('/a', now - 5_400_000, [[now, 1]]), log('/a', now - 1_800_000, [[now, 2]]), log('/a', null, [[now, 4]])]
    expect(summarize(logs, now, sessions).bySession).toEqual({ old: { usd: 1, tokens: 1000 }, new: { usd: 2, tokens: 1000 } })
  })
})

/* ---------- tracker sobre un home temporal ---------- */

describe('CostTracker', () => {
  let home: string
  let now: number
  const claudeDir = (): string => join(home, '.claude', 'projects', encodeCwd(CWD))
  const codexDir = (): string => join(home, '.codex', 'sessions', '2026', '10', '15')
  const tracker = (over: { sessions?: () => Array<{ id: string; cwd: string; createdAt: number }>; maxBytesPerPass?: number } = {}): CostTracker =>
    new CostTracker({ home, now: () => now, sessions: over.sessions ?? (() => []), maxBytesPerPass: over.maxBytesPerPass })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'omni-cost-'))
    now = Date.parse('2026-10-15T20:00:00Z')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('sin logs → today 0 y bySession vacío', async () => {
    expect(await tracker().summary()).toEqual({ today: 0, bySession: {}, byAgent: {} })
  })

  it('suma Claude y Codex, deduplica bloques del mismo mensaje y atribuye a la sesión viva', async () => {
    mkdirSync(claudeDir(), { recursive: true })
    mkdirSync(codexDir(), { recursive: true })
    const dup = claudeAssistant()
    writeFileSync(join(claudeDir(), 'a.jsonl'), [claudeUser(), dup, dup, dup, claudeAssistant({ id: 'msg_2', model: 'claude-haiku-5-5', timestamp: '2026-10-14T23:59:59Z' })].join('\n') + '\n')
    writeFileSync(join(codexDir(), 'rollout-x.jsonl'), [codexMeta(), codexTokens({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 }), codexTurn('gpt-5.5')].join('\n') + '\n')
    const t = tracker({ sessions: () => [{ id: 's1', cwd: CWD, createdAt: Date.parse('2026-10-15T15:00:00Z') }] })
    const s = await t.summary()
    const opus = costOfUsage({ input: 2, output: 488, cacheWrite: 28619, cacheRead: 44575 }, 'claude-opus-5-5')
    const haiku = costOfUsage({ input: 2, output: 488, cacheWrite: 28619, cacheRead: 44575 }, 'claude-haiku-5-5')
    const gpt = costOfUsage({ input: 600, output: 100, cacheWrite: 0, cacheRead: 400 }, 'codex')
    // La línea haiku es de ayer (UTC): cuenta para la sesión pero no para hoy si el día local ya cambió.
    const haikuToday = Date.parse('2026-10-14T23:59:59Z') >= startOfDay(now) ? haiku : 0
    expect(s.today).toBeCloseTo(opus + gpt + haikuToday, 9)
    // El log de Claude empezó a las 16:00 (después de la sesión); el de Codex a las 14:10 (antes): solo el primero es suyo.
    expect(s.bySession.s1?.usd).toBeCloseTo(opus + haiku, 9)
    expect(s.bySession.s1?.tokens).toBe(2 * (2 + 488 + 28619 + 44575))
    // Lo de hoy, separado por CLI para el widget Uso (§3.25).
    expect(s.byAgent.claude?.usd).toBeCloseTo(opus + haikuToday, 9)
    expect(s.byAgent.codex?.usd).toBeCloseTo(gpt, 9)
    expect(s.byAgent.codex?.tokens).toBe(1100)
  })

  it('un host remoto aporta sus logs; un cwd del VPS solo se atribuye a la sesión de ese VPS', async () => {
    // El "VPS": otro home con el mismo cwd que una sesión local, leído por la interfaz de logs remotos.
    const vpsHome = mkdtempSync(join(tmpdir(), 'omni-cost-vps-'))
    try {
      const vpsDir = join(vpsHome, '.claude', 'projects', encodeCwd(CWD))
      mkdirSync(vpsDir, { recursive: true })
      const text = [claudeUser(), claudeAssistant()].join('\n') + '\n'
      writeFileSync(join(vpsDir, 'r.jsonl'), text)
      const reads: Array<[number, number]> = []
      const remote = {
        hostId: 'vps',
        home: vpsHome,
        list: async (root: string) => (root.endsWith('.claude/projects') ? [{ rel: `${encodeCwd(CWD)}/r.jsonl`, size: Buffer.byteLength(text), mtime: now, ino: 7 }] : []),
        read: async (path: string, offset: number, max: number) => {
          reads.push([offset, max])
          const { readFileSync } = await import('node:fs')
          return readFileSync(path).subarray(offset, offset + max)
        }
      }
      const created = Date.parse('2026-10-15T15:00:00Z')
      const t = new CostTracker({ home, now: () => now, sessions: () => [{ id: 'local', cwd: CWD, createdAt: created }, { id: 'remota', cwd: CWD, createdAt: created, host: 'vps' }], remotes: async () => [remote] })
      const s = await t.summary()
      const opus = costOfUsage({ input: 2, output: 488, cacheWrite: 28619, cacheRead: 44575 }, 'claude-opus-5-5')
      expect(s.bySession.remota?.usd).toBeCloseTo(opus, 9)
      expect(s.bySession.local).toBeUndefined()
      expect(s.today).toBeCloseTo(opus, 9)
      // La segunda pasada no vuelve a leer lo ya leído.
      await t.refresh()
      expect(reads).toHaveLength(1)
    } finally {
      rmSync(vpsHome, { recursive: true, force: true })
    }
  })

  it('cachea 30 s, refresh() lee solo lo nuevo y avisa si cambió', async () => {
    mkdirSync(claudeDir(), { recursive: true })
    const file = join(claudeDir(), 'a.jsonl')
    writeFileSync(file, claudeAssistant() + '\n')
    const t = tracker()
    const listener = vi.fn()
    t.onChanged(listener)
    const first = await t.summary()
    expect(listener).toHaveBeenCalledTimes(1)
    appendFileSync(file, claudeAssistant({ id: 'msg_2', requestId: 'req_2' }) + '\n')
    expect(await t.summary()).toBe(first)
    now += 29_000
    expect(await t.summary()).toBe(first)
    now += 2_000
    const second = await t.summary()
    expect(second.today).toBeCloseTo(first.today * 2, 9)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(await t.refresh()).toEqual(second)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('respeta el tope de bytes por pasada y sigue en la siguiente', async () => {
    mkdirSync(claudeDir(), { recursive: true })
    const line = claudeAssistant({ id: 'msg_a', requestId: 'r1' }) + '\n'
    writeFileSync(join(claudeDir(), 'a.jsonl'), line + claudeAssistant({ id: 'msg_b', requestId: 'r2' }) + '\n')
    const t = tracker({ maxBytesPerPass: line.length + 10 })
    const one = await t.refresh()
    const two = await t.refresh()
    expect(two.today).toBeCloseTo(one.today * 2, 9)
  })

  it('un archivo truncado se relee desde cero', async () => {
    mkdirSync(claudeDir(), { recursive: true })
    const file = join(claudeDir(), 'a.jsonl')
    writeFileSync(file, claudeAssistant({ id: 'a', requestId: '1' }) + '\n' + claudeAssistant({ id: 'b', requestId: '2' }) + '\n')
    const t = tracker()
    const before = await t.refresh()
    writeFileSync(file, claudeAssistant({ id: 'c', requestId: '3' }) + '\n')
    expect((await t.refresh()).today).toBeCloseTo(before.today / 2, 9)
  })

  it('un archivo rotado (otro inode con la misma ruta) se relee desde cero aunque no sea más corto', async () => {
    mkdirSync(claudeDir(), { recursive: true })
    const file = join(claudeDir(), 'a.jsonl')
    writeFileSync(file, claudeAssistant({ id: 'a', requestId: '1' }) + '\n' + claudeAssistant({ id: 'b', requestId: '2' }) + '\n')
    const t = tracker()
    const unit = (await t.refresh()).today / 2
    // Se borra y se escribe otro archivo más largo con ids de otra longitud: sin detectar la rotación, el offset
    // viejo caería a mitad de línea y se contarían registros de ambos archivos.
    rmSync(file)
    writeFileSync(file, ['cc', 'dd', 'ee'].map((id) => claudeAssistant({ id, requestId: id }) + '\n').join(''))
    expect((await t.refresh()).today).toBeCloseTo(unit * 3, 9)
  })

  it('los logs de subagentes (<sesión>/subagents/*.jsonl) se atribuyen a la sesión del cwd', async () => {
    const sub = join(claudeDir(), 'ae992fbb-3fea-4ff1-80b0-9d3640a7173a', 'subagents')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'agent-a9d441d957cf66f88.jsonl'), claudeUser() + '\n' + claudeAssistant() + '\n')
    const t = tracker({ sessions: () => [{ id: 's1', cwd: CWD, createdAt: Date.parse('2026-10-15T15:00:00Z') }, { id: 'other', cwd: '/elsewhere', createdAt: 0 }] })
    const s = await t.summary()
    const usd = costOfUsage({ input: 2, output: 488, cacheWrite: 28619, cacheRead: 44575 }, 'claude-opus-5-5')
    expect(s.today).toBeCloseTo(usd, 9)
    expect(s.bySession).toEqual({ s1: { usd, tokens: 2 + 488 + 28619 + 44575 } })
  })

  it('ignora archivos viejos que no tocan ni hoy ni una sesión viva', async () => {
    mkdirSync(claudeDir(), { recursive: true })
    const file = join(claudeDir(), 'old.jsonl')
    writeFileSync(file, claudeAssistant() + '\n')
    const old = new Date(now - 3 * 86_400_000)
    utimesSync(file, old, old)
    expect(await tracker().summary()).toEqual({ today: 0, bySession: {}, byAgent: {} })
  })
})
