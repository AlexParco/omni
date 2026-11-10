import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { ptyPayload } from '@shared/pty-text'
import type { AgentDef, ControlCommand, ControlCommandType, ControlResult, Project, SessionInfo, SessionLiveStatus, Workspace } from '@shared/types'
import { decodeLine, encodeLine, LineSplitter } from '../../daemon/protocol'
import { CONFIG_DIR } from '../paths'

/** Socket de control: `~/.config/omni/app.sock` (ARCHITECTURE §3.21). */
export const CONTROL_SOCK = join(CONFIG_DIR, 'app.sock')

/** Cuánto se espera al renderer por un comando reenviado; `capture` carga una página y tarda más. */
export const FORWARD_TIMEOUT_MS = 30_000
export const CAPTURE_TIMEOUT_MS = 60_000

/** Cada cuánto se comprueba que el archivo del socket sigue ahí (como el daemon). */
const WATCH_MS = 5_000

/** Una línea sin `\n` más larga que esto es basura o un ataque: se corta la conexión. */
export const MAX_LINE_BYTES = 1024 * 1024

/** Pedidos en vuelo por conexión; los demás se rechazan en el acto. */
export const MAX_PENDING_PER_SOCKET = 8

const TYPES: readonly ControlCommandType[] = ['list', 'send', 'open', 'browser', 'capture', 'diff', 'focus', 'show', 'todo', 'notify']

/** Prefijo de las operaciones del navegador manejado por un agente (MCP `omni-browser`, §3.23): las resuelve main. */
export const PAGE_PREFIX = 'page.'

/** Lo que main necesita para resolver `list` y `send` y para reenviar el resto; lo cablea `main/ipc.ts`. */
export interface ControlBridge {
  /** Sesiones de todos los dueños (PTY, navegadores, documentos). */
  sessions(): Promise<SessionInfo[]>
  /** Escribe en la PTY; rechaza si la sesión no es una terminal o el daemon no responde. */
  write(sessionId: string, data: string): Promise<void>
  /** Un `send` salió bien: el renderer pinta el aviso en la franja (`control:sent`). */
  sent(sessionId: string, from: string): void
  workspace(id: string): Workspace | undefined
  project(id: string): Project | undefined
  agents(): AgentDef[]
  /** Manda el comando al renderer (`app:command`); `false` si no hay ventana que lo reciba. */
  emit(command: ControlCommand): boolean
  /**
   * `page.<op>`: valida y ejecuta una operación del navegador (MCP `omni-browser`). `null` si el op no
   * existe. Devuelve el resultado o lanza con mensaje humano.
   */
  page(op: string, args: Args, from: string): { run: () => Promise<unknown> } | { error: string } | null
}

export interface ControlServerOptions {
  sockPath?: string
  timeoutMs?: number
  captureTimeoutMs?: number
}

/** Sesión tal como la ve quien llama por el socket (resultado de `list`). */
export interface SessionEntry {
  id: string
  agent: string
  agentName: string
  badge: string
  workspaceId: string
  workspace: string
  project: string
  path: string
  createdAt: number
  /** Trabajando, pregunta o listo, según el renderer; falta si la ventana no contestó a tiempo. */
  status?: SessionLiveStatus['status']
  /** Título vivo de la sesión (tema de la conversación); falta si no hay. */
  title?: string
}

/** Cuánto espera `list` el estado del renderer: sin ventana (o colgada) responde sin estado. */
const STATUS_TIMEOUT_MS = 1500

type Args = Record<string, unknown>

function str(args: Args, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function isWebUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** `example.com/x` → `https://example.com/x`; lo que ya tiene esquema se deja. */
function normalizeUrl(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
}

export type Validated = { ok: true; args: Args } | { ok: false; error: string }

/**
 * Forma de los argumentos por tipo, antes de resolver o reenviar: nada llega al renderer sin lo
 * mínimo (una `url` http(s), un `path`, un `text`…). Pura, exportada para tests.
 */
export function validateCommand(type: ControlCommandType, args: Args): Validated {
  switch (type) {
    case 'list':
      return { ok: true, args: {} }
    case 'statuses':
      // Pedido interno de main al renderer para `list`: no entra por el socket (no está en `TYPES`).
      return { ok: false, error: 'statuses: pedido interno' }
    case 'send': {
      const text = typeof args.text === 'string' ? args.text : undefined
      if (text === undefined || text === '') return { ok: false, error: 'send: falta el texto (text)' }
      const sessionId = str(args, 'sessionId')
      const title = str(args, 'title')
      if (!sessionId && !title) return { ok: false, error: 'send: falta la sesión (sessionId o title)' }
      return { ok: true, args: { text, sessionId, title, submit: args.submit === true } }
    }
    case 'open': {
      const path = str(args, 'path')
      if (!path) return { ok: false, error: 'open: falta la ruta (path)' }
      const kind = args.kind === 'file' || args.kind === 'dir' ? args.kind : undefined
      return { ok: true, args: kind ? { path, kind } : { path } }
    }
    case 'browser':
    case 'capture': {
      const raw = str(args, 'url')
      if (!raw) return { ok: false, error: `${type}: falta la dirección (url)` }
      const url = normalizeUrl(raw.trim())
      if (!isWebUrl(url)) return { ok: false, error: `${type}: la dirección no es http(s): ${raw}` }
      if (type === 'browser') return { ok: true, args: { url, workspaceId: str(args, 'workspaceId') } }
      return { ok: true, args: { url, sessionId: str(args, 'sessionId') } }
    }
    case 'diff': {
      const workspaceId = str(args, 'workspaceId')
      if (!workspaceId) return { ok: false, error: 'diff: falta el workspace (workspaceId)' }
      return { ok: true, args: { workspaceId } }
    }
    case 'focus':
    case 'show': {
      const sessionId = str(args, 'sessionId')
      if (!sessionId) return { ok: false, error: `${type}: falta la sesión (sessionId)` }
      return { ok: true, args: { sessionId } }
    }
    case 'todo': {
      const text = str(args, 'text')
      if (!text) return { ok: false, error: 'todo: falta el texto (text)' }
      return { ok: true, args: { text: text.trim() } }
    }
    case 'notify': {
      const title = str(args, 'title')
      if (!title) return { ok: false, error: 'notify: falta el título (title)' }
      return { ok: true, args: { title: title.trim(), body: typeof args.body === 'string' ? args.body : '' } }
    }
  }
}

/** `cli` o `mcp:<agente>`; cualquier otra cosa cuenta como `cli`. */
export function sanitizeFrom(raw: unknown): string {
  if (typeof raw !== 'string') return 'cli'
  const clean = raw.trim()
  return /^(cli|mcp:[\w.-]{1,40})$/.test(clean) ? clean : 'cli'
}

export type Found = { ok: true; entry: SessionEntry } | { ok: false; error: string }

/**
 * Sesión destino de `send`: por id exacto o prefijo único (≥ 4 chars), o por "título": nombre,
 * badge o id del agente, nombre del workspace o del proyecto, por coincidencia exacta sin distinguir
 * mayúsculas (sin prefijos: "co" no debe caer en Codex por casualidad). Ambigüedad → error con los
 * ids candidatos. Pura, exportada para tests.
 */
export function findSession(entries: SessionEntry[], query: { sessionId?: string; title?: string }): Found {
  const q = (query.sessionId ?? query.title ?? '').trim()
  if (q === '') return { ok: false, error: 'send: falta la sesión (sessionId o title)' }
  const exactId = entries.find((e) => e.id === q)
  if (exactId) return { ok: true, entry: exactId }
  const byIdPrefix = q.length >= 4 ? entries.filter((e) => e.id.startsWith(q)) : []
  if (byIdPrefix.length === 1) return { ok: true, entry: byIdPrefix[0] as SessionEntry }
  if (byIdPrefix.length > 1) return { ok: false, error: `varias sesiones empiezan por ${q}: ${byIdPrefix.map((e) => e.id).join(', ')}` }
  const lower = q.toLowerCase()
  const names = (e: SessionEntry): string[] => [e.agentName, e.badge, e.agent, e.workspace, e.project].map((n) => n.toLowerCase())
  const exact = entries.filter((e) => names(e).includes(lower))
  if (exact.length === 1) return { ok: true, entry: exact[0] as SessionEntry }
  if (exact.length > 1) return { ok: false, error: `varias sesiones coinciden con "${q}": ${exact.map((e) => `${e.id.slice(0, 8)} (${e.agentName} · ${e.project}/${e.workspace})`).join(', ')}` }
  return { ok: false, error: `no hay sesión que coincida con "${q}"` }
}

interface Pending {
  type: ControlCommandType
  resolve: (result: ControlResult) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Servidor del socket de control (ARCHITECTURE §3.21): NDJSON `{ id, type, from?, ...args }` →
 * `{ id, ok, result | error }`. Resuelve `list` y `send` con lo que main sabe; el resto lo reenvía al
 * renderer y espera `app:commandResult`. Nunca ejecuta shell. Permisos 600, socket huérfano fuera al
 * arrancar, re-escucha si el archivo desaparece y lo borra al cerrar. No conoce IPC: `attach` recibe
 * el puente desde `main/ipc.ts` y `main/index.ts` maneja arranque y cierre.
 */
export class ControlServer {
  private readonly sock: string
  private readonly timeoutMs: number
  private readonly captureTimeoutMs: number
  private bridge: ControlBridge | null = null
  private server: Server | null = null
  /** Todos los servidores abiertos sobre la ruta (el vivo y los que quedaron tras un relisten). */
  private readonly servers = new Set<Server>()
  /** Inodo del archivo que abrimos: solo se borra si sigue siendo ese (no el de otro omni). */
  private ino: number | null = null
  private readonly clients = new Set<Socket>()
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private watcher: ReturnType<typeof setInterval> | null = null
  private stopping = false
  private relistening = false
  /** El archivo del socket es nuestro (lo abrimos nosotros): solo entonces se borra al cerrar. */
  private owned = false

  constructor(opts: ControlServerOptions = {}) {
    this.sock = opts.sockPath ?? CONTROL_SOCK
    this.timeoutMs = opts.timeoutMs ?? FORWARD_TIMEOUT_MS
    this.captureTimeoutMs = opts.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS
  }

  get path(): string {
    return this.sock
  }

  attach(bridge: ControlBridge): void {
    this.bridge = bridge
  }

  /** Abre el socket. Si otro omni ya escucha ahí, se queda sin socket y lo dice; un socket huérfano se borra. */
  async start(): Promise<void> {
    this.stopping = false
    mkdirSync(dirname(this.sock), { recursive: true })
    if (existsSync(this.sock)) {
      if (await probe(this.sock)) {
        console.warn(`[omni] ya hay un omni escuchando en ${this.sock}: este no abre el socket de control`)
        return
      }
      unlinkSync(this.sock)
    }
    this.server = await this.listen()
    this.owned = true
    this.watcher = setInterval(() => this.relistenIfGone(), WATCH_MS)
    this.watcher.unref()
  }

  /**
   * Cierra conexiones y servidor y borra el archivo del socket, pero solo si el archivo sigue siendo
   * el nuestro (mismo inodo): `server.close()` hace que libuv borre la ruta aunque ya sea de otro
   * omni, así que con un inodo ajeno el handle se suelta sin cerrarlo. Lo pendiente se responde con error.
   */
  async close(): Promise<void> {
    this.stopping = true
    if (this.watcher) clearInterval(this.watcher)
    this.watcher = null
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: 'omni se está cerrando' })
    }
    this.pending.clear()
    for (const c of this.clients) c.destroy()
    this.clients.clear()
    const servers = [...this.servers]
    this.servers.clear()
    this.server = null
    if (!this.owned) return
    this.owned = false
    const mine = this.ino !== null && inodeOf(this.sock) === this.ino
    this.ino = null
    if (!mine) {
      for (const s of servers) s.unref()
      return
    }
    for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()))
    try {
      if (existsSync(this.sock)) unlinkSync(this.sock)
    } catch {
      // ya no estaba: da igual
    }
  }

  /** `app:commandResult` del renderer. Un id desconocido (tarde o repetido) se ignora. */
  resolve(id: number, result: ControlResult): void {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    p.resolve(result)
  }

  /** Atiende un pedido ya parseado. Exportado para tests: el socket solo añade framing. */
  async handle(request: Record<string, unknown>): Promise<ControlResult> {
    const type = request.type
    if (typeof type === 'string' && type.startsWith(PAGE_PREFIX)) return this.page(type.slice(PAGE_PREFIX.length), request)
    if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type)) return { ok: false, error: `comando desconocido: ${String(type)}` }
    const { id: _id, type: _type, from: rawFrom, ...rest } = request
    const from = sanitizeFrom(rawFrom)
    const validated = validateCommand(type as ControlCommandType, rest)
    if (!validated.ok) return validated
    const bridge = this.bridge
    if (!bridge) return { ok: false, error: 'omni todavía no está listo' }
    try {
      switch (type) {
        case 'list':
          return { ok: true, result: await this.listWithStatus(bridge) }
        case 'send':
          return await this.send(bridge, from, validated.args)
        case 'open':
          return await this.forward(bridge, 'open', from, withKind(validated.args))
        default:
          return await this.forward(bridge, type as ControlCommandType, from, validated.args)
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** `page.<op>`: lo valida y lo corre el agente del navegador que cablea `main/ipc.ts`. */
  private async page(op: string, request: Record<string, unknown>): Promise<ControlResult> {
    const { id: _id, type: _type, from: rawFrom, ...rest } = request
    const bridge = this.bridge
    if (!bridge) return { ok: false, error: 'omni todavía no está listo' }
    const prepared = bridge.page(op, rest, sanitizeFrom(rawFrom))
    if (prepared === null) return { ok: false, error: `comando desconocido: page.${op}` }
    if ('error' in prepared) return { ok: false, error: prepared.error }
    try {
      return { ok: true, result: await prepared.run() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * `list` con estado: main no sabe si un agente trabaja o pregunta (lo infiere el renderer de la salida),
   * así que se le pregunta con `statuses`. Si no contesta en `STATUS_TIMEOUT_MS`, la lista sale sin estado.
   */
  private async listWithStatus(bridge: ControlBridge): Promise<SessionEntry[]> {
    const [entries, live] = await Promise.all([
      this.entries(bridge),
      Promise.race([this.forward(bridge, 'statuses', 'omni', {}), new Promise<null>((done) => setTimeout(() => done(null), STATUS_TIMEOUT_MS))])
    ])
    const map = live?.ok && typeof live.result === 'object' && live.result !== null ? (live.result as Record<string, SessionLiveStatus>) : {}
    return entries.map((e) => {
      const s = map[e.id]
      if (!s) return e
      return s.title ? { ...e, status: s.status, title: s.title } : { ...e, status: s.status }
    })
  }

  private async entries(bridge: ControlBridge): Promise<SessionEntry[]> {
    const agents = bridge.agents()
    return (await bridge.sessions()).map((s) => {
      const agent = agents.find((a) => a.id === s.agent)
      const workspace = bridge.workspace(s.workspaceId)
      const project = workspace ? bridge.project(workspace.projectId) : undefined
      return {
        id: s.id,
        agent: s.agent,
        agentName: agent?.name ?? s.agent,
        badge: agent?.badge ?? s.agent,
        workspaceId: s.workspaceId,
        workspace: workspace?.name ?? '',
        project: project?.name ?? '',
        path: s.cwd,
        createdAt: s.createdAt
      }
    })
  }

  /**
   * Escribe en una terminal. Un navegador o un documento (editor, preview) no es una PTY. Un shell
   * pelado (sin `command`) solo desde la CLI: el bus MCP escribe a agentes, nunca a un shell del usuario.
   */
  private async send(bridge: ControlBridge, from: string, args: Args): Promise<ControlResult> {
    const found = findSession(await this.entries(bridge), { sessionId: str(args, 'sessionId'), title: str(args, 'title') })
    if (!found.ok) return found
    const { entry } = found
    const short = entry.id.slice(0, 8)
    const agent = bridge.agents().find((a) => a.id === entry.agent)
    if (entry.agent === 'browser') return { ok: false, error: `la sesión ${short} es un navegador: no recibe texto` }
    if (entry.agent !== 'shell' && (!agent || agent.command === null)) return { ok: false, error: `la sesión ${short} (${entry.agentName}) no es una terminal` }
    if (from.startsWith('mcp:') && (!agent || agent.command === null)) return { ok: false, error: 'el MCP no escribe en shells ni documentos' }
    const text = typeof args.text === 'string' ? args.text : ''
    await bridge.write(entry.id, ptyPayload(text, args.submit === true))
    bridge.sent(entry.id, from)
    return { ok: true, result: { sessionId: entry.id, chars: text.length, submitted: args.submit === true } }
  }

  private forward(bridge: ControlBridge, type: ControlCommandType, from: string, args: Args): Promise<ControlResult> {
    const id = this.nextId++
    const command: ControlCommand = { id, type, from, args }
    return new Promise((resolve) => {
      const timeoutMs = type === 'capture' ? this.captureTimeoutMs : this.timeoutMs
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: `${type}: omni no respondió en ${Math.round(timeoutMs / 1000)} s` })
      }, timeoutMs)
      this.pending.set(id, { type, resolve, timer })
      if (!bridge.emit(command)) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, error: 'omni no tiene ventana' })
      }
    })
  }

  /** Escucha con umask 077 (el archivo nace 600, sin ventana entre `bind` y `chmod`) y anota el inodo. */
  private listen(): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket))
      const prevUmask = process.umask(0o077)
      let restored = false
      const restore = (): void => {
        if (restored) return
        restored = true
        process.umask(prevUmask)
      }
      server.once('error', (err) => {
        restore()
        reject(err)
      })
      server.listen(this.sock, () => {
        restore()
        server.removeListener('error', reject)
        server.on('error', (err) => console.warn('[omni] socket de control:', err.message))
        try {
          chmodSync(this.sock, 0o600)
        } catch (err) {
          console.warn('[omni] no se pudo poner 600 a app.sock:', err)
        }
        this.ino = inodeOf(this.sock)
        this.servers.add(server)
        resolve(server)
      })
    })
  }

  /** El archivo desapareció (limpieza a mano): se escucha de nuevo; el servidor viejo sigue sirviendo lo que ya tiene. */
  private relistenIfGone(): void {
    if (this.stopping || this.relistening || !this.server || existsSync(this.sock)) return
    this.relistening = true
    this.listen()
      .then((server) => {
        this.server = server
      })
      .catch((err: unknown) => console.warn('[omni] no se pudo volver a abrir app.sock:', err))
      .finally(() => {
        this.relistening = false
      })
  }

  private onConnection(socket: Socket): void {
    this.clients.add(socket)
    const splitter = new LineSplitter()
    let inFlight = 0
    socket.setNoDelay(true)
    socket.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) {
        const request = decodeLine(line)
        if (!request) {
          this.reply(socket, { id: null, ok: false, error: 'línea que no es JSON' })
          continue
        }
        const id = typeof request.id === 'number' || typeof request.id === 'string' ? request.id : null
        if (inFlight >= MAX_PENDING_PER_SOCKET) {
          this.reply(socket, { id, ok: false, error: `demasiados pedidos en vuelo (máx. ${MAX_PENDING_PER_SOCKET})` })
          continue
        }
        inFlight++
        this.handle(request)
          .catch((err: unknown): ControlResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
          .then((result) => {
            inFlight--
            this.reply(socket, { id, ...result })
          })
      }
      if (Buffer.byteLength(splitter.pending) > MAX_LINE_BYTES) {
        this.reply(socket, { id: null, ok: false, error: 'línea demasiado larga' })
        socket.destroy()
      }
    })
    socket.on('error', () => undefined)
    socket.on('close', () => this.clients.delete(socket))
  }

  private reply(socket: Socket, message: object): void {
    if (socket.destroyed) return
    socket.write(encodeLine(message))
  }
}

/** Inodo del archivo o `null` si no existe. */
function inodeOf(path: string): number | null {
  try {
    return statSync(path).ino
  } catch {
    return null
  }
}

/** `open`: main mira el disco y le dice al renderer si es archivo o carpeta; lo que no existe no se reenvía. */
function withKind(args: Args): Args {
  const path = typeof args.path === 'string' ? args.path : ''
  let kind: 'file' | 'dir'
  try {
    kind = statSync(path).isDirectory() ? 'dir' : 'file'
  } catch {
    throw new Error(`open: no existe ${path}`)
  }
  return { ...args, kind }
}

/** `true` si alguien acepta conexiones en `sock` (otro omni vivo); `false` si está huérfano. */
function probe(sock: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection(sock)
    const done = (alive: boolean): void => {
      clearTimeout(timer)
      conn.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    conn.once('connect', () => done(true))
    conn.once('error', () => done(false))
  })
}
