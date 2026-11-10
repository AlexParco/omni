/**
 * Normaliza lo que el usuario escribe en la barra de URL del navegador embebido.
 * Compartido entre main (al navegar) y renderer (para mostrar lo que se va a cargar).
 */

/** Esquemas que se respetan tal cual. */
const SCHEME_RE = /^(https?|about|data|chrome):/i
/** Cualquier otro `esquema://` (p. ej. `file://`) también se deja tal cual: main decide si lo deniega. */
const OTHER_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Hosts de desarrollo que van por `http://`: localhost, loopback, IPv4, `[::1]`,
 * y dominios `*.test` / `*.localhost`, con puerto y ruta opcionales.
 */
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(\.\d{1,3}){3}|[a-z0-9-]+(\.[a-z0-9-]+)*\.(test|localhost))(:\d+)?([/?#].*)?$/i

export function normalizeUrl(input: string): string {
  const value = input.trim()
  if (!value) return 'about:blank'
  if (SCHEME_RE.test(value) || OTHER_SCHEME_RE.test(value)) return value
  return (LOCAL_HOST_RE.test(value) ? 'http://' : 'https://') + value
}

/**
 * URL que puede abrirse en el navegador del sistema (`shell:openExternal`): solo `http:` y
 * `https:`. Devuelve la URL normalizada; tira con mensaje humano en cualquier otro caso
 * (`file:`, `javascript:`, texto suelto…).
 */
export function externalUrl(input: string): string {
  let parsed: URL
  try {
    parsed = new URL(input.trim())
  } catch {
    throw new Error(`no es una URL válida: ${input}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`solo se abren enlaces http(s), no ${parsed.protocol}`)
  return parsed.href
}
