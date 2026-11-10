import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SavedSession } from '@shared/daemon'
import type { AgentId, SessionInfo } from '@shared/types'

/** Tras la salida de una sesión se espera esto antes de olvidarla: en un apagado del sistema los shells mueren antes (o a la vez) que llega el SIGTERM al daemon. */
export const EXIT_GRACE_MS = 3000
/** Espera para agrupar escrituras de `sessions.json` (crear varias sesiones seguidas escribe una vez). */
const WRITE_DELAY_MS = 250
/** Ids que se aceptan como nombre de archivo de pantalla: los de `randomUUID` y los que pida un cliente con la misma forma. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/

export interface ManifestOptions {
  exitGraceMs?: number
  writeDelayMs?: number
}

/**
 * Registro en disco de las sesiones del daemon para revivirlas tras un reinicio de la Mac o una caída
 * del daemon (ARCHITECTURE §3.10b). `sessions.json` lleva las vivas más las huérfanas sin reclamar;
 * `screens/<id>.ans` la última foto de cada pantalla.
 *
 * Contrato: al arrancar, todo lo que había en el archivo es de un daemon muerto → huérfanas. Un `kill`
 * o la salida del shell las olvida; un apagado (`freeze`) congela el registro tal cual para que las
 * muertes en cascada del apagado no lo vacíen. "Apagar todo" (`clear`) lo vacía a propósito.
 */
export class SessionManifest {
  private readonly file: string
  private readonly screens: string
  private readonly orphans = new Map<string, SavedSession>()
  private readonly live = new Map<string, SavedSession>()
  private readonly removals = new Map<string, NodeJS.Timeout>()
  private writeTimer: NodeJS.Timeout | null = null
  private frozen = false
  private readonly exitGraceMs: number
  private readonly writeDelayMs: number

  constructor(dir: string, opts: ManifestOptions = {}) {
    this.file = join(dir, 'sessions.json')
    this.screens = join(dir, 'screens')
    this.exitGraceMs = opts.exitGraceMs ?? EXIT_GRACE_MS
    this.writeDelayMs = opts.writeDelayMs ?? WRITE_DELAY_MS
  }

  /** Lee el registro del daemon anterior: todo pasa a huérfanas. Un archivo roto se ignora (arrancar sin nada es válido). */
  load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      for (const s of sanitizeSessions(raw)) this.orphans.set(s.id, s)
    } catch {
      // Registro corrupto: no hay nada que revivir.
    }
  }

  /** Huérfanas por antigüedad (la más vieja primero, como estaban en el sidebar). */
  getOrphans(): SavedSession[] {
    return [...this.orphans.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  getOrphan(id: string): SavedSession | undefined {
    return this.orphans.get(id)
  }

  /** Sesión nueva o revivida. Una revivida conserva el `createdAt` original (identifica la conversación de su agente). */
  track(info: SessionInfo, createdAt = info.createdAt): void {
    if (this.frozen) return
    this.orphans.delete(info.id)
    const saved: SavedSession = { id: info.id, agent: info.agent, workspaceId: info.workspaceId, cwd: info.cwd, createdAt }
    if (info.args?.length) saved.args = info.args
    if (info.resumeId) saved.resumeId = info.resumeId
    this.live.set(info.id, saved)
    this.scheduleWrite()
  }

  /** `kill` explícito: se olvida ya, con su pantalla. */
  forget(id: string): void {
    if (this.frozen) return
    this.cancelRemoval(id)
    this.live.delete(id)
    this.deleteScreen(id)
    this.scheduleWrite()
  }

  /** El shell de la sesión salió: se olvida tras la gracia, salvo que antes llegue un apagado (`freeze`). */
  exited(id: string): void {
    if (this.frozen || !this.live.has(id)) return
    this.cancelRemoval(id)
    this.removals.set(
      id,
      setTimeout(() => {
        this.removals.delete(id)
        this.forget(id)
      }, this.exitGraceMs)
    )
  }

  /**
   * Terminal remota que agotó sus reconexiones: el proceso local murió pero la sesión dtach puede
   * seguir viva en el host. Pasa a huérfana (con su pantalla y su `createdAt`) para que la app se
   * vuelva a enganchar cuando el host conecte, en vez de olvidarla y dejar al agente corriendo solo.
   */
  lost(id: string): void {
    if (this.frozen) return
    const saved = this.live.get(id)
    if (!saved) return
    this.cancelRemoval(id)
    this.live.delete(id)
    this.orphans.set(id, saved)
    this.scheduleWrite()
  }

  /**
   * El agente de una sesión viva cambió de conversación (p. ej. `/resume` en Claude Code): revivir debe
   * retomar la nueva, no la del lanzamiento. Ignora sesiones que no están vivas en el registro.
   */
  setResumeId(id: string, resumeId: string): void {
    if (this.frozen) return
    const saved = this.live.get(id)
    if (!saved || saved.resumeId === resumeId) return
    saved.resumeId = resumeId
    this.scheduleWrite()
  }

  /** Descarta huérfanas que no se van a revivir. */
  dismiss(ids: readonly string[]): void {
    if (this.frozen) return
    for (const id of ids) {
      if (!this.orphans.delete(id)) continue
      this.deleteScreen(id)
    }
    this.scheduleWrite()
  }

  /** Apagado del sistema o caída: se deja el registro como está y no se toca más. Escribe lo pendiente al instante. */
  freeze(): void {
    if (this.frozen) return
    for (const t of this.removals.values()) clearTimeout(t)
    this.removals.clear()
    this.flush()
    this.frozen = true
  }

  /** "Apagar todo": nada que revivir. Borra registro y pantallas y congela. */
  clear(): void {
    for (const t of this.removals.values()) clearTimeout(t)
    this.removals.clear()
    this.orphans.clear()
    this.live.clear()
    try {
      if (existsSync(this.screens)) for (const f of readdirSync(this.screens)) unlinkSync(join(this.screens, f))
    } catch {
      // Una pantalla que no se pudo borrar no se revive igual: sin registro no hay sesión.
    }
    this.flush()
    this.frozen = true
  }

  /** Guarda la foto de la pantalla de una sesión viva (atómico). */
  saveScreen(id: string, text: string): void {
    if (this.frozen || !SAFE_ID.test(id) || !this.live.has(id)) return
    try {
      mkdirSync(this.screens, { recursive: true })
      const file = this.screenFile(id)
      writeFileSync(`${file}.tmp`, text)
      renameSync(`${file}.tmp`, file)
    } catch {
      // Sin foto se revive igual, con la pantalla vacía.
    }
  }

  /** Última foto guardada de la sesión; `null` si no hay. */
  readScreen(id: string): string | null {
    if (!SAFE_ID.test(id)) return null
    try {
      return readFileSync(this.screenFile(id), 'utf8')
    } catch {
      return null
    }
  }

  /** Escribe ya lo pendiente (también lo usa el apagado). */
  flush(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = null
    if (this.frozen) return
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      const all = [...this.live.values(), ...this.orphans.values()]
      writeFileSync(`${this.file}.tmp`, JSON.stringify(all, null, 2) + '\n')
      renameSync(`${this.file}.tmp`, this.file)
    } catch {
      // Disco lleno o sin permisos: el daemon sigue; solo se pierde la posibilidad de revivir.
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => this.flush(), this.writeDelayMs)
  }

  private cancelRemoval(id: string): void {
    const t = this.removals.get(id)
    if (t) clearTimeout(t)
    this.removals.delete(id)
  }

  private screenFile(id: string): string {
    return join(this.screens, `${id}.ans`)
  }

  private deleteScreen(id: string): void {
    if (!SAFE_ID.test(id)) return
    try {
      unlinkSync(this.screenFile(id))
    } catch {
      // No había foto.
    }
  }
}

const AGENTS: readonly AgentId[] = ['shell', 'claude', 'codex', 'opencode', 'goose', 'hermes']

/** Deja solo entradas con forma válida (y de agentes con PTY). Exportada para tests. */
export function sanitizeSessions(raw: unknown): SavedSession[] {
  if (!Array.isArray(raw)) return []
  const out: SavedSession[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    if (typeof x !== 'object' || x === null) continue
    const r = x as Record<string, unknown>
    if (typeof r.id !== 'string' || !SAFE_ID.test(r.id) || seen.has(r.id)) continue
    if (typeof r.agent !== 'string' || !AGENTS.includes(r.agent as AgentId)) continue
    if (typeof r.workspaceId !== 'string' || typeof r.cwd !== 'string' || r.cwd === '') continue
    const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0
    const s: SavedSession = { id: r.id, agent: r.agent as AgentId, workspaceId: r.workspaceId, cwd: r.cwd, createdAt }
    if (Array.isArray(r.args)) {
      const args = r.args.filter((a): a is string => typeof a === 'string' && a.trim() !== '')
      if (args.length) s.args = args
    }
    if (typeof r.resumeId === 'string' && r.resumeId !== '') s.resumeId = r.resumeId
    seen.add(s.id)
    out.push(s)
  }
  return out
}

/**
 * Lo que se pinta antes del shell en una sesión revivida: la foto guardada, atributos limpios y una
 * línea tenue que separa lo de antes de lo nuevo. Exportada para tests.
 */
export function restorePreamble(screen: string, at: Date = new Date()): string {
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  // La foto deja el cursor donde estaba (a veces sobre una línea ya escrita): se baja al final antes del separador.
  const body = screen.replace(/\s+$/, '')
  const sep = `\x1b[2m── sesión restaurada ${hh}:${mm} ──\x1b[0m`
  return body ? `${body}\x1b[0m\r\n\r\n${sep}\r\n` : `${sep}\r\n`
}
