import type { AgentId, SessionInfo } from './types'

/**
 * Protocolo entre la app (cliente) y `omni-daemon` (dueño de los PTY), por socket Unix en
 * `~/.config/omni/daemon.sock`, una línea JSON por mensaje (NDJSON). Cerrar la app no mata nada:
 * el daemon sigue con sus sesiones y la app se reconecta al abrir (ARCHITECTURE §3.10).
 */
export const DAEMON_PROTOCOL = 1

/** Pedido de cliente a daemon: `id` correlaciona la respuesta. */
export type DaemonRequest =
  | { id: number; type: 'info' }
  | { id: number; type: 'list' }
  | { id: number; type: 'create'; input: DaemonCreateInput }
  | { id: number; type: 'write'; sessionId: string; data: string }
  | { id: number; type: 'resize'; sessionId: string; cols: number; rows: number }
  | { id: number; type: 'kill'; sessionId: string }
  /** Historial de salida reciente de una sesión (para repintar xterm al reconectar). */
  | { id: number; type: 'history'; sessionId: string }
  /** Proceso en primer plano por sesión (`{ [sessionId]: nombre }`). Un daemon viejo responde error. */
  | { id: number; type: 'foreground' }
  /** Pid del daemon y del shell de cada sesión (`{ root, sessions: { [sessionId]: pid } }`). Un daemon viejo responde error. */
  | { id: number; type: 'pids' }
  /** Desde ahora este cliente recibe los eventos `data`/`exit` de todas las sesiones. */
  | { id: number; type: 'subscribe' }
  /**
   * Mata todas las sesiones y apaga el daemon. `forget: true` ("Apagar todo") borra además el registro
   * de sesiones para que no se revivan; sin él (reinicio por build distinto) se reviven al volver.
   */
  | { id: number; type: 'shutdown'; forget?: boolean }
  /** Sesiones de un daemon anterior que murió sin "Apagar todo" (reinicio, caída): candidatas a revivir (§3.10b). */
  | { id: number; type: 'orphans' }
  /** Descarta sesiones huérfanas que no se van a revivir (su workspace ya no existe, ajuste apagado). */
  | { id: number; type: 'dismiss'; ids: string[] }

export interface DaemonCreateInput {
  /** Id que quiere el cliente (p. ej. para restaurar); el daemon lo respeta si está libre. */
  id?: string
  agent: AgentId
  workspaceId: string
  cwd: string
  /** Comando del agente que se escribe tras el primer prompt (`null` para shell). */
  command: string | null
  args?: string[]
  /** Id de la conversación del agente, para retomarla en el próximo reinicio. */
  resumeId?: string
  /**
   * Revive una huérfana con este mismo `id`: el daemon la saca de las huérfanas y, con
   * `restoreScreen`, pinta primero la pantalla guardada.
   */
  restored?: boolean
  restoreScreen?: boolean
  /**
   * Proceso a lanzar en vez del shell de login local: una terminal remota es `ssh -tt … dtach …`
   * (§3.26). Con `reconnect`, si sale con 255 (conexión caída) el daemon lo relanza igual.
   */
  spawn?: { file: string; args: string[]; reconnect: boolean }
}

/** Sesión que el daemon recuerda en `~/.config/omni/sessions.json` para revivirla tras un reinicio (§3.10b). */
export interface SavedSession {
  id: string
  agent: AgentId
  workspaceId: string
  cwd: string
  /** Cuándo se lanzó por primera vez (ms): con el cwd identifica la conversación de agentes sin `resumeId`. */
  createdAt: number
  args?: string[]
  resumeId?: string
}

export interface DaemonInfo {
  pid: number
  protocol: number
  /** Sello del build del daemon: si no coincide con el de la app, la app lo reinicia (sesiones perdidas; solo en dev). */
  build: string
  startedAt: number
}

export type DaemonResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

/** Eventos sin `id`, solo a clientes suscritos. `data` va en base64 para no romper el NDJSON. */
export type DaemonEvent =
  | { event: 'data'; sessionId: string; data: string }
  | { event: 'exit'; sessionId: string; code: number }
  | { event: 'created'; session: SessionInfo }

export type DaemonMessage = DaemonResponse | DaemonEvent

/** Bytes de salida que el daemon conserva por sesión para `history`. */
export const HISTORY_BYTES = 512 * 1024
