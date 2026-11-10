import { execFile } from 'node:child_process'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentUsage, CostSummary, SessionCost, UsageLimit, UsageReport } from '@shared/types'
import { startOfDay } from './cost'

/**
 * Consumo por agente (ARCHITECTURE §3.25). Hoy sale de los logs locales: Claude Code y Codex por el
 * `CostTracker`, OpenCode y Hermes de su SQLite (solo lectura, con el `sqlite3` del sistema). Los topes
 * del plan se piden en vivo como hace Orca, con el login que ya tiene cada CLI: Claude Code en el
 * llavero de macOS y Codex en `~/.codex/auth.json`. El token solo vive dentro de la función que pide;
 * nunca se guarda, nunca se registra y los errores solo dicen el código HTTP. omni no renueva logins:
 * si uno venció, lo renueva el propio CLI al abrirse.
 */

export const LIMITS_TTL_MS = 60_000
const LOCAL_TTL_MS = 15_000
const FETCH_TIMEOUT_MS = 10_000
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'
/** Cuánto del final de un log de Codex se lee para buscar sus últimos topes. */
const CODEX_TAIL_BYTES = 256 * 1024

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
type Exec = (file: string, args: string[]) => Promise<{ code: number; stdout: string }>

/** Topes de un agente, en vivo o del último valor conocido. */
interface Limits {
  plan: string | null
  limits: UsageLimit[]
  at: number | null
  stale: boolean
  error: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const clampPercent = (n: number): number => Math.min(100, Math.max(0, n))

/** Instante de reinicio: ISO, segundos o milisegundos epoch → ms. */
export function toMs(v: unknown): number | null {
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  const n = finite(v)
  if (n === null || n <= 0) return null
  return n < 1e12 ? n * 1000 : n
}

/** `5 h`, `Semana` o `<n> h`/`<n> d` según lo que dure la ventana. */
export function windowLabel(minutes: number): string {
  if (minutes >= 10_000 && minutes <= 10_200) return 'Semana'
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 día' : `${minutes / 1440} días`
  return `${Math.round(minutes / 60)} h`
}

/** Una ventana de Claude (`{ utilization | used_percentage, resets_at }`) → tope; `null` si no trae porcentaje. */
function claudeWindow(id: string, label: string, minutes: number, w: unknown): UsageLimit | null {
  if (!isRecord(w)) return null
  const used = finite(w.utilization) ?? finite(w.used_percentage) ?? finite(w.percent)
  if (used === null) return null
  return { id, label, usedPercent: clampPercent(used), windowMinutes: minutes, resetsAt: toMs(w.resets_at) }
}

/**
 * Respuesta de `api/oauth/usage` → topes: la sesión de 5 h, la semana y los topes semanales por modelo
 * (`limits[]` de tipo `weekly_scoped`, p. ej. Fable; también las claves viejas `seven_day_opus`/`_sonnet`).
 */
export function parseClaudeUsage(json: unknown): UsageLimit[] {
  if (!isRecord(json)) return []
  const out: UsageLimit[] = []
  const push = (l: UsageLimit | null): void => {
    if (l && !out.some((x) => x.id === l.id)) out.push(l)
  }
  push(claudeWindow('session', '5 h', 300, json.five_hour))
  push(claudeWindow('weekly', 'Semana', 10_080, json.seven_day))
  if (Array.isArray(json.limits)) {
    for (const l of json.limits) {
      if (!isRecord(l) || l.kind !== 'weekly_scoped') continue
      const scope = isRecord(l.scope) && isRecord(l.scope.model) ? l.scope.model : null
      const name = typeof scope?.display_name === 'string' ? scope.display_name.trim() : ''
      if (name) push(claudeWindow(`model:${name.toLowerCase()}`, name, 10_080, { used_percentage: l.percent, resets_at: l.resets_at }))
    }
  }
  for (const [key, name] of [['seven_day_fable', 'Fable'], ['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']] as const) push(claudeWindow(`model:${name.toLowerCase()}`, name, 10_080, json[key]))
  return out
}

/** Plan de Claude desde el login guardado: `max` + `default_claude_max_20x` → `Max 20x`. */
export function claudePlan(oauth: Record<string, unknown>): string | null {
  const tier = typeof oauth.rateLimitTier === 'string' ? /max_(\d+x)/i.exec(oauth.rateLimitTier)?.[1] : undefined
  const sub = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType.trim() : ''
  if (!sub) return null
  const name = sub.charAt(0).toUpperCase() + sub.slice(1).toLowerCase()
  return tier && name === 'Max' ? `Max ${tier}` : name
}

/** Una ventana de Codex (`{ used_percent, limit_window_seconds | window_minutes, reset_at | resets_at }`) → tope. */
function codexWindow(w: unknown, fallbackId: string): UsageLimit | null {
  if (!isRecord(w)) return null
  const used = finite(w.used_percent)
  if (used === null) return null
  const seconds = finite(w.limit_window_seconds)
  const minutes = finite(w.window_minutes) ?? (seconds ? Math.ceil(seconds / 60) : null) ?? (fallbackId === 'session' ? 300 : 10_080)
  const id = minutes <= 1440 ? 'session' : 'weekly'
  return { id, label: windowLabel(minutes), usedPercent: clampPercent(used), windowMinutes: minutes, resetsAt: toMs(w.reset_at ?? w.resets_at) }
}

/** Ventana corta primero, sin repetir: la respuesta y los logs llaman `primary` a la que toque. */
function codexLimits(primary: unknown, secondary: unknown): UsageLimit[] {
  const out = [codexWindow(primary, 'session'), codexWindow(secondary, 'weekly')].filter((l): l is UsageLimit => l !== null)
  out.sort((a, b) => a.windowMinutes - b.windowMinutes)
  return out.filter((l, i) => out.findIndex((x) => x.id === l.id) === i)
}

/** Respuesta de `wham/usage` → plan y topes. */
export function parseCodexUsage(json: unknown): { plan: string | null; limits: UsageLimit[] } {
  if (!isRecord(json)) return { plan: null, limits: [] }
  const rl = isRecord(json.rate_limit) ? json.rate_limit : {}
  return { plan: planName(json.plan_type), limits: codexLimits(rl.primary_window, rl.secondary_window) }
}

/** Línea `token_count` de un log de Codex → topes con la hora de la línea; `null` si no los trae. */
export function parseCodexLogLimits(line: string): { plan: string | null; limits: UsageLimit[]; at: number | null } | null {
  try {
    const j: unknown = JSON.parse(line)
    if (!isRecord(j) || !isRecord(j.payload)) return null
    const rl = isRecord(j.payload.rate_limits) ? j.payload.rate_limits : null
    if (!rl) return null
    const limits = codexLimits(rl.primary, rl.secondary)
    return limits.length ? { plan: planName(rl.plan_type), limits, at: toMs(j.timestamp) } : null
  } catch {
    return null
  }
}

const planName = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().charAt(0).toUpperCase() + v.trim().slice(1) : null)

/** Mensaje humano para una respuesta HTTP fallida (nunca incluye cabeceras ni cuerpo). */
function httpError(cli: string, status: number): string {
  if (status === 401 || status === 403) return `El login de ${cli} venció o fue rechazado: abre ${cli} y se renueva`
  if (status === 429) return `${cli}: demasiadas consultas, se reintenta en un minuto`
  return `${cli}: el servidor respondió ${status}`
}

const defaultExec: Exec = (file, args) =>
  new Promise((done) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // Con salida distinta de 0, `err.code` es el código de salida; sin número (no existe, timeout) cuenta como 1.
      const exit: unknown = err ? (err as { code?: unknown }).code : 0
      done({ code: typeof exit === 'number' ? exit : 1, stdout: typeof stdout === 'string' ? stdout : '' })
    })
  })

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

export interface UsageServiceOptions {
  /** Costo de hoy por CLI (`CostTracker.summary`). */
  cost: () => Promise<CostSummary>
  /** `net.fetch` de Electron (respeta el proxy del sistema); inyectable en tests. */
  fetch: Fetch
  exec?: Exec
  home?: string
  now?: () => number
  /** `false` fuera de macOS: no hay llavero que leer. */
  keychain?: boolean
}

export class UsageService {
  private readonly exec: Exec
  private readonly home: string
  private readonly now: () => number
  private readonly keychain: boolean
  private limits: { claude: Limits; codex: Limits } | null = null
  private limitsAt = -Infinity
  private limitsInflight: Promise<{ claude: Limits; codex: Limits }> | null = null
  private local: { opencode: SessionCost | null; hermes: SessionCost | null; found: Record<string, boolean> } | null = null
  private localAt = -Infinity

  constructor(private readonly opts: UsageServiceOptions) {
    this.exec = opts.exec ?? defaultExec
    this.home = opts.home ?? homedir()
    this.now = opts.now ?? Date.now
    this.keychain = opts.keychain ?? process.platform === 'darwin'
  }

  /** Reporte de los cinco agentes. `force` vuelve a pedir los topes aunque el cache siga fresco. */
  async report(force = false): Promise<UsageReport> {
    const now = this.now()
    const [cost, limits, local] = await Promise.all([
      this.opts.cost().catch((): CostSummary => ({ today: 0, bySession: {}, byAgent: {} })),
      this.limitsCached(force),
      this.localCached()
    ])
    const agent = (id: AgentUsage['agent'], found: boolean, today: SessionCost | null, l: Limits | null): AgentUsage => ({
      agent: id,
      found: found || today !== null || (l !== null && (l.limits.length > 0 || l.plan !== null)),
      today,
      plan: l?.plan ?? null,
      limits: l?.limits ?? [],
      limitsAt: l?.at ?? null,
      stale: l?.stale ?? false,
      limitsError: l?.error ?? null
    })
    const agents = [
      agent('claude', local.found.claude, cost.byAgent.claude ?? (local.found.claude ? { usd: 0, tokens: 0 } : null), limits.claude),
      agent('codex', local.found.codex, cost.byAgent.codex ?? (local.found.codex ? { usd: 0, tokens: 0 } : null), limits.codex),
      agent('opencode', local.found.opencode, local.opencode, null),
      agent('goose', local.found.goose, null, null),
      agent('hermes', local.found.hermes, local.hermes, null)
    ]
    const todayUsd = agents.reduce((sum, a) => sum + (a.today?.usd ?? 0), 0)
    return { agents, todayUsd, at: now }
  }

  private async limitsCached(force: boolean): Promise<{ claude: Limits; codex: Limits }> {
    if (!force && this.limits && this.now() - this.limitsAt < LIMITS_TTL_MS) return this.limits
    if (this.limitsInflight) return this.limitsInflight
    this.limitsInflight = Promise.all([this.claudeLimits(), this.codexLimits()]).then(([claude, codex]) => {
      this.limits = { claude, codex }
      this.limitsAt = this.now()
      this.limitsInflight = null
      return this.limits
    })
    return this.limitsInflight
  }

  private async localCached(): Promise<NonNullable<UsageService['local']>> {
    if (this.local && this.now() - this.localAt < LOCAL_TTL_MS) return this.local
    const since = startOfDay(this.now())
    const opencodeDb = join(this.home, '.local', 'share', 'opencode', 'opencode.db')
    const hermesDb = join(this.home, '.hermes', 'state.db')
    const [claude, codex, opencode, goose, hermes] = await Promise.all([
      exists(join(this.home, '.claude', 'projects')),
      exists(join(this.home, '.codex')),
      exists(opencodeDb),
      Promise.all([join(this.home, '.local', 'share', 'goose'), join(this.home, '.config', 'goose')].map(exists)).then((xs) => xs.some(Boolean)),
      exists(hermesDb)
    ])
    // OpenCode guarda cada respuesta con su costo y tokens; Hermes, el acumulado por sesión y modelo (se cuenta el día de su última llamada).
    const [oc, hm] = await Promise.all([
      opencode ? this.sqliteSum(opencodeDb, `select coalesce(sum(json_extract(data,'$.cost')),0) as usd, coalesce(sum(coalesce(json_extract(data,'$.tokens.total'), json_extract(data,'$.tokens.input') + json_extract(data,'$.tokens.output') + json_extract(data,'$.tokens.reasoning') + json_extract(data,'$.tokens.cache.read') + json_extract(data,'$.tokens.cache.write'))),0) as tokens from message where json_extract(data,'$.role')='assistant' and json_extract(data,'$.time.created') >= ${since}`) : null,
      hermes ? this.sqliteSum(hermesDb, `select coalesce(sum(case when actual_cost_usd > 0 then actual_cost_usd else estimated_cost_usd end),0) as usd, coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens),0) as tokens from session_model_usage where last_seen >= ${since / 1000}`) : null
    ])
    this.local = { opencode: oc, hermes: hm, found: { claude, codex, opencode, goose, hermes } }
    this.localAt = this.now()
    return this.local
  }

  /** Una fila `{ usd, tokens }` de una base SQLite abierta en solo lectura; `null` si no se pudo leer. */
  private async sqliteSum(db: string, sql: string): Promise<SessionCost | null> {
    const r = await this.exec('/usr/bin/sqlite3', ['-readonly', '-json', `file:${db}?mode=ro`, sql])
    if (r.code !== 0) return null
    try {
      const row: unknown = (JSON.parse(r.stdout || '[]') as unknown[])[0]
      if (!isRecord(row)) return { usd: 0, tokens: 0 }
      return { usd: finite(row.usd) ?? 0, tokens: finite(row.tokens) ?? 0 }
    } catch {
      return null
    }
  }

  private async claudeLimits(): Promise<Limits> {
    const none = (error: string, plan: string | null = null): Limits => ({ plan, limits: [], at: null, stale: false, error })
    if (!this.keychain) return none('Los topes de Claude Code solo se leen en macOS')
    const r = await this.exec('/usr/bin/security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'])
    if (r.code !== 0 || !r.stdout.trim()) return none('Sin login de Claude Code en el llavero (claude /login)')
    let oauth: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(r.stdout)
      oauth = isRecord(parsed) && isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : {}
    } catch {
      return none('El login de Claude Code en el llavero no se entiende')
    }
    const plan = claudePlan(oauth)
    const token = typeof oauth.accessToken === 'string' ? oauth.accessToken : ''
    if (!token) return none('Sin login de Claude Code en el llavero (claude /login)', plan)
    const expires = finite(oauth.expiresAt)
    if (expires !== null && expires < this.now()) return none('El login de Claude Code venció: abre Claude Code y se renueva', plan)
    try {
      const res = await this.opts.fetch(CLAUDE_USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!res.ok) return none(httpError('Claude Code', res.status), plan)
      return { plan, limits: parseClaudeUsage(await res.json()), at: this.now(), stale: false, error: null }
    } catch {
      return none('Sin conexión con Anthropic', plan)
    }
  }

  private async codexLimits(): Promise<Limits> {
    const live = await this.codexLive()
    if (!live.error) return live
    // Sin red o sin login: el último tope que Codex escribió en sus logs, marcado como viejo.
    const fromLogs = await this.codexFromLogs()
    return fromLogs ? { ...fromLogs, plan: fromLogs.plan ?? live.plan, error: live.error } : live
  }

  private async codexLive(): Promise<Limits> {
    const none = (error: string): Limits => ({ plan: null, limits: [], at: null, stale: false, error })
    let tokens: Record<string, unknown>
    try {
      const auth: unknown = JSON.parse(await readFile(join(this.home, '.codex', 'auth.json'), 'utf8'))
      tokens = isRecord(auth) && isRecord(auth.tokens) ? auth.tokens : {}
    } catch {
      return none('Sin login de Codex (codex login)')
    }
    const token = typeof tokens.access_token === 'string' ? tokens.access_token : ''
    if (!token) return none('Codex usa una API key: sin topes de plan que mostrar')
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'User-Agent': 'codex-cli', 'OpenAI-Beta': 'codex-1' }
    if (typeof tokens.account_id === 'string' && tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id
    try {
      const res = await this.opts.fetch(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) return none(httpError('Codex', res.status))
      const parsed = parseCodexUsage(await res.json())
      return { plan: parsed.plan, limits: parsed.limits, at: this.now(), stale: false, error: null }
    } catch {
      return none('Sin conexión con OpenAI')
    }
  }

  /** Últimos topes en los logs de Codex: el final de sus archivos más nuevos (`YYYY/MM/DD/rollout-*.jsonl`). */
  private async codexFromLogs(): Promise<Omit<Limits, 'error'> | null> {
    const root = join(this.home, '.codex', 'sessions')
    const newest = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [] as string[])).filter((n) => !n.startsWith('.')).sort().reverse()
    const files: string[] = []
    for (const y of (await newest(root)).slice(0, 2))
      for (const m of (await newest(join(root, y))).slice(0, 2))
        for (const d of (await newest(join(root, y, m))).slice(0, 3)) for (const f of await newest(join(root, y, m, d))) if (f.endsWith('.jsonl')) files.push(join(root, y, m, d, f))
    const withTime = await Promise.all(files.map(async (f) => ({ f, t: (await stat(f).catch(() => null))?.mtimeMs ?? 0 })))
    withTime.sort((a, b) => b.t - a.t)
    for (const { f } of withTime.slice(0, 8)) {
      const fh = await open(f, 'r').catch(() => null)
      if (!fh) continue
      try {
        const size = (await fh.stat()).size
        const length = Math.min(size, CODEX_TAIL_BYTES)
        const buf = Buffer.alloc(length)
        await fh.read(buf, 0, length, size - length)
        const lines = buf.toString('utf8').split('\n').reverse()
        for (const line of lines) {
          if (!line.includes('"rate_limits"')) continue
          const hit = parseCodexLogLimits(line)
          if (hit) return { plan: hit.plan, limits: hit.limits, at: hit.at, stale: true }
        }
      } finally {
        await fh.close()
      }
    }
    return null
  }
}
