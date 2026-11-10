import { spawn } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { DAEMON_PROTOCOL, type DaemonInfo, type DaemonRequest, type SavedSession } from '@shared/daemon'
import type { AgentDef, SessionInfo, Workspace } from '@shared/types'
import { daemonPaths, type DaemonPaths } from '../../daemon/paths'
import { decodeLine, encodeLine, LineSplitter } from '../../daemon/protocol'
import type { CreateOptions, DataListener, ExitListener, SessionBackend, SessionPids } from './session-backend'

export interface DaemonClientOptions {
  /** Sello del build de la app (`BUILD_STAMP`), para compararlo con `DaemonInfo.build`. */
  build: string
  /** Solo en dev: un daemon con otro build se apaga y relanza (se pierden sus sesiones). */
  restartOnBuildMismatch: boolean
  /** Ruta de `out/main/daemon.js`. */
  script: string
  /** Binario con el que se lanza el daemon: Electron corriendo como Node. */
  execPath: string
  paths?: DaemonPaths
  log?: (message: string) => void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

/** Pedido sin `id`: el cliente lo asigna. */
type RequestBody = DaemonRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

/** Cuánto se espera a que el daemon recién lanzado abra el socket. */
const START_TIMEOUT_MS = 3000
const RECONNECT_EVERY_MS = 1000
/** No se relanza el daemon más seguido que esto mientras se reintenta conectar. */
const RESPAWN_EVERY_MS = 3000

/**
 * Cliente de `omni-daemon` con la cara de `SessionBackend`: main habla con el daemon por el
 * socket Unix y reenvía sus eventos. Si el socket cae, reintenta cada segundo (relanzando el
 * daemon si no está) y vuelve a suscribirse; mientras tanto `write`/`resize`/`kill` se pierden
 * en silencio.
 */
export class DaemonClient implements SessionBackend {
  private readonly paths: DaemonPaths
  private readonly log: (message: string) => void
  private socket: Socket | null = null
  private splitter = new LineSplitter()
  private nextId = 1
  private pending = new Map<number, Pending>()
  private dataListeners = new Set<DataListener>()
  private exitListeners = new Set<ExitListener>()
  /** Sesiones que el daemon nos contó: al reconectar, las que ya no estén se dan por salidas. */
  private known = new Set<string>()
  /** `true` tras `shutdown()`: no se reconecta más. */
  private closed = false
  /** Mientras se reinicia por build distinto no se dispara la reconexión automática. */
  private restarting = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private lastSpawnAt = 0
  /** Pid del daemon conectado (de `info`): respaldo de `pids()` con un daemon viejo que no sabe responderlo. */
  private daemonPid: number | null = null
  /**
   * El daemon es de este build y sabe lanzar terminales remotas (`spawn`, §3.26). Uno conservado de
   * otro build lo ignoraría y abriría un shell local creyendo que es el VPS: ahí se niega.
   */
  private sameBuild = true

  constructor(private readonly opts: DaemonClientOptions) {
    this.paths = opts.paths ?? daemonPaths()
    this.log = opts.log ?? ((m) => console.log(`[omni] ${m}`))
  }

  async start(): Promise<void> {
    await this.establish()
    const info = await this.info()
    const protocolMismatch = info.protocol !== DAEMON_PROTOCOL
    const buildMismatch = info.build !== this.opts.build
    if (protocolMismatch || (buildMismatch && this.opts.restartOnBuildMismatch)) {
      const why = protocolMismatch ? `protocolo ${info.protocol} ≠ ${DAEMON_PROTOCOL}` : `build ${info.build} ≠ ${this.opts.build}`
      this.log(`daemon pid=${info.pid} con ${why}: se apaga y relanza (sus sesiones se reviven al volver)`)
      await this.restart()
      await this.refreshBuild()
    } else if (buildMismatch && (await this.list()).length === 0) {
      // Sin sesiones vivas no hay paso en curso que perder: se actualiza sin preguntar (§3.10c).
      this.log(`daemon pid=${info.pid} con build ${info.build} y sin sesiones: se relanza`)
      await this.restart()
      await this.refreshBuild()
    } else if (buildMismatch) {
      this.sameBuild = false
      this.log(`daemon pid=${info.pid} con build ${info.build} (app ${this.opts.build}): se conserva hasta "Actualizar terminales"`)
    } else {
      this.sameBuild = true
      this.log(`conectado al daemon pid=${info.pid} build=${info.build}`)
    }
  }

  /**
   * Vuelve a calcular `sameBuild` con el daemon al que se está conectado ahora: tras una caída el
   * cliente puede terminar en uno que lanzó él (mismo build) o en otro ajeno. Sin respuesta se deja
   * como estaba.
   */
  private async refreshBuild(): Promise<void> {
    try {
      const info = await this.info()
      this.sameBuild = info.build === this.opts.build && info.protocol === DAEMON_PROTOCOL
    } catch {
      // Daemon que no contesta `info`: la próxima reconexión lo vuelve a intentar.
    }
  }

  remoteReady(): boolean {
    return this.sameBuild
  }

  outdated(): boolean {
    return !this.sameBuild
  }

  async upgrade(): Promise<void> {
    if (this.sameBuild) return
    this.log('actualizando el daemon a este build (las sesiones se reviven)')
    await this.restart()
    await this.refreshBuild()
  }

  async create(agent: AgentDef, workspace: Workspace, args?: string[], opts: CreateOptions = {}): Promise<SessionInfo> {
    if (opts.spawn && !this.sameBuild) throw new Error('el daemon de terminales es de una versión anterior y no sabe abrir terminales remotas: dale a "Actualizar terminales" en el pie (reabre tus terminales y los agentes retoman su conversación) y vuelve a intentarlo')
    const command = opts.command === undefined ? agent.command : opts.command
    const result = await this.request({
      type: 'create',
      input: {
        id: opts.id,
        agent: agent.id,
        workspaceId: workspace.id,
        cwd: workspace.cwd ?? workspace.path,
        command,
        args,
        resumeId: opts.resumeId,
        restored: opts.restored,
        restoreScreen: opts.restoreScreen,
        spawn: opts.spawn
      }
    })
    const session = asSessionInfo(result)
    if (!session) throw new Error('el daemon devolvió una sesión inválida')
    this.known.add(session.id)
    return session
  }

  async list(): Promise<SessionInfo[]> {
    const result = await this.request({ type: 'list' })
    const sessions = Array.isArray(result) ? result.map(asSessionInfo).filter((s): s is SessionInfo => s !== null) : []
    sessions.forEach((s) => this.known.add(s.id))
    return sessions
  }

  write(id: string, data: string): Promise<void> {
    return this.request({ type: 'write', sessionId: id, data }).then(() => undefined)
  }

  resize(id: string, cols: number, rows: number): void {
    this.fire({ type: 'resize', sessionId: id, cols, rows })
  }

  kill(id: string): void {
    this.fire({ type: 'kill', sessionId: id })
  }

  async killAll(): Promise<void> {
    for (const s of await this.list()) this.kill(s.id)
  }

  /** Un daemon anterior a este pedido responde error: no guarda registro, no hay nada que revivir. */
  async orphans(): Promise<SavedSession[]> {
    try {
      const result = await this.request({ type: 'orphans' })
      return Array.isArray(result) ? (result as SavedSession[]) : []
    } catch {
      return []
    }
  }

  async dismiss(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    try {
      await this.request({ type: 'dismiss', ids })
    } catch {
      // Daemon viejo o caído: nada que descartar.
    }
  }

  async shutdown(forget = false): Promise<void> {
    this.closed = true
    this.stopReconnecting()
    try {
      await this.request({ type: 'shutdown', forget })
    } catch {
      // Si ya no había daemon, no hay nada que apagar.
    }
    this.socket?.destroy()
    this.socket = null
  }

  async history(id: string): Promise<string> {
    const result = await this.request({ type: 'history', sessionId: id })
    return typeof result === 'string' ? Buffer.from(result, 'base64').toString('utf8') : ''
  }

  async foreground(): Promise<Record<string, string>> {
    try {
      const result = await this.request({ type: 'foreground' })
      if (typeof result !== 'object' || result === null) return {}
      return Object.fromEntries(Object.entries(result).filter((e): e is [string, string] => typeof e[1] === 'string'))
    } catch {
      // Daemon anterior a este pedido (build conservado): sin datos, la UI usa el agente de origen.
      return {}
    }
  }

  async pids(): Promise<SessionPids> {
    try {
      const result = await this.request({ type: 'pids' })
      const parsed = asSessionPids(result)
      if (parsed) {
        this.daemonPid = parsed.root
        return parsed
      }
    } catch {
      // Daemon anterior a este pedido (build conservado): se sabe que un proceso es de omni, no de qué sesión.
    }
    return { root: this.daemonPid, sessions: {} }
  }

  async info(): Promise<DaemonInfo> {
    const result = await this.request({ type: 'info' })
    const info = asDaemonInfo(result)
    if (!info) throw new Error('el daemon devolvió un info inválido')
    this.daemonPid = info.pid
    return info
  }

  onData(l: DataListener): () => void {
    this.dataListeners.add(l)
    return () => this.dataListeners.delete(l)
  }

  onExit(l: ExitListener): () => void {
    this.exitListeners.add(l)
    return () => this.exitListeners.delete(l)
  }

  /* ---------- conexión ---------- */

  /** Conecta al socket; si no hay daemon lo lanza y espera hasta `START_TIMEOUT_MS`. */
  private async establish(): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS
    let spawned = false
    for (;;) {
      try {
        await this.open()
        return
      } catch (err) {
        if (!spawned) {
          this.spawnDaemon()
          spawned = true
        }
        if (Date.now() > deadline) throw new Error(`el daemon no abrió ${this.paths.sock} en ${START_TIMEOUT_MS} ms: ${errorMessage(err)}`)
        await sleep(100)
      }
    }
  }

  /** Abre el socket y se suscribe. Rechaza si no hay nadie escuchando. */
  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.paths.sock)
      socket.setNoDelay(true)
      socket.once('error', reject)
      socket.once('connect', () => {
        socket.removeListener('error', reject)
        this.attach(socket)
        this.request({ type: 'subscribe' }).then(() => resolve(), reject)
      })
    })
  }

  private attach(socket: Socket): void {
    this.socket = socket
    this.splitter = new LineSplitter()
    socket.on('data', (chunk) => {
      for (const line of this.splitter.push(chunk)) this.onLine(line)
    })
    socket.on('error', (err) => this.log(`socket del daemon: ${err.message}`))
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.rejectPending(new Error('conexión con el daemon cerrada'))
      if (this.closed || this.restarting) return
      this.log('se perdió la conexión con el daemon: reintentando cada segundo')
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect()
    }, RECONNECT_EVERY_MS)
  }

  private stopReconnecting(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private async reconnect(): Promise<void> {
    if (this.closed || this.socket) return
    try {
      await this.open()
    } catch {
      if (Date.now() - this.lastSpawnAt > RESPAWN_EVERY_MS) this.spawnDaemon()
      this.scheduleReconnect()
      return
    }
    this.log('reconectado al daemon')
    await this.refreshBuild()
    await this.reconcile()
  }

  /** Tras reconectar: lo que el daemon ya no tiene se da por salido para que el renderer lo refleje. */
  private async reconcile(): Promise<void> {
    const before = [...this.known]
    let alive: Set<string>
    try {
      alive = new Set((await this.list()).map((s) => s.id))
    } catch {
      return
    }
    for (const id of before) {
      if (alive.has(id)) continue
      this.known.delete(id)
      this.exitListeners.forEach((l) => l(id, -1))
    }
  }

  /** Apaga el daemon actual, espera a que suelte el socket y levanta uno nuevo. */
  private async restart(): Promise<void> {
    this.restarting = true
    try {
      const socket = this.socket
      const closed = socket ? new Promise<void>((resolve) => socket.once('close', () => resolve())) : Promise.resolve()
      try {
        await this.request({ type: 'shutdown' })
      } catch {
        // Si murió antes de contestar, igual se relanza.
      }
      socket?.end()
      await Promise.race([closed, sleep(2000)])
      socket?.destroy()
      this.socket = null
      this.known.clear()
      await this.establish()
    } finally {
      this.restarting = false
    }
  }

  private spawnDaemon(): void {
    // `sameBuild` no se toca aquí: el lanzado puede retirarse si otro ya escucha; se recalcula al conectar.
    this.lastSpawnAt = Date.now()
    this.log(`lanzando daemon: ${this.opts.execPath} ${this.opts.script}`)
    const child = spawn(this.opts.execPath, [this.opts.script], {
      detached: true,
      stdio: 'ignore',
      env: { ...daemonEnv(process.env), ELECTRON_RUN_AS_NODE: '1' }
    })
    child.on('error', (err) => this.log(`no se pudo lanzar el daemon: ${err.message}`))
    child.unref()
  }

  /* ---------- mensajes ---------- */

  private request(body: RequestBody): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.destroyed) return Promise.reject(new Error('sin conexión con el daemon'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      socket.write(encodeLine({ id, ...body }), (err) => {
        if (err && this.pending.delete(id)) reject(err)
      })
    })
  }

  /** Pedido sin esperar respuesta: si no hay conexión se pierde en silencio. */
  private fire(body: RequestBody): void {
    this.request(body).catch(() => undefined)
  }

  private rejectPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private onLine(line: string): void {
    const msg = decodeLine(line)
    if (!msg) return
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok === true) p.resolve(msg.result)
      else p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'error del daemon'))
      return
    }
    switch (msg.event) {
      case 'data':
        if (typeof msg.sessionId === 'string' && typeof msg.data === 'string') {
          const text = Buffer.from(msg.data, 'base64').toString('utf8')
          this.dataListeners.forEach((l) => l(msg.sessionId as string, text))
        }
        return
      case 'exit':
        if (typeof msg.sessionId === 'string' && typeof msg.code === 'number') {
          this.known.delete(msg.sessionId)
          // Las muertes del apagado por actualización no son salidas: la sesión vuelve con su mismo id.
          if (this.restarting) return
          this.exitListeners.forEach((l) => l(msg.sessionId as string, msg.code as number))
        }
        return
      case 'created': {
        // Sesión creada por otro cliente (p. ej. un CLI futuro): hoy solo se anota; el renderer la verá en `session:list`.
        const session = asSessionInfo(msg.session)
        if (session) this.known.add(session.id)
        return
      }
      default:
        return
    }
  }
}

/* ---------- guards de lo que llega por el socket ---------- */

function asSessionInfo(x: unknown): SessionInfo | null {
  if (typeof x !== 'object' || x === null) return null
  const r = x as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.agent !== 'string' || typeof r.workspaceId !== 'string' || typeof r.cwd !== 'string') return null
  if (typeof r.createdAt !== 'number') return null
  const info: SessionInfo = { id: r.id, agent: r.agent as SessionInfo['agent'], workspaceId: r.workspaceId, cwd: r.cwd, createdAt: r.createdAt }
  if (Array.isArray(r.args)) info.args = r.args.filter((a): a is string => typeof a === 'string')
  if (typeof r.resumeId === 'string' && r.resumeId !== '') info.resumeId = r.resumeId
  if (r.restored === true) info.restored = true
  if (r.remote === true) info.remote = true
  return info
}

function asDaemonInfo(x: unknown): DaemonInfo | null {
  if (typeof x !== 'object' || x === null) return null
  const r = x as Record<string, unknown>
  if (typeof r.pid !== 'number' || typeof r.protocol !== 'number' || typeof r.build !== 'string' || typeof r.startedAt !== 'number') return null
  return { pid: r.pid, protocol: r.protocol, build: r.build, startedAt: r.startedAt }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Entorno con el que nace el daemon (y por herencia cada PTY). Si omni se lanzó desde dentro de una
 * sesión de Claude Code, su marcador (`CLAUDE_CODE_*`, `CLAUDECODE`) haría que los agentes se crean
 * subprocesos: no guardan transcript y omni no puede leer su costo. Se quita aquí, en main, para no
 * tocar el sello del daemon.
 */
export function daemonEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!/^CLAUDE_CODE_|^CLAUDECODE$/.test(k)) out[k] = v
  return out
}

/** Valida la respuesta de `pids`; `null` si no tiene la forma esperada. */
function asSessionPids(value: unknown): SessionPids | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Record<string, unknown>
  if (typeof r.root !== 'number' || typeof r.sessions !== 'object' || r.sessions === null) return null
  const sessions: Record<string, number> = {}
  for (const [id, pid] of Object.entries(r.sessions)) if (typeof pid === 'number' && pid > 0) sessions[id] = pid
  return { root: r.root, sessions }
}
