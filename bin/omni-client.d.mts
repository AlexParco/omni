/** Tipos de `omni-client.mjs` para los tests en TypeScript. */
export interface ControlReply {
  ok: boolean
  result?: unknown
  error?: string
}
export class NotOpenError extends Error {
  code: 'NOT_OPEN'
}
export function controlSockPath(env?: NodeJS.ProcessEnv): string
export function sendCommand(sock: string, command: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<ControlReply>
