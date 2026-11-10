import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RemoteHost } from '@shared/types'
import { exec as localExec, type Exec, type ExecResult } from '../exec'
import { loginWrap, remoteLine, shCommand } from './shq'

/**
 * Transporte SSH de un host remoto (ARCHITECTURE §3.26): el `ssh` del sistema (respeta
 * `~/.ssh/config`, ProxyJump, el agente de 1Password/Secretive y known_hosts) con UN ControlMaster
 * por host que maneja omni. Toda operación es `ssh <opciones> <destino> -- <línea POSIX>`, armada
 * solo con `shq`/`shCommand`; nunca pasa por un shell local.
 */

/** Por qué falló la conexión (no el comando remoto). */
export type SshFailureKind = 'auth' | 'resolve' | 'refused' | 'hostkey' | 'timeout' | 'unreachable' | 'other'

/** Fallo de ssh mismo (código 255): mensaje humano en español para la UI y el tipo para decidir reintentos. */
export class SshError extends Error {
  readonly kind: SshFailureKind
  constructor(kind: SshFailureKind, message: string) {
    super(message)
    this.name = 'SshError'
    this.kind = kind
  }
}

/** Resultado de `run`: salida binaria (para `readFile`) y stderr como texto. */
export interface RunResult {
  /** Código del comando remoto; `null` si se canceló por tiempo. Nunca 255 (eso es `SshError`). */
  code: number | null
  stdout: Buffer
  stderr: string
}

export interface RunOptions {
  /** Bytes que se escriben al stdin del comando remoto (binario seguro). */
  input?: Buffer
  /** Por defecto 30 s. */
  timeoutMs?: number
  /** Tope de stdout; pasarse es un error. Por defecto 64 MB. */
  maxBuffer?: number
}

export interface SshTransportOptions {
  /** Carpeta de los sockets de ControlMaster; por defecto `/tmp/omni-ssh-<uid>`. */
  controlDir?: string
  /** Ejecutable de ssh; por defecto `OMNI_SSH_BIN` o `ssh`. */
  sshBin?: string
  /** Inyectable en tests; por defecto el `exec` local. */
  exec?: Exec
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RUN_MAX_BUFFER = 64 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 30_000
/** `sun_path` de macOS: 104 bytes con el NUL. */
const MAX_SOCKET_PATH = 103
const READY = 'omni-ssh-ok'

/** Ejecutable de ssh: `OMNI_SSH_BIN` (tests y e2e apuntan al falso de `e2e/fake-ssh/ssh`) o el del PATH. */
export function sshBinary(): string {
  return process.env.OMNI_SSH_BIN || 'ssh'
}

/** Carpeta corta para los sockets: un unix socket no pasa de 104 bytes, así que nada de `~/Library/…`. */
export function defaultControlDir(): string {
  return `/tmp/omni-ssh-${process.getuid?.() ?? 'user'}`
}

/** Socket del ControlMaster de un destino: hash corto del destino (sin caracteres raros ni largo variable). */
export function controlPath(dir: string, target: string): string {
  const hash = createHash('sha256').update(target).digest('hex').slice(0, 16)
  const path = join(dir, hash)
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) throw new Error(`La ruta del socket de SSH es demasiado larga: ${path}`)
  return path
}

/**
 * Crea la carpeta de sockets con 0700 y verifica que sea nuestra: otro usuario con acceso a ella
 * podría colgarse de la conexión ya autenticada. Un symlink o una carpeta ajena es un error.
 */
export async function ensureControlDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} no es una carpeta (¿symlink?): no se usa para los sockets de SSH`)
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} pertenece a otro usuario: no se usa para los sockets de SSH`)
  if ((stat.mode & 0o077) !== 0) await fs.chmod(dir, 0o700)
}

/** Valida el destino: uno que empiece con `-` se leería como opción de ssh (`-oProxyCommand=…`). */
export function assertTarget(target: string): void {
  if (target === '' || target.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(target)) {
    throw new Error(`Destino SSH inválido: ${JSON.stringify(target)}`)
  }
}

/** Host de un destino `user@host` / `host` (sin usuario), para los mensajes. */
function hostOf(target: string): string {
  const at = target.lastIndexOf('@')
  return at === -1 ? target : target.slice(at + 1)
}

/**
 * Traduce el stderr de ssh (código 255) a un error humano. Pura: se prueba sin red. Los textos son
 * los de OpenSSH; si ninguno calza, la última línea útil.
 */
export function describeSshFailure(stderr: string, target: string): SshError {
  const host = hostOf(target)
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key is known/i.test(stderr)) {
    const changed = /Host key for (\S+) has changed/.exec(stderr)
    if (changed || /IDENTIFICATION HAS CHANGED/.test(stderr)) {
      const name = changed?.[1] ?? host
      return new SshError(
        'hostkey',
        `La llave de ${name} cambió desde la última conexión. Si es esperado (servidor reinstalado), bórrala con \`ssh-keygen -R ${name}\` y vuelve a conectar desde una terminal para aceptar la nueva.`
      )
    }
    return new SshError(
      'hostkey',
      `${host} no está en known_hosts. Conéctate una vez con \`ssh ${target}\` en una terminal para aceptar su llave (si la llave cambió: \`ssh-keygen -R ${host}\`).`
    )
  }
  if (/Permission denied/i.test(stderr)) {
    return new SshError(
      'auth',
      `${target} rechazó la autenticación. omni entra solo con llaves o el agente SSH (sin contraseña): agrega tu llave con \`ssh-copy-id ${target}\` o cárgala con \`ssh-add\`.`
    )
  }
  if (/Could not resolve hostname/i.test(stderr)) {
    return new SshError('resolve', `No se encuentra el host ${host}: revisa el nombre o tu DNS/VPN.`)
  }
  if (/Connection refused/i.test(stderr)) {
    return new SshError('refused', `${host} rechazó la conexión: ¿sshd está corriendo y el puerto es el correcto?`)
  }
  if (/timed out/i.test(stderr)) {
    return new SshError('timeout', `${host} no responde (se agotó el tiempo de conexión): revisa la red, la VPN o el firewall.`)
  }
  if (/No route to host|Network is unreachable|Host is down/i.test(stderr)) {
    return new SshError('unreachable', `No hay ruta hasta ${host}: revisa la red o la VPN.`)
  }
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const detail = lines.at(-1) ?? 'ssh terminó con código 255'
  return new SshError('other', `Falló la conexión SSH a ${target}: ${detail}`)
}

/** `-L` de un reenvío: solo en loopback del Mac (nada de exponer el servicio del VPS a la red local). */
export function forwardSpec(localPort: number, remotePort: number): string {
  for (const p of [localPort, remotePort]) if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`puerto inválido: ${p}`)
  return `127.0.0.1:${localPort}:localhost:${remotePort}`
}

/** Transporte de un host: ControlMaster, `exec` remoto con argumentos comillados y `run` binario. */
export class SshTransport {
  readonly target: string
  readonly controlPath: string
  private readonly controlDir: string
  private readonly sshBin: string
  private readonly localExec: Exec
  private readonly options: string[]

  constructor(host: RemoteHost, opts: SshTransportOptions = {}) {
    assertTarget(host.target)
    this.target = host.target
    this.controlDir = opts.controlDir ?? defaultControlDir()
    this.controlPath = controlPath(this.controlDir, host.target)
    this.sshBin = opts.sshBin ?? sshBinary()
    this.localExec = opts.exec ?? localExec
    this.options = [
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPersist=600',
      '-o', `ControlPath=${this.controlPath}`,
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      // Sin prompts: en v1 solo llaves o agente. Un prompt de contraseña colgaría el proceso.
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      // El socket de control reenviado al host (`forwardSocket`) reemplaza al de una conexión anterior.
      '-o', 'StreamLocalBindUnlink=yes'
    ]
  }

  /** Ejecutable de ssh que usa este transporte (las terminales lo lanzan con `baseArgs()`). */
  get binary(): string {
    return this.sshBin
  }

  /**
   * Opciones de omni + destino, para otros que lancen ssh por este mismo ControlMaster. Las
   * terminales: `[...baseArgs(), '-tt', '--', remoteLine(cmd)]` (OpenSSH sigue leyendo opciones tras el destino).
   */
  baseArgs(): string[] {
    return [...this.options, this.target]
  }

  /**
   * Deja lista la conexión: si el ControlMaster ya corre (`-O check`) no hace nada; si no, un
   * comando trivial lo levanta (ControlMaster=auto + ControlPersist lo deja en segundo plano con
   * su stdio en /dev/null). Rechaza con `SshError` si no se pudo autenticar o llegar. `true` si
   * hubo que levantar un master nuevo (el anterior se había caído o no existía).
   */
  async connect(): Promise<boolean> {
    await ensureControlDir(this.controlDir)
    const check = await this.raw([...this.options, '-O', 'check', this.target], { timeoutMs: 5_000 })
    if (check.code === 0) return false
    const probe = await this.run(`printf ${READY}`, { timeoutMs: CONNECT_TIMEOUT_MS })
    if (probe.code === null) throw new SshError('timeout', `${hostOf(this.target)} no respondió a tiempo.`)
    if (probe.code !== 0 || !probe.stdout.toString('utf8').includes(READY)) {
      const lines = probe.stderr.split('\n').map((l) => l.trim()).filter((l) => l !== '')
      throw new SshError('other', `${this.target} aceptó la conexión pero no pudo correr comandos: ${lines.at(-1) ?? `código ${probe.code}`}`)
    }
    return true
  }

  /**
   * Reenvía `127.0.0.1:<localPort>` del Mac a `localhost:<remotePort>` del host por el ControlMaster
   * (`ssh -O forward -L`): sin otra conexión ni otra autenticación. Vive lo que viva el master.
   */
  async forward(localPort: number, remotePort: number): Promise<void> {
    const spec = forwardSpec(localPort, remotePort)
    const r = await this.raw([...this.options, '-O', 'forward', '-L', spec, this.target], { timeoutMs: 10_000 })
    if (r.code === 255) throw describeSshFailure(r.stderr, this.target)
    if (r.code !== 0) throw new Error(`No se pudo reenviar el puerto ${remotePort}: ${r.stderr.trim().split('\n').at(-1) ?? `código ${r.code}`}`)
  }

  /**
   * Reenvía un socket Unix del Mac a una ruta del host (`ssh -O forward -R <host>:<mac>`): lo que se
   * conecte allá llega aquí. `StreamLocalBindUnlink` reemplaza un socket viejo en esa ruta.
   */
  async forwardSocket(remotePath: string, localPath: string): Promise<void> {
    if (!remotePath.startsWith('/') || !localPath.startsWith('/') || /[:\s]/.test(remotePath + localPath)) throw new Error('rutas de socket inválidas')
    const r = await this.raw([...this.options, '-O', 'forward', '-R', `${remotePath}:${localPath}`, this.target], { timeoutMs: 10_000 })
    if (r.code === 255) throw describeSshFailure(r.stderr, this.target)
    if (r.code !== 0) throw new Error(`No se pudo reenviar el socket de omni: ${r.stderr.trim().split('\n').at(-1) ?? `código ${r.code}`}`)
  }

  /** Deshace un `forward` (`ssh -O cancel -L`). Sin master o sin el reenvío no es un error. */
  async cancelForward(localPort: number, remotePort: number): Promise<void> {
    await this.raw([...this.options, '-O', 'cancel', '-L', forwardSpec(localPort, remotePort), this.target], { timeoutMs: 5_000 }).catch(() => undefined)
  }

  /** Cierra el ControlMaster (`ssh -O exit`). Sin master corriendo no es un error. */
  async close(): Promise<void> {
    await this.raw([...this.options, '-O', 'exit', this.target], { timeoutMs: 5_000 }).catch(() => undefined)
  }

  /**
   * `Exec` remoto: `cmd args…` comillados con `shCommand`, en `opts.cwd` del HOST REMOTO.
   * `opts.env` NO se reenvía (allowlist vacía): el entorno remoto es el que arma sshd y el
   * `~/.ssh/config` (SendEnv). Código 255 → `SshError` (falló ssh); otro código ≠ 0 es un resultado
   * normal del comando remoto, como en el `exec` local.
   */
  readonly exec: Exec = (cmd, args, opts) => this.execLine(shCommand([cmd, ...args], opts.cwd), opts.timeoutMs, opts.maxBuffer)

  /** Como `exec` pero dentro del shell de login remoto (`"$SHELL" -lc`): PATH de nvm/asdf/brew. */
  readonly execLogin: Exec = (cmd, args, opts) => this.execLine(loginWrap(shCommand([cmd, ...args], opts.cwd)), opts.timeoutMs, opts.maxBuffer)

  /**
   * Corre una línea POSIX ya armada (con `shq`/`shCommand`/`loginWrap`) con stdout binario y stdin
   * opcional. Para `readFile`/`writeFile`, que no caben en el `Exec` de texto. Rechaza con
   * `SshError` si ssh falla (255) o con el error de spawn si ssh no arranca. La línea la corre
   * `/bin/sh` aunque el shell del usuario sea fish o csh (`remoteLine`).
   */
  async run(cmdline: string, opts: RunOptions = {}): Promise<RunResult> {
    const result = await this.raw([...this.options, '-T', this.target, '--', remoteLine(cmdline)], opts)
    if (result.code === 255) throw describeSshFailure(result.stderr, this.target)
    return result
  }

  private async execLine(cmdline: string, timeoutMs: number, maxBuffer: number | undefined): Promise<ExecResult> {
    // `-n`: stdin desde /dev/null; el `exec` local deja el pipe abierto y un remoto que lea stdin se colgaría.
    const result = await this.localExec(this.sshBin, [...this.options, '-n', '-T', this.target, '--', remoteLine(cmdline)], {
      // cwd del proceso ssh LOCAL: cualquiera que exista; el remoto lo fija el `cd` de `shCommand`.
      cwd: homedir(),
      timeoutMs,
      maxBuffer
    })
    if (result.code === 255) throw describeSshFailure(result.stderr, this.target)
    return result
  }

  /** `spawn` de ssh sin shell, con stdout en Buffer y tiempo límite. No interpreta el código. */
  private raw(args: string[], opts: RunOptions): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBuffer = opts.maxBuffer ?? DEFAULT_RUN_MAX_BUFFER
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.sshBin, args, { cwd: homedir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let outBytes = 0
      let settled = false
      let timedOut = false
      let overflow = false
      let exitCode: number | null | undefined
      let graceTimer: NodeJS.Timeout | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(graceTimer)
        const stderr = Buffer.concat(err).toString('utf8')
        if (overflow) {
          reject(new Error(`La salida de ssh pasó el tope de ${Math.round(maxBuffer / 1024 / 1024)} MB`))
          return
        }
        if (timedOut) {
          resolvePromise({ code: null, stdout: Buffer.concat(out), stderr: `${stderr}\nssh cancelado a los ${Math.round(timeoutMs / 1000)} s` })
          return
        }
        resolvePromise({ code: exitCode ?? null, stdout: Buffer.concat(out), stderr })
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        outBytes += chunk.length
        if (outBytes > maxBuffer) {
          overflow = true
          child.kill('SIGTERM')
          return
        }
        out.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e)
      })
      child.on('exit', (code) => {
        exitCode = code
        // Si un nieto (p. ej. un master que no soltó el stdio) mantiene los pipes abiertos, no se
        // espera a que los cierre: el código ya está.
        graceTimer = setTimeout(finish, 500)
      })
      child.on('close', finish)
      // stdin: si el remoto termina sin leerlo todo, el EPIPE no es un error de omni.
      child.stdin.on('error', () => undefined)
      if (opts.input !== undefined) child.stdin.end(opts.input)
      else child.stdin.end()
    })
  }
}
