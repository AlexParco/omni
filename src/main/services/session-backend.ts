import type { SavedSession } from '@shared/daemon'
import type { AgentDef, SessionInfo, Workspace } from '@shared/types'

/** Pids de las sesiones para el widget de puertos (§3.24). `root` null = no se sabe (daemon caído). */
export interface SessionPids {
  root: number | null
  sessions: Record<string, number>
}

/** Cómo crear una sesión más allá del agente y su workspace (§3.10b). */
export interface CreateOptions {
  /** Id fijo: revivir una sesión con el mismo id deja válido el layout guardado. */
  id?: string
  /** Comando a escribir en el shell en vez de `agent.command` (p. ej. `claude --resume <id>`); `null` = shell pelado. */
  command?: string | null
  /** Conversación del agente a recordar para el próximo reinicio. */
  resumeId?: string
  /** Revive una huérfana: el daemon la saca de la lista y conserva su `createdAt` original. */
  restored?: boolean
  /** Pintar primero la pantalla guardada (agente que no retomó conversación, o shell). */
  restoreScreen?: boolean
  /** Terminal remota: el proceso que lanza el daemon (`ssh -tt … dtach …`) y si se reconecta solo (§3.26). */
  spawn?: { file: string; args: string[]; reconnect: boolean }
}

export type DataListener = (id: string, data: string) => void
export type ExitListener = (id: string, code: number) => void

/**
 * Quien pone los PTY detrás de `session:*`. Dos implementaciones con la misma cara:
 * `DaemonClient` (por defecto: las sesiones viven en `omni-daemon` y sobreviven a la app) y
 * `PtyManager` (`OMNI_DAEMON=0`: en proceso, mueren con la app). `main/index.ts` elige.
 */
export interface SessionBackend {
  /** Conecta o prepara lo que haga falta antes de atender pedidos. */
  start(): Promise<void>
  /** `args` son flags extra del agente (p. ej. `--dangerously-skip-permissions`): van tras el comando. */
  create(agent: AgentDef, workspace: Workspace, args?: string[], opts?: CreateOptions): Promise<SessionInfo>
  /** Sesiones de un daemon anterior que murió sin "Apagar todo"; `[]` si el backend no las guarda. */
  orphans(): Promise<SavedSession[]>
  /** `false` si el dueño de los PTY no sabe lanzar terminales remotas (daemon de otro build, §3.26). */
  remoteReady(): boolean
  /** El daemon conectado es de otro build: los arreglos del daemon no llegan hasta `upgrade` (§3.10c). */
  outdated(): boolean
  /**
   * Cambia el daemon por uno de este build: congela el registro, lo apaga (sus procesos mueren) y
   * levanta otro. Las salidas de ese apagado no se avisan: quien llama revive las sesiones con su mismo id.
   */
  upgrade(): Promise<void>
  /** Olvida huérfanas que no se van a revivir. */
  dismiss(ids: string[]): Promise<void>
  list(): Promise<SessionInfo[]>
  /** Resuelve cuando el dueño del PTY aceptó la escritura; rechaza si no hay daemon. */
  write(id: string, data: string): Promise<void>
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  /** Mata las sesiones una a una; el backend sigue utilizable. */
  killAll(): Promise<void>
  /**
   * Mata todo y apaga el dueño de los PTY (el daemon, si lo hay). Después no se atienden más pedidos.
   * `forget` ("Apagar todo") borra el registro para no revivir nada; sin él se reviven al volver.
   */
  shutdown(forget?: boolean): Promise<void>
  /** Salida reciente de una sesión (texto), para repintar xterm al reconectar. Vacío si no hay. */
  history(id: string): Promise<string>
  /** Proceso en primer plano de cada sesión viva; `{}` si el dueño de los PTY no lo soporta. */
  foreground(): Promise<Record<string, string>>
  /** Quién es dueño de los procesos de las sesiones: pid del dueño de los PTY (`root`) y del shell de cada una. */
  pids(): Promise<SessionPids>
  onData(l: DataListener): () => void
  onExit(l: ExitListener): () => void
}
