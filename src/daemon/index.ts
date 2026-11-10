import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { DAEMON_PROTOCOL, type DaemonCreateInput, type DaemonEvent, type DaemonInfo, type DaemonResponse } from '@shared/daemon'
import type { AgentId } from '@shared/types'
import { claudeSessionUnder, readProcessTable } from './agent-session'
import { BUILD_STAMP } from './build'
import { restorePreamble, SessionManifest } from './manifest'
import { daemonPaths, LOG_MAX_BYTES } from './paths'
import { decodeLine, encodeLine, LineSplitter } from './protocol'
import { PtyHost } from './ptys'

/**
 * `omni-daemon`: proceso Node desacoplado de la app que es dueño de los PTY (ARCHITECTURE §3.10).
 * Main lo lanza con `ELECTRON_RUN_AS_NODE=1` sobre el binario de Electron (mismo ABI para
 * `node-pty`) y habla con él por `~/.config/omni/daemon.sock` en NDJSON (`@shared/daemon`).
 * Cerrar la app no lo toca: sigue vivo sin clientes hasta un `shutdown` o una señal.
 */

const paths = daemonPaths()
const startedAt = Date.now()

interface Client {
  socket: Socket
  splitter: LineSplitter
  /** Recibe `data`/`exit`/`created` de todas las sesiones. */
  subscribed: boolean
}

/* ---------- log mínimo con rotación por truncado ---------- */

let logBytes = 0

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`
  try {
    if (logBytes + line.length > LOG_MAX_BYTES) {
      writeFileSync(paths.log, '')
      logBytes = 0
    }
    appendFileSync(paths.log, line)
    logBytes += line.length
  } catch {
    // Sin log no se cae el daemon.
  }
}

/* ---------- arranque: un solo daemon por socket ---------- */

/** `true` si en `sock` hay un daemon que contesta `info` (socket huérfano si no). */
function isAlive(sock: string, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const splitter = new LineSplitter()
    const conn = createConnection(sock)
    const done = (alive: boolean): void => {
      clearTimeout(timer)
      conn.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    conn.on('connect', () => conn.write(encodeLine({ id: 0, type: 'info' })))
    conn.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) {
        const msg = decodeLine(line)
        if (msg && msg.id === 0 && msg.ok === true) return done(true)
      }
    })
    conn.on('error', () => done(false))
  })
}

/* ---------- servidor ---------- */

const host = new PtyHost()
/** Registro para revivir sesiones tras un reinicio (§3.10b): vivas + huérfanas del daemon anterior. */
const manifest = new SessionManifest(paths.dir)
/** Sesiones con salida nueva desde su última foto. */
const dirty = new Set<string>()
/** Cada cuánto se guarda la foto de las pantallas que cambiaron. */
const SNAPSHOT_EVERY_MS = 5000
const clients = new Set<Client>()
let server: Server | null = null
let stopping = false

function send(client: Client, message: DaemonResponse | DaemonEvent): void {
  if (client.socket.destroyed) return
  client.socket.write(encodeLine(message))
}

function broadcast(event: DaemonEvent, except?: Client): void {
  for (const c of clients) if (c.subscribed && c !== except) send(c, event)
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`campo inválido: ${field}`)
  return value
}

function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`campo inválido: ${field}`)
  return value
}

function parseCreateInput(raw: unknown): DaemonCreateInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('create sin input')
  const r = raw as Record<string, unknown>
  const input: DaemonCreateInput = {
    // La app ya validó el agente contra su catálogo; aquí solo importa que sea un string.
    agent: str(r.agent, 'agent') as AgentId,
    workspaceId: str(r.workspaceId, 'workspaceId'),
    cwd: str(r.cwd, 'cwd'),
    command: r.command === null || r.command === undefined ? null : str(r.command, 'command')
  }
  if (typeof r.id === 'string' && r.id !== '') input.id = r.id
  if (Array.isArray(r.args)) input.args = r.args.filter((a): a is string => typeof a === 'string')
  if (typeof r.resumeId === 'string' && r.resumeId !== '') input.resumeId = r.resumeId
  if (r.restored === true) input.restored = true
  if (r.restoreScreen === true) input.restoreScreen = true
  if (typeof r.spawn === 'object' && r.spawn !== null) {
    const sp = r.spawn as Record<string, unknown>
    if (typeof sp.file === 'string' && sp.file !== '' && Array.isArray(sp.args) && sp.args.every((a) => typeof a === 'string')) {
      input.spawn = { file: sp.file, args: sp.args as string[], reconnect: sp.reconnect === true }
    }
  }
  return input
}

/** Ejecuta un pedido y devuelve su `result`; lanza si el pedido es inválido. */
function dispatch(client: Client, req: Record<string, unknown>): unknown {
  switch (req.type) {
    case 'info': {
      const info: DaemonInfo = { pid: process.pid, protocol: DAEMON_PROTOCOL, build: BUILD_STAMP, startedAt }
      return info
    }
    case 'list':
      return host.list()
    case 'create': {
      const input = parseCreateInput(req.input)
      // Revivir: misma sesión de antes (mismo id y `createdAt` original), con su pantalla si se pidió.
      const orphan = input.restored && input.id ? manifest.getOrphan(input.id) : undefined
      const screen = orphan && input.restoreScreen ? manifest.readScreen(orphan.id) : null
      const session = host.create(input, orphan ? restorePreamble(screen ?? '') : undefined)
      manifest.track(session, orphan?.createdAt ?? session.createdAt)
      log(`create ${session.id} ${session.agent} ${session.cwd}${orphan ? ' (revivida)' : ''}`)
      broadcast({ event: 'created', session }, client)
      return session
    }
    case 'write':
      host.write(str(req.sessionId, 'sessionId'), str(req.data, 'data'))
      return null
    case 'resize':
      host.resize(str(req.sessionId, 'sessionId'), num(req.cols, 'cols'), num(req.rows, 'rows'))
      return null
    case 'kill': {
      const id = str(req.sessionId, 'sessionId')
      log(`kill ${id}`)
      manifest.forget(id)
      host.kill(id)
      return null
    }
    case 'history':
      // Base64 para no romper el NDJSON con controles de terminal.
      return Buffer.from(host.history(str(req.sessionId, 'sessionId')), 'utf8').toString('base64')
    case 'foreground':
      return host.foreground()
    case 'pids':
      return { root: process.pid, sessions: host.pids() }
    case 'subscribe':
      client.subscribed = true
      return null
    case 'orphans':
      return manifest.getOrphans()
    case 'dismiss': {
      const ids = Array.isArray(req.ids) ? req.ids.filter((x): x is string => typeof x === 'string') : []
      log(`dismiss ${ids.length} huérfanas`)
      manifest.dismiss(ids)
      return null
    }
    case 'shutdown':
      log(`shutdown pedido por un cliente${req.forget === true ? ' (sin revivir)' : ''}`)
      // "Apagar todo" no deja nada que revivir; un reinicio por build distinto sí.
      if (req.forget === true) manifest.clear()
      else snapshotAndFreeze()
      // Se responde antes de apagar para que el cliente no se quede esperando.
      setImmediate(() => shutdown(0))
      return null
    default:
      throw new Error(`pedido desconocido: ${String(req.type)}`)
  }
}

function onLine(client: Client, line: string): void {
  const req = decodeLine(line)
  if (!req || typeof req.id !== 'number') {
    log(`línea inválida de un cliente: ${line.slice(0, 120)}`)
    return
  }
  const id = req.id
  try {
    send(client, { id, ok: true, result: dispatch(client, req) })
  } catch (err) {
    send(client, { id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

function onConnection(socket: Socket): void {
  const client: Client = { socket, splitter: new LineSplitter(), subscribed: false }
  clients.add(client)
  socket.setNoDelay(true)
  socket.on('data', (chunk) => {
    for (const line of client.splitter.push(chunk)) onLine(client, line)
  })
  const drop = (): void => {
    clients.delete(client)
  }
  socket.on('close', drop)
  socket.on('error', (err) => {
    log(`cliente: ${err.message}`)
    drop()
  })
}

/** `true` si el socket y el info apuntan a ESTE proceso (el último que escribió daemon.json). */
function ownsFiles(): boolean {
  try {
    const info: unknown = JSON.parse(readFileSync(paths.info, 'utf8'))
    return typeof info === 'object' && info !== null && (info as { pid?: unknown }).pid === process.pid
  } catch {
    return false
  }
}

/**
 * Borra socket e info solo si siguen siendo nuestros: un daemon viejo que se apaga tarde no debe
 * llevarse el socket del que lo reemplazó (dejaría al nuevo vivo pero inalcanzable, con sus sesiones).
 */
function cleanupFiles(): void {
  if (!ownsFiles()) {
    log('socket e info ya son de otro daemon: no se tocan')
    return
  }
  for (const file of [paths.sock, paths.info]) {
    try {
      if (existsSync(file)) unlinkSync(file)
    } catch {
      // Nada que hacer: el próximo arranque lo detecta como huérfano.
    }
  }
}

/** Guarda la foto de las pantallas con salida nueva. */
function snapshotDirty(): void {
  for (const id of dirty) {
    const text = host.snapshot(id)
    if (text !== null) manifest.saveScreen(id, text)
  }
  dirty.clear()
}

const TRACK_RESUME_EVERY_MS = 10_000
let trackingResume = false

/**
 * Sigue la conversación en curso de cada Claude Code local: si el usuario hizo `/resume` a otro chat,
 * el `resumeId` del registro pasa a ese, y revivir tras cerrar omni o reiniciar la Mac retoma el chat
 * correcto. Una vuelta a la vez; sin sesiones de Claude no llama a `ps`.
 */
async function trackResumeIds(): Promise<void> {
  const sessions = host.localPidsOf('claude')
  if (trackingResume || sessions.length === 0) return
  trackingResume = true
  try {
    const table = await readProcessTable()
    for (const s of sessions) {
      const current = await claudeSessionUnder(table, s.pid)
      if (!current || current === s.resumeId) continue
      if (!host.setResumeId(s.id, current)) continue
      manifest.setResumeId(s.id, current)
      log(`resume ${s.id}: claude cambió a la conversación ${current}`)
    }
  } finally {
    trackingResume = false
  }
}

/** Apagado (señal o reinicio por build): última foto y registro congelado, para que las muertes que siguen no lo vacíen. */
function snapshotAndFreeze(): void {
  snapshotDirty()
  manifest.freeze()
}

function shutdown(code: number): void {
  if (stopping) return
  stopping = true
  // Cualquier salida que no sea "Apagar todo" (ya congelado por `clear`) deja el registro para revivir.
  snapshotAndFreeze()
  log(`apagando (${host.list().length} sesiones)`)
  host.killAll()
  for (const c of clients) c.socket.end()
  // `server.close()` hace que libuv borre el archivo del socket por la ruta, aunque esa ruta ya sea
  // del daemon que nos reemplazó: solo se cierra el servidor (y se limpian los archivos) si son nuestros.
  // Si no, el proceso sale sin cerrar el handle y el socket del daemon vivo queda intacto.
  if (ownsFiles()) {
    server?.close()
    cleanupFiles()
  } else {
    log('socket e info ya son de otro daemon: no se tocan')
  }
  // Un respiro para que lleguen las últimas respuestas y las señales a los shells.
  setTimeout(() => process.exit(code), 100)
}

let relistening = false

/**
 * Si el archivo del socket desaparece (un daemon viejo mal apagado, una limpieza a mano), este daemon
 * sigue vivo con sus sesiones pero nadie puede conectarse: se escucha de nuevo en la misma ruta.
 * El servidor viejo NO se cierra: `close()` espera a que terminen sus conexiones (la app sigue
 * conectada) y su unlink borraría la ruta recién creada; se queda sirviendo lo que ya tiene.
 */
function watchSocket(): void {
  setInterval(() => {
    if (stopping || relistening || !server || existsSync(paths.sock)) return
    relistening = true
    log('el socket desapareció: se vuelve a escuchar')
    const next = createServer(onConnection)
    next.on('error', (err) => {
      log(`servidor: ${err.message}`)
      relistening = false
    })
    next.listen(paths.sock, () => {
      server = next
      relistening = false
      writeFileSync(paths.info, JSON.stringify({ pid: process.pid, build: BUILD_STAMP, startedAt }, null, 2) + '\n')
      log(`escuchando de nuevo en ${paths.sock} pid=${process.pid}`)
    })
  }, 5000).unref()
}

async function main(): Promise<void> {
  mkdirSync(paths.dir, { recursive: true })
  try {
    logBytes = statSync(paths.log).size
  } catch {
    logBytes = 0
  }

  if (existsSync(paths.sock)) {
    if (await isAlive(paths.sock)) {
      log(`ya hay un daemon escuchando en ${paths.sock}; este (${process.pid}) se retira`)
      process.exit(0)
    }
    log('socket huérfano: se borra')
    unlinkSync(paths.sock)
  }

  // Lo que dejó el daemon anterior (reinicio de la Mac, caída) queda como huérfanas hasta que la app las revive o descarta.
  manifest.load()
  const orphans = manifest.getOrphans().length
  if (orphans) log(`${orphans} sesiones de antes por revivir`)
  setInterval(snapshotDirty, SNAPSHOT_EVERY_MS).unref()
  setInterval(() => void trackResumeIds(), TRACK_RESUME_EVERY_MS).unref()

  host.onData((sessionId, data) => {
    dirty.add(sessionId)
    broadcast({ event: 'data', sessionId, data: Buffer.from(data, 'utf8').toString('base64') })
  })
  host.onExit((sessionId, code, signal, lost, screen) => {
    log(`exit ${sessionId} code=${code}${signal ? ` signal=${signal}` : ''}${lost ? ' (conexión perdida: queda huérfana)' : ''}`)
    dirty.delete(sessionId)
    // Remota sin conexión tras agotar las esperas: el dtach sigue en el host, se revive al reconectar.
    if (lost) {
      // La foto va antes de `lost`: `saveScreen` solo acepta sesiones vivas en el registro.
      if (screen) manifest.saveScreen(sessionId, screen)
      manifest.lost(sessionId)
    } else manifest.exited(sessionId)
    broadcast({ event: 'exit', sessionId, code })
  })

  server = createServer(onConnection)
  server.on('error', (err) => {
    log(`servidor: ${err.message}`)
    shutdown(1)
  })
  await new Promise<void>((resolve) => server?.listen(paths.sock, resolve))
  writeFileSync(paths.info, JSON.stringify({ pid: process.pid, build: BUILD_STAMP, startedAt }, null, 2) + '\n')
  log(`escuchando en ${paths.sock} pid=${process.pid} build=${BUILD_STAMP}`)

  watchSocket()

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log(`señal ${signal}`)
      shutdown(0)
    })
  }
  // SIGHUP llega cuando se cierra la terminal que lanzó la app en dev: el daemon es desacoplado y sigue.
  process.on('SIGHUP', () => log('SIGHUP ignorado'))
  process.on('uncaughtException', (err) => log(`uncaught: ${err.stack ?? err.message}`))
  process.on('unhandledRejection', (reason) => log(`unhandled: ${String(reason)}`))
}

process.title = 'omni-daemon'
void main()
