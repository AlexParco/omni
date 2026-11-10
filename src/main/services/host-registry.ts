import type { HostStatus, RemoteHost, SshConfigHost, Workspace } from '@shared/types'
import { LocalHost } from '../hosts/local-host'
import { preflight } from '../hosts/preflight'
import { loginWrap, remoteLine, shCommand, shq } from '../hosts/shq'
import { SshError } from '../hosts/ssh'
import { SshHost } from '../hosts/ssh-host'
import { listSshConfigHosts } from '../hosts/ssh-config'
import type { Host, RemoteLogs, RemoteLspHost } from '../hosts/types'
import type { HostStore } from './hosts'
import { createConnection, createServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { expandHome } from './projects'

/** Cómo lanzar una terminal remota en el daemon: `ssh -tt … <comando>` y si se reconecta sola. */
export interface RemoteSpawn {
  file: string
  args: string[]
  reconnect: boolean
}

/** Carpeta de sockets de dtach en el host, relativa a su `$HOME` (no `/tmp`: no la limpia tmpfiles ni el logout). */
const RUN_DIR = '.omni/run'
/** CLI `omni` y servidor MCP en el host, copiados al conectar. */
const BIN_DIR = '.omni/bin'
/** Archivos de `bin/` que se copian al host: el CLI, el MCP y su cliente compartido. */
const CLI_FILES = ['omni.mjs', 'omni-client.mjs', 'omni-mcp.mjs'] as const
/** Lanzadores de `~/.omni/bin`: sin `.mjs` ni `node` delante, como en el Mac. */
const CLI_WRAPPERS: Record<string, string> = { omni: 'omni.mjs', 'omni-mcp': 'omni-mcp.mjs' }
/** Lo más que se sugiere al completar una ruta remota. */
const SUGGEST_MAX = 8

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error(`id de sesión inválido: ${sessionId}`)
}

/**
 * Comando remoto de una terminal (§3.26), POSIX (lo corre `/bin/sh` vía `remoteLine`): entra al cwd
 * y, con dtach, se engancha a la sesión `<id>` o la crea (`-A`); así un corte de red o cerrar omni
 * no matan al agente, y reconectar es volver a correr lo mismo. `-r winch` hace que la TUI se
 * repinte al volver; `-z` deja ⌃Z para el shell. `dtach` es la ruta que encontró el preflight en el
 * shell de login (aquí no está su PATH); `null` = sin dtach: un shell de login normal (muere con la
 * conexión). Exportada para tests.
 */
export function terminalCommand(sessionId: string, cwd: string, dtach: string | null): string {
  assertSessionId(sessionId)
  const shell = '"${SHELL:-/bin/sh}"'
  // `OMNI_SOCK` y `~/.omni/bin`: el CLI `omni` del host habla con este omni por el socket reenviado (§3.26).
  const enter = `cd -- ${shq(cwd)} 2>/dev/null || cd; export TERM_PROGRAM=omni OMNI_SESSION=1 OMNI_SOCK="$HOME"/${RUN_DIR}/app.sock PATH="$HOME"/${BIN_DIR}:"$PATH"`
  if (dtach === null) return `${enter}; exec ${shell} -l`
  const sock = `"$HOME"/${RUN_DIR}/${sessionId}.sock`
  return `mkdir -p "$HOME"/${RUN_DIR} && chmod 700 "$HOME"/${RUN_DIR}; ${enter}; exec ${shq(dtach)} -A ${sock} -r winch -z ${shell} -l`
}

/**
 * Regex (ERE de `pgrep`/`pkill -f`) de los procesos dtach de la sesión `<id>`. Anclada a argv0
 * (`dtach` o `/ruta/dtach`, gracias al `exec`): sin el `^` calzaría también con el `sh -c` que
 * corre el `pkill`, que lleva el patrón en su línea, y `pkill` lo mataría antes del `rm`.
 * Exportada para tests.
 */
export function dtachPattern(sessionId: string): string {
  assertSessionId(sessionId)
  return `^([^ ]*/)?dtach -A .*/${RUN_DIR.replaceAll('.', '\\.')}/${sessionId}\\.sock( |$)`
}

/** Comando que termina la sesión dtach `<id>` en el host (su shell y el agente mueren con ella). Exportada para tests. */
export function killCommand(sessionId: string): string {
  // Patrón entero entre comillas: un `.*` suelto lo expandiría el shell como glob.
  return `pkill -f -- ${shq(dtachPattern(sessionId))}; rm -f "$HOME"/${RUN_DIR}/${sessionId}.sock`
}

/**
 * Comando que sale con 0 si la sesión dtach `<id>` sigue viva en el host. No basta con que exista el
 * socket: tras un reinicio del host queda el archivo muerto y engancharse a él abriría un shell
 * pelado sin el agente. Se busca el proceso dtach (`pgrep`); si no está, el socket muerto se borra.
 * Sin `pgrep` (o si falla) se confía en el socket, que es lo que se hacía antes. Exportada para tests.
 */
export function sessionCheckCommand(sessionId: string): string {
  const pattern = dtachPattern(sessionId)
  return [
    `s="$HOME"/${RUN_DIR}/${sessionId}.sock`,
    '[ -S "$s" ] || exit 1',
    'command -v pgrep >/dev/null 2>&1 || exit 0',
    `pgrep -u "$(id -u)" -f -- ${shq(pattern)} >/dev/null; r=$?`,
    '[ "$r" -eq 0 ] && exit 0',
    '[ "$r" -eq 1 ] || exit 0',
    'rm -f -- "$s"',
    'exit 1'
  ].join('\n')
}

export interface HostRegistryOptions {
  store: HostStore
  /** Fábrica de hosts SSH (tests: con el ssh falso). */
  createSsh?: (host: RemoteHost) => SshHost
  /**
   * CLI `omni` en el host (§3.26): socket de control de este omni (se reenvía al host) y carpeta con
   * `omni.mjs` y compañía (se copian). Sin ellos no se instala nada.
   */
  cli?: { controlSock: string; binDir: string }
}

/**
 * `<tamaño> <mtime s> <inode> <ruta>` por línea (lo que imprime el `stat` GNU o BSD de `costLogs`) →
 * archivos con su ruta relativa a `root`. Las líneas que no tienen esa forma se ignoran. Exportada para tests.
 */
export function parseStatLines(out: string, root: string): Array<{ rel: string; size: number; mtime: number; ino: number }> {
  const prefix = root.endsWith('/') ? root : `${root}/`
  const files: Array<{ rel: string; size: number; mtime: number; ino: number }> = []
  for (const line of out.split('\n')) {
    const m = /^(\d+) (\d+) (\d+) (.+)$/.exec(line)
    if (!m || !m[4]?.startsWith(prefix)) continue
    files.push({ rel: m[4].slice(prefix.length), size: Number(m[1]), mtime: Number(m[2]) * 1000, ino: Number(m[3]) })
  }
  return files
}

/** `true` si algo escucha en `127.0.0.1:<port>` (el túnel sigue abierto). */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(1000, () => done(false))
  })
}

/** `true` si se puede escuchar en `127.0.0.1:<port>` (nadie lo ocupa en el Mac). */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/** Un puerto libre en loopback que elige el sistema. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no hay puertos libres'))))
    })
  })
}

/**
 * Hosts de omni (ARCHITECTURE §3.26): este Mac y los servidores de `hosts.json`, con su conexión y
 * lo que tienen instalado. Los servicios piden `for(workspace)` y no saben si es local o remoto.
 */
export class HostRegistry {
  readonly local = new LocalHost()
  private readonly ssh = new Map<string, SshHost>()
  private readonly status = new Map<string, HostStatus>()
  private readonly connecting = new Map<string, Promise<HostStatus>>()
  private readonly listeners = new Set<(status: HostStatus) => void>()
  /** Sesiones cerradas sin conexión con su host: se matan en cuanto vuelva a conectar. */
  private readonly pendingKills = new Map<string, Set<string>>()
  /** Hosts con el CLI `omni` instalado y el socket de control reenviado en esta conexión. */
  private readonly cliReady = new Set<string>()
  /** Puertos reenviados por host: puerto del host → puerto del Mac. Viven con el ControlMaster. */
  private readonly forwards = new Map<string, Map<number, number>>()

  constructor(private readonly opts: HostRegistryOptions) {}

  /** Avisa cada cambio de estado de una conexión (para el sidebar y Ajustes). */
  onStatus(l: (status: HostStatus) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  list(): RemoteHost[] {
    return this.opts.store.list()
  }

  add(name: string, target: string): RemoteHost {
    return this.opts.store.add(name, target)
  }

  /** Olvida el host (cierra su conexión). Los proyectos que lo usan los revisa quien llama. */
  async remove(id: string): Promise<void> {
    await this.disconnect(id)
    this.ssh.delete(id)
    this.status.delete(id)
    this.pendingKills.delete(id)
    this.opts.store.remove(id)
  }

  statuses(): HostStatus[] {
    return this.list().map((h) => this.statusOf(h.id))
  }

  statusOf(id: string): HostStatus {
    return this.status.get(id) ?? { hostId: id, state: 'disconnected', error: null, home: null, system: null, tools: null }
  }

  sshConfigHosts(): Promise<SshConfigHost[]> {
    return listSshConfigHosts()
  }

  /** Host de un id (`undefined` = este Mac). Error humano si el host ya no existe. */
  for(hostId: string | undefined): Host {
    if (!hostId) return this.local
    return this.sshOf(hostId)
  }

  forWorkspace(workspace: Pick<Workspace, 'host'>): Host {
    return this.for(workspace.host)
  }

  /** Host remoto conectado o error humano ("conéctate primero"): para lo que no puede esperar a conectar. */
  connected(hostId: string): SshHost {
    const host = this.sshOf(hostId)
    if (this.statusOf(hostId).state !== 'connected') throw new Error(`${this.nameOf(hostId)} no está conectado`)
    return host
  }

  /**
   * Deja el host conectado: conecta y corre el preflight, o, si ya estaba conectado, solo comprueba
   * que la conexión sigue viva (sin avisar `connecting`→`connected`, que volvería a disparar
   * el revivir de sus sesiones); si se cayó, reconecta. Nunca lanza: el fallo queda en el estado.
   */
  connect(id: string): Promise<HostStatus> {
    const running = this.connecting.get(id)
    if (running) return running
    const run = (this.statusOf(id).state === 'connected' ? this.verify(id) : this.doConnect(id)).finally(() => this.connecting.delete(id))
    this.connecting.set(id, run)
    return run
  }

  /** Conectado o conectar ahora; error humano si no se pudo. */
  async ensure(id: string): Promise<SshHost> {
    const status = this.statusOf(id).state === 'connected' ? this.statusOf(id) : await this.connect(id)
    if (status.state !== 'connected') throw new Error(status.error ?? `no se pudo conectar a ${this.nameOf(id)}`)
    return this.sshOf(id)
  }

  /**
   * Reenvía `localhost:<remotePort>` del host a este Mac y devuelve el puerto local: el mismo si está
   * libre (así la URL que imprimió el servidor sigue valiendo), si no uno cualquiera. Reusa el
   * reenvío vivo; si el master se cayó y con él el túnel, lo vuelve a abrir.
   */
  async forwardPort(hostId: string, remotePort: number): Promise<number> {
    const host = await this.ensure(hostId)
    const known = this.forwards.get(hostId) ?? new Map<number, number>()
    this.forwards.set(hostId, known)
    const existing = known.get(remotePort)
    if (existing !== undefined && (await isListening(existing))) return existing
    if (existing !== undefined) await host.transport.cancelForward(existing, remotePort)
    const local = (await isFree(remotePort)) ? remotePort : await freePort()
    await host.transport.forward(local, remotePort)
    known.set(remotePort, local)
    return local
  }

  /**
   * Logs de costo del host (§3.17, §3.26) para `CostTracker`: lista con `find` + `stat` (GNU o BSD) los
   * `.jsonl` tocados desde `since` y lee con `tail -c`. Requiere el host conectado; si no, tira.
   */
  async costLogs(hostId: string): Promise<RemoteLogs> {
    const host = await this.ensure(hostId)
    const home = await host.home()
    return {
      hostId,
      home,
      list: async (root, since) => {
        const minutes = Math.max(1, Math.ceil((Date.now() - since) / 60_000))
        const stat = `for f; do stat -c '%s %Y %i %n' "$f" 2>/dev/null || stat -f '%z %m %i %N' "$f"; done`
        const line = `[ -d ${shq(root)} ] || exit 0; find ${shq(root)} -type f -name '*.jsonl' -mmin -${minutes} -exec sh -c ${shq(stat)} sh {} + 2>/dev/null; exit 0`
        const r = await host.transport.run(line, { timeoutMs: 20_000 })
        return parseStatLines(r.stdout.toString('utf8'), root)
      },
      read: async (path, offset, max) => {
        const r = await host.transport.run(`tail -c +${offset + 1} ${shq(path)} | head -c ${Math.max(0, Math.floor(max))}`, { timeoutMs: 30_000, maxBuffer: max + 1024 })
        return r.stdout
      }
    }
  }

  /** El host como `RemoteLspHost` (servidores de lenguaje remotos, §3.19b). Requiere conexión. */
  async lspHost(hostId: string): Promise<RemoteLspHost> {
    const host = await this.ensure(hostId)
    return {
      key: hostId,
      exists: async (path) => (await host.fs.stat(path).catch(() => null)) !== null,
      readText: async (path) => (await host.fs.readFile(path)).toString('utf8'),
      which: async (name) => {
        const r = await host.execLogin('sh', ['-c', 'command -v "$1"', 'sh', name], { cwd: '/', timeoutMs: 15_000 }).catch(() => null)
        const path = r?.code === 0 ? r.stdout.trim().split('\n').at(-1) ?? '' : ''
        return path.startsWith('/') ? path : null
      },
      // `-T` sin terminal: el stdio del ssh es el del servidor. Shell de login para su PATH (nvm, ~/go/bin).
      launch: (argv, cwd) => ({ command: host.transport.binary, args: [...host.transport.baseArgs(), '-T', '--', remoteLine(loginWrap(shCommand(argv, cwd)))] })
    }
  }

  /** Reenvíos vivos de un host (para Ajustes y tests). */
  forwardsOf(hostId: string): Array<{ remote: number; local: number }> {
    return [...(this.forwards.get(hostId) ?? new Map<number, number>())].map(([remote, local]) => ({ remote, local }))
  }

  async disconnect(id: string): Promise<void> {
    const host = this.ssh.get(id)
    // Cerrar el master se lleva sus túneles; se cancelan antes por si el master sigue vivo para otro cliente.
    const open = this.forwards.get(id)
    this.forwards.delete(id)
    this.cliReady.delete(id)
    if (host && open) await Promise.all([...open].map(([remote, local]) => host.transport.cancelForward(local, remote)))
    if (host) await host.transport.close().catch(() => undefined)
    this.setStatus({ ...this.statusOf(id), state: 'disconnected', error: null })
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.ssh.keys()].map((id) => this.disconnect(id)))
  }

  /**
   * Completa una ruta del host para "Abrir carpeta remota": `~`, `~/x` o absoluta; con barra final
   * lista los hijos, si no, los hermanos que empiezan igual. Solo carpetas, sin ocultas salvo que el
   * prefijo empiece con `.`. Devuelve rutas absolutas.
   */
  async suggestPaths(hostId: string, input: string): Promise<string[]> {
    const host = await this.ensure(hostId)
    const home = await host.home()
    const raw = input.trim() === '' ? '~/' : input.trim()
    const abs = raw === '~' ? `${home}/` : raw.startsWith('~/') ? `${home}/${raw.slice(2)}` : raw
    if (!abs.startsWith('/')) return []
    const slash = abs.lastIndexOf('/')
    const dir = slash === 0 ? '/' : abs.slice(0, slash)
    const prefix = abs.slice(slash + 1).toLowerCase()
    const entries = await host.fs.readdir(dir).catch(() => [])
    return entries
      .filter((e) => e.dir && e.name.toLowerCase().startsWith(prefix) && (prefix.startsWith('.') || !e.name.startsWith('.')))
      .map((e) => (dir === '/' ? `/${e.name}` : `${dir}/${e.name}`))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, SUGGEST_MAX)
  }

  /** Valida una carpeta remota (existe, es carpeta) y devuelve su ruta real. */
  async resolveDir(hostId: string, raw: string): Promise<string> {
    const host = await this.ensure(hostId)
    const home = await host.home()
    const path = expandHome(raw, home)
    if (!path.startsWith('/')) throw new Error(`la ruta tiene que ser absoluta o empezar con ~: ${raw}`)
    const stat = await host.fs.stat(path)
    if (!stat) throw new Error(`no existe en ${this.nameOf(hostId)}: ${path}`)
    if (!stat.dir) throw new Error(`no es una carpeta: ${path}`)
    return host.fs.realpath(path)
  }

  /** Cómo lanza el daemon una terminal en el host: por la conexión compartida, con dtach si lo hay. */
  async terminalSpawn(hostId: string, sessionId: string, cwd: string): Promise<RemoteSpawn> {
    const host = await this.ensure(hostId)
    const tools = this.statusOf(hostId).tools
    const dtach = tools?.dtach === true ? (tools.dtachPath ?? 'dtach') : null
    return { file: host.transport.binary, args: [...host.transport.baseArgs(), '-tt', '--', remoteLine(terminalCommand(sessionId, cwd, dtach))], reconnect: dtach !== null }
  }

  /** ¿Sigue viva en el host la sesión dtach `<id>`? (para revivir: engancharse sin relanzar el agente). */
  async hasSession(hostId: string, sessionId: string): Promise<boolean> {
    const host = await this.ensure(hostId)
    if (!SESSION_ID.test(sessionId)) return false
    const r = await host.transport.run(sessionCheckCommand(sessionId), { timeoutMs: 10_000 })
    return r.code === 0
  }

  /**
   * Mata la sesión en el host (cerrar el pane no basta: dtach la mantendría viva). Sin conexión se
   * intenta conectar; si no se puede, la orden queda pendiente y se cumple al próximo `connected`
   * (si no, el agente seguiría corriendo para siempre en el host). Nunca lanza.
   */
  async killSession(hostId: string, sessionId: string): Promise<void> {
    if (!SESSION_ID.test(sessionId)) return
    let host: SshHost
    try {
      host = await this.ensure(hostId)
    } catch {
      this.queueKill(hostId, sessionId)
      return
    }
    try {
      await host.transport.run(killCommand(sessionId), { timeoutMs: 10_000 })
    } catch {
      this.queueKill(hostId, sessionId)
    }
  }

  /** Sesiones por matar en un host en cuanto conecte (tests y diagnóstico). */
  pendingKillsOf(hostId: string): string[] {
    return [...(this.pendingKills.get(hostId) ?? [])]
  }

  nameOf(id: string): string {
    return this.opts.store.get(id)?.name ?? id
  }

  private sshOf(id: string): SshHost {
    const existing = this.ssh.get(id)
    if (existing) return existing
    const spec = this.opts.store.get(id)
    if (!spec) throw new Error(`host desconocido: ${id}`)
    const host = this.opts.createSsh ? this.opts.createSsh(spec) : new SshHost(spec)
    this.ssh.set(id, host)
    return host
  }

  private queueKill(hostId: string, sessionId: string): void {
    const set = this.pendingKills.get(hostId) ?? new Set<string>()
    set.add(sessionId)
    this.pendingKills.set(hostId, set)
  }

  /** Cumple las órdenes de matar que quedaron pendientes mientras el host no conectaba. */
  private async flushKills(hostId: string): Promise<void> {
    const ids = this.pendingKills.get(hostId)
    if (!ids?.size) return
    this.pendingKills.delete(hostId)
    await Promise.all([...ids].map((id) => this.killSession(hostId, id)))
  }

  /**
   * Ya conectado: comprueba el ControlMaster. Vivo → nada que avisar. Caído pero el host responde →
   * se levanta otro y se vuelve a avisar `connected` (lo que se perdió con el corte se revive). Sin
   * respuesta → reconecta de cero (`connecting` → `error`/`connected`).
   */
  private async verify(id: string): Promise<HostStatus> {
    try {
      const reopened = await this.sshOf(id).transport.connect()
      return reopened ? this.setStatus(this.statusOf(id)) : this.statusOf(id)
    } catch {
      return this.doConnect(id)
    }
  }

  /**
   * Vuelve a correr el preflight de un host conectado (p. ej. tras instalar dtach): las terminales nuevas
   * lo usan desde ya; las que ya estaban abiertas siguen como estaban.
   */
  async rescan(id: string): Promise<HostStatus> {
    const host = await this.ensure(id)
    const info = await preflight(host.transport)
    return this.setStatus({ hostId: id, state: 'connected', error: null, home: info.home, system: info.system, tools: info.tools })
  }

  /**
   * Deja el CLI `omni` listo en el host: reenvía el socket de control a `~/.omni/run/app.sock` (Unix a
   * Unix, 0600, por el ControlMaster) y copia `omni`/`omni-mcp` a `~/.omni/bin`. El reenvío muere con
   * el master; se rehace en cada conexión. Requiere `node` en el host para correr el CLI.
   */
  private async setupCli(id: string, host: SshHost, home: string): Promise<void> {
    const cli = this.opts.cli
    if (!cli) return
    const bin = posix.join(home, BIN_DIR)
    await host.fs.mkdirp(bin)
    await host.fs.mkdirp(posix.join(home, RUN_DIR))
    for (const file of CLI_FILES) await host.fs.writeFile(posix.join(bin, file), await readFile(join(cli.binDir, file)))
    for (const [name, target] of Object.entries(CLI_WRAPPERS)) await host.fs.writeFile(posix.join(bin, name), `#!/bin/sh\n# Ruta real: el CLI compara argv[1] con su propia URL, y un home bajo un symlink no calzaría.\nexec node "$(cd "$(dirname "$0")" && pwd -P)/${target}" "$@"\n`)
    await host.transport.run(`chmod 700 ${shq(posix.join(home, RUN_DIR))} && chmod 755 ${Object.keys(CLI_WRAPPERS).map((n) => shq(posix.join(bin, n))).join(' ')}`, { timeoutMs: 10_000 })
    await host.transport.forwardSocket(posix.join(home, RUN_DIR, 'app.sock'), cli.controlSock)
    this.cliReady.add(id)
  }

  /** `true` si el CLI `omni` del host ya habla con este omni (Ajustes, tests). */
  cliReadyOn(id: string): boolean {
    return this.cliReady.has(id)
  }

  private async doConnect(id: string): Promise<HostStatus> {
    let host: SshHost
    try {
      host = this.sshOf(id)
    } catch (err) {
      return this.setStatus({ ...this.statusOf(id), state: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    this.setStatus({ ...this.statusOf(id), state: 'connecting', error: null })
    try {
      await host.transport.connect()
      const info = await preflight(host.transport)
      // El CLI no frena la conexión: si falla, las terminales funcionan igual y `omni` dice que no está abierto.
      void this.setupCli(id, host, info.home).catch((err: unknown) => console.warn(`[omni] CLI en ${host.transport.target}:`, err))
      return this.setStatus({ hostId: id, state: 'connected', error: null, home: info.home, system: info.system, tools: info.tools })
    } catch (err) {
      const error = err instanceof SshError || err instanceof Error ? err.message : String(err)
      return this.setStatus({ ...this.statusOf(id), state: 'error', error })
    }
  }

  private setStatus(status: HostStatus): HostStatus {
    this.status.set(status.hostId, status)
    this.listeners.forEach((l) => l(status))
    if (status.state === 'connected') void this.flushKills(status.hostId)
    return status
  }
}
