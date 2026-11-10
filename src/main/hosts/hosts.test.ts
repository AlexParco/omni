import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LocalHost } from './local-host'
import { parseDirents, parseSizeMtime } from './remote-fs'
import { SshHost } from './ssh-host'
import type { Host } from './types'

const FAKE_SSH = resolve(__dirname, '../../../e2e/fake-ssh/ssh')
const TRICKY_NAMES = ['con espacios', "it's", 'a"b', '$HOME', '`id`', 'line\nbreak', 'ñandú 日本 🚀', '-dash', '.oculto', '*']

let root: string
const env = { ...process.env }

beforeAll(() => {
  // /tmp y no tmpdir(): en macOS es corta y realpath la resuelve a /private/tmp (sirve para probar symlinks).
  root = realpathSync(mkdtempSync('/tmp/omni-hosts-'))
  process.env.FAKE_SSH_HOME = root
  process.env.FAKE_SSH_REMOTE_SHELL = '/bin/sh'
})
afterAll(() => {
  process.env = env
  rmSync(root, { recursive: true, force: true })
})

// El mismo contrato para los dos: LocalHost es la referencia y SshHost tiene que comportarse igual.
describe.each([
  ['LocalHost', (): Host => new LocalHost()],
  ['SshHost (ssh falso)', (): Host => new SshHost({ id: 'h1', name: 'vps', target: 'alex@vps' }, { sshBin: FAKE_SSH, controlDir: join(root, '.ctl') })]
])('%s', { timeout: 15_000 }, (label, make) => {
  let base: string
  let host: Host
  beforeAll(() => {
    base = join(root, label.replace(/\W+/g, '-'))
    mkdirSync(base)
    host = make()
  })

  it('home', async () => {
    const home = await host.home()
    expect(home.startsWith('/')).toBe(true)
  })

  it('round-trip de nombres difíciles: writeFile, readFile, readdir, stat', async () => {
    const dir = join(base, 'tricky')
    await host.fs.mkdirp(dir)
    for (const name of TRICKY_NAMES) {
      const mtime = await host.fs.writeFile(join(dir, name), `contenido de ${name}`)
      expect(mtime).toBeGreaterThan(0)
      expect((await host.fs.readFile(join(dir, name))).toString('utf8')).toBe(`contenido de ${name}`)
      expect(readFileSync(join(dir, name), 'utf8')).toBe(`contenido de ${name}`)
    }
    mkdirSync(join(dir, 'sub dir\nnl'))
    const entries = await host.fs.readdir(dir)
    expect(entries.map((e) => e.name).sort()).toEqual([...TRICKY_NAMES, 'sub dir\nnl'].sort())
    expect(entries.find((e) => e.name === 'sub dir\nnl')?.dir).toBe(true)
    expect(entries.filter((e) => e.dir)).toHaveLength(1)
  }, 30_000)

  it('archivo binario: round-trip exacto', async () => {
    const data = Buffer.alloc(256 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 8)) & 0xff
    const path = join(base, 'bin.dat')
    await host.fs.writeFile(path, data)
    expect(Buffer.compare(readFileSync(path), data)).toBe(0)
    expect(Buffer.compare(await host.fs.readFile(path), data)).toBe(0)
  })

  it('writeFile atómico: reemplaza, conserva permisos, no deja tmp y devuelve el mtime de stat', async () => {
    const dir = join(base, 'atomic')
    mkdirSync(dir)
    const path = join(dir, 'f.sh')
    writeFileSync(path, 'viejo')
    chmodSync(path, 0o750)
    const mtime = await host.fs.writeFile(path, 'nuevo')
    expect(readFileSync(path, 'utf8')).toBe('nuevo')
    expect(statSync(path).mode & 0o777).toBe(0o750)
    expect(readdirSync(dir)).toEqual(['f.sh'])
    const st = await host.fs.stat(path)
    expect(st).toMatchObject({ dir: false, size: 5 })
    expect(Math.abs((st?.mtime ?? 0) - mtime)).toBeLessThan(1)
    expect(Math.abs(mtime - statSync(path).mtimeMs)).toBeLessThan(1)
  })

  it('writeFile sobre un symlink escribe en el destino', async () => {
    const target = join(base, 'target.txt')
    const link = join(base, 'link.txt')
    writeFileSync(target, 'a')
    symlinkSync(target, link)
    await host.fs.writeFile(link, 'b')
    expect(readFileSync(target, 'utf8')).toBe('b')
  })

  it('stat: null si no existe; dir y tamaño', async () => {
    expect(await host.fs.stat(join(base, 'no-existe'))).toBeNull()
    const st = await host.fs.stat(base)
    expect(st?.dir).toBe(true)
  })

  it('realpath de un symlink; rechaza si no existe', async () => {
    const real = join(base, 'real dir')
    mkdirSync(real)
    const link = join(base, "enlace 'x'")
    symlinkSync(real, link)
    expect(await host.fs.realpath(link)).toBe(real)
    expect(await host.fs.realpath('/tmp')).toBe(realpathSync('/tmp'))
    await expect(host.fs.realpath(join(base, 'nada'))).rejects.toThrow(/no existe/)
  })

  it('readdir sigue symlinks a carpetas', async () => {
    const dir = join(base, 'links')
    mkdirSync(join(dir, 'd'), { recursive: true })
    symlinkSync(join(dir, 'd'), join(dir, 'ld'))
    symlinkSync(join(dir, 'nada'), join(dir, 'roto'))
    const entries = await host.fs.readdir(dir)
    expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'd', dir: true },
      { name: 'ld', dir: true },
      { name: 'roto', dir: false }
    ])
  })

  it('errores humanos', async () => {
    const file = join(base, 'plain.txt')
    writeFileSync(file, 'x')
    await expect(host.fs.readFile(join(base, 'no-existe'))).rejects.toThrow(/^no existe: /)
    await expect(host.fs.readdir(join(base, 'no-existe'))).rejects.toThrow(/^no existe: /)
    await expect(host.fs.readdir(file)).rejects.toThrow(/^no es una carpeta: /)
    await expect(host.fs.readFile(base)).rejects.toThrow(/^es una carpeta: /)
    await expect(host.fs.writeFile(base, 'x')).rejects.toThrow(/es una carpeta: /)
    await expect(host.fs.mkdirp(join(file, 'sub'))).rejects.toThrow(/plain\.txt/)
  })

  it('mkdirp anidado e idempotente', async () => {
    const deep = join(base, 'a', 'b c', "d'e")
    await host.fs.mkdirp(deep)
    await host.fs.mkdirp(deep)
    expect(existsSync(deep)).toBe(true)
  })

  it('exec y execLogin con cwd', async () => {
    const r = await host.exec('pwd', ['-P'], { cwd: base, timeoutMs: 10_000 })
    expect(r.stdout.trim()).toBe(base)
    const l = await host.execLogin('printf', ['%s', "a'b $x"], { cwd: base, timeoutMs: 10_000 })
    expect(l).toMatchObject({ code: 0, stdout: "a'b $x" })
  })
})

describe('parsers de remote-fs', () => {
  it('parseSizeMtime: GNU con fracción, BSD con fracción y sin ella', () => {
    expect(parseSizeMtime('12 1729600000.1234567890')).toEqual({ size: 12, mtime: 1729600000123 })
    expect(parseSizeMtime('0 1729600000')).toEqual({ size: 0, mtime: 1729600000000 })
    expect(() => parseSizeMtime('garbage')).toThrow()
  })

  it('parseDirents: separador NUL, nombres con saltos de línea', () => {
    expect(parseDirents(Buffer.from('d/a\nb\0f/c d\0'))).toEqual([
      { name: 'a\nb', dir: true },
      { name: 'c d', dir: false }
    ])
    expect(parseDirents(Buffer.alloc(0))).toEqual([])
    expect(() => parseDirents(Buffer.from('x/y\0'))).toThrow()
  })
})
