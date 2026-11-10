import type { RemoteHost } from '@shared/types'
import type { Exec } from '../exec'
import type { Host, HostFs } from './types'
import { RemoteFs } from './remote-fs'
import { SshTransport, type SshTransportOptions } from './ssh'

/**
 * Un servidor por SSH como `Host`: procesos y archivos por el transporte (un ControlMaster por
 * host). `connect()` del transporte va antes de usarlo; si no, el primer comando abre el master.
 */
export class SshHost implements Host {
  readonly id: string
  readonly remote = true
  readonly transport: SshTransport
  readonly exec: Exec
  readonly execLogin: Exec
  readonly fs: HostFs
  private homeDir: Promise<string> | null = null

  constructor(host: RemoteHost, opts: SshTransportOptions = {}) {
    this.id = host.id
    this.transport = new SshTransport(host, opts)
    this.exec = this.transport.exec
    this.execLogin = this.transport.execLogin
    this.fs = new RemoteFs(this.transport)
  }

  /** `$HOME` remoto; se pide una vez y queda en caché (si falla, se vuelve a pedir la próxima). */
  home(): Promise<string> {
    if (!this.homeDir) {
      this.homeDir = this.transport.run('printf %s "$HOME"').then((r) => {
        const home = r.stdout.toString('utf8')
        if (r.code !== 0 || !home.startsWith('/')) throw new Error(`No se pudo leer $HOME en ${this.transport.target}`)
        return home
      })
      this.homeDir.catch(() => {
        this.homeDir = null
      })
    }
    return this.homeDir
  }
}
