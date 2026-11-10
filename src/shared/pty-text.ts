/**
 * Quita los caracteres de control de un texto que va a una PTY (conserva `\n` y `\t`). El texto
 * viene de fuera (una captura, una tarea, el socket de control): uno hostil podría meter
 * `\x1b[201~` para cerrar el bracketed paste y un `\r` para ejecutar lo que siga. La comparten el
 * renderer (`store/session-write.ts`) y main (`services/control.ts`).
 */
export function sanitizeForPty(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/**
 * Cuerpo listo para escribir en la PTY: saneado, entre marcas de bracketed paste si tiene varias
 * líneas (así Claude Code, Codex y zsh lo toman como un bloque) y con `\r` si `submit`.
 */
export function ptyPayload(text: string, submit: boolean, bracketed = true): string {
  const clean = sanitizeForPty(text)
  const body = bracketed && clean.includes('\n') ? `\x1b[200~${clean}\x1b[201~` : clean
  return submit ? `${body}\r` : body
}
