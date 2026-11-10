import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SshHost } from '../hosts/ssh-host'
import type { HostFs, HostStat } from '../hosts/types'
import { createFileProtocolHandler, REMOTE_PREVIEW_MAX_BYTES } from './file-protocol'
import { FileIndex } from './files'
import { git, initRepo } from './git-fixture'
import { isInsidePosix, listRemoteFiles, listRemoteTree, parseRemoteList, readRemoteText, RemoteWatcher, writeRemoteText } from './remote-files'

const FAKE_SSH = resolve(__dirname, '../../../e2e/fake-ssh/ssh')

let root: string
let ws: string
let host: SshHost
const env = { ...process.env }

beforeAll(() => {
  // /tmp corta (el ControlPath de ssh tiene tope de longitud); realpath para comparar rutas reales.
  root = realpathSync(mkdtempSync('/tmp/omni-rfiles-'))
  process.env.FAKE_SSH_HOME = root
  process.env.FAKE_SSH_REMOTE_SHELL = '/bin/sh'
  ws = join(root, 'ws')
  mkdirSync(join(ws, 'src', 'deep'), { recursive: true })
  mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(ws, 'logs'))
  writeFileSync(join(ws, 'src', 'index.ts'), 'export {}\n')
  writeFileSync(join(ws, 'src', 'deep', 'a2.ts'), 'a')
  writeFileSync(join(ws, 'src', 'deep', 'a10.ts'), 'a')
  writeFileSync(join(ws, 'node_modules', 'pkg', 'x.js'), 'x')
  writeFileSync(join(ws, '.hidden'), 'h')
  writeFileSync(join(ws, '.gitignore'), 'logs/\n*.log\n')
  writeFileSync(join(ws, 'app.log'), 'l')
  writeFileSync(join(ws, 'bin.dat'), Buffer.from([1, 0, 2]))
  writeFileSync(join(ws, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
  writeFileSync(join(root, 'secret.txt'), 'fuera')
  symlinkSync(join(root, 'secret.txt'), join(ws, 'escape.txt'))
  host = new SshHost({ id: 'h1', name: 'vps', target: 'alex@vps' }, { sshBin: FAKE_SSH, controlDir: join(root, '.ctl') })
})
afterAll(() => {
  process.env = env
  rmSync(root, { recursive: true, force: true })
})

describe('isInsidePosix', () => {
  it('normaliza y compara por prefijo de carpeta', () => {
    expect(isInsidePosix('/srv/app/a.ts', '/srv/app')).toBe(true)
    expect(isInsidePosix('/srv/app', '/srv/app/')).toBe(true)
    expect(isInsidePosix('/srv/app/../other/a.ts', '/srv/app')).toBe(false)
    expect(isInsidePosix('/srv/apple/a.ts', '/srv/app')).toBe(false)
    expect(isInsidePosix('rel/a.ts', '/srv/app')).toBe(false)
    expect(isInsidePosix('/srv/app/a\0b', '/srv/app')).toBe(false)
  })
})

describe('archivos remotos por el ssh falso', { timeout: 30_000 }, () => {
  it('readRemoteText: texto y mtime del host; mismos errores que en local', async () => {
    const r = await readRemoteText(host.fs, ws, join(ws, 'src', 'index.ts'))
    expect(r.text).toBe('export {}\n')
    expect(r.mtime).toBeGreaterThan(0)
    await expect(readRemoteText(host.fs, ws, join(ws, 'bin.dat'))).rejects.toThrow('bin.dat es un archivo binario')
    await expect(readRemoteText(host.fs, ws, join(ws, 'big.txt'))).rejects.toThrow('big.txt pesa más de 2 MB')
    await expect(readRemoteText(host.fs, ws, join(ws, 'src'))).rejects.toThrow('src no es un archivo')
    await expect(readRemoteText(host.fs, ws, join(ws, 'nada.ts'))).rejects.toThrow('nada.ts no existe')
    await expect(readRemoteText(host.fs, ws, join(root, 'secret.txt'))).rejects.toThrow(/fuera del workspace/)
    await expect(readRemoteText(host.fs, ws, `${ws}/../secret.txt`)).rejects.toThrow(/fuera del workspace/)
    // Symlink dentro que apunta fuera: la ruta real lo delata.
    await expect(readRemoteText(host.fs, ws, join(ws, 'escape.txt'))).rejects.toThrow(/fuera del workspace/)
  })

  it('writeRemoteText: atómico, archivo nuevo, y rechaza lo que escapa', async () => {
    const path = join(ws, 'src', 'new.ts')
    const { mtime } = await writeRemoteText(host.fs, ws, path, 'hola ñ\n')
    expect(readFileSync(path, 'utf8')).toBe('hola ñ\n')
    const back = await readRemoteText(host.fs, ws, path)
    expect(back.mtime).toBe(mtime)
    await expect(writeRemoteText(host.fs, ws, join(ws, 'escape.txt'), 'x')).rejects.toThrow(/fuera del workspace/)
    expect(readFileSync(join(root, 'secret.txt'), 'utf8')).toBe('fuera')
    await expect(writeRemoteText(host.fs, ws, join(ws, 'src'), 'x')).rejects.toThrow('src es una carpeta')
    await expect(writeRemoteText(host.fs, ws, join(root, 'otro.txt'), 'x')).rejects.toThrow(/fuera del workspace/)
  })

  // Workspace aparte para los symlinks: no ensucian el listado de `ws` que revisan otros casos.
  const linksWorkspace = (name: string): string => {
    const dir = join(root, name)
    mkdirSync(join(dir, 'src'), { recursive: true })
    return dir
  }

  it('writeRemoteText: un symlink roto que apunta fuera no escribe fuera; se reemplaza el enlace por el archivo', async () => {
    const lws = linksWorkspace('ws-links-1')
    const outside = join(root, 'creado-fuera.txt')
    const link = join(lws, 'roto.txt')
    symlinkSync(outside, link)
    await writeRemoteText(host.fs, lws, link, 'dentro')
    expect(existsSync(outside)).toBe(false)
    expect(lstatSync(link).isSymbolicLink()).toBe(false)
    expect(readFileSync(link, 'utf8')).toBe('dentro')
  })

  it('RemoteFs.writeFile: un symlink roto se reemplaza (no se sigue); uno a un archivo que existe escribe en el destino', async () => {
    const lws = linksWorkspace('ws-links-2')
    const outside = join(root, 'tampoco-fuera.txt')
    const broken = join(lws, 'roto2.txt')
    symlinkSync(outside, broken)
    await host.fs.writeFile(broken, 'x')
    expect(existsSync(outside)).toBe(false)
    expect(readFileSync(broken, 'utf8')).toBe('x')
    const real = join(lws, 'src', 'real.ts')
    writeFileSync(real, 'antes')
    const alias = join(lws, 'alias.ts')
    symlinkSync(real, alias)
    await writeRemoteText(host.fs, lws, alias, 'después')
    expect(lstatSync(alias).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('después')
  })

  it('listRemoteTree: sin ocultos ni ignorados, carpetas primero, orden natural, truncado', async () => {
    const top = await listRemoteTree(host.fs, ws, ws)
    expect(top.truncated).toBe(false)
    expect(top.entries.map((e) => `${e.dir ? 'd' : 'f'}:${e.name}`)).toEqual(['d:src', 'f:big.txt', 'f:bin.dat', 'f:escape.txt'])
    const deep = await listRemoteTree(host.fs, ws, join(ws, 'src', 'deep'))
    expect(deep.entries.map((e) => e.name)).toEqual(['a2.ts', 'a10.ts'])
    expect(deep.entries[0].path).toBe(join(ws, 'src', 'deep', 'a2.ts'))
    const cut = await listRemoteTree(host.fs, ws, ws, 2)
    expect(cut).toMatchObject({ truncated: true })
    expect(cut.entries).toHaveLength(2)
    await expect(listRemoteTree(host.fs, ws, root)).rejects.toThrow(/carpeta fuera del workspace/)
  })

  it('listRemoteFiles sin git: find saltando las carpetas de siempre', async () => {
    const files = await listRemoteFiles(host, ws)
    expect(files).toContain('src/index.ts')
    expect(files).toContain('src/deep/a10.ts')
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
  })

  it('listRemoteFiles con git: seguidos + sin seguimiento no ignorados', async () => {
    const repo = realpathSync(initRepo())
    try {
      mkdirSync(join(repo, 'dist'))
      writeFileSync(join(repo, 'dist', 'out.js'), 'x')
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
      writeFileSync(join(repo, 'ignored.txt'), 'x')
      writeFileSync(join(repo, 'nuevo archivo.ts'), 'x')
      git(repo, 'add', '.gitignore')
      git(repo, 'commit', '-q', '-m', 'ignore')
      const files = await listRemoteFiles(host, repo)
      expect(files.sort()).toEqual(['.gitignore', 'README.md', 'nuevo archivo.ts'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('listRemoteFiles: carpeta que no existe → error', async () => {
    await expect(listRemoteFiles(host, join(root, 'no-existe'))).rejects.toThrow(/no existe/)
  })

  it('FileIndex incluye workspaces remotos con el host conectado y los salta si no', async () => {
    let connected = true
    const index = new FileIndex({
      workspaces: () => [{ id: 'r1', path: ws, host: 'h1' }],
      hosts: {
        connected: () => {
          if (!connected) throw new Error('vps no está conectado')
          return host
        }
      },
      remoteWaitMs: 10_000
    })
    const hits = await index.search('index', 5)
    expect(hits[0]).toEqual({ workspaceId: 'r1', path: join(ws, 'src', 'index.ts'), rel: 'src/index.ts' })
    connected = false
    // Sin conexión responde con lo que ya tenía, sin tocar ssh.
    expect((await index.search('index', 5))[0]?.rel).toBe('src/index.ts')
    const cold = new FileIndex({ workspaces: () => [{ id: 'r2', path: ws, host: 'h1' }], hosts: { connected: () => { throw new Error('no') } } })
    expect(await cold.search('index', 5)).toEqual([])
    // Sin `hosts` configurado, un remoto nunca se recorre en el disco local (aunque la ruta exista aquí).
    const none = new FileIndex({ workspaces: () => [{ id: 'r3', path: ws, host: 'h1' }] })
    expect(await none.search('index', 5)).toEqual([])
  })

  it('FileIndex: un host lento no bloquea la búsqueda más de remoteWaitMs', async () => {
    const slow = { exec: () => new Promise<never>(() => undefined) }
    const index = new FileIndex({ workspaces: () => [{ id: 'r1', path: '/srv/x', host: 'h1' }], hosts: { connected: () => slow }, remoteWaitMs: 50 })
    const started = Date.now()
    expect(await index.search('a', 5)).toEqual([])
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('omni-file:// remoto: sirve bytes del host, 404 fuera o por symlink, 413 si es enorme', async () => {
    const handler = createFileProtocolHandler(() => [{ id: 'wsr', path: ws, host: 'h1' }], async () => host.fs)
    const ok = await handler(new Request('omni-file://wsr/src/index.ts'))
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('export {}\n')
    expect((await handler(new Request('omni-file://wsr/escape.txt'))).status).toBe(404)
    expect((await handler(new Request('omni-file://wsr/src/%2E%2E/%2E%2E/secret.txt'))).status).toBe(404)
    expect((await handler(new Request('omni-file://wsr/nada.png'))).status).toBe(404)
    const huge = { ...host.fs, stat: async (): Promise<HostStat> => ({ dir: false, size: REMOTE_PREVIEW_MAX_BYTES + 1, mtime: 1 }) } as HostFs
    const capped = createFileProtocolHandler(() => [{ id: 'wsr', path: ws, host: 'h1' }], async () => huge)
    expect((await capped(new Request('omni-file://wsr/big.txt'))).status).toBe(413)
    // Sin resolvedor de hosts, un remoto da 404 aunque la ruta exista en este Mac.
    const local = createFileProtocolHandler(() => [{ id: 'wsr', path: ws, host: 'h1' }])
    expect(local(new Request('omni-file://wsr/src/index.ts')).status).toBe(404)
  })
})

describe('parseRemoteList', () => {
  it('quita ./, lo ignorado siempre y la entrada cortada', () => {
    expect(parseRemoteList('./a.ts\0./node_modules/x.js\0b/.DS_Store\0dist/y.js\0c/d.ts\0cort')).toEqual(['a.ts', 'c/d.ts'])
    expect(parseRemoteList('a\0b\0c\0', 2)).toEqual(['a', 'b'])
    expect(parseRemoteList('')).toEqual([])
  })
})

describe('RemoteWatcher', () => {
  /** HostFs mínimo: solo `stat`, con mtime controlado por el test. */
  const fakeFs = (state: { mtime: number | null; fail?: boolean }): HostFs =>
    ({
      stat: async (): Promise<HostStat | null> => {
        if (state.fail) throw new Error('ssh caído')
        return state.mtime === null ? null : { dir: false, size: 1, mtime: state.mtime }
      }
    }) as unknown as HostFs
  const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('avisa solo cuando cambia el mtime (0 al borrarse), con conteo de referencias', async () => {
    const state: { mtime: number | null; fail?: boolean } = { mtime: 100 }
    const w = new RemoteWatcher({ fsOf: () => fakeFs(state), intervalMs: 10 })
    const seen: Array<[string, string, number]> = []
    w.onChanged((id, path, mtime) => seen.push([id, path, mtime]))
    w.watch('ws1', '/srv/a.ts')
    w.watch('ws1', '/srv/a.ts')
    await tick(40)
    expect(seen).toEqual([])
    state.mtime = 200
    await tick(40)
    expect(seen).toEqual([['ws1', '/srv/a.ts', 200]])
    state.fail = true
    await tick(40)
    state.fail = false
    state.mtime = null
    await tick(40)
    expect(seen.at(-1)).toEqual(['ws1', '/srv/a.ts', 0])
    expect(w.unwatch('ws1', '/srv/a.ts')).toBe(true)
    expect(w.has('ws1', '/srv/a.ts')).toBe(true)
    expect(w.unwatch('ws1', '/srv/a.ts')).toBe(true)
    expect(w.keys()).toEqual([])
    expect(w.unwatch('ws1', '/srv/a.ts')).toBe(false)
    const count = seen.length
    state.mtime = 999
    await tick(40)
    expect(seen).toHaveLength(count)
  })

  it('sin host conectado no sondea pero mantiene la referencia', async () => {
    const w = new RemoteWatcher({ fsOf: () => null, intervalMs: 10 })
    w.watch('ws1', '/srv/a.ts')
    await tick(30)
    expect(w.keys()).toHaveLength(1)
    w.close()
    expect(w.keys()).toEqual([])
  })
})
