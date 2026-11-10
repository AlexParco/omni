import type { Exec } from '../exec'

/**
 * Dónde corren los procesos y viven los archivos de un workspace (ARCHITECTURE §3.26): este Mac
 * (`LocalHost`) o un servidor por SSH (`SshHost`). Los servicios piden `hosts.for(workspace)` en
 * vez de tocar `node:fs` o `child_process` directo, así el mismo código sirve para los dos.
 */
export interface Host {
  /** `local` o el id del host remoto. */
  readonly id: string
  readonly remote: boolean
  /** Corre un ejecutable con argumentos en el host (en remoto, comillado POSIX con `shq`; nunca concatenado a mano). */
  readonly exec: Exec
  /** Como `exec` pero dentro del shell de login del host (`"$SHELL" -lc`): ahí está el PATH de nvm/asdf/brew. */
  readonly execLogin: Exec
  readonly fs: HostFs
  /** `$HOME` del host. */
  home(): Promise<string>
}

/** Entrada de un directorio. */
export interface HostDirent {
  name: string
  dir: boolean
}

export interface HostStat {
  dir: boolean
  size: number
  /** ms desde epoch. */
  mtime: number
}

/** Sistema de archivos del host. Rutas absolutas POSIX del host. Los errores son humanos ("no existe: /x"). */
export interface HostFs {
  /** `null` si no existe. */
  stat(path: string): Promise<HostStat | null>
  readFile(path: string): Promise<Buffer>
  /** Escritura atómica (tmp + rename en la misma carpeta). Devuelve el mtime nuevo. */
  writeFile(path: string, data: Buffer | string): Promise<number>
  readdir(path: string): Promise<HostDirent[]>
  /** Ruta real (symlinks resueltos); rechaza si no existe. */
  realpath(path: string): Promise<string>
  mkdirp(path: string): Promise<void>
}

/**
 * Logs de un host remoto (§3.26): el mismo `.claude/` y `.codex/` de su `$HOME`, listados y leídos por
 * SSH. `list` devuelve los `.jsonl` de `root` tocados desde `since` (rutas relativas a `root`).
 */
export interface RemoteLogs {
  hostId: string
  home: string
  list(root: string, since: number): Promise<Array<{ rel: string; size: number; mtime: number; ino: number }>>
  /** Hasta `max` bytes desde `offset`. */
  read(path: string, offset: number, max: number): Promise<Buffer>
}

/**
 * Lo mínimo de un servidor para resolver y lanzar allá un servidor de lenguaje (§3.19b, §3.26): mirar
 * archivos, buscar binarios en su shell de login y armar el `ssh -T` que lo corre por stdio.
 */
export interface RemoteLspHost {
  /** Id del host: separa servidores de dos hosts con la misma ruta. */
  key: string
  exists(path: string): Promise<boolean>
  readText(path: string): Promise<string>
  /** Ruta absoluta del binario en el PATH de login del host, o `null`. */
  which(name: string): Promise<string | null>
  /** Comando local que corre `argv` en el host con ese cwd, con stdin/stdout de ida y vuelta. */
  launch(argv: string[], cwd: string): { command: string; args: string[] }
}
