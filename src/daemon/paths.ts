import { homedir } from 'node:os'
import { join } from 'node:path'

/** Rutas del daemon bajo `~/.config/omni`. Compartidas por el servidor y el cliente (main). */
export interface DaemonPaths {
  dir: string
  /** Socket Unix donde escucha el daemon. */
  sock: string
  /** `{ pid, build, startedAt }` del daemon vivo; informativo (la verdad es el socket). */
  info: string
  /** Log mínimo, truncado cuando pasa de `LOG_MAX_BYTES`. */
  log: string
}

export const LOG_MAX_BYTES = 1024 * 1024

export function daemonPaths(dir = join(homedir(), '.config', 'omni')): DaemonPaths {
  return { dir, sock: join(dir, 'daemon.sock'), info: join(dir, 'daemon.json'), log: join(dir, 'daemon.log') }
}
