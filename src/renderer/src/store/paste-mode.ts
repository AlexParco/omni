/**
 * Modo "bracketed paste" por sesión, leído del stream (`ESC[?2004h` lo enciende, `ESC[?2004l` lo apaga).
 * Las TUI (Claude Code, Codex, zsh en el prompt) lo encienden al estar listas para leer: es la señal
 * que usa `writeWhenSettled` para saber si puede mandar un prompt con ⏎. Vive aparte del store de
 * sesiones para que `session-write.ts` lo lea sin importar el store (ciclo).
 */
const PASTE_ON = '\x1b[?2004h'
const PASTE_OFF = '\x1b[?2004l'
const modes = new Map<string, boolean>()

/** Anota el último cambio de modo que trae el chunk. */
export function notePasteMode(id: string, data: string): void {
  const on = data.lastIndexOf(PASTE_ON)
  const off = data.lastIndexOf(PASTE_OFF)
  if (on === -1 && off === -1) return
  modes.set(id, on > off)
}

export function pasteModeOf(id: string): boolean {
  return modes.get(id) === true
}

export function forgetPasteMode(id: string): void {
  modes.delete(id)
}
