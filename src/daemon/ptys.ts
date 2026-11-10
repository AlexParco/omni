import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import { HISTORY_BYTES, type DaemonCreateInput } from '@shared/daemon'
import type { SessionInfo } from '@shared/types'
import { RingBuffer, ringToText } from './ring'
import { ScreenMirror } from './screen'

interface Live {
  info: SessionInfo
  proc: pty.IPty
  /** Cómo se lanzó el proceso (para relanzarlo igual al reconectar). */
  spawn: { file: string; args: string[]; cwd: string; env: Record<string, string>; reconnect: boolean }
  cols: number
  rows: number
  /** `kill` pedido: la salida que sigue es definitiva, no se reconecta. */
  killed: boolean
  /** Reconexiones seguidas que no duraron (se reinicia cuando un proceso aguanta `stableMs`). */
  attempts: number
  /** Cuándo arrancó el proceso actual (para saber si la reconexión aguantó). */
  startedAt: number
  retry: NodeJS.Timeout | null
  history: RingBuffer
  /** Estado de la pantalla para `history`; si falla, se cae al ring de bytes crudos. */
  screen: ScreenMirror | null
  /**
   * Comando del agente que todavía no se escribió (espera el primer prompt). Vive en la sesión y no
   * en el proceso: si el primer `ssh` se cae antes de escribirlo, lo escribe el relanzado.
   */
  pending: { input: string; settleMs: number; maxWaitMs: number } | null
  /** Espera del prompt en curso (se cancela si el proceso muere antes). */
  pendingWait: { cancel: () => void } | null
}

export type DataListener = (id: string, data: string) => void
/**
 * `signal` > 0 si el proceso murió por una señal (apagado del sistema, `kill`); 0 si salió solo.
 * `lost`: terminal remota con el ssh caído (sin dtach, o con dtach tras agotar las reconexiones); el
 * registro la guarda como huérfana para revivirla cuando el host vuelva (§3.26). `screen`: con `lost`,
 * la última foto de la pantalla (la periódica puede ser de hasta unos segundos antes del corte).
 */
export type ExitListener = (id: string, code: number, signal: number, lost?: boolean, screen?: string | null) => void

/** Línea que se escribe en el shell: el comando del agente más sus flags, si los hay. Exportada para tests. */
export function agentCommand(command: string, args?: string[]): string {
  const extra = (args ?? []).map((a) => a.trim()).filter((a) => a !== '')
  return extra.length ? `${command} ${extra.join(' ')}` : command
}

/** Esperas entre reconexiones de una terminal remota (unos 10 minutos en total, luego se da por perdida). */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 5000, 10_000, 10_000, 30_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]

/**
 * Un proceso remoto que vivió al menos esto antes de caerse cuenta como reconexión lograda y el
 * backoff vuelve a empezar. No sirve "llegó salida": el error de `ssh` también sale por el PTY.
 */
export const RECONNECT_STABLE_MS = 30_000

/** Tiempos de la reconexión; inyectables en tests. */
export interface ReconnectTiming {
  backoffMs?: readonly number[]
  stableMs?: number
}

/** Variables que no deben heredar los shells: son del lanzador (Electron como Node) y romperían lo que corra dentro. */
const STRIPPED_ENV = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']

/**
 * Marcadores de una sesión de Claude Code (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`…). Si el daemon
 * o main se lanzaron desde una, cada agente se creería subproceso y no guardaría su transcript. main
 * ya los quita al lanzar el daemon (`daemonEnv`); aquí se quitan otra vez por si el daemon vino de otro lado.
 */
const CLAUDE_MARKER = /^CLAUDE_CODE_|^CLAUDECODE$/

/** Entorno de un shell nuevo: el del proceso sin lo del lanzador ni marcadores de Claude Code. Exportada para tests. */
export function shellEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) if (v !== undefined && !STRIPPED_ENV.includes(k) && !CLAUDE_MARKER.test(k)) env[k] = v
  return env
}

/**
 * Dueño real de los PTY, sin Electron: lo usa el daemon (`src/daemon/index.ts`) y, con
 * `OMNI_DAEMON=0`, main en proceso (`PtyManager`). Guarda por sesión los últimos
 * `HISTORY_BYTES` de salida para repintar la xterm al reconectar.
 */
export class PtyHost {
  private live = new Map<string, Live>()
  private dataListeners = new Set<DataListener>()
  private exitListeners = new Set<ExitListener>()

  private readonly backoffMs: readonly number[]
  private readonly stableMs: number

  constructor(
    private readonly historyBytes = HISTORY_BYTES,
    timing: ReconnectTiming = {}
  ) {
    this.backoffMs = timing.backoffMs ?? RECONNECT_BACKOFF_MS
    this.stableMs = timing.stableMs ?? RECONNECT_STABLE_MS
  }

  /** `preamble`: texto que se pinta antes de la salida del shell (la pantalla guardada de una sesión revivida). */
  create(input: DaemonCreateInput, preamble?: string): SessionInfo {
    // Revivir o enganchar a un dtach remoto con un id que ya vive sería la misma sesión dos veces
    // (dos ssh al mismo dtach, el agente relanzado): se rechaza en vez de inventar otro id.
    if (input.id && this.live.has(input.id) && (input.restored || input.spawn)) throw new Error(`la sesión ${input.id} ya existe`)
    const id = input.id && !this.live.has(input.id) ? input.id : randomUUID()
    const env = shellEnv(process.env)
    env.TERM_PROGRAM = 'omni'
    env.OMNI_SESSION = '1'
    const shell = process.env.SHELL || '/bin/zsh'
    // Local: el shell de login en el cwd. Remoto (§3.26): `ssh -tt … dtach` en una carpeta local cualquiera (el cwd es del host).
    const spawn = input.spawn
      ? { file: input.spawn.file, args: input.spawn.args, cwd: process.env.HOME || '/', env, reconnect: input.spawn.reconnect }
      : { file: shell, args: ['-l'], cwd: input.cwd, env, reconnect: false }
    const proc = pty.spawn(spawn.file, spawn.args, { name: 'xterm-256color', cols: 120, rows: 32, cwd: spawn.cwd, env: spawn.env })

    const info: SessionInfo = { id, agent: input.agent, workspaceId: input.workspaceId, cwd: input.cwd, createdAt: Date.now() }
    const flags = (input.args ?? []).map((a) => a.trim()).filter((a) => a !== '')
    if (flags.length) info.args = flags
    if (input.resumeId) info.resumeId = input.resumeId
    if (input.restored) info.restored = true
    if (input.spawn) info.remote = true
    // Por SSH el primer prompt tarda lo que tarde la conexión: se le da más margen antes de escribir igual.
    const pending = input.command ? { input: `${agentCommand(input.command, input.args)}\r`, settleMs: 120, maxWaitMs: input.spawn ? 10_000 : 2000 } : null
    const live: Live = { info, proc, spawn, cols: 120, rows: 32, killed: false, attempts: 0, startedAt: Date.now(), retry: null, history: new RingBuffer(this.historyBytes), screen: newMirror(120, 32), pending, pendingWait: null }
    this.live.set(id, live)
    // Pantalla de antes del reinicio (§3.10b): va primero en el historial para que la xterm la pinte arriba.
    if (preamble) {
      live.history.write(Buffer.from(preamble, 'utf8'))
      live.screen?.write(preamble)
    }

    this.wire(live, proc)
    this.armPending(live, proc)
    return info
  }

  /** Escribe en el historial y en la xterm como si viniera del proceso (avisos de reconexión). */
  private emit(live: Live, data: string): void {
    live.history.write(Buffer.from(data, 'utf8'))
    live.screen?.write(data)
    this.dataListeners.forEach((l) => l(live.info.id, data))
  }

  /** Escribe el comando pendiente en `proc` tras su primer prompt, si `proc` sigue siendo el de la sesión. */
  private armPending(live: Live, proc: pty.IPty): void {
    const pending = live.pending
    if (!pending) return
    live.pendingWait = writeAfterPrompt(proc, pending.settleMs, pending.maxWaitMs, () => {
      live.pendingWait = null
      if (live.proc !== proc || live.pending !== pending) return
      live.pending = null
      proc.write(pending.input)
    })
  }

  private wire(live: Live, proc: pty.IPty): void {
    const id = live.info.id
    proc.onData((data) => {
      if (live.proc !== proc) return
      this.emit(live, data)
    })
    proc.onExit(({ exitCode, signal }) => {
      if (live.proc !== proc) return
      // Murió antes de su prompt: el comando sigue pendiente para el relanzado.
      live.pendingWait?.cancel()
      live.pendingWait = null
      // `ssh` sale con 255 cuando se cae la conexión (no el shell remoto): con dtach la sesión sigue
      // viva en el host y se vuelve a enganchar, con espera creciente (§3.26).
      if (Date.now() - live.startedAt >= this.stableMs) live.attempts = 0
      if (live.spawn.reconnect && !live.killed && exitCode === 255 && live.attempts < this.backoffMs.length) {
        const wait = this.backoffMs[live.attempts]
        live.attempts++
        this.emit(live, `\r\n\x1b[2m── conexión perdida, reconectando en ${Math.round(wait / 1000)} s ──\x1b[0m\r\n`)
        live.retry = setTimeout(() => this.respawn(live), wait)
        return
      }
      // Remota con el ssh caído (255) y sin que nadie la matara: queda para revivir al volver la conexión.
      // Con dtach el agente sigue vivo en el host y se engancha; sin dtach murió con el ssh y se relanza
      // retomando su conversación (§3.26). Antes solo contaba con dtach, y sin él la sesión se perdía.
      const lost = live.info.remote === true && !live.killed && exitCode === 255
      const screen = lost ? this.snapshot(id) : null
      live.screen?.dispose()
      this.live.delete(id)
      this.exitListeners.forEach((l) => l(id, exitCode, signal ?? 0, lost, screen))
    })
  }

  private respawn(live: Live): void {
    live.retry = null
    if (live.killed || this.live.get(live.info.id) !== live) return
    try {
      const proc = pty.spawn(live.spawn.file, live.spawn.args, { name: 'xterm-256color', cols: live.cols, rows: live.rows, cwd: live.spawn.cwd, env: live.spawn.env })
      live.proc = proc
      live.startedAt = Date.now()
      this.wire(live, proc)
      this.armPending(live, proc)
    } catch {
      // El binario no arrancó (ssh borrado, sin PTYs): cuenta como intento; agotados, la sesión termina.
      if (live.attempts >= this.backoffMs.length) {
        live.screen?.dispose()
        this.live.delete(live.info.id)
        this.exitListeners.forEach((l) => l(live.info.id, 255, 0, true))
        return
      }
      live.retry = setTimeout(() => this.respawn(live), this.backoffMs[live.attempts])
      live.attempts++
    }
  }

  /**
   * Foto de la pantalla para revivir la sesión tras un reinicio: scrollback reciente del buffer
   * normal, sin la pantalla alterna ni los modos (una TUI a medio pintar no sirve como recuerdo).
   * `null` si la sesión no existe o no tiene espejo.
   */
  snapshot(id: string): string | null {
    const screen = this.live.get(id)?.screen
    if (!screen) return null
    try {
      return screen.snapshot()
    } catch {
      return null
    }
  }

  list(): SessionInfo[] {
    return [...this.live.values()].map((l) => l.info)
  }

  has(id: string): boolean {
    return this.live.has(id)
  }

  write(id: string, data: string): void {
    this.live.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return
    const live = this.live.get(id)
    if (!live) return
    live.cols = cols
    live.rows = rows
    try {
      live.proc.resize(cols, rows)
    } catch {
      // Proceso reconectándose: el tamaño se aplica al relanzar.
    }
    live.screen?.resize(cols, rows)
  }

  kill(id: string): void {
    const live = this.live.get(id)
    if (!live) return
    live.killed = true
    live.pending = null
    live.pendingWait?.cancel()
    live.pendingWait = null
    if (live.retry) {
      // Esperando para reconectar: no hay proceso que matar, la sesión termina aquí.
      clearTimeout(live.retry)
      live.retry = null
      live.screen?.dispose()
      this.live.delete(id)
      this.exitListeners.forEach((l) => l(id, 255, 0))
      return
    }
    live.proc.kill()
  }

  killAll(): void {
    this.live.forEach((l) => this.kill(l.info.id))
  }

  /**
   * Proceso en primer plano de cada sesión (p. ej. `zsh` si el agente ya salió y queda el
   * shell). Sin entrada si node-pty no puede leerlo.
   */
  foreground(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [id, l] of this.live) {
      try {
        const name = l.proc.process
        if (name) out[id] = name
      } catch {
        // PTY cerrándose: se omite.
      }
    }
    return out
  }

  /** Sesiones locales vivas de `agent` con el pid de su shell: las remotas corren en otra máquina y no se siguen. */
  localPidsOf(agent: string): Array<{ id: string; pid: number; resumeId?: string }> {
    const out: Array<{ id: string; pid: number; resumeId?: string }> = []
    for (const [id, l] of this.live) {
      if (l.info.agent !== agent || l.info.remote || l.proc.pid <= 0) continue
      out.push({ id, pid: l.proc.pid, resumeId: l.info.resumeId })
    }
    return out
  }

  /** Cambia la conversación del agente de una sesión viva (la que se retoma al revivir); `false` si no existe. */
  setResumeId(id: string, resumeId: string): boolean {
    const l = this.live.get(id)
    if (!l) return false
    l.info.resumeId = resumeId
    return true
  }

  /** Pid del shell de cada sesión viva (`{ [sessionId]: pid }`): el widget de puertos (§3.24) sube por el árbol de procesos hasta uno de ellos. */
  pids(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [id, l] of this.live) if (l.proc.pid > 0) out[id] = l.proc.pid
    return out
  }

  /**
   * Para repintar la xterm al reconectar: el estado serializado de la pantalla (espejo headless) o,
   * si no hay espejo, la salida reciente cruda. Vacío si la sesión no existe.
   */
  history(id: string): string {
    const live = this.live.get(id)
    if (!live) return ''
    if (live.screen) {
      try {
        return live.screen.serialize()
      } catch {
        // Espejo roto: se usa el ring.
      }
    }
    return ringToText(live.history)
  }

  onData(l: DataListener): () => void {
    this.dataListeners.add(l)
    return () => this.dataListeners.delete(l)
  }

  onExit(l: ExitListener): () => void {
    this.exitListeners.add(l)
    return () => this.exitListeners.delete(l)
  }
}

/** Espejo headless de una sesión; `null` si no se pudo crear (la sesión sigue con el ring). */
function newMirror(cols: number, rows: number): ScreenMirror | null {
  try {
    return new ScreenMirror(cols, rows)
  } catch {
    return null
  }
}

/**
 * Llama a `write` cuando el shell terminó de pintar su primer prompt: se espera a que la salida
 * inicial se calme (debounce) con un tope por si el shell no imprime nada. Escribir antes hace que
 * zsh eche el comando crudo encima del prompt. `cancel` la descarta (el proceso murió antes).
 */
function writeAfterPrompt(proc: pty.IPty, settleMs: number, maxWaitMs: number, write: () => void): { cancel: () => void } {
  let done = false
  let settle: NodeJS.Timeout | undefined
  const stop = (): void => {
    done = true
    clearTimeout(settle)
    clearTimeout(cap)
    sub.dispose()
  }
  const fire = (): void => {
    if (done) return
    stop()
    write()
  }
  const sub = proc.onData(() => {
    clearTimeout(settle)
    settle = setTimeout(fire, settleMs)
  })
  const cap = setTimeout(fire, maxWaitMs)
  return { cancel: () => (done ? undefined : stop()) }
}
