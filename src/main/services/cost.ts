import type { Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { CostSummary, SessionCost } from '@shared/types'
import type { RemoteLogs } from '../hosts/types'

/**
 * Costo del día como piso (ARCHITECTURE §3.17): suma tokens × precio leyendo los logs locales que
 * los CLIs dejan en disco. No habla con ninguna API; si no hay logs, el costo es 0.
 *
 * Forma real de los logs en esta máquina (octubre 2026):
 *
 * - Claude Code: `~/.claude/projects/<cwd codificado>/<sessionId>.jsonl` y, para los subagentes,
 *   `<cwd codificado>/<sessionId>/subagents/<agentId>.jsonl`. El cwd se codifica reemplazando
 *   **todo carácter que no sea alfanumérico** por `-` (no solo `/`: también espacios, `.` y `_`),
 *   p. ej. `/Users/x/Library/Application Support/Claude` → `-Users-x-Library-Application-Support-Claude`.
 *   Cada línea es un JSON con `timestamp` (ISO UTC), `cwd`, `requestId` y, en las de tipo
 *   `assistant`, `message.model` y `message.usage` (`input_tokens`, `output_tokens`,
 *   `cache_creation_input_tokens`, `cache_read_input_tokens`). Una respuesta con varios bloques
 *   (texto + tool_use) se escribe como varias líneas con el mismo `message.id` y `requestId` y el
 *   mismo `usage`: hay que deduplicar o el costo sale casi al doble.
 *
 * - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<fecha>-<id>.jsonl`. Primera línea
 *   `session_meta` con `payload.cwd` y `payload.timestamp`; cada turno abre con `turn_context`
 *   (`payload.model`, `payload.cwd`) y el consumo llega en `event_msg` con
 *   `payload.type === 'token_count'` e `info.last_token_usage` (`input_tokens`,
 *   `cached_input_tokens` incluido en `input_tokens`, `output_tokens`, `reasoning_output_tokens`
 *   incluido en `output_tokens`). `total_token_usage` es el acumulado: no se suma.
 */

/** Más de esto y el resumen se vuelve a calcular. */
export const COST_TTL_MS = 30_000
/** Bytes nuevos que se leen como máximo en una pasada; lo que sobra espera a la siguiente. */
export const MAX_BYTES_PER_PASS = 50 * 1024 * 1024
/** Un log cuenta para una sesión si empezó después de `createdAt − SESSION_SLACK_MS`. */
export const SESSION_SLACK_MS = 60_000

/** Tokens de una respuesta, ya normalizados entre CLIs. */
export interface Usage {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** USD por millón de tokens. */
export interface Price {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** Tabla por familia y generación; lo desconocido se cobra como sonnet-5 (es un piso, no una factura). */
export const PRICES = {
  fable: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  gpt: { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 }
} as const satisfies Record<string, Price>

/** De la más específica a la genérica: la primera que casa manda. */
const PRICE_RULES: ReadonlyArray<[RegExp, Price]> = [
  [/fable|mythos/, PRICES.fable],
  [/opus-5-5/, PRICES['opus-5-5']],
  [/opus/, PRICES.opus],
  [/sonnet-5/, PRICES['sonnet-5']],
  [/sonnet/, PRICES.sonnet],
  [/haiku-5-5/, PRICES['haiku-5-5']],
  [/haiku/, PRICES.haiku],
  [/^(gpt|o\d)|codex/, PRICES.gpt]
]

export function priceFor(model: string): Price {
  const m = model.toLowerCase()
  return PRICE_RULES.find(([re]) => re.test(m))?.[1] ?? PRICES['sonnet-5']
}

export function costOfUsage(usage: Usage, model: string): number {
  const p = priceFor(model)
  return (usage.input * p.input + usage.output * p.output + usage.cacheWrite * p.cacheWrite + usage.cacheRead * p.cacheRead) / 1_000_000
}

export function tokensOf(usage: Usage): number {
  return usage.input + usage.output + usage.cacheWrite + usage.cacheRead
}

/** Nombre de carpeta que Claude Code usa para un cwd: todo lo no alfanumérico pasa a `-`. */
export function encodeCwd(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

/** Una respuesta con costo, ya en USD. */
export interface CostRecord {
  /** Epoch ms. */
  at: number
  usd: number
  tokens: number
}

/**
 * Lo que una línea aporta: metadatos del archivo (`cwd`, `model` vigente, `at` de la línea) y, si
 * la línea es una respuesta, su `usage` con `key` para deduplicar. `null` si no es JSON útil.
 */
export interface ParsedLine {
  at?: number
  cwd?: string
  model?: string
  usage?: Usage
  key?: string
}

export type LineParser = (line: string) => ParsedLine | null

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const when = (v: unknown): number | undefined => {
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

function parseJson(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed[0] !== '{') return null
  try {
    const v: unknown = JSON.parse(trimmed)
    return isRecord(v) ? v : null
  } catch {
    return null
  }
}

/** Línea de `~/.claude/projects/**\/*.jsonl`. */
export const parseClaudeLine: LineParser = (line) => {
  const j = parseJson(line)
  if (!j) return null
  const out: ParsedLine = {}
  const at = when(j.timestamp)
  if (at !== undefined) out.at = at
  const cwd = str(j.cwd)
  if (cwd) out.cwd = cwd
  const message = j.message
  if (isRecord(message) && isRecord(message.usage)) {
    const u = message.usage
    out.usage = {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      cacheRead: num(u.cache_read_input_tokens)
    }
    const model = str(message.model)
    if (model) out.model = model
    const id = str(message.id)
    if (id) out.key = `${str(j.requestId) ?? ''}:${id}`
  }
  return out
}

/** Línea de `~/.codex/sessions/**\/*.jsonl`. */
export const parseCodexLine: LineParser = (line) => {
  const j = parseJson(line)
  if (!j) return null
  const out: ParsedLine = {}
  const at = when(j.timestamp)
  if (at !== undefined) out.at = at
  const payload = isRecord(j.payload) ? j.payload : null
  if (!payload) return out
  const cwd = str(payload.cwd)
  if (cwd) out.cwd = cwd
  const model = str(payload.model)
  if (model) out.model = model
  // `session_meta` llega antes que cualquier `turn_context`: sin modelo aún, se cobra como gpt
  // (la tarifa más baja, para que siga siendo piso) y el `turn_context` lo afina después.
  else if (j.type === 'session_meta' && str(payload.model_provider) === 'openai') out.model = 'codex'
  if (j.type === 'event_msg' && payload.type === 'token_count' && isRecord(payload.info) && isRecord(payload.info.last_token_usage)) {
    const u = payload.info.last_token_usage
    const input = num(u.input_tokens)
    const cached = Math.min(num(u.cached_input_tokens), input)
    out.usage = { input: input - cached, output: num(u.output_tokens), cacheWrite: 0, cacheRead: cached }
  }
  return out
}

/** Sesión viva tal como la ve el tracker (lo que `ptys.list()` da, sin el resto). */
export interface SessionRef {
  id: string
  cwd: string
  createdAt: number
  /** Host remoto donde corre (§3.26); ausente = este Mac. Un cwd solo se compara con logs del mismo host. */
  host?: string
}

/** Un archivo de log ya leído: a qué cwd pertenece, cuándo empezó y qué costó. */
export interface LogRecords {
  /** CLI que escribió el log; sin él, lo de hoy solo cuenta en el total. */
  agent?: 'claude' | 'codex'
  /** `encodeCwd(cwd)`: así comparan igual Claude (carpeta) y Codex (`session_meta.cwd`). */
  cwdKey: string
  /** Host del que salió el log; ausente = este Mac. */
  host?: string
  /** `timestamp` de la primera línea; `null` si el archivo aún no dijo nada. */
  firstAt: number | null
  records: CostRecord[]
}

/** Las 00:00 locales del día de `now`. */
export function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * `today`: todo lo registrado desde las 00:00 locales. `bySession`: cada log va a la sesión con el
 * mismo cwd creada más recientemente antes de la primera línea del log (con un minuto de margen);
 * dos sesiones en el mismo cwd se reparten los logs por orden, no se duplican. Solo aparecen
 * sesiones con algo que contar.
 */
export function summarize(logs: LogRecords[], now: number, sessions: SessionRef[]): CostSummary {
  const midnight = startOfDay(now)
  let today = 0
  const bySession: Record<string, SessionCost> = {}
  const byAgent: CostSummary['byAgent'] = {}
  const byCwd = new Map<string, SessionRef[]>()
  for (const s of sessions) {
    const key = `${s.host ?? ''}\0${encodeCwd(s.cwd)}`
    const list = byCwd.get(key) ?? []
    list.push(s)
    byCwd.set(key, list)
  }
  for (const log of logs) {
    let owner: SessionRef | null = null
    if (log.firstAt !== null) {
      for (const s of byCwd.get(`${log.host ?? ''}\0${log.cwdKey}`) ?? []) {
        if (s.createdAt - SESSION_SLACK_MS <= log.firstAt && (!owner || s.createdAt > owner.createdAt)) owner = s
      }
    }
    for (const r of log.records) {
      if (r.at >= midnight) {
        today += r.usd
        if (log.agent) {
          const acc = byAgent[log.agent] ?? { usd: 0, tokens: 0 }
          acc.usd += r.usd
          acc.tokens += r.tokens
          byAgent[log.agent] = acc
        }
      }
      if (owner) {
        const acc = bySession[owner.id] ?? { usd: 0, tokens: 0 }
        acc.usd += r.usd
        acc.tokens += r.tokens
        bySession[owner.id] = acc
      }
    }
  }
  return { today, bySession, byAgent }
}

/** Estado de lectura incremental de un archivo. */
interface Tracked extends LogRecords {
  path: string
  parse: LineParser
  offset: number
  decoder: StringDecoder
  /** Trozo de la última línea aún sin `\n`. */
  rest: string
  /** Modelo vigente (Codex lo dice por turno; Claude por línea). */
  model: string | null
  seen: Set<string>
  /** Identidad del archivo al empezar a leerlo: si cambia, es otro archivo con la misma ruta (rotación). */
  ino: number
  /** Log de un host remoto: se lee por SSH. */
  remote?: RemoteLogs
  birthtime: number
}

/** Un `.jsonl` encontrado en la pasada, con lo que `stat` dice de él. */
interface Candidate {
  source: Source
  /** Remoto: por dónde se lee; ausente = disco local. */
  remote?: RemoteLogs
  path: string
  parts: string[]
  size: number
  mtime: number
  ino: number
  birthtime: number
}

/** Estado inicial de lectura de un archivo (también tras una rotación). */
const fresh = (c: Candidate): Tracked => ({
  ...(c.remote ? { host: c.remote.hostId, remote: c.remote } : {}),
  path: c.path,
  parse: c.source.parse,
  offset: 0,
  decoder: new StringDecoder('utf8'),
  rest: '',
  model: null,
  seen: new Set(),
  ino: c.ino,
  birthtime: c.birthtime,
  agent: c.source.agent,
  cwdKey: c.source.keyFromPath(c.parts) ?? '',
  firstAt: null,
  records: []
})

interface Source {
  agent: 'claude' | 'codex'
  root: string
  parse: LineParser
  /** `null` = no bajar a esa carpeta (p. ej. días viejos de Codex). */
  prune: (parts: string[], since: number) => boolean
  /** Clave de cwd si el archivo no la dice por sí mismo (Claude: la carpeta del proyecto). */
  keyFromPath: (parts: string[]) => string | null
}

export interface CostTrackerOptions {
  sessions: () => Promise<SessionRef[]> | SessionRef[]
  /** Solo se sondea en segundo plano mientras devuelva `true` (ventana enfocada). */
  isFocused?: () => boolean
  /** Raíz donde cuelgan `.claude/` y `.codex/` (el home; inyectable en tests). */
  home?: string
  /** Hosts remotos con sesiones vivas cuyos logs también cuentan (§3.26). */
  remotes?: () => Promise<RemoteLogs[]>
  now?: () => number
  ttlMs?: number
  maxBytesPerPass?: number
}

export type CostListener = (summary: CostSummary) => void

const EMPTY: CostSummary = { today: 0, bySession: {}, byAgent: {} }
/** Espera entre pasadas cuando la anterior agotó el tope de bytes. */
const BACKLOG_DELAY_MS = 1_000
const CHUNK = 1024 * 1024

/** `YYYY/MM/DD` de Codex: se salta un día entero si acabó antes de `since` (con un día de margen por sesiones largas). */
const codexPrune = (parts: string[], since: number): boolean => {
  if (parts.length !== 3) return false
  const [y, m, d] = parts.map((p) => Number(p))
  if (![y, m, d].every((n) => Number.isInteger(n))) return false
  return new Date(y, m - 1, d + 2).getTime() < since
}

export class CostTracker {
  private readonly tracked = new Map<string, Tracked>()
  private readonly listeners = new Set<CostListener>()
  private readonly sources: Source[]
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxBytes: number
  private cached: CostSummary = EMPTY
  private cachedAt = -Infinity
  private inflight: Promise<CostSummary> | null = null
  /** La última pasada agotó el tope de bytes: queda log sin leer. */
  private backlog = false
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly opts: CostTrackerOptions) {
    const home = opts.home ?? homedir()
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? COST_TTL_MS
    this.maxBytes = opts.maxBytesPerPass ?? MAX_BYTES_PER_PASS
    this.sources = [
      { agent: 'claude', root: join(home, '.claude', 'projects'), parse: parseClaudeLine, prune: () => false, keyFromPath: (parts) => parts[0] ?? null },
      { agent: 'codex', root: join(home, '.codex', 'sessions'), parse: parseCodexLine, prune: codexPrune, keyFromPath: () => null }
    ]
  }

  /** Resumen con cache de `ttlMs`; la primera llamada lee los logs. Nunca tira: sin logs es 0. */
  summary(): Promise<CostSummary> {
    if (this.now() - this.cachedAt < this.ttlMs) return Promise.resolve(this.cached)
    return this.refresh()
  }

  /** Relee lo nuevo ahora mismo y avisa si cambió algo. Llamadas concurrentes comparten la pasada. */
  refresh(): Promise<CostSummary> {
    if (this.inflight) return this.inflight
    this.inflight = this.pass()
      .catch((err: unknown) => {
        console.warn('[omni] no se pudieron leer los logs de costo:', err)
        return this.cached
      })
      .then((next) => {
        this.inflight = null
        this.cachedAt = this.now()
        const changed = JSON.stringify(next) !== JSON.stringify(this.cached)
        this.cached = next
        if (changed) this.listeners.forEach((l) => l(next))
        // Con log pendiente no se espera al siguiente sondeo: otra pasada en un segundo, siempre dentro del tope.
        if (this.backlog) setTimeout(() => void this.refresh(), BACKLOG_DELAY_MS).unref()
        return next
      })
    return this.inflight
  }

  onChanged(listener: CostListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Sondeo en segundo plano cada `ttlMs` mientras la ventana esté enfocada. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.opts.isFocused?.() ?? true) void this.refresh()
    }, this.ttlMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async pass(): Promise<CostSummary> {
    const now = this.now()
    const sessions = await this.opts.sessions()
    // Solo interesan archivos que pudieron escribirse hoy o durante alguna sesión viva.
    const since = Math.min(startOfDay(now), ...sessions.map((s) => s.createdAt - SESSION_SLACK_MS))
    const candidates: Candidate[] = []
    for (const source of this.sources) await this.walk(source, source.root, [], since, candidates)
    for (const remote of (await this.opts.remotes?.().catch(() => [])) ?? []) {
      for (const source of this.sources) {
        const root = posix.join(remote.home, source.agent === 'claude' ? '.claude/projects' : '.codex/sessions')
        const files = await remote.list(root, since).catch(() => [])
        for (const f of files) {
          const parts = f.rel.split('/').slice(0, -1)
          if (parts.length > 4 || source.prune(parts, since)) continue
          candidates.push({ source, remote, path: posix.join(root, f.rel), parts, size: f.size, mtime: f.mtime, ino: f.ino, birthtime: 0 })
        }
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    let budget = this.maxBytes
    this.backlog = false
    for (const c of candidates) {
      if (budget <= 0) {
        this.backlog = true
        break
      }
      const key = c.remote ? `${c.remote.hostId}:${c.path}` : c.path
      let t = this.tracked.get(key)
      if (!t && c.mtime < since) continue
      // Sin estado, truncado, o rotado (otro inode u otra fecha de creación aunque el tamaño no baje): desde cero.
      // El mtime no sirve de identidad: cambia con cada línea que se añade.
      if (!t || c.size < t.offset || c.ino !== t.ino || c.birthtime !== t.birthtime) {
        t = fresh(c)
        this.tracked.set(key, t)
      }
      if (c.size <= t.offset) continue
      budget -= await this.read(t, c.size, budget)
      if (t.offset < c.size) this.backlog = true
    }
    return summarize([...this.tracked.values()], now, sessions)
  }

  private async walk(source: Source, dir: string, parts: string[], since: number, out: Candidate[]): Promise<void> {
    if (parts.length > 4 || source.prune(parts, since)) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isDirectory()) await this.walk(source, path, [...parts, e.name], since, out)
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const s = await stat(path)
          out.push({ source, path, parts, size: s.size, mtime: s.mtimeMs, ino: s.ino, birthtime: s.birthtimeMs })
        } catch {
          /* desapareció entre el readdir y el stat */
        }
      }
    }
  }

  /** Lee desde `t.offset` hasta `size` (o hasta agotar `budget`) y devuelve los bytes consumidos. */
  private async read(t: Tracked, size: number, budget: number): Promise<number> {
    const end = Math.min(size, t.offset + budget)
    if (t.remote) return this.readRemote(t, t.remote, end)
    const fh = await open(t.path, 'r')
    const buf = Buffer.allocUnsafe(CHUNK)
    let consumed = 0
    try {
      while (t.offset < end) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, end - t.offset), t.offset)
        if (bytesRead === 0) break
        t.offset += bytesRead
        consumed += bytesRead
        const text = t.rest + t.decoder.write(buf.subarray(0, bytesRead))
        const lines = text.split('\n')
        t.rest = lines.pop() ?? ''
        for (const line of lines) this.ingest(t, line)
      }
    } finally {
      await fh.close()
    }
    return consumed
  }

  /** Como `read`, pero por SSH y de una sola vez (un `tail -c` por archivo y pasada). */
  private async readRemote(t: Tracked, remote: RemoteLogs, end: number): Promise<number> {
    const chunk = await remote.read(t.path, t.offset, end - t.offset)
    t.offset += chunk.length
    const text = t.rest + t.decoder.write(chunk)
    const lines = text.split('\n')
    t.rest = lines.pop() ?? ''
    for (const line of lines) this.ingest(t, line)
    return chunk.length
  }

  private ingest(t: Tracked, line: string): void {
    const p = t.parse(line)
    if (!p) return
    if (p.at !== undefined && t.firstAt === null) t.firstAt = p.at
    if (p.cwd) t.cwdKey = encodeCwd(p.cwd)
    if (p.model) t.model = p.model
    if (!p.usage || p.at === undefined) return
    if (p.key) {
      if (t.seen.has(p.key)) return
      t.seen.add(p.key)
    }
    const usd = costOfUsage(p.usage, t.model ?? '')
    const tokens = tokensOf(p.usage)
    if (usd === 0 && tokens === 0) return
    t.records.push({ at: p.at, usd, tokens })
  }
}
