/**
 * Framing NDJSON del protocolo daemon ↔ app (`@shared/daemon`): un objeto JSON por línea.
 * Sin dependencias de Node ni de Electron: lo usan el servidor, el cliente y los tests.
 */

/** Serializa un mensaje como línea NDJSON (con su `\n` final). */
export function encodeLine(message: object): string {
  return JSON.stringify(message) + '\n'
}

/** Parsea una línea; `null` si no es JSON válido o no es un objeto. */
export function decodeLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Acumula trozos del socket y devuelve solo las líneas completas. Lo que queda tras el último
 * `\n` espera al siguiente trozo. Las líneas vacías se descartan.
 */
export class LineSplitter {
  private rest = ''

  push(chunk: Buffer | string): string[] {
    this.rest += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const parts = this.rest.split('\n')
    this.rest = parts.pop() ?? ''
    return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p)).filter((p) => p !== '')
  }

  /** Bytes pendientes sin `\n` (p. ej. para diagnosticar un cliente que cortó a mitad de línea). */
  get pending(): string {
    return this.rest
  }
}
