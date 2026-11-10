/**
 * Lector de la pantalla renderizada de una sesión, inyectado por `terminal-host` al cargar. Vive
 * aparte para que `session-write.ts` pueda verificar entregas sin importar xterm (y sus tests corran
 * en Node). Sin lector registrado, `readScreen` devuelve `null` y no se verifica nada.
 */
type Reader = (sessionId: string, n: number) => string[] | null
let reader: Reader | null = null

export function setScreenReader(fn: Reader | null): void {
  reader = fn
}

export function readScreen(sessionId: string, n: number): string[] | null {
  return reader ? reader(sessionId, n) : null
}
