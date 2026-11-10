import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Workspace } from '@shared/types'
import { frame, LspFramer, LspService, lspBinDirs, resolveRemoteServer, resolveServer, type LspServerSpec, type ResolveDeps } from './lsp'

describe('frame / LspFramer', () => {
  it('Content-Length cuenta bytes UTF-8, no caracteres', () => {
    const f = frame('{"a":"ñ😀"}')
    expect(f.toString('utf8')).toBe('Content-Length: 14\r\n\r\n{"a":"ñ😀"}')
  })

  it('varios mensajes en un solo trozo', () => {
    const framer = new LspFramer()
    expect(framer.push(Buffer.concat([frame('{"id":1}'), frame('{"id":2}')]))).toEqual(['{"id":1}', '{"id":2}'])
  })

  it('trozos parciales: cabecera y cuerpo partidos, incluso a mitad de un carácter multibyte', () => {
    const framer = new LspFramer()
    const bytes = Buffer.concat([frame('{"t":"áé😀"}'), frame('{"x":1}')])
    const out: string[] = []
    for (let i = 0; i < bytes.length; i++) out.push(...framer.push(bytes.subarray(i, i + 1)))
    expect(out).toEqual(['{"t":"áé😀"}', '{"x":1}'])
  })

  it('cabeceras extra y mayúsculas distintas; una cabecera sin Content-Length se descarta', () => {
    const framer = new LspFramer()
    const raw = 'X-Basura: 1\r\n\r\ncontent-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}'
    expect(framer.push(raw)).toEqual(['{}'])
  })

  it('un mensaje incompleto queda esperando al siguiente trozo', () => {
    const framer = new LspFramer()
    const bytes = frame('{"id":7}')
    expect(framer.push(bytes.subarray(0, bytes.length - 2))).toEqual([])
    expect(framer.push(bytes.subarray(bytes.length - 2))).toEqual(['{"id":7}'])
  })
})

describe('lspBinDirs', () => {
  it('suma Homebrew y las carpetas de usuario al PATH, sin repetir', () => {
    expect(lspBinDirs('/usr/bin:/opt/homebrew/bin', '/Users/x')).toEqual(['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', '/Users/x/go/bin', '/Users/x/.cargo/bin', '/Users/x/.local/bin'])
  })
})

describe('resolveServer', () => {
  /** Sistema de archivos falso: rutas que existen y contenido de los package.json. */
  const fakeDeps = (files: Record<string, string>, bins: Record<string, string> = {}): ResolveDeps => ({
    exists: async (p) => p in files,
    readText: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`)
      return files[p]
    },
    which: async (name) => bins[name] ?? null,
    env: { PATH: '/usr/bin' },
    execPath: '/E',
    tsLanguageServerCli: () => '/omni/tsls/cli.mjs'
  })

  it('TypeScript 5 (con tsserver.js): typescript-language-server de omni apuntando al tsserver del proyecto', async () => {
    const deps = fakeDeps({ '/w/node_modules/typescript/package.json': '{"version":"5.9.3"}', '/w/node_modules/typescript/lib/tsserver.js': '' })
    const spec = await resolveServer('/w', '/w/src/a.tsx', deps)
    expect(spec).toEqual({
      kind: 'typescript',
      name: 'TypeScript 5.9.3',
      command: '/E',
      args: ['/omni/tsls/cli.mjs', '--stdio'],
      env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
      cwd: '/w',
      initializationOptions: { tsserver: { path: '/w/node_modules/typescript/lib/tsserver.js' } },
      languageId: 'typescriptreact',
      key: 'typescript|/w|/w/node_modules/typescript'
    })
  })

  it('TypeScript 7 (nativo, sin tsserver.js): su propio `tsc --lsp --stdio`', async () => {
    const deps = fakeDeps({ '/w/node_modules/typescript/package.json': '{"version":"7.0.2"}' })
    const spec = await resolveServer('/w', '/w/src/main.mjs', deps)
    expect(spec).toMatchObject({
      kind: 'tsgo',
      name: 'TypeScript 7.0.2',
      command: '/E',
      args: ['/w/node_modules/typescript/bin/tsc', '--lsp', '--stdio'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      initializationOptions: null,
      languageId: 'javascript',
      key: 'tsgo|/w|/w/node_modules/typescript'
    })
  })

  it('sin typescript instalado (o uno viejo sin tsserver) no hay servidor', async () => {
    expect(await resolveServer('/w', '/w/a.ts', fakeDeps({}))).toBeNull()
    expect(await resolveServer('/w', '/w/a.ts', fakeDeps({ '/w/node_modules/typescript/package.json': '{"version":"4.0.0"}' }))).toBeNull()
  })

  it('en un monorepo gana el node_modules más cercano al archivo, sin pasar de la raíz', async () => {
    const deps = fakeDeps({
      '/w/node_modules/typescript/package.json': '{"version":"7.0.2"}',
      '/w/packages/web/node_modules/typescript/package.json': '{"version":"5.4.0"}',
      '/w/packages/web/node_modules/typescript/lib/tsserver.js': '',
      '/node_modules/typescript/package.json': '{"version":"5.0.0"}'
    })
    const web = await resolveServer('/w', '/w/packages/web/src/x.jsx', deps)
    expect(web).toMatchObject({ kind: 'typescript', name: 'TypeScript 5.4.0', languageId: 'javascriptreact', key: 'typescript|/w|/w/packages/web/node_modules/typescript' })
    expect(await resolveServer('/w', '/w/packages/api/a.cts', deps)).toMatchObject({ kind: 'tsgo', key: 'tsgo|/w|/w/node_modules/typescript' })
    expect(await resolveServer('/w/packages/api', '/w/packages/api/a.ts', deps)).toBeNull()
  })

  it('Go, Rust y Python usan el binario del PATH ampliado; sin binario, null', async () => {
    const deps = fakeDeps({}, { gopls: '/h/go/bin/gopls', 'rust-analyzer': '/h/.cargo/bin/rust-analyzer', 'pyright-langserver': '/b/pyright-langserver' })
    expect(await resolveServer('/w', '/w/main.go', deps)).toEqual({
      kind: 'gopls',
      name: 'gopls',
      command: '/h/go/bin/gopls',
      args: [],
      env: { PATH: '/usr/bin' },
      cwd: '/w',
      initializationOptions: null,
      languageId: 'go',
      key: 'gopls|/w|/h/go/bin/gopls'
    })
    expect(await resolveServer('/w', '/w/src/lib.rs', deps)).toMatchObject({ kind: 'rust-analyzer', command: '/h/.cargo/bin/rust-analyzer', languageId: 'rust' })
    expect(await resolveServer('/w', '/w/a.py', deps)).toMatchObject({ kind: 'pyright', name: 'pyright', args: ['--stdio'], languageId: 'python' })
    expect(await resolveServer('/w', '/w/a.go', fakeDeps({}))).toBeNull()
    expect(await resolveServer('/w', '/w/README.md', deps)).toBeNull()
  })

  it('Python prefiere basedpyright sobre pyright', async () => {
    const deps = fakeDeps({}, { 'basedpyright-langserver': '/b/basedpyright-langserver', 'pyright-langserver': '/b/pyright-langserver' })
    expect(await resolveServer('/w', '/w/a.py', deps)).toMatchObject({ kind: 'pyright', name: 'basedpyright', command: '/b/basedpyright-langserver' })
  })
})

describe('LspService', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-lsp-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.ts'), '')
  writeFileSync(join(dir, 'src', 'b.ts'), '')
  /** Servidor falso: responde cada mensaje con `{ echo }`; `crash` escribe en stderr y sale con 2; ignora SIGTERM si se pide. */
  const script = join(dir, 'fake-server.js')
  writeFileSync(
    script,
    `let buf = Buffer.alloc(0)
if (process.argv.includes('--stubborn')) process.on('SIGTERM', () => {})
const send = (o) => { const b = Buffer.from(JSON.stringify(o)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b) }
if (process.argv.includes('--grandchild')) {
  // Hijo terco (como tsserver bajo typescript-language-server), sin stdio heredado: avisa su pid.
  const kid = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
  send({ grandchild: kid.pid })
}
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c])
  for (;;) {
    const end = buf.indexOf('\\r\\n\\r\\n'); if (end < 0) return
    const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, end).toString())[1])
    if (buf.length < end + 4 + len) return
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString()); buf = buf.subarray(end + 4 + len)
    if (msg.method === 'crash') { process.stderr.write('panic: algo falló\\n'); process.exit(2) }
    send({ echo: msg })
  }
})
`
  )
  const workspace: Workspace = { id: 'w1', projectId: 'p1', kind: 'local', path: dir, name: 'w' }

  const fakeSpec = (key: string, extra: string[] = []): LspServerSpec => ({
    kind: 'gopls',
    name: 'fake',
    command: process.execPath,
    args: [script, ...extra],
    env: { PATH: process.env.PATH ?? '' },
    cwd: dir,
    initializationOptions: null,
    languageId: 'go',
    key
  })

  const setup = (spec: () => LspServerSpec | null, killDelayMs = 2000) => {
    const svc = new LspService({ resolve: async () => spec(), killDelayMs })
    const messages: Array<[string, string]> = []
    const exits: Array<[string, string | null]> = []
    svc.onMessage((id, m) => messages.push([id, m]))
    svc.onExit((id, e) => exits.push([id, e]))
    return { svc, messages, exits }
  }

  const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
    const t0 = Date.now()
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('lanza el servidor, reenvía con marco y entrega cada respuesta sin cabecera', async () => {
    const { svc, messages, exits } = setup(() => fakeSpec('k'))
    const info = await svc.start(workspace, join(dir, 'src', 'a.ts'), 'c1')
    expect(info).toMatchObject({ kind: 'gopls', name: 'fake', rootUri: pathToFileURL(dir).href, initializationOptions: null, languageId: 'go' })
    svc.send(info!.id, '{"id":1,"method":"hola","params":{"t":"ñ"}}')
    svc.send('desconocido', '{}')
    await until(() => messages.length === 1)
    expect(messages[0]).toEqual([info!.id, '{"echo":{"id":1,"method":"hola","params":{"t":"ñ"}}}'])
    svc.stop(info!.id)
    await until(() => exits.length === 1)
    expect(exits[0]).toEqual([info!.id, null])
    expect(svc.list()).toEqual([])
  })

  it('reusa el servidor con la misma key y cliente; otra key lanza otro', async () => {
    let key = 'k1'
    const { svc } = setup(() => fakeSpec(key))
    const a = await svc.start(workspace, join(dir, 'src', 'a.ts'), 'c1')
    const b = await svc.start(workspace, join(dir, 'src', 'b.ts'), 'c1')
    expect(b!.id).toBe(a!.id)
    key = 'k2'
    const c = await svc.start(workspace, join(dir, 'src', 'a.ts'), 'c1')
    expect(c!.id).not.toBe(a!.id)
    expect(svc.list().sort()).toEqual([a!.id, c!.id].sort())
    svc.stopAll()
    expect(svc.list()).toEqual([])
  })

  it('un cliente nuevo (renderer recargado) para todos los servidores del anterior', async () => {
    const { svc, exits } = setup(() => fakeSpec('k'))
    const old = await svc.start(workspace, join(dir, 'src', 'a.ts'), 'c1')
    const fresh = await svc.start(workspace, join(dir, 'src', 'a.ts'), 'c2')
    expect(fresh!.id).not.toBe(old!.id)
    expect(svc.list()).toEqual([fresh!.id])
    await until(() => exits.length === 1)
    expect(exits[0]).toEqual([old!.id, null])
    svc.stopAll()
  })

  it('una caída se avisa con el nombre, el código y la cola de stderr', async () => {
    const { svc, exits } = setup(() => fakeSpec('k'))
    const info = await svc.start(workspace, join(dir, 'src', 'a.ts'), 'c1')
    svc.send(info!.id, '{"method":"crash"}')
    await until(() => exits.length === 1)
    expect(exits[0]).toEqual([info!.id, 'fake se cerró (código 2): panic: algo falló'])
    expect(svc.list()).toEqual([])
  })

  it('stop manda SIGKILL si el servidor ignora el SIGTERM', async () => {
    const { svc, exits } = setup(() => fakeSpec('k', ['--stubborn']), 100)
    const info = await svc.start(workspace, join(dir, 'src', 'a.ts'), 'c1')
    svc.stop(info!.id)
    await until(() => exits.length === 1)
    expect(exits[0]).toEqual([info!.id, null])
  })

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('killAll (al salir) mata al instante a un servidor que ignora SIGTERM, también si ya se estaba parando', async () => {
    let key = 'k1'
    const { svc, messages, exits } = setup(() => fakeSpec(key, ['--stubborn']), 60_000)
    const a = await svc.start(workspace, join(dir, 'src', 'a.ts'), 'c1')
    key = 'k2'
    const b = await svc.start(workspace, join(dir, 'src', 'a.ts'), 'c1')
    // Que el script ya corra (y tenga su manejador de SIGTERM) antes de pararlo.
    svc.send(a!.id, '{"id":1}')
    svc.send(b!.id, '{"id":1}')
    await until(() => messages.length === 2)
    svc.stop(a!.id)
    await new Promise((r) => setTimeout(r, 100))
    expect(exits).toHaveLength(0)
    svc.killAll()
    expect(svc.list()).toEqual([])
    await until(() => exits.length === 2, 2000)
    expect(exits.map(([id]) => id).sort()).toEqual([a!.id, b!.id].sort())
    expect(exits.every(([, e]) => e === null)).toBe(true)
  })

  it('killAll alcanza a los hijos del servidor (su grupo de procesos)', async () => {
    const { svc, messages, exits } = setup(() => fakeSpec('k', ['--stubborn', '--grandchild']), 60_000)
    await svc.start(workspace, join(dir, 'src', 'a.ts'), 'c1')
    await until(() => messages.length === 1)
    const pid = (JSON.parse(messages[0][1]) as { grandchild: number }).grandchild
    expect(alive(pid)).toBe(true)
    svc.killAll()
    await until(() => exits.length === 1, 2000)
    await until(() => !alive(pid), 2000)
  })

  it('sin servidor para el archivo devuelve null; una ruta fuera del workspace es un error', async () => {
    const { svc } = setup(() => null)
    expect(await svc.start(workspace, join(dir, 'src', 'a.ts'), 'c1')).toBeNull()
    await expect(svc.start(workspace, '/etc/hosts', 'c1')).rejects.toThrow('ruta fuera del workspace')
  })

  it('un binario que no arranca rechaza con un error humano', async () => {
    const { svc, exits } = setup(() => ({ ...fakeSpec('k'), command: join(dir, 'no-existe') }))
    await expect(svc.start(workspace, join(dir, 'src', 'a.ts'), 'c1')).rejects.toThrow('fake no se pudo lanzar')
    expect(exits).toHaveLength(1)
    expect(svc.list()).toEqual([])
  })
})

describe('resolveRemoteServer (§3.26)', () => {
  const files: Record<string, string> = {
    '/srv/app/node_modules/typescript/package.json': '{"version":"7.0.1"}',
    '/srv/old/node_modules/typescript/package.json': '{"version":"5.9.3"}',
    '/srv/old/node_modules/typescript/lib/tsserver.js': ''
  }
  const host = (bins: Record<string, string>) => ({
    key: 'vps',
    exists: async (p: string) => p in files,
    readText: async (p: string) => files[p] ?? '',
    which: async (name: string) => bins[name] ?? null,
    launch: (argv: string[], cwd: string) => ({ command: '/usr/bin/ssh', args: ['vps', '--', `cd ${cwd} && exec ${argv.join(' ')}`] })
  })

  it('TS 7: el tsc del proyecto en el host, lanzado por ssh; la key separa hosts', async () => {
    const spec = await resolveRemoteServer(host({}), '/srv/app', '/srv/app/src/a.ts')
    expect(spec).toMatchObject({ kind: 'tsgo', command: '/usr/bin/ssh', args: ['vps', '--', 'cd /srv/app && exec node /srv/app/node_modules/typescript/bin/tsc --lsp --stdio'] })
    expect(spec?.key.startsWith('vps|tsgo|/srv/app|')).toBe(true)
  })

  it('TS < 7: necesita typescript-language-server en el host (con el tsserver del proyecto)', async () => {
    expect(await resolveRemoteServer(host({}), '/srv/old', '/srv/old/a.ts')).toBeNull()
    const spec = await resolveRemoteServer(host({ 'typescript-language-server': '/home/a/.nvm/bin/typescript-language-server' }), '/srv/old', '/srv/old/a.ts')
    expect(spec?.args.at(-1)).toBe('cd /srv/old && exec /home/a/.nvm/bin/typescript-language-server --stdio')
    expect(spec?.initializationOptions).toEqual({ tsserver: { path: '/srv/old/node_modules/typescript/lib/tsserver.js' } })
  })

  it('gopls y compañía: el binario del PATH de login del host', async () => {
    const spec = await resolveRemoteServer(host({ gopls: '/home/a/go/bin/gopls' }), '/srv/app', '/srv/app/main.go')
    expect(spec?.args.at(-1)).toBe('cd /srv/app && exec /home/a/go/bin/gopls')
    expect(await resolveRemoteServer(host({}), '/srv/app', '/srv/app/lib.rs')).toBeNull()
  })
})
