import type { SavedSession } from '@shared/daemon'
import type { AgentDef, SessionInfo, Workspace } from '@shared/types'
import { PtyHost } from '../../daemon/ptys'
import type { CreateOptions, DataListener, ExitListener, SessionBackend, SessionPids } from './session-backend'

export { agentCommand } from '../../daemon/ptys'

/**
 * Backend en proceso (`OMNI_DAEMON=0`): los PTY viven en main y mueren con la app. Sobreviven
 * a recargas del renderer, pero no a cerrar omni; para eso está `DaemonClient`. Comparte el
 * `PtyHost` del daemon, así que `history` funciona igual.
 */
export class PtyManager implements SessionBackend {
  private readonly host = new PtyHost()

  async start(): Promise<void> {
    // Nada que conectar.
  }

  async create(agent: AgentDef, workspace: Workspace, args?: string[], opts: CreateOptions = {}): Promise<SessionInfo> {
    const command = opts.command === undefined ? agent.command : opts.command
    return this.host.create({ id: opts.id, agent: agent.id, workspaceId: workspace.id, cwd: workspace.cwd ?? workspace.path, command, args, resumeId: opts.resumeId, spawn: opts.spawn })
  }

  remoteReady(): boolean {
    return true
  }

  /** En proceso no hay daemon que quede viejo. */
  outdated(): boolean {
    return false
  }

  async upgrade(): Promise<void> {
    // Nada que actualizar.
  }

  /** En proceso las sesiones mueren con la app a propósito (pruebas, depuración): no hay nada que revivir. */
  async orphans(): Promise<SavedSession[]> {
    return []
  }

  async dismiss(): Promise<void> {
    // Sin registro en disco.
  }

  async list(): Promise<SessionInfo[]> {
    return this.host.list()
  }

  async write(id: string, data: string): Promise<void> {
    this.host.write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.host.resize(id, cols, rows)
  }

  kill(id: string): void {
    this.host.kill(id)
  }

  async killAll(): Promise<void> {
    this.host.killAll()
  }

  async shutdown(): Promise<void> {
    this.host.killAll()
  }

  async history(id: string): Promise<string> {
    return this.host.history(id)
  }

  async foreground(): Promise<Record<string, string>> {
    return this.host.foreground()
  }

  async pids(): Promise<SessionPids> {
    return { root: process.pid, sessions: this.host.pids() }
  }

  onData(l: DataListener): () => void {
    return this.host.onData(l)
  }

  onExit(l: ExitListener): () => void {
    return this.host.onExit(l)
  }
}
