import { createCipheriv, createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CookiesSetDetails } from 'electron'
import {
  chromiumRowsToCookies,
  decryptChromiumValue,
  deriveChromiumKey,
  firefoxRowsToCookies,
  GOOGLE_NOTE,
  importCookies,
  parseBinaryCookies,
  parseCookieFile,
  parseJsonCookies,
  parseNetscape,
  sameSiteOf,
  toSetDetails,
  type ChromiumRow,
  type RawCookie
} from './cookies'

/* ---------- helpers de fixtures ---------- */

/** Cifra como Chromium en macOS: `v10` + AES-128-CBC con IV de espacios (PKCS7). */
function encryptV10(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()])
}

interface BinCookie {
  domain: string
  name: string
  path: string
  value: string
  flags: number
  /** Segundos desde 2001 (época Mac). */
  expiry: number
}

/** Una cookie en el formato binario de Safari: cabecera de 56 bytes + cadenas NUL-terminadas. */
function binaryCookie(c: BinCookie): Buffer {
  const strings = [c.domain, c.name, c.path, c.value].map((s) => Buffer.from(s + '\0', 'utf8'))
  const offsets: number[] = []
  let at = 56
  for (const s of strings) {
    offsets.push(at)
    at += s.length
  }
  const header = Buffer.alloc(56)
  header.writeUInt32LE(at, 0) // tamaño total
  header.writeUInt32LE(0, 4)
  header.writeUInt32LE(c.flags, 8)
  header.writeUInt32LE(0, 12)
  header.writeUInt32LE(offsets[0] ?? 0, 16) // dominio
  header.writeUInt32LE(offsets[1] ?? 0, 20) // nombre
  header.writeUInt32LE(offsets[2] ?? 0, 24) // path
  header.writeUInt32LE(offsets[3] ?? 0, 28) // valor
  header.writeDoubleLE(c.expiry, 40)
  header.writeDoubleLE(0, 48)
  return Buffer.concat([header, ...strings])
}

/** Una página: cabecera 0x00000100, nº de cookies, offsets (LE) y un 0 de cierre. */
function binaryPage(cookies: Buffer[]): Buffer {
  const headerSize = 4 + 4 + cookies.length * 4 + 4
  const header = Buffer.alloc(headerSize)
  header.writeUInt32BE(0x00000100, 0)
  header.writeUInt32LE(cookies.length, 4)
  let at = headerSize
  cookies.forEach((c, i) => {
    header.writeUInt32LE(at, 8 + i * 4)
    at += c.length
  })
  return Buffer.concat([header, ...cookies])
}

/** El archivo completo: `cook`, nº de páginas y tamaños (BE), páginas y un pie de 8 bytes. */
function binaryFile(pages: Buffer[]): Buffer {
  const header = Buffer.alloc(8 + pages.length * 4)
  header.write('cook', 0, 'latin1')
  header.writeUInt32BE(pages.length, 4)
  pages.forEach((p, i) => header.writeUInt32BE(p.length, 8 + i * 4))
  return Buffer.concat([header, ...pages, Buffer.alloc(8)])
}

const MAC_EPOCH = 978307200

/* ---------- tests ---------- */

describe('parseNetscape', () => {
  it('lee las 7 columnas, ignora comentarios y respeta #HttpOnly_', () => {
    const text = [
      '# Netscape HTTP Cookie File',
      '',
      '.example.com\tTRUE\t/\tTRUE\t1893456000\tsid\tabc123',
      '#HttpOnly_.example.com\tTRUE\t/api\tFALSE\t0\ttoken\tx=y',
      'host.only.com\tFALSE\t/\tFALSE\t1893456000\tplain\t',
      'corta\tTRUE\t/'
    ].join('\n')
    expect(parseNetscape(text)).toEqual<RawCookie[]>([
      { domain: '.example.com', path: '/', secure: true, expires: 1893456000, name: 'sid', value: 'abc123', httpOnly: false },
      { domain: '.example.com', path: '/api', secure: false, name: 'token', value: 'x=y', httpOnly: true },
      { domain: 'host.only.com', path: '/', secure: false, expires: 1893456000, name: 'plain', value: '', httpOnly: false }
    ])
  })

  it('aguanta CRLF', () => {
    const [c] = parseNetscape('.a.com\tTRUE\t/\tFALSE\t0\tn\tv\r\n')
    expect(c?.value).toBe('v')
  })
})

describe('parseJsonCookies', () => {
  it('lee un array con expires/expirationDate y sameSite en texto', () => {
    const text = JSON.stringify([
      { name: 'a', value: 'b', domain: '.example.com', path: '/', expires: 1893456000, secure: true, httpOnly: true, sameSite: 'Lax' },
      { name: 'c', value: 1, domain: 'example.com', expirationDate: 1893456000, sameSite: 'None' },
      { name: 'd', value: 'x', domain: 'example.com', expires: -1, session: true },
      { name: 'sin dominio', value: 'x' },
      'basura'
    ])
    expect(parseJsonCookies(text)).toEqual<RawCookie[]>([
      { name: 'a', value: 'b', domain: '.example.com', path: '/', expires: 1893456000, secure: true, httpOnly: true, sameSite: 'lax' },
      { name: 'c', value: '1', domain: 'example.com', path: '/', expires: 1893456000, secure: false, httpOnly: false, sameSite: 'no_restriction' },
      { name: 'd', value: 'x', domain: 'example.com', path: '/', secure: false, httpOnly: false }
    ])
  })

  it('acepta { cookies: [...] } y falla claro con JSON roto o sin array', () => {
    expect(parseJsonCookies('{"cookies":[{"name":"a","value":"","domain":"x.com"}]}')).toHaveLength(1)
    expect(() => parseJsonCookies('{ nope')).toThrow(/JSON/)
    expect(() => parseJsonCookies('{"a":1}')).toThrow(/array/)
  })

  it('parseCookieFile elige el formato por el primer carácter', () => {
    expect(parseCookieFile('  [{"name":"a","value":"","domain":"x.com"}]')).toHaveLength(1)
    expect(parseCookieFile('.x.com\tTRUE\t/\tFALSE\t0\ta\tb')).toHaveLength(1)
  })
})

describe('sameSiteOf', () => {
  it('normaliza texto y rechaza lo demás', () => {
    expect(sameSiteOf('None')).toBe('no_restriction')
    expect(sameSiteOf('no_restriction')).toBe('no_restriction')
    expect(sameSiteOf('STRICT')).toBe('strict')
    expect(sameSiteOf('lax')).toBe('lax')
    expect(sameSiteOf('unspecified')).toBe('unspecified')
    expect(sameSiteOf('raro')).toBeUndefined()
    expect(sameSiteOf(1)).toBeUndefined()
  })
})

describe('descifrado Chromium', () => {
  const key = deriveChromiumKey('clave-de-prueba')

  it('deriva una clave de 16 bytes estable', () => {
    expect(key).toHaveLength(16)
    expect(deriveChromiumKey('clave-de-prueba').equals(key)).toBe(true)
    expect(deriveChromiumKey('otra').equals(key)).toBe(false)
  })

  it('descifra un valor v10 clásico', () => {
    expect(decryptChromiumValue(encryptV10(Buffer.from('hola mundo'), key), key, 'example.com')).toBe('hola mundo')
  })

  it('recorta el SHA-256 del host que antepone Chrome ≥ 130', () => {
    const prefix = createHash('sha256').update('.example.com').digest()
    const encrypted = encryptV10(Buffer.concat([prefix, Buffer.from('valor')]), key)
    expect(decryptChromiumValue(encrypted, key, '.example.com')).toBe('valor')
  })

  it('recorta también un prefijo binario aunque el hash no cuadre', () => {
    const prefix = Buffer.alloc(32, 0x01)
    const encrypted = encryptV10(Buffer.concat([prefix, Buffer.from('valor')]), key)
    expect(decryptChromiumValue(encrypted, key, 'otro.host')).toBe('valor')
  })

  it('no recorta un valor largo de texto normal', () => {
    const long = 'a'.repeat(40)
    expect(decryptChromiumValue(encryptV10(Buffer.from(long), key), key, 'x')).toBe(long)
  })

  it('devuelve vacío sin cifrado, y null con otro esquema o clave equivocada', () => {
    expect(decryptChromiumValue(Buffer.alloc(0), key, 'x')).toBe('')
    expect(decryptChromiumValue(Buffer.from('v11xxxxxxxxxxxxxxxxx'), key, 'x')).toBeNull()
    expect(decryptChromiumValue(encryptV10(Buffer.from('secreto'), key), deriveChromiumKey('mal'), 'x')).toBeNull()
  })

  it('chromiumRowsToCookies convierte filas, épocas y sameSite; omite lo que no descifra', () => {
    const row = (partial: Partial<ChromiumRow>): ChromiumRow => ({
      host_key: '.example.com',
      name: 'n',
      value: '',
      encrypted_hex: '',
      path: '/',
      expires_utc: 0,
      is_secure: 0,
      is_httponly: 0,
      samesite: -1,
      ...partial
    })
    const rows: ChromiumRow[] = [
      row({ name: 'cifrada', encrypted_hex: encryptV10(Buffer.from('v'), key).toString('hex'), expires_utc: (1893456000 + 11644473600) * 1e6, is_secure: 1, is_httponly: 1, samesite: 1 }),
      row({ name: 'clara', value: 'plano', samesite: 0 }),
      row({ name: 'rota', encrypted_hex: encryptV10(Buffer.from('x'), deriveChromiumKey('otra')).toString('hex'), samesite: 2 })
    ]
    expect(chromiumRowsToCookies(rows, key)).toEqual<RawCookie[]>([
      { name: 'cifrada', value: 'v', domain: '.example.com', path: '/', secure: true, httpOnly: true, expires: 1893456000, sameSite: 'lax' },
      { name: 'clara', value: 'plano', domain: '.example.com', path: '/', secure: false, httpOnly: false, sameSite: 'no_restriction' }
    ])
  })
})

describe('firefoxRowsToCookies', () => {
  it('mapea columnas y deja sameSite 0 sin especificar', () => {
    expect(
      firefoxRowsToCookies([
        { host: '.mozilla.org', name: 'a', value: 'b', path: '/x', expiry: 1893456000, isSecure: 1, isHttpOnly: 0, sameSite: 1 },
        { host: 'host.org', name: 'c', value: 'd', path: '', expiry: 0, isSecure: 0, isHttpOnly: 1, sameSite: 0 }
      ])
    ).toEqual<RawCookie[]>([
      { name: 'a', value: 'b', domain: '.mozilla.org', path: '/x', secure: true, httpOnly: false, expires: 1893456000, sameSite: 'lax' },
      { name: 'c', value: 'd', domain: 'host.org', path: '/', secure: false, httpOnly: true }
    ])
  })
})

describe('parseBinaryCookies', () => {
  it('lee páginas, flags y fechas en época Mac', () => {
    const file = binaryFile([
      binaryPage([
        binaryCookie({ domain: '.apple.com', name: 'sid', path: '/', value: 'abc', flags: 1 | 4, expiry: 1893456000 - MAC_EPOCH }),
        binaryCookie({ domain: 'host.com', name: 'plain', path: '/p', value: '', flags: 0, expiry: 0 })
      ]),
      binaryPage([binaryCookie({ domain: '.b.com', name: 'x', path: '/', value: 'y', flags: 4, expiry: 1893456000 - MAC_EPOCH })])
    ])
    expect(parseBinaryCookies(file)).toEqual<RawCookie[]>([
      { name: 'sid', value: 'abc', domain: '.apple.com', path: '/', secure: true, httpOnly: true, expires: 1893456000 },
      { name: 'plain', value: '', domain: 'host.com', path: '/p', secure: false, httpOnly: false },
      { name: 'x', value: 'y', domain: '.b.com', path: '/', secure: false, httpOnly: true, expires: 1893456000 }
    ])
  })

  it('rechaza lo que no empieza por cook y salta cookies con offsets fuera de rango', () => {
    expect(() => parseBinaryCookies(Buffer.from('nope'))).toThrow(/Safari/)
    const bad = binaryCookie({ domain: 'a.com', name: 'n', path: '/', value: 'v', flags: 0, expiry: 0 })
    bad.writeUInt32LE(9999, 0) // tamaño imposible
    const good = binaryCookie({ domain: 'b.com', name: 'ok', path: '/', value: 'v', flags: 0, expiry: 0 })
    expect(parseBinaryCookies(binaryFile([binaryPage([bad, good])])).map((c) => c.name)).toEqual(['ok'])
  })
})

describe('toSetDetails', () => {
  it('arma la URL https sin punto y solo pone domain en cookies de dominio', () => {
    const base: RawCookie = { name: 'n', value: 'v', domain: '.example.com', path: '/p', secure: true, httpOnly: true, expires: 123, sameSite: 'lax' }
    expect(toSetDetails(base)).toEqual<CookiesSetDetails>({ url: 'https://example.com/', name: 'n', value: 'v', path: '/p', secure: true, httpOnly: true, domain: '.example.com', expirationDate: 123, sameSite: 'lax' })
    const hostOnly = toSetDetails({ ...base, domain: 'example.com', path: 'rara' })
    expect(hostOnly.domain).toBeUndefined()
    expect(hostOnly.path).toBe('/')
    const session = toSetDetails({ name: 'n', value: 'v', domain: 'x.com', path: '/', secure: false, httpOnly: false })
    expect(session.expirationDate).toBeUndefined()
    expect(session.sameSite).toBeUndefined()
  })
})

describe('importCookies', () => {
  it('cuenta importadas y saltadas (caducadas, sin nombre, rechazadas) y añade la nota de Google', async () => {
    const set: CookiesSetDetails[] = []
    const sink = {
      set: async (d: CookiesSetDetails): Promise<void> => {
        if (d.name === 'rechazada') throw new Error('no')
        set.push(d)
      }
    }
    const now = 1000
    const result = await importCookies(
      [
        { name: 'ok', value: '1', domain: 'a.com', path: '/', secure: false, httpOnly: false, expires: 2000 },
        { name: 'sesion', value: '2', domain: 'a.com', path: '/', secure: false, httpOnly: false },
        { name: 'caducada', value: '3', domain: 'a.com', path: '/', secure: false, httpOnly: false, expires: 999 },
        { name: '', value: '4', domain: 'a.com', path: '/', secure: false, httpOnly: false },
        { name: 'sin-dominio', value: '5', domain: '.', path: '/', secure: false, httpOnly: false },
        { name: 'rechazada', value: '6', domain: 'a.com', path: '/', secure: false, httpOnly: false }
      ],
      sink,
      now
    )
    expect(result).toEqual({ imported: 2, skipped: 4, note: GOOGLE_NOTE })
    expect(set.map((d) => d.name)).toEqual(['ok', 'sesion'])
  })
})
