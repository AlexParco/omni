import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LspServerInfo, LspServerKind, Workspace } from '@shared/types'
import { dirsUpTo } from './diagnostics'
import { isInside } from './files'
import { EXTRA_BIN_DIRS } from './whisper'
import { testsEnv } from './worktrees'
import { nodeExecPath } from '../node-exec'
import type { RemoteLspHost } from '../hosts/types'

/**
 * Servidores de lenguaje del editor (ARCHITECTURE §3.19b). Main lanza el servidor que corresponde al
 * archivo (el TypeScript del propio proyecto, gopls, pyright, rust-analyzer), le pone y le quita el
 * marco `Content-Length` y reenvía los cuerpos JSON-RPC tal cual: el `initialize` y todo el protocolo
 * los habla el cliente LSP del renderer. Sin servidor instalado no hay LSP y el editor sigue con su
 * tsc/eslint al guardar. Sin shell: argumentos como lista.
 */

/** Tras el SIGTERM de `stop`, cuánto se espera antes del SIGKILL. */
export const LSP_KILL_DELAY_MS = 2_000
/** Caracteres de stderr que se guardan para explicar una caída. */
const STDERR_TAIL = 4_000

const HEADER_END = Buffer.from('\r\n\r\n')

/** Envuelve un cuerpo JSON-RPC con su cabecera; `Content-Length` cuenta BYTES UTF-8, no caracteres. */
export function frame(message: string): Buffer {
  const body = Buffer.from(message, 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

/**
 * Parte el stdout de un servidor en mensajes. Acepta trozos arbitrarios (una cabecera o un carácter
 * multibyte partidos entre dos trozos, varios mensajes en uno): acumula bytes y solo decodifica un
 * cuerpo completo. Una cabecera sin `Content-Length` se descarta sin romper el resto del flujo.
 */
export class LspFramer {
  private buf: Buffer = Buffer.alloc(0)

  /** Mensajes completos (cuerpos sin cabecera) que deja este trozo; lo incompleto queda para el siguiente. */
  push(chunk: Buffer | string): string[] {
    this.buf = Buffer.concat([this.buf, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk])
    const out: string[] = []
    for (;;) {
      const end = this.buf.indexOf(HEADER_END)
      if (end === -1) break
      const header = this.buf.subarray(0, end).toString('ascii')
      const m = /content-length:\s*(\d+)/i.exec(header)
      if (!m) {
        this.buf = this.buf.subarray(end + HEADER_END.length)
        continue
      }
      const length = Number(m[1])
      const start = end + HEADER_END.length
      if (this.buf.length < start + length) break
      out.push(this.buf.subarray(start, start + length).toString('utf8'))
      this.buf = this.buf.subarray(start + length)
    }
    return out
  }
}

/** Cómo lanzar un servidor para un archivo; `key` identifica a los que se pueden compartir. */
export interface LspServerSpec {
  kind: LspServerKind
  /** Nombre visible: "TypeScript 5.9.3", "gopls". */
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  initializationOptions: Record<string, unknown> | null
  languageId: string
  /** `${kind}|${raíz del workspace}|${carpeta de typescript o binario}`: dos archivos con la misma key comparten proceso. */
  key: string
}

export interface ResolveDeps {
  exists?: (path: string) => Promise<boolean>
  readText?: (path: string) => Promise<string>
  /** Ruta absoluta de un binario en el PATH de los servidores, o `null` si no está. */
  which?: (name: string) => Promise<string | null>
  /** Entorno base de los servidores (sin variables de Electron, con el PATH ampliado). */
  env?: Record<string, string>
  /** Ejecutable con el que se corren los servidores en JS (`ELECTRON_RUN_AS_NODE=1`). */
  execPath?: string
  /** `cli.mjs` del `typescript-language-server` que trae omni; `null` si no se encuentra. */
  tsLanguageServerCli?: () => string | null
}

const TS_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact'
}

/** Servidores de Python en orden de preferencia (solo la familia pyright: mismo protocolo y opciones). */
const PYTHON_SERVERS: Array<{ bin: string; name: string }> = [
  { bin: 'basedpyright-langserver', name: 'basedpyright' },
  { bin: 'pyright-langserver', name: 'pyright' }
]

/**
 * Carpetas donde se buscan los binarios: el PATH del proceso más Homebrew y los de usuario. Una app
 * lanzada desde el Finder hereda un PATH mínimo y gopls vive en `~/go/bin`, rust-analyzer en `~/.cargo/bin`.
 */
export function lspBinDirs(pathVar: string = process.env.PATH ?? '', home: string = homedir()): string[] {
  const dirs = [...pathVar.split(delimiter), ...EXTRA_BIN_DIRS, join(home, 'go', 'bin'), join(home, '.cargo', 'bin'), join(home, '.local', 'bin')]
  return [...new Set(dirs.filter((d) => d !== ''))]
}

/** Entorno de los servidores: el de los tests (sin variables de Electron) con el PATH ampliado. */
export function lspEnv(): Record<string, string> {
  const env = testsEnv()
  env.PATH = lspBinDirs(process.env.PATH).join(delimiter)
  return env
}

const defaultExists = (path: string): Promise<boolean> =>
  fs.access(path).then(
    () => true,
    () => false
  )

async function defaultWhich(name: string): Promise<string | null> {
  for (const dir of lspBinDirs()) {
    const full = join(dir, name)
    const ok = await fs.access(full, fsConstants.X_OK).then(
      () => true,
      () => false
    )
    if (ok) return full
  }
  return null
}

/**
 * `cli.mjs` del `typescript-language-server` empaquetado con omni. En la app empaquetada vive dentro
 * de `app.asar`; se apunta a la copia de `app.asar.unpacked` (electron-builder `asarUnpack`) porque
 * el proceso hijo lo carga como módulo ES, que no se lee desde dentro del asar.
 */
export function bundledTsLanguageServerCli(): string | null {
  try {
    const path = createRequire(import.meta.url).resolve('typescript-language-server/lib/cli.mjs')
    return path.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  } catch {
    return null
  }
}

/**
 * Servidor que corresponde a `filePath` dentro de `workspaceRoot`, o `null` si no hay ninguno
 * instalado (o el lenguaje no tiene soporte). Para TS/JS se usa el `typescript` del proyecto (el
 * `node_modules` más cercano subiendo hasta la raíz), nunca uno global.
 */
export async function resolveServer(workspaceRoot: string, filePath: string, deps: ResolveDeps = {}): Promise<LspServerSpec | null> {
  const exists = deps.exists ?? defaultExists
  const readText = deps.readText ?? ((p: string) => fs.readFile(p, 'utf8'))
  const which = deps.which ?? defaultWhich
  const env = deps.env ?? lspEnv()
  const execPath = deps.execPath ?? nodeExecPath()
  const ext = extname(filePath).toLowerCase()

  const tsLanguage = TS_LANGUAGE[ext]
  if (tsLanguage) {
    let tsDir: string | null = null
    for (const dir of dirsUpTo(dirname(filePath), workspaceRoot)) {
      const candidate = join(dir, 'node_modules', 'typescript')
      if (await exists(join(candidate, 'package.json'))) {
        tsDir = candidate
        break
      }
    }
    if (!tsDir) return null
    let version = ''
    try {
      const pkg = JSON.parse(await readText(join(tsDir, 'package.json'))) as { version?: unknown }
      if (typeof pkg.version === 'string') version = pkg.version
    } catch {
      return null
    }
    const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    const name = version ? `TypeScript ${version}` : 'TypeScript'
    const tsserver = join(tsDir, 'lib', 'tsserver.js')
    if (await exists(tsserver)) {
      const cli = (deps.tsLanguageServerCli ?? bundledTsLanguageServerCli)()
      if (!cli) return null
      return {
        kind: 'typescript',
        name,
        command: execPath,
        args: [cli, '--stdio'],
        env: nodeEnv,
        cwd: workspaceRoot,
        initializationOptions: { tsserver: { path: tsserver } },
        languageId: tsLanguage,
        key: `typescript|${workspaceRoot}|${tsDir}`
      }
    }
    // TypeScript 7 (nativo) no trae tsserver.js: su `tsc` habla LSP directamente.
    if (Number(version.split('.')[0]) >= 7) {
      return {
        kind: 'tsgo',
        name,
        command: execPath,
        args: [join(tsDir, 'bin', 'tsc'), '--lsp', '--stdio'],
        env: nodeEnv,
        cwd: workspaceRoot,
        initializationOptions: null,
        languageId: tsLanguage,
        key: `tsgo|${workspaceRoot}|${tsDir}`
      }
    }
    return null
  }

  const binary = async (kind: LspServerKind, bin: string, name: string, args: string[], languageId: string): Promise<LspServerSpec | null> => {
    const command = await which(bin)
    if (!command) return null
    return { kind, name, command, args, env, cwd: workspaceRoot, initializationOptions: null, languageId, key: `${kind}|${workspaceRoot}|${command}` }
  }
  if (ext === '.go') return binary('gopls', 'gopls', 'gopls', [], 'go')
  if (ext === '.rs') return binary('rust-analyzer', 'rust-analyzer', 'rust-analyzer', [], 'rust')
  if (ext === '.py' || ext === '.pyi') {
    for (const s of PYTHON_SERVERS) {
      const spec = await binary('pyright', s.bin, s.name, ['--stdio'], 'python')
      if (spec) return spec
    }
  }
  return null
}

/**
 * Servidor para un archivo de un workspace remoto (§3.26): se resuelve con los archivos y el PATH del
 * host y se lanza allá por `ssh -T` (el editor ya usa rutas del host, así las URIs `file://` calzan).
 * TypeScript < 7 necesita `typescript-language-server` en el host; TS 7 habla LSP con su propio `tsc`.
 */
export async function resolveRemoteServer(host: RemoteLspHost, root: string, filePath: string): Promise<LspServerSpec | null> {
  // Marca: `resolveServer` arma el lanzamiento con el CLI que trae omni; en el host se usa el suyo.
  const BUNDLED = '\0omni-bundled-tls'
  const spec = await resolveServer(root, filePath, { exists: host.exists, readText: host.readText, which: host.which, env: {}, execPath: 'node', tsLanguageServerCli: () => BUNDLED })
  if (!spec) return null
  let argv = [spec.command, ...spec.args]
  if (spec.args[0] === BUNDLED) {
    const tls = await host.which('typescript-language-server')
    if (!tls) return null
    argv = [tls, '--stdio']
  }
  const { command, args } = host.launch(argv, root)
  return { ...spec, command, args, env: lspEnv(), cwd: homedir(), key: `${host.key}|${spec.key}` }
}

/**
 * `spawn` inyectable en tests; el servicio solo usa stdio por pipes. El de fábrica lanza el servidor
 * como líder de su propio grupo de procesos (`detached`) para que las señales alcancen también a sus
 * hijos (`typescript-language-server` lanza `tsserver`, rust-analyzer sus procMacro…).
 */
export type SpawnFn = (command: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => ChildProcess

export interface LspServiceOptions {
  /** Resolución del servidor de un archivo; por defecto `resolveServer` con dependencias reales. */
  resolve?: (workspaceRoot: string, filePath: string) => Promise<LspServerSpec | null>
  spawn?: SpawnFn
  killDelayMs?: number
  /** Workspaces remotos (§3.26): resolución en el host; sin esto, un remoto no tiene servidor. */
  remote?: (workspace: Workspace, filePath: string) => Promise<LspServerSpec | null>
}

interface LiveServer {
  id: string
  spec: LspServerSpec
  /** Token del renderer que hizo el `initialize`; otro token = otro cliente que no puede reusarlo. */
  client: string
  rootUri: string
  child: ChildProcess
  /** Resuelve cuando el proceso arrancó; rechaza con un error humano si no se pudo lanzar. */
  ready: Promise<void>
  stderr: string
  /** Lo paramos nosotros: su salida no es un error. */
  stopped: boolean
  finished: boolean
  killTimer: NodeJS.Timeout | null
}

type MessageListener = (serverId: string, message: string) => void
type ExitListener = (serverId: string, error: string | null) => void

const defaultSpawn: SpawnFn = (command, args, opts) => nodeSpawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })

/**
 * Manda `signal` al grupo del servidor (él y sus hijos); si no es líder de grupo (un `spawn` inyectado
 * sin `detached`) o el grupo ya no existe, solo al proceso.
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Sin grupo propio: se cae al proceso solo.
    }
  }
  child.kill(signal)
}

/** Últimas líneas no vacías de stderr, recortadas, para el mensaje de caída. */
function tailText(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  const text = lines.slice(-3).join(' · ')
  return text.length > 300 ? `…${text.slice(-300)}` : text
}

export class LspService {
  private readonly resolve: (workspaceRoot: string, filePath: string) => Promise<LspServerSpec | null>
  private readonly spawn: SpawnFn
  private readonly killDelayMs: number
  private readonly remote: LspServiceOptions['remote']
  private readonly servers = new Map<string, LiveServer>()
  /** Procesos que aún no terminaron, incluidos los parados que esperan su SIGKILL (ya fuera de `servers`). */
  private readonly running = new Set<LiveServer>()
  private readonly messageListeners = new Set<MessageListener>()
  private readonly exitListeners = new Set<ExitListener>()

  constructor(opts: LspServiceOptions = {}) {
    this.resolve = opts.resolve ?? ((root, path) => resolveServer(root, path))
    this.spawn = opts.spawn ?? defaultSpawn
    this.killDelayMs = opts.killDelayMs ?? LSP_KILL_DELAY_MS
    this.remote = opts.remote
  }

  /** Cada mensaje JSON-RPC (sin cabecera) que manda un servidor. */
  onMessage(l: MessageListener): () => void {
    this.messageListeners.add(l)
    return () => this.messageListeners.delete(l)
  }

  /** Un servidor terminó: `error` humano si se cayó, `null` si lo paramos nosotros. Ya no está en el mapa. */
  onExit(l: ExitListener): () => void {
    this.exitListeners.add(l)
    return () => this.exitListeners.delete(l)
  }

  /**
   * Servidor para `path` (absoluto, dentro del workspace), o `null` si no hay ninguno instalado. Se
   * reusa uno vivo con la misma key y el mismo `client`; si hay servidores de otro `client` (el
   * renderer se recargó y su `initialize` ya se consumió) se paran todos antes.
   */
  async start(workspace: Workspace, path: string, client: string): Promise<LspServerInfo | null> {
    let spec: LspServerSpec | null
    if (workspace.host) {
      // Remoto (§3.26): ruta POSIX del host, comprobada sin `realpath` local; el servidor corre allá.
      if (!this.remote) return null
      const root = workspace.path.endsWith('/') ? workspace.path : `${workspace.path}/`
      if (!path.startsWith(root) || path.split('/').includes('..')) throw new Error(`ruta fuera del workspace: ${path}`)
      spec = await this.remote(workspace, path)
    } else {
      if (!isInside(path, [workspace.path])) throw new Error(`ruta fuera del workspace: ${path}`)
      spec = await this.resolve(workspace.path, path)
    }
    // Todo lo que sigue es síncrono hasta guardar el servidor en el mapa: dos `start` simultáneos no lanzan dos procesos.
    for (const s of [...this.servers.values()]) if (s.client !== client) this.stop(s.id)
    if (!spec) return null
    const live = [...this.servers.values()].find((s) => s.spec.key === spec.key && s.client === client)
    const server = live ?? this.launch(spec, client, pathToFileURL(workspace.path).href)
    await server.ready
    return { id: server.id, kind: spec.kind, name: spec.name, rootUri: server.rootUri, initializationOptions: spec.initializationOptions, languageId: spec.languageId }
  }

  /** Escribe un cuerpo JSON-RPC (con su cabecera) en el stdin del servidor; id desconocido o muerto se ignora. */
  send(serverId: string, message: string): void {
    const s = this.servers.get(serverId)
    if (!s || s.finished || !s.child.stdin?.writable) return
    s.child.stdin.write(frame(message))
  }

  /** SIGTERM y, si no sale en `killDelayMs`, SIGKILL. Su salida se avisa con `error: null`. */
  stop(serverId: string): void {
    const s = this.servers.get(serverId)
    if (!s) return
    this.servers.delete(serverId)
    s.stopped = true
    if (s.finished) return
    signalTree(s.child, 'SIGTERM')
    s.killTimer = setTimeout(() => {
      if (!s.finished) signalTree(s.child, 'SIGKILL')
    }, this.killDelayMs)
    s.killTimer.unref()
  }

  /** Para todos con la gracia de `stop` (SIGTERM y luego SIGKILL); para cuando la app sigue viva. */
  stopAll(): void {
    for (const id of [...this.servers.keys()]) this.stop(id)
  }

  /**
   * Al salir de la app: SIGKILL síncrono a cada servidor y su grupo, también a los que ya se estaban
   * parando. No espera nada: el temporizador de `stop` no llega a correr si el proceso de omni sale, y
   * un servidor que ignora SIGTERM sobreviviría a omni.
   */
  killAll(): void {
    for (const s of [...this.running]) {
      this.servers.delete(s.id)
      s.stopped = true
      if (s.killTimer) clearTimeout(s.killTimer)
      if (!s.finished) signalTree(s.child, 'SIGKILL')
    }
  }

  /** Ids vivos (para tests y diagnóstico). */
  list(): string[] {
    return [...this.servers.keys()]
  }

  private launch(spec: LspServerSpec, client: string, rootUri: string): LiveServer {
    const id = randomUUID()
    const child = this.spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env })
    let onReady: () => void = () => undefined
    let onFail: (err: Error) => void = () => undefined
    const ready = new Promise<void>((res, rej) => {
      onReady = res
      onFail = rej
    })
    const server: LiveServer = { id, spec, client, rootUri, child, ready, stderr: '', stopped: false, finished: false, killTimer: null }
    this.servers.set(id, server)
    this.running.add(server)

    const finish = (error: string | null): void => {
      if (server.finished) return
      server.finished = true
      if (server.killTimer) clearTimeout(server.killTimer)
      this.servers.delete(id)
      this.running.delete(server)
      const reported = server.stopped ? null : error
      for (const l of this.exitListeners) l(id, reported)
    }

    const framer = new LspFramer()
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const message of framer.push(chunk)) for (const l of this.messageListeners) l(id, message)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      server.stderr = (server.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL)
    })
    // Un servidor que muere con mensajes en vuelo deja EPIPE en stdin: la caída se informa por `close`.
    child.stdin?.on('error', () => undefined)
    child.once('spawn', () => onReady())
    child.once('error', (err) => {
      const msg = `${spec.name} no se pudo lanzar: ${err.message}`
      onFail(new Error(msg))
      finish(msg)
    })
    // `close` (no `exit`): llega cuando stdout ya se vació, así ningún mensaje se pierde tras la salida.
    child.once('close', (code, signal) => {
      const tail = tailText(server.stderr)
      const how = signal ? `señal ${signal}` : `código ${code ?? '?'}`
      finish(`${spec.name} se cerró (${how})${tail ? `: ${tail}` : ''}`)
    })
    // El que espera `ready` puede no llegar a escucharlo (lo paramos antes): sin rechazo sin capturar.
    ready.catch(() => undefined)
    return server
  }
}
