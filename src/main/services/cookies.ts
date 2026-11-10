import { execFile } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CookiesSetDetails } from 'electron'
import type { CookieImportResult, CookieImportSource } from '@shared/types'

/**
 * Importación de cookies de otros navegadores al perfil de una vista (ARCHITECTURE §3.9).
 * Todo lo que parsea y normaliza es puro (y con tests); la IO (archivos, `sqlite3`, llavero)
 * vive en `readSourceCookies` y en `importCookies` solo entra un `CookieSink` (la API de
 * `session.cookies`), así nada de aquí instancia Electron.
 */

export type SameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict'

/** Cookie tal como la da cualquier fuente, antes de normalizarla a Electron. */
export interface RawCookie {
  name: string
  value: string
  /** Con punto inicial = vale para subdominios (cookie de dominio); sin él = solo ese host. */
  domain: string
  path: string
  /** Segundos Unix; ausente = cookie de sesión. */
  expires?: number
  secure: boolean
  httpOnly: boolean
  sameSite?: SameSite
}

/** Lo único que `importCookies` necesita de `session.cookies`. */
export interface CookieSink {
  set(details: CookiesSetDetails): Promise<void>
}

export const GOOGLE_NOTE = 'Las sesiones de Google no se importan: inicia sesión en Google dentro de omni.'

const execFileAsync = promisify(execFile)
const SQLITE3 = '/usr/bin/sqlite3'
const SECURITY = '/usr/bin/security'
/** Salt y vueltas fijas de Chromium en macOS (`os_crypt_mac.mm`). */
const CHROMIUM_SALT = 'saltysalt'
const CHROMIUM_ITERATIONS = 1003
const CHROMIUM_KEY_BYTES = 16
const CHROMIUM_IV = Buffer.alloc(16, 0x20)
/** Diferencia entre la época de Chromium (1601) y la Unix (1970), en segundos. */
const CHROMIUM_EPOCH_OFFSET = 11644473600
/** Época de Core Foundation (2001-01-01) en segundos Unix, para Safari. */
const MAC_EPOCH_OFFSET = 978307200

type ChromiumSource = Exclude<CookieImportSource, 'firefox' | 'safari' | 'file'>

/** Dónde guarda cada Chromium su base de cookies (relativo a `~`) y qué ítem del llavero protege la clave. */
export const CHROMIUM_SOURCES: Record<ChromiumSource, { name: string; db: string; keychain: string }> = {
  chrome: { name: 'Chrome', db: 'Library/Application Support/Google/Chrome/Default/Cookies', keychain: 'Chrome Safe Storage' },
  arc: { name: 'Arc', db: 'Library/Application Support/Arc/User Data/Default/Cookies', keychain: 'Arc Safe Storage' },
  brave: { name: 'Brave', db: 'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies', keychain: 'Brave Safe Storage' },
  edge: { name: 'Microsoft Edge', db: 'Library/Application Support/Microsoft Edge/Default/Cookies', keychain: 'Microsoft Edge Safe Storage' }
}
const FIREFOX_PROFILES = 'Library/Application Support/Firefox/Profiles'
const SAFARI_COOKIES = 'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies'

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isChromiumSource(source: CookieImportSource): source is ChromiumSource {
  return source in CHROMIUM_SOURCES
}

/* ---------- normalización (pura) ---------- */

/** `sameSite` de cualquier fuente (texto o número de Chromium/Firefox) al vocabulario de Electron. */
export function sameSiteOf(x: unknown): SameSite | undefined {
  if (typeof x === 'string') {
    const s = x.toLowerCase()
    if (s === 'none' || s === 'no_restriction') return 'no_restriction'
    if (s === 'lax') return 'lax'
    if (s === 'strict') return 'strict'
    if (s === 'unspecified') return 'unspecified'
    return undefined
  }
  return undefined
}

/**
 * `Electron.CookiesSetDetails` de una cookie cruda. La URL es `https://<host>/` (sin el punto
 * inicial); `domain` solo va cuando la cookie era de dominio: una host-only (p. ej. `__Host-`)
 * con `domain` dejaría de serlo y Chromium la rechazaría.
 */
export function toSetDetails(c: RawCookie): CookiesSetDetails {
  const host = c.domain.replace(/^\./, '')
  const path = c.path.startsWith('/') ? c.path : '/'
  const details: CookiesSetDetails = { url: `https://${host}/`, name: c.name, value: c.value, path, secure: c.secure, httpOnly: c.httpOnly }
  if (c.domain.startsWith('.')) details.domain = c.domain
  if (c.expires !== undefined) details.expirationDate = c.expires
  if (c.sameSite) details.sameSite = c.sameSite
  return details
}

/** Mete las cookies una por una contando importadas y saltadas (sin nombre o dominio, caducadas, o rechazadas por Chromium). */
export async function importCookies(raw: RawCookie[], sink: CookieSink, now = Date.now() / 1000): Promise<CookieImportResult> {
  let imported = 0
  let skipped = 0
  for (const c of raw) {
    if (!c.name || !c.domain.replace(/^\./, '') || (c.expires !== undefined && c.expires <= now)) {
      skipped++
      continue
    }
    try {
      await sink.set(toSetDetails(c))
      imported++
    } catch {
      skipped++
    }
  }
  return { imported, skipped, note: GOOGLE_NOTE }
}

/* ---------- archivo: cookies.txt de Netscape o JSON (puro) ---------- */

/**
 * Formato Netscape (curl, wget, extensiones "Get cookies.txt"): 7 columnas separadas por
 * tabulador (dominio, subdominios, path, secure, caducidad, nombre, valor). Las líneas `#` son
 * comentario salvo el prefijo `#HttpOnly_`, que marca la cookie como httpOnly.
 */
export function parseNetscape(text: string): RawCookie[] {
  const out: RawCookie[] = []
  for (const rawLine of text.split('\n')) {
    let line = rawLine.replace(/\r$/, '')
    if (line.trim() === '') continue
    let httpOnly = false
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true
      line = line.slice('#HttpOnly_'.length)
    } else if (line.startsWith('#')) {
      continue
    }
    const cols = line.split('\t')
    if (cols.length < 7) continue
    const [domain = '', , path = '/', secure = '', expires = '', name = '', ...rest] = cols
    const exp = Number(expires)
    const cookie: RawCookie = { domain, path: path || '/', secure: secure.toUpperCase() === 'TRUE', name, value: rest.join('\t'), httpOnly }
    if (Number.isFinite(exp) && exp > 0) cookie.expires = exp
    out.push(cookie)
  }
  return out
}

/**
 * JSON exportado (Cookie-Editor, EditThisCookie, Playwright…): array de objetos (o `{ cookies: [...] }`)
 * con `name`, `value`, `domain`, `path`, `expires`/`expirationDate` (segundos Unix; ≤ 0 = sesión),
 * `secure`, `httpOnly`, `sameSite`.
 */
export function parseJsonCookies(text: string): RawCookie[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('el archivo no es JSON válido')
  }
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.cookies) ? data.cookies : null
  if (!list) throw new Error('el JSON tiene que ser un array de cookies')
  const out: RawCookie[] = []
  for (const item of list) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.domain !== 'string') continue
    const cookie: RawCookie = {
      name: item.name,
      value: typeof item.value === 'string' ? item.value : String(item.value ?? ''),
      domain: item.domain,
      path: typeof item.path === 'string' && item.path !== '' ? item.path : '/',
      secure: item.secure === true,
      httpOnly: item.httpOnly === true || item.httponly === true
    }
    const exp = item.expires ?? item.expirationDate ?? item.expiry
    if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0 && item.session !== true) cookie.expires = exp
    const sameSite = sameSiteOf(item.sameSite)
    if (sameSite) cookie.sameSite = sameSite
    out.push(cookie)
  }
  return out
}

/** Un archivo que empieza por `[` o `{` es JSON; lo demás se lee como cookies.txt. */
export function parseCookieFile(text: string): RawCookie[] {
  const first = text.trimStart()[0]
  return first === '[' || first === '{' ? parseJsonCookies(text) : parseNetscape(text)
}

/* ---------- Chromium: descifrado y filas (puro) ---------- */

/** Clave AES-128 a partir de la contraseña del llavero: PBKDF2-SHA1, salt `saltysalt`, 1003 vueltas. */
export function deriveChromiumKey(password: string): Buffer {
  return pbkdf2Sync(password, CHROMIUM_SALT, CHROMIUM_ITERATIONS, CHROMIUM_KEY_BYTES, 'sha1')
}

/** `true` si los 32 bytes iniciales no parecen texto de cookie (Chrome ≥ 130 antepone un SHA-256 binario). */
function looksBinary(prefix: Buffer): boolean {
  for (const b of prefix) if (b < 0x20 || b > 0x7e) return true
  return false
}

/**
 * Descifra un `encrypted_value` `v10` (AES-128-CBC, IV de 16 espacios, PKCS7). Chrome ≥ 130
 * antepone al valor el SHA-256 del `host_key`: si está, se recorta (también si los 32 bytes
 * iniciales no son texto, por si el hash no cuadra). `null` si el esquema no es `v10` o el
 * descifrado falla (clave de otro perfil, archivo corrupto).
 */
export function decryptChromiumValue(encrypted: Buffer, key: Buffer, hostKey: string): string | null {
  if (encrypted.length === 0) return ''
  if (encrypted.subarray(0, 3).toString('latin1') !== 'v10') return null
  let plain: Buffer
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, CHROMIUM_IV)
    plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
  } catch {
    return null
  }
  if (plain.length >= 32) {
    const prefix = plain.subarray(0, 32)
    if (prefix.equals(createHash('sha256').update(hostKey).digest()) || looksBinary(prefix)) plain = plain.subarray(32)
  }
  return plain.toString('utf8')
}

/** Fila de la tabla `cookies` de Chromium tal como la da `sqlite3 -json` (el BLOB va en hex por la consulta). */
export interface ChromiumRow {
  host_key: string
  name: string
  value: string
  encrypted_hex: string
  path: string
  /** Microsegundos desde 1601; 0 = sesión. */
  expires_utc: number
  is_secure: number
  is_httponly: number
  /** -1 sin especificar, 0 none, 1 lax, 2 strict. */
  samesite: number
}

const CHROMIUM_SQL = 'SELECT host_key, name, value, hex(encrypted_value) AS encrypted_hex, path, expires_utc, is_secure, is_httponly, samesite FROM cookies'

function chromiumSameSite(n: number): SameSite | undefined {
  switch (n) {
    case 0:
      return 'no_restriction'
    case 1:
      return 'lax'
    case 2:
      return 'strict'
    default:
      return undefined
  }
}

/** Convierte filas de Chromium a cookies crudas descifrando con `key`; las que no se pueden descifrar se omiten. */
export function chromiumRowsToCookies(rows: ChromiumRow[], key: Buffer): RawCookie[] {
  const out: RawCookie[] = []
  for (const row of rows) {
    const encrypted = Buffer.from(row.encrypted_hex ?? '', 'hex')
    const value = encrypted.length > 0 ? decryptChromiumValue(encrypted, key, row.host_key) : row.value
    if (value === null) continue
    const cookie: RawCookie = { name: row.name, value, domain: row.host_key, path: row.path || '/', secure: row.is_secure === 1, httpOnly: row.is_httponly === 1 }
    if (row.expires_utc > 0) cookie.expires = row.expires_utc / 1e6 - CHROMIUM_EPOCH_OFFSET
    const sameSite = chromiumSameSite(row.samesite)
    if (sameSite) cookie.sameSite = sameSite
    out.push(cookie)
  }
  return out
}

/* ---------- Firefox: filas en claro (puro) ---------- */

export interface FirefoxRow {
  host: string
  name: string
  value: string
  path: string
  /** Segundos Unix; 0 = sesión. */
  expiry: number
  isSecure: number
  isHttpOnly: number
  /** 0 none, 1 lax, 2 strict. */
  sameSite: number
}

const FIREFOX_SQL = 'SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies'

export function firefoxRowsToCookies(rows: FirefoxRow[]): RawCookie[] {
  return rows.map((row) => {
    const cookie: RawCookie = { name: row.name, value: row.value, domain: row.host, path: row.path || '/', secure: row.isSecure === 1, httpOnly: row.isHttpOnly === 1 }
    if (row.expiry > 0) cookie.expires = row.expiry
    // 0 en Firefox es "None" pero también lo que graba sin atributo: se deja sin especificar para
    // que Chromium no rechace las que no son `secure`.
    if (row.sameSite === 1) cookie.sameSite = 'lax'
    else if (row.sameSite === 2) cookie.sameSite = 'strict'
    return cookie
  })
}

/* ---------- Safari: Cookies.binarycookies (puro) ---------- */

/**
 * Formato binarycookies: cabecera `cook`, nº de páginas y sus tamaños (big-endian); cada página
 * lleva nº de cookies y sus offsets (little-endian); cada cookie, tamaño, flags (1 secure,
 * 4 httpOnly), offsets de dominio/nombre/path/valor (cadenas terminadas en NUL, relativas a la
 * cookie) y fechas en segundos desde 2001 (double LE). Las inconsistencias se saltan sin tirar.
 */
export function parseBinaryCookies(buf: Buffer): RawCookie[] {
  if (buf.length < 8 || buf.subarray(0, 4).toString('latin1') !== 'cook') throw new Error('el archivo no es un Cookies.binarycookies de Safari')
  const pages = buf.readUInt32BE(4)
  const out: RawCookie[] = []
  let pageStart = 8 + pages * 4
  for (let p = 0; p < pages; p++) {
    const size = buf.readUInt32BE(8 + p * 4)
    if (pageStart + size > buf.length) break
    out.push(...parseBinaryPage(buf.subarray(pageStart, pageStart + size)))
    pageStart += size
  }
  return out
}

function parseBinaryPage(page: Buffer): RawCookie[] {
  const out: RawCookie[] = []
  if (page.length < 8 || page.readUInt32BE(0) !== 0x00000100) return out
  const count = page.readUInt32LE(4)
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 4
    if (at + 4 > page.length) break
    const offset = page.readUInt32LE(at)
    if (offset + 56 > page.length) continue
    const size = page.readUInt32LE(offset)
    if (size < 56 || offset + size > page.length) continue
    const cookie = parseBinaryCookie(page.subarray(offset, offset + size))
    if (cookie) out.push(cookie)
  }
  return out
}

function cString(buf: Buffer, offset: number): string | null {
  if (offset <= 0 || offset >= buf.length) return null
  const end = buf.indexOf(0, offset)
  return buf.subarray(offset, end === -1 ? buf.length : end).toString('utf8')
}

function parseBinaryCookie(c: Buffer): RawCookie | null {
  const flags = c.readUInt32LE(8)
  const domain = cString(c, c.readUInt32LE(16))
  const name = cString(c, c.readUInt32LE(20))
  const path = cString(c, c.readUInt32LE(24))
  const value = cString(c, c.readUInt32LE(28))
  if (domain === null || name === null) return null
  const expiry = c.readDoubleLE(40)
  const cookie: RawCookie = { name, value: value ?? '', domain, path: path || '/', secure: (flags & 1) !== 0, httpOnly: (flags & 4) !== 0 }
  if (Number.isFinite(expiry) && expiry > 0) cookie.expires = expiry + MAC_EPOCH_OFFSET
  return cookie
}

/* ---------- IO: localizar, copiar y leer cada fuente ---------- */

/** Ruta de la base de cookies de una fuente Chromium; exportado para tests y mensajes. */
export function chromiumCookiePath(source: ChromiumSource, home = homedir()): string {
  return join(home, CHROMIUM_SOURCES[source].db)
}

/** `cookies.sqlite` del perfil de Firefox con actividad más reciente; `null` si no hay ninguno. */
export function firefoxCookiePath(home = homedir()): string | null {
  const root = join(home, FIREFOX_PROFILES)
  if (!existsSync(root)) return null
  let best: { path: string; mtime: number } | null = null
  for (const dir of readdirSync(root)) {
    const path = join(root, dir, 'cookies.sqlite')
    if (!existsSync(path)) continue
    const mtime = statSync(path).mtimeMs
    if (!best || mtime > best.mtime) best = { path, mtime }
  }
  return best?.path ?? null
}

/**
 * Lee las cookies de la fuente pedida. Errores con mensaje humano: archivo que no existe, llavero
 * que deniega, `sqlite3` que falla. `path` solo cuenta con `file`.
 */
export async function readSourceCookies(source: CookieImportSource, path?: string, home = homedir()): Promise<RawCookie[]> {
  if (isChromiumSource(source)) return readChromium(source, home)
  if (source === 'firefox') {
    const db = firefoxCookiePath(home)
    if (!db) throw new Error('No se encontró ningún perfil de Firefox con cookies')
    return firefoxRowsToCookies(await querySqlite<FirefoxRow>(db, FIREFOX_SQL))
  }
  if (source === 'safari') {
    const file = join(home, SAFARI_COOKIES)
    if (!existsSync(file)) throw new Error('No se encontró el archivo de cookies de Safari')
    try {
      return parseBinaryCookies(readFileSync(file))
    } catch (err) {
      if (isErrno(err, 'EPERM') || isErrno(err, 'EACCES')) throw new Error('macOS no deja leer las cookies de Safari: da a omni "Acceso total al disco" en Privacidad y seguridad')
      throw err
    }
  }
  if (!path) throw new Error('Elige un archivo de cookies (cookies.txt o JSON)')
  if (!existsSync(path)) throw new Error(`No existe el archivo ${path}`)
  return parseCookieFile(readFileSync(path, 'utf8'))
}

async function readChromium(source: ChromiumSource, home: string): Promise<RawCookie[]> {
  const { name, keychain } = CHROMIUM_SOURCES[source]
  const db = chromiumCookiePath(source, home)
  if (!existsSync(db)) throw new Error(`No se encontró la base de cookies de ${name}`)
  const key = deriveChromiumKey(await keychainPassword(keychain, name))
  return chromiumRowsToCookies(await querySqlite<ChromiumRow>(db, CHROMIUM_SQL), key)
}

/** Contraseña de "<Nombre> Safe Storage" del llavero; macOS pide permiso al usuario la primera vez. */
async function keychainPassword(service: string, name: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(SECURITY, ['find-generic-password', '-s', service, '-w'])
    const password = stdout.replace(/\r?\n$/, '')
    if (password === '') throw new Error('vacía')
    return password
  } catch {
    throw new Error(`El llavero no dio la clave de ${name} ("${service}"): sin ella no se pueden descifrar sus cookies`)
  }
}

/**
 * La base está bloqueada mientras el navegador corre: se copia a una carpeta temporal (con su WAL
 * y journal si existen) y se consulta ahí con `sqlite3 -json`.
 */
async function querySqlite<T>(db: string, sql: string): Promise<T[]> {
  const dir = mkdtempSync(join(tmpdir(), 'omni-cookies-'))
  try {
    const copy = join(dir, 'db.sqlite')
    copyFileSync(db, copy)
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(db + suffix)) copyFileSync(db + suffix, copy + suffix)
    let stdout: string
    try {
      ;({ stdout } = await execFileAsync(SQLITE3, ['-readonly', '-json', copy, sql], { maxBuffer: 64 * 1024 * 1024 }))
    } catch (err) {
      throw new Error(`No se pudo leer la base de cookies con sqlite3: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (stdout.trim() === '') return []
    const rows: unknown = JSON.parse(stdout)
    return Array.isArray(rows) ? (rows as T[]) : []
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function isErrno(err: unknown, code: string): boolean {
  return isRecord(err) && err.code === code
}
