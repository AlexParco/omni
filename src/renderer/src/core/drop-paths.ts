/**
 * Rutas soltadas sobre una terminal, como las pega Terminal.app o iTerm: cada una escapada para el
 * shell (barra invertida antes de espacios y metacaracteres) y separadas por un espacio. Claude Code
 * reconoce así una imagen arrastrada y la adjunta.
 */

/** Caracteres que el shell interpreta y que Terminal.app escapa al soltar una ruta. */
const SHELL_SPECIAL = /[ \t\n\\'"`$!&*()|;<>?[\]{}#~^]/g

/**
 * Archivo soltado que el agente no va a poder leer: la miniatura flotante de una captura de macOS
 * llega como `…/TemporaryItems/NSIRD_screencaptureui_…/Captura.png`, una carpeta que macOS solo abre a
 * la app que recibió el arrastre (omni) y no a los procesos del daemon (Claude Code respondía
 * "Operation not permitted" y la pegaba como texto). Además se borra al rato. Exportada para tests.
 */
export function isEphemeralDrop(path: string): boolean {
  return /\/TemporaryItems\//.test(path) || /\/NSIRD_[^/]*\//.test(path)
}

export function shellEscapePath(path: string): string {
  return path.replace(SHELL_SPECIAL, (c) => `\\${c}`)
}

/** Texto a pegar: rutas escapadas separadas por espacio, con un espacio final para seguir escribiendo. */
export function dropText(paths: readonly string[]): string {
  const clean = paths.filter((p) => p !== '')
  return clean.length ? `${clean.map(shellEscapePath).join(' ')} ` : ''
}
