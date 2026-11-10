import { stripAnsi } from '@/core/terminal-text'
import { omni } from '@/lib/omni'
import { pasteModeOf } from './paste-mode'
import { readScreen } from './screen-probe'

/** Nuevo agente: el texto se escribe cuando la TUI activó el bracketed paste y `session:data` lleva este tiempo callado, con tope. */
const SETTLE_MS = 2500
const SETTLE_CAP_MS = 8000
/** La TUI (Claude Code, Codex) pide bracketed paste al arrancar: señal de que su prompt está listo. */
const BRACKETED_PASTE_ON = '\x1b[?2004h'
const BRACKETED_PASTE_OFF = '\x1b[?2004l'

/**
 * Quita los caracteres de control de un texto que va a una PTY (conserva `\n` y `\t`). El HTML, el
 * CSS, la consola, la URL o el texto de una tarea vienen de fuera: un texto hostil podría meter
 * `\x1b[201~` para cerrar el bracketed paste y un `\r` para ejecutar lo que siga.
 */
export function sanitizeForPty(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/**
 * Escribe texto en una sesión. Con varias líneas va entre marcas de bracketed paste, así Claude Code,
 * Codex y zsh lo toman como un bloque en vez de ejecutar línea por línea. `submit` agrega ⏎.
 * El texto se sanea aquí mismo (`sanitizeForPty`): nada de lo que se escriba puede cerrar el pegado
 * ni meter un ⏎, venga de una captura, del quick open o de una tarea.
 */
/** El ⏎ va en un write aparte y un poco después: las TUI (Claude Code) tratan un chunk grande como pegado y se tragarían el ⏎ que viniera dentro. */
export const SUBMIT_DELAY_MS = 150

export function writeToSession(id: string, text: string, submit: boolean, bracketed = true): void {
  const clean = sanitizeForPty(text)
  const body = bracketed && clean.includes('\n') ? `\x1b[200~${clean}\x1b[201~` : clean
  if (body) omni.send('session:write', id, body)
  if (!submit) return
  if (!body) return omni.send('session:write', id, '\r')
  setTimeout(() => omni.send('session:write', id, '\r'), SUBMIT_DELAY_MS)
}

/**
 * Nuevo agente: su CLI tarda en pintar el prompt. Se escribe cuando la TUI ya pidió bracketed paste
 * (`\x1b[?2004h` en su salida) y `session:data` lleva `SETTLE_MS` callado. Si en `SETTLE_CAP_MS` no
 * llegó esa señal, se escribe en texto plano, SIN pegado y SIN ⏎ (delante puede haber un shell si el
 * agente murió: un prompt con ⏎ se ejecutaría como comando), y se avisa con `onFallback` a quien llamó
 * (el navegador lo muestra en su franja). Lo usan el envío de capturas y el widget de tareas.
 */
/** Espera tras enviar antes de mirar si el texto llegó a la pantalla, y reintentos máximos. */
export const VERIFY_MS = 1500
export const MAX_ATTEMPTS = 3

/** Trozo que debe verse en pantalla si el texto llegó (primeros caracteres de la primera línea). */
export function deliveryProbe(text: string): string {
  return normalize(sanitizeForPty(text).split('\n')[0]).slice(0, 16)
}

const normalize = (t: string): string => t.replace(/\s+/g, ' ').trim()

/**
 * ¿Hay que reintentar? Solo si la TUI reinició su entrada después del envío (apagó el modo pegado,
 * `ESC[?2004l`: la firma de una TUI que arranca y se traga lo escrito) Y el texto no se ve ni en la
 * pantalla (xterm) ni en lo que repintó. Un pegado largo que la TUI abrevia ("[Pasted text #1]") cuenta
 * como entregado. Ante la duda, entregado: un prompt repetido es peor que uno que hay que reescribir.
 */
export function shouldRetry(probe: string, screen: readonly string[] | null, echo: string): boolean {
  if (!probe || !echo.includes(BRACKETED_PASTE_OFF)) return false
  const clean = normalize(stripAnsi(echo))
  if (clean.includes(probe) || /Pasted text/i.test(clean)) return false
  if (screen && screen.some((l) => normalize(l).includes(probe) || /Pasted text/i.test(l))) return false
  return true
}

export function writeWhenSettled(id: string, text: string, onFallback?: () => void): void {
  let done = false
  // Si la TUI ya pidió el pegado antes de que nos suscribiéramos (p. ej. tras su diálogo de confianza), vale igual.
  let ready = pasteModeOf(id)
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const probe = deliveryProbe(text)
  let echo = ''
  const finish = (): void => {
    done = true
    clearTimeout(timer)
    clearTimeout(cap)
    off()
  }
  const fire = (bracketed: boolean): void => {
    if (done) return
    if (!bracketed) {
      finish()
      writeToSession(id, text, false, false)
      onFallback?.()
      return
    }
    attempts++
    echo = ''
    writeToSession(id, text, true, true)
    // Una TUI que arranca puede reiniciar su entrada y tragarse lo escrito: se mira la pantalla (o, sin
    // xterm montado, lo que la TUI repintó desde el envío) y se reintenta si el texto no aparece.
    setTimeout(() => {
      if (done) return
      if (!shouldRetry(probe, readScreen(id, 60), echo) || attempts >= MAX_ATTEMPTS) return finish()
      ready = false
      clearTimeout(timer)
      timer = setTimeout(() => fire(true), SETTLE_MS)
    }, VERIFY_MS)
  }
  const off = omni.on('session:data', (sid, data) => {
    if (sid !== id || done) return
    if (attempts > 0) echo = (echo + data).slice(-20_000)
    if (data.includes(BRACKETED_PASTE_ON)) ready = true
    clearTimeout(timer)
    if (ready || attempts > 0) timer = setTimeout(() => fire(true), SETTLE_MS)
  })
  if (ready) timer = setTimeout(() => fire(true), SETTLE_MS)
  const cap = setTimeout(() => {
    if (attempts === 0) fire(false)
  }, SETTLE_CAP_MS)
}
