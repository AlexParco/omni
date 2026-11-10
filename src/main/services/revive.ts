import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SavedSession } from '@shared/daemon'
import { claudeSessionUnder, readProcessTable, type ProcessTable } from '../../daemon/agent-session'
import type { AgentDef, AgentId, SessionInfo, Workspace } from '@shared/types'
import type { CreateOptions, SessionBackend } from './session-backend'

/**
 * Revivir sesiones tras un reinicio de la Mac o una caída del daemon (ARCHITECTURE §3.10b). Los
 * procesos no sobreviven a un apagado: el daemon deja `sessions.json` con lo que corría y, al volver,
 * main vuelve a crear cada sesión con su mismo id (el layout guardado sigue válido) y, si es un
 * agente, retoma su conversación:
 *
 * - Claude Code: omni lo lanza con `--session-id <uuid>` y lo retoma con `--resume <uuid>` si su
 *   transcript existe (`~/.claude/projects/<cwd codificado>/<uuid>.jsonl`; no existe hasta el primer mensaje).
 * - Codex: `codex resume <id>`. El id sale de `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
 *   (primera línea `session_meta` con `payload.id`, `payload.cwd` real y `payload.timestamp` de lanzamiento).
 * - OpenCode: `opencode -s <id>`. Tabla `session` de `~/.local/share/opencode/opencode.db` (la fila
 *   nace con el primer prompt, así que `time_created` puede ser muy posterior al lanzamiento).
 * - Hermes: `hermes --resume <id>`. Tabla `sessions` de `~/.hermes/state.db`; el id lleva la hora
 *   local de lanzamiento (`YYYYMMDD_HHMMSS_xxxxxx`) y Hermes sigue solo la cadena de compresión.
 * - Goose y overrides desconocidos: se relanza el comando tal cual (sin conversación que retomar).
 *
 * Sin conversación encontrada el agente arranca limpio y la pantalla guardada se pinta arriba.
 */

/** Ventana alrededor del lanzamiento en la que se acepta la conversación de un agente. El comando se escribe tras el primer prompt (≤ 2 s). */
const LAUNCH_BEFORE_MS = 2_000
const LAUNCH_AFTER_MS = 60_000
const DAY_MS = 86_400_000

/** Resultado de un comando externo; `code` 1 si no se pudo ejecutar. */
export interface ExecResult {
  code: number
  stdout: string
}
export type Exec = (file: string, args: string[]) => Promise<ExecResult>

const defaultExec: Exec = (file, args) =>
  new Promise((done) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const exit: unknown = err ? (err as { code?: unknown }).code : 0
      done({ code: typeof exit === 'number' ? exit : 1, stdout: typeof stdout === 'string' ? stdout : '' })
    })
  })

/** Codificación de cwd de Claude Code: todo carácter no alfanumérico pasa a `-`. Exportada para tests. */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** Hora de lanzamiento (ms) de un id UUIDv7 de Codex: sus primeros 48 bits. `null` si no tiene esa forma. Exportada para tests. */
export function uuidV7Time(id: string): number | null {
  const hex = id.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== '7') return null
  return parseInt(hex.slice(0, 12), 16)
}

/** Hora de lanzamiento (ms) de un id de Hermes (`YYYYMMDD_HHMMSS_xxxxxx`, hora local). `null` si no tiene esa forma. Exportada para tests. */
export function hermesIdTime(id: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/.exec(id)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  const t = new Date(y, mo - 1, d, h, mi, s).getTime()
  return Number.isFinite(t) ? t : null
}

/** Conversación candidata de un agente: id, cwd con que corrió y hora de lanzamiento (ms). */
export interface Candidate {
  id: string
  cwd: string
  at: number
}

/**
 * La conversación de una terminal: misma carpeta, lanzada en la ventana `[T−2 s, T+60 s]` (o, con
 * `openEnded`, cualquier momento desde T−2 s: OpenCode crea la fila con el primer prompt), la más
 * cercana a T y no reclamada por otra terminal. Exportada para tests.
 */
export function pickCandidate(candidates: readonly Candidate[], cwds: readonly string[], createdAt: number, claimed: ReadonlySet<string>, openEnded = false): string | null {
  const from = createdAt - LAUNCH_BEFORE_MS
  const to = openEnded ? Infinity : createdAt + LAUNCH_AFTER_MS
  const best = candidates
    .filter((c) => cwds.includes(c.cwd) && c.at >= from && c.at <= to && !claimed.has(c.id))
    .sort((a, b) => Math.abs(a.at - createdAt) - Math.abs(b.at - createdAt))[0]
  return best?.id ?? null
}

/** Carpetas a comparar: la guardada y su ruta real (Codex guarda `/private/var/…` por `/var/…`). */
function cwdVariants(cwd: string): string[] {
  try {
    const real = realpathSync(cwd)
    return real === cwd ? [cwd] : [cwd, real]
  } catch {
    return [cwd]
  }
}

/** Literal SQL entre comillas simples (las internas se duplican): los valores son rutas e ids propios, no entrada del usuario, pero una ruta puede llevar `'`. */
const sqlString = (s: string): string => `'${s.replace(/'/g, "''")}'`

export interface ResumeResolverOptions {
  home?: string
  exec?: Exec
}

/** Busca, por agente, la conversación que corría en una terminal. Solo lee: nunca abre una base en escritura. */
export class ResumeResolver {
  private readonly home: string
  private readonly exec: Exec

  constructor(opts: ResumeResolverOptions = {}) {
    this.home = opts.home ?? homedir()
    this.exec = opts.exec ?? defaultExec
  }

  /** Id de la conversación a retomar, o `null` si no hay (agente sin mensajes, archivada, desconocida). */
  async find(saved: SavedSession, claimed: ReadonlySet<string>): Promise<string | null> {
    // Una conversación que ya retoma otra terminal no se abre dos veces (dos procesos escribiendo el mismo transcript).
    if (saved.resumeId && claimed.has(saved.resumeId)) return null
    const cwds = cwdVariants(saved.cwd)
    switch (saved.agent) {
      case 'claude':
        return saved.resumeId && this.claudeTranscriptExists(saved.resumeId, cwds) ? saved.resumeId : null
      case 'codex':
        return this.codex(saved, cwds, claimed)
      case 'opencode':
        return this.opencode(saved, cwds, claimed)
      case 'hermes':
        return this.hermes(saved, cwds, claimed)
      default:
        return null
    }
  }

  private claudeTranscriptExists(id: string, cwds: readonly string[]): boolean {
    return cwds.some((c) => existsSync(join(this.home, '.claude', 'projects', claudeProjectDir(c), `${id}.jsonl`)))
  }

  /** Rollouts de Codex del día de lanzamiento ±1 (las carpetas van en hora local). Con `resumeId` conocido solo se comprueba que su archivo siga ahí. */
  private async codex(saved: SavedSession, cwds: readonly string[], claimed: ReadonlySet<string>): Promise<string | null> {
    const root = join(this.home, '.codex', 'sessions')
    if (saved.resumeId) {
      // Retomar no cambia el id ni el archivo: basta con encontrarlo en cualquier fecha.
      for (const dir of await listDirs(root, 3)) for (const f of await listFiles(dir)) if (f.endsWith(`${saved.resumeId}.jsonl`)) return saved.resumeId
      return null
    }
    const files: string[] = []
    for (const t of [saved.createdAt - DAY_MS, saved.createdAt, saved.createdAt + DAY_MS]) {
      const d = new Date(t)
      const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
      for (const f of await listFiles(dir)) if (f.startsWith('rollout-') && f.endsWith('.jsonl')) files.push(join(dir, f))
    }
    const candidates: Candidate[] = []
    for (const file of files) {
      // El UUIDv7 del nombre lleva la hora de lanzamiento: se filtra antes de abrir el archivo.
      const idInName = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file)?.[1]
      const at = idInName ? uuidV7Time(idInName) : null
      if (at !== null && (at < saved.createdAt - LAUNCH_BEFORE_MS || at > saved.createdAt + LAUNCH_AFTER_MS)) continue
      const meta = parseCodexMeta(await firstLine(file))
      if (meta) candidates.push(meta)
    }
    return pickCandidate(candidates, cwds, saved.createdAt, claimed)
  }

  private async opencode(saved: SavedSession, cwds: readonly string[], claimed: ReadonlySet<string>): Promise<string | null> {
    const db = join(this.home, '.local', 'share', 'opencode', 'opencode.db')
    if (!existsSync(db)) return null
    if (saved.resumeId) {
      const rows = await this.sqlite(db, `select id from session where id = ${sqlString(saved.resumeId)} and time_archived is null`)
      return rows.length ? saved.resumeId : null
    }
    const rows = await this.sqlite(
      db,
      `select id, directory as cwd, time_created as at from session where parent_id is null and time_archived is null and directory in (${cwds.map(sqlString).join(',')}) and time_created >= ${Math.floor(saved.createdAt - LAUNCH_BEFORE_MS)} order by time_created`
    )
    return pickCandidate(rows.map(asCandidate).filter((c): c is Candidate => c !== null), cwds, saved.createdAt, claimed, true)
  }

  private async hermes(saved: SavedSession, cwds: readonly string[], claimed: ReadonlySet<string>): Promise<string | null> {
    const db = join(this.home, '.hermes', 'state.db')
    if (!existsSync(db)) return null
    if (saved.resumeId) {
      const rows = await this.sqlite(db, `select id from sessions where id = ${sqlString(saved.resumeId)}`)
      return rows.length ? saved.resumeId : null
    }
    // La fila nace con el primer turno; la hora de lanzamiento va en el id (hora local).
    const rows = await this.sqlite(db, `select id, cwd from sessions where parent_session_id is null and cwd in (${cwds.map(sqlString).join(',')})`)
    const candidates: Candidate[] = []
    for (const r of rows) {
      const id = typeof r.id === 'string' ? r.id : null
      const at = id ? hermesIdTime(id) : null
      if (id && at !== null && typeof r.cwd === 'string') candidates.push({ id, cwd: r.cwd, at })
    }
    // Precisión de segundos en el id: se tolera un segundo más hacia atrás.
    return pickCandidate(candidates, cwds, saved.createdAt - 1000, claimed)
  }

  private async sqlite(db: string, sql: string): Promise<Record<string, unknown>[]> {
    const r = await this.exec('/usr/bin/sqlite3', ['-readonly', '-json', `file:${db}?mode=ro`, sql])
    if (r.code !== 0 || !r.stdout.trim()) return []
    try {
      const rows: unknown = JSON.parse(r.stdout)
      return Array.isArray(rows) ? rows.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : []
    } catch {
      return []
    }
  }
}

function asCandidate(r: Record<string, unknown>): Candidate | null {
  return typeof r.id === 'string' && typeof r.cwd === 'string' && typeof r.at === 'number' ? { id: r.id, cwd: r.cwd, at: r.at } : null
}

/** `session_meta` de un rollout de Codex como candidato; descarta forks y sesiones no interactivas. Exportada para tests. */
export function parseCodexMeta(line: string | null): Candidate | null {
  if (!line) return null
  try {
    const raw: unknown = JSON.parse(line)
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as { type?: unknown; payload?: Record<string, unknown> }
    const p = r.payload
    if (r.type !== 'session_meta' || !p || typeof p.id !== 'string' || typeof p.cwd !== 'string') return null
    if (p.forked_from_id) return null
    if (p.source === 'exec' || (typeof p.originator === 'string' && p.originator !== 'codex-tui' && p.originator !== 'codex_cli_rs')) return null
    if (p.thread_source !== undefined && p.thread_source !== 'user') return null
    const at = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN
    return Number.isFinite(at) ? { id: p.id, cwd: p.cwd, at } : null
  } catch {
    return null
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/** Directorios a `depth` niveles bajo `root` (año/mes/día de Codex). */
async function listDirs(root: string, depth: number): Promise<string[]> {
  let level = [root]
  for (let i = 0; i < depth; i++) {
    const next: string[] = []
    for (const dir of level) for (const name of await listFiles(dir)) if (/^\d+$/.test(name)) next.push(join(dir, name))
    level = next
  }
  return level
}

/** Primera línea de un archivo sin leerlo entero (los rollouts pesan megas). */
async function firstLine(file: string, max = 64 * 1024): Promise<string | null> {
  try {
    const fh = await open(file, 'r')
    try {
      const buf = Buffer.alloc(max)
      const { bytesRead } = await fh.read(buf, 0, max, 0)
      const text = buf.subarray(0, bytesRead).toString('utf8')
      const nl = text.indexOf('\n')
      return nl === -1 ? text : text.slice(0, nl)
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/* ---------- comandos ---------- */

/** Agentes con conversación que se puede retomar; el resto se relanza limpio. */
export const RESUMABLE: readonly AgentId[] = ['claude', 'codex', 'opencode', 'hermes']

/**
 * Comando de lanzamiento de una sesión nueva. Claude Code recibe `--session-id` con un uuid propio:
 * así omni sabe qué conversación retomar sin adivinar (dos Claude en la misma carpeta no se confunden).
 */
export function launchCommand(agent: AgentDef): { command: string | null; resumeId?: string } {
  if (agent.id === 'claude' && agent.command) {
    const resumeId = randomUUID()
    return { command: `${agent.command} --session-id ${resumeId}`, resumeId }
  }
  return { command: agent.command }
}

/**
 * Comando para revivir: retomar `resumeId` si hay, o lanzar limpio (Claude con el mismo `--session-id`
 * si nunca llegó a escribir su transcript). Los flags originales los agrega el daemon detrás. Exportada para tests.
 */
export function resumeCommand(agent: AgentDef, found: string | null, saved: SavedSession): { command: string | null; resumeId?: string } {
  const base = agent.command
  if (!base) return { command: null }
  if (found) {
    switch (agent.id) {
      case 'claude':
        return { command: `${base} --resume ${found}`, resumeId: found }
      case 'codex':
        return { command: `${base} resume ${found}`, resumeId: found }
      case 'opencode':
        return { command: `${base} -s ${found}`, resumeId: found }
      case 'hermes':
        return { command: `${base} --resume ${found}`, resumeId: found }
    }
  }
  if (agent.id === 'claude') {
    const resumeId = saved.resumeId ?? randomUUID()
    return { command: `${base} --session-id ${resumeId}`, resumeId }
  }
  return { command: base }
}

/* ---------- orquestación ---------- */

export interface ReviveDeps {
  backend: SessionBackend
  workspace: (id: string) => Workspace | undefined
  findAgent: (id: string) => AgentDef | undefined
  /** Ajuste "Revivir sesiones al reiniciar": apagado, las huérfanas se descartan. */
  enabled: boolean
  resolver?: ResumeResolver
  log?: (message: string) => void
  /**
   * Conversación en curso por id de sesión, leída justo antes de cambiar el daemon (`currentClaudeChats`):
   * manda sobre el `resumeId` del registro, que un daemon de un build anterior no actualiza tras `/resume`.
   */
  resumeOverrides?: Record<string, string>
}

/** Lo que pasó al revivir: sesiones creadas y cuántas retomaron su conversación. */
export interface ReviveResult {
  sessions: SessionInfo[]
  resumed: number
}

/**
 * Chat en curso de cada Claude Code local vivo que ya no es el de su `resumeId` (el usuario hizo
 * `/resume` o `/clear`), leído de `~/.claude/sessions/<pid>.json` bajo el shell de cada sesión. Se
 * llama justo antes de "Actualizar terminales": el daemon viejo no sigue esos cambios y revivir con su
 * registro abriría el chat del lanzamiento. `{}` si el daemon no informa los pids o no hay cambios.
 */
export async function currentClaudeChats(
  sessions: readonly SessionInfo[],
  pids: Record<string, number>,
  table?: ProcessTable,
  find: typeof claudeSessionUnder = claudeSessionUnder
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const local = sessions.filter((s) => s.agent === 'claude' && !s.remote && pids[s.id] > 0)
  if (local.length === 0) return out
  const procs = table ?? (await readProcessTable())
  for (const s of local) {
    const current = await find(procs, pids[s.id])
    if (current && current !== s.resumeId) out[s.id] = current
  }
  return out
}

/**
 * Revive las huérfanas del daemon (si las hay) antes de que el renderer pida `session:list`. Las que
 * no se pueden revivir (workspace borrado, agente desconocido, carpeta que ya no existe) se descartan.
 * Nunca lanza: un fallo deja la sesión fuera y sigue con la siguiente.
 */
export async function reviveSessions(deps: ReviveDeps): Promise<ReviveResult> {
  const log = deps.log ?? ((m: string) => console.log(`[omni] ${m}`))
  const result: ReviveResult = { sessions: [], resumed: 0 }
  const orphans = await deps.backend.orphans()
  if (orphans.length === 0) return result
  if (!deps.enabled) {
    await deps.backend.dismiss(orphans.map((o) => o.id))
    log(`${orphans.length} sesiones de antes del reinicio descartadas (ajuste apagado)`)
    return result
  }
  const resolver = deps.resolver ?? new ResumeResolver()
  // Conversaciones ya en uso (sesiones vivas o recién revividas): dos terminales nunca retoman la misma.
  const claimed = new Set<string>()
  for (const s of await deps.backend.list()) if (s.resumeId) claimed.add(s.resumeId)
  const dismiss: string[] = []

  for (const saved of orphans) {
    const workspace = deps.workspace(saved.workspaceId)
    const agent = deps.findAgent(saved.agent)
    // Las remotas las revive `reviveRemote` (hace falta conectar al host); aquí no se tocan ni se descartan.
    if (workspace?.host) continue
    const cwd = existsSync(saved.cwd) ? saved.cwd : workspace && existsSync(workspace.path) ? workspace.path : null
    if (!workspace || !agent || agent.id === 'browser' || cwd === null) {
      dismiss.push(saved.id)
      continue
    }
    try {
      const override = deps.resumeOverrides?.[saved.id]
      const target = override ? { ...saved, resumeId: override } : saved
      const found = RESUMABLE.includes(agent.id) ? await resolver.find(target, claimed) : null
      if (found) claimed.add(found)
      const plan = resumeCommand(agent, found, target)
      const opts: CreateOptions = { id: saved.id, command: plan.command, resumeId: plan.resumeId, restored: true, restoreScreen: !found }
      const info = await deps.backend.create(agent, { ...workspace, path: cwd }, saved.args, opts)
      result.sessions.push(info)
      if (found) result.resumed++
      log(`revivida ${saved.id} (${agent.id}${found ? ` → ${found}` : ', limpia'}) en ${cwd}`)
    } catch (err) {
      log(`no se pudo revivir ${saved.id}: ${err instanceof Error ? err.message : String(err)}`)
      dismiss.push(saved.id)
    }
  }
  if (dismiss.length) await deps.backend.dismiss(dismiss)
  return result
}

/* ---------- sesiones remotas (§3.26) ---------- */

/** Lo que `reviveRemote` necesita del registro de hosts. */
export interface RemoteHosts {
  /** Conectado o conectar ahora; lanza con un error humano si no se puede. */
  ensure(hostId: string): Promise<{ transport: { run(cmdline: string, opts?: { timeoutMs?: number }): Promise<{ code: number | null }> } }>
  hasSession(hostId: string, sessionId: string): Promise<boolean>
  terminalSpawn(hostId: string, sessionId: string, cwd: string): Promise<{ file: string; args: string[]; reconnect: boolean }>
}

export interface RemoteReviveDeps {
  backend: SessionBackend
  workspace: (id: string) => Workspace | undefined
  findAgent: (id: string) => AgentDef | undefined
  hosts: RemoteHosts
  enabled: boolean
  /** Solo las de este host (al reconectarse uno); sin él, todas. */
  hostId?: string
  log?: (message: string) => void
}

/** Comando remoto que dice si existe el transcript de Claude Code de esa conversación en el host. Exportada para tests. */
export function claudeTranscriptCheck(cwd: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`id de conversación inválido: ${id}`)
  return `test -f "$HOME"/.claude/projects/${claudeProjectDir(cwd)}/${id}.jsonl`
}

/**
 * Huérfanas remotas que alguna llamada a `reviveRemote` está reviviendo ahora. El arranque y cada
 * `connected` de un host lanzan su propia llamada y pueden solaparse: sin esto las dos crearían la
 * misma sesión (dos ssh enganchados al mismo dtach, o el agente relanzado dos veces).
 */
const reviving = new Set<string>()

/**
 * Revive las sesiones remotas huérfanas (§3.26). Tras un reinicio de la Mac el ssh murió pero, con
 * dtach, la sesión sigue en el host: se vuelve a enganchar con el mismo id y sin escribir nada (el
 * agente sigue donde estaba). Si el host se reinició, se abre otra y se relanza el agente (Claude Code
 * retoma su conversación si su transcript está en el host). Un host que no conecta deja sus sesiones
 * como huérfanas para el próximo intento; nunca lanza.
 */
export async function reviveRemote(deps: RemoteReviveDeps): Promise<ReviveResult> {
  const log = deps.log ?? ((m: string) => console.log(`[omni] ${m}`))
  const result: ReviveResult = { sessions: [], resumed: 0 }
  const live = new Set((await deps.backend.list()).map((s) => s.id))
  const orphans = (await deps.backend.orphans()).filter((o) => !live.has(o.id) && deps.workspace(o.workspaceId)?.host !== undefined)
  const mine = deps.hostId ? orphans.filter((o) => deps.workspace(o.workspaceId)?.host === deps.hostId) : orphans
  if (mine.length === 0) return result
  // Un daemon de otro build abriría shells locales: se dejan como huérfanas hasta reiniciarlo.
  if (!deps.backend.remoteReady()) return result
  if (!deps.enabled) {
    await deps.backend.dismiss(mine.map((o) => o.id))
    return result
  }
  const dismiss: string[] = []
  const unreachable = new Set<string>()
  for (const saved of mine) {
    const workspace = deps.workspace(saved.workspaceId)
    const agent = deps.findAgent(saved.agent)
    const host = workspace?.host
    if (!workspace || !host || !agent || agent.id === 'browser') {
      dismiss.push(saved.id)
      continue
    }
    if (unreachable.has(host)) continue
    // Otra llamada ya la está reviviendo: esta no la toca (ni la descarta).
    if (reviving.has(saved.id)) continue
    reviving.add(saved.id)
    try {
      const conn = await deps.hosts.ensure(host)
      const alive = await deps.hosts.hasSession(host, saved.id)
      const spawn = await deps.hosts.terminalSpawn(host, saved.id, saved.cwd)
      let opts: CreateOptions = { id: saved.id, command: null, resumeId: saved.resumeId, restored: true, restoreScreen: false, spawn }
      let resumed = alive
      if (!alive) {
        const found = agent.id === 'claude' && saved.resumeId && (await conn.transport.run(claudeTranscriptCheck(saved.cwd, saved.resumeId), { timeoutMs: 10_000 })).code === 0 ? saved.resumeId : null
        const plan = resumeCommand(agent, found, saved)
        opts = { ...opts, command: plan.command, resumeId: plan.resumeId, restoreScreen: true }
        resumed = found !== null
      }
      // La lista se tomó antes de conectar (segundos): otra llamada pudo revivirla mientras tanto.
      if ((await deps.backend.list()).some((s) => s.id === saved.id)) continue
      const info = await deps.backend.create(agent, workspace, saved.args, opts)
      result.sessions.push(info)
      if (resumed && agent.id !== 'shell') result.resumed++
      log(`revivida remota ${saved.id} (${agent.id}, ${alive ? 'enganchada a dtach' : 'relanzada'})`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // El daemon rechaza un id que ya vive: no es un host caído, la sesión ya está.
      if (await deps.backend.list().then((all) => all.some((s) => s.id === saved.id), () => false)) {
        log(`remota ${saved.id} ya estaba viva: no se revive dos veces`)
        continue
      }
      unreachable.add(host)
      log(`host ${host} sin conexión: ${saved.id} queda para el próximo intento (${message})`)
    } finally {
      reviving.delete(saved.id)
    }
  }
  if (dismiss.length) await deps.backend.dismiss(dismiss)
  return result
}

/** Esperas entre intentos de revivir remotas tras una caída (el host puede tardar en volver: wifi, VPN, sleep). */
export const REMOTE_RECOVERY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000, 300_000, 300_000]

export interface RemoteRecoveryDeps {
  /** Hosts con terminales remotas huérfanas (ssh caído) pendientes de revivir. */
  pendingHosts(): Promise<string[]>
  /** Revive las huérfanas de ese host (`reviveRemote` con `hostId`); conecta si hace falta. */
  revive(hostId: string): Promise<SessionInfo[]>
  /** Avisa al renderer de lo revivido (`session:added`). */
  added(list: SessionInfo[]): void
  delaysMs?: readonly number[]
  log?: (message: string) => void
}

/**
 * Reintentos para revivir terminales remotas cuyo ssh se cayó con la app abierta (cerrar la tapa,
 * cambiar de red). `kick()` (al caer una sesión remota o al despertar la Mac) agenda un intento; si
 * tras él quedan huérfanas, vuelve a probar con espera creciente hasta agotar `delaysMs`. Un nuevo
 * `kick()` reinicia la cuenta. Nunca corre dos intentos a la vez. Exportada para tests.
 */
export function remoteRecovery(deps: RemoteRecoveryDeps): { kick(): void; stop(): void } {
  const delays = deps.delaysMs ?? REMOTE_RECOVERY_DELAYS_MS
  const log = deps.log ?? ((m: string) => console.log(`[omni] ${m}`))
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let running = false
  let again = false
  let stopped = false

  const schedule = (): void => {
    if (stopped || timer || attempt >= delays.length) return
    timer = setTimeout(() => void run(), delays[attempt])
    attempt++
  }

  const run = async (): Promise<void> => {
    timer = null
    if (running) {
      again = true
      return
    }
    running = true
    try {
      for (const host of await deps.pendingHosts()) {
        const revived = await deps.revive(host).catch(() => [] as SessionInfo[])
        if (revived.length) {
          log(`${revived.length} terminal(es) remota(s) revivida(s) en ${host}`)
          deps.added(revived)
        }
      }
      const left = await deps.pendingHosts().catch(() => [] as string[])
      if (left.length === 0) attempt = 0
      else schedule()
    } finally {
      running = false
      if (again) {
        again = false
        schedule()
      }
    }
  }

  return {
    kick() {
      attempt = 0
      if (timer) clearTimeout(timer)
      timer = null
      schedule()
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
