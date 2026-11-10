import type { SessionInfo, WhisperStatus } from '@shared/types'
import { rankTargets } from './capture-target'
import type { SessionStatus } from './sessions'

/**
 * Lógica pura del dictado (ARCHITECTURE §3.22), sin IPC ni DOM: formato del tiempo, elección y
 * rotación del destino, disponibilidad de whisper y las constantes de tiempo de las teclas.
 */

/** Dos pulsaciones de ⌥Space dentro de este margen = manos libres. */
export const TAP_MS = 400
/** Una grabación más corta que esto no se transcribe: fue un toque, no una frase. */
export const MIN_AUDIO_MS = 300
/** Cuánto se ve "Enviado a X" antes de cerrar el overlay. */
export const SENT_MS = 900
/** Comando que instala whisper.cpp; `C` lo copia desde el overlay. */
export const INSTALL_COMMAND = 'brew install whisper-cpp'
/** Tamaño aproximado del modelo base, para el pie del botón de descarga. */
export const MODEL_SIZE_LABEL = '~150 MB'

/** Por qué no se puede dictar ahora mismo. */
export type UnavailableReason = 'binary' | 'model' | 'mic' | 'target' | 'failed'

/** `0:07`, `1:23`, `12:05`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Qué le falta a whisper: primero el binario, luego el modelo; `null` si está todo. */
export function unavailableReason(status: WhisperStatus | null): 'binary' | 'model' | null {
  if (!status || !status.binary) return 'binary'
  if (!status.model) return 'model'
  return null
}

export function canDictate(status: WhisperStatus | null): boolean {
  return unavailableReason(status) === null
}

/** Texto del overlay para cada motivo. */
export function unavailableText(reason: UnavailableReason, detail: string | null = null): string {
  switch (reason) {
    case 'binary':
      return `Instala whisper (${INSTALL_COMMAND})`
    case 'model':
      return 'Falta el modelo de whisper'
    case 'mic':
      return detail ?? 'No se pudo abrir el micrófono'
    case 'target':
      return 'No hay ningún agente en este workspace al que dictar'
    case 'failed':
      return detail ? `La transcripción falló: ${detail}` : 'La transcripción falló'
  }
}

/**
 * Destinos posibles del dictado: las terminales del workspace, en el orden de "Enviar al agente"
 * (`rankTargets`), con la sesión con foco del layout como preferida.
 */
export function dictationTargets(sessions: SessionInfo[], workspaceId: string | null, statusOf: (id: string) => SessionStatus, focused: string | null): SessionInfo[] {
  if (!workspaceId) return []
  return rankTargets(sessions, workspaceId, statusOf, focused)
}

/**
 * Destino por defecto: la sesión con foco del layout si es una terminal (agente o shell, no un
 * navegador); si no, el primer destino rankeado del workspace.
 */
export function defaultTarget(sessions: SessionInfo[], workspaceId: string | null, statusOf: (id: string) => SessionStatus, focused: string | null): string | null {
  const focusedSession = focused ? sessions.find((s) => s.id === focused) : undefined
  if (focusedSession && focusedSession.agent !== 'browser' && focusedSession.workspaceId === workspaceId) return focusedSession.id
  return dictationTargets(sessions, workspaceId, statusOf, focused)[0]?.id ?? null
}

/** Siguiente destino en la lista, circular; con el actual fuera de la lista, el primero. */
export function nextTarget(ids: string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null
  const i = current ? ids.indexOf(current) : -1
  if (i === -1) return ids[0]
  return ids[(i + delta + ids.length) % ids.length]
}

/** Una pulsación corta es un toque, no una frase sostenida. */
export function isTap(heldMs: number): boolean {
  return heldMs < TAP_MS
}

/** Texto de whisper listo para el prompt: sin espacios ni saltos sobrantes. */
export function cleanTranscript(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
