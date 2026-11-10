import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canSignalGroup, describeCommand, parseCwds, parseElapsed, parseLsof, parsePs, PortScanner, readRepo, resolveOwner } from './ports'

const LSOF = ['p3413', 'cnode', 'f20', 'n*:3000', 'f21', 'n[::1]:9999', 'f22', 'n*:3000', 'p586', 'cfigma_agent', 'f8', 'n127.0.0.1:44950', 'p606', 'cOneDrive\\x20Sync', 'f3', 'n[::1]:42050', 'p9', 'cbroken', 'f1', 'nsin-puerto'].join('\n')

const PS = [
  '    1     0     1 13-03:13:46 /sbin/launchd',
  '  500     1   500 13-00:00:00 /Applications/omni.app/Contents/MacOS/omni',
  '  600     1   600 10-00:00:00 omni-daemon',
  '  700   600   700    05:00:00 -zsh',
  '  710   700   710    04:00:00 node /usr/local/bin/pnpm dev',
  '  720   710   710    03:59:59 node /repo/node_modules/.bin/nuxt dev --port 3100',
  '  800   600   800    02:00:00 /bin/zsh -l',
  '  810   800   810    01:00:00 claude',
  '  820   810   810       34:09 node server.js',
  '  900   500   500       10:00 /Applications/omni.app/Contents/Frameworks/omni Helper',
  ' 1000     1  1000    01:00:00 node dist/main.js'
].join('\n')

describe('parsers', () => {
  it('parseElapsed entiende días, horas y minutos', () => {
    expect(parseElapsed('13-03:13:46')).toBe(13 * 86400 + 3 * 3600 + 13 * 60 + 46)
    expect(parseElapsed('01:18:28')).toBe(3600 + 18 * 60 + 28)
    expect(parseElapsed('34:09')).toBe(34 * 60 + 9)
    expect(parseElapsed('ayer')).toBeNull()
  })

  it('parseLsof agrupa por proceso, sin repetir IPv4/IPv6 y con los espacios de vuelta', () => {
    const entries = parseLsof(LSOF)
    expect(entries).toEqual([
      { pid: 3413, name: 'node', ports: [3000, 9999], hosts: ['*', '::1'] },
      { pid: 586, name: 'figma_agent', ports: [44950], hosts: ['127.0.0.1'] },
      { pid: 606, name: 'OneDrive Sync', ports: [42050], hosts: ['::1'] }
    ])
  })

  it('parsePs y parseCwds leen pid, padre, grupo y carpeta', () => {
    const table = parsePs(PS)
    expect(table.get(720)).toMatchObject({ ppid: 710, pgid: 710, command: 'node /repo/node_modules/.bin/nuxt dev --port 3100' })
    expect(parseCwds('p1\nfcwd\nn/\np2\nfcwd\nn/Users/a/web').get(2)).toBe('/Users/a/web')
  })
})

describe('describeCommand', () => {
  it.each([
    ['node /repo/node_modules/.bin/nuxt dev --dotenv ./env/dev.env', 'nuxt dev'],
    ['node node_modules/.bin/vite --port 5173', 'vite'],
    ['node --enable-source-maps --expose-gc dist/main.js', 'node dist/main.js'],
    ['/usr/bin/python3 -m http.server 8000', 'python3 -m http.server'],
    ['/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility', 'Visual Studio Code'],
    ['/opt/homebrew/opt/postgresql@16/bin/postgres -D /opt/homebrew/var/postgresql@16', 'postgres'],
    ['redis-server *:6379', 'redis-server'],
    ['bun run dev', 'bun run'],
    ["node -e require('http').createServer().listen(3000)", 'node -e'],
    ['python3 -c import http.server', 'python3 -c']
  ])('%s → %s', (command, name) => {
    expect(describeCommand(command, 'x')).toBe(name)
  })
})

describe('dueño y grupo', () => {
  const table = parsePs(PS)
  const owners = { root: 600, sessions: { s1: 700, s2: 800 } }

  it('resolveOwner sube hasta el shell de la sesión, aunque pase por un agente', () => {
    expect(resolveOwner(720, table, owners, 500)).toEqual({ sessionId: 's1', inOmni: true, self: false })
    expect(resolveOwner(820, table, owners, 500)).toEqual({ sessionId: 's2', inOmni: true, self: false })
    expect(resolveOwner(1000, table, owners, 500)).toEqual({ sessionId: null, inOmni: false, self: false })
    expect(resolveOwner(900, table, owners, 500)).toEqual({ sessionId: null, inOmni: false, self: true })
  })

  it('con un daemon viejo (sin pids de sesión) sabe que es de omni pero no de cuál', () => {
    expect(resolveOwner(720, table, { root: 600, sessions: {} }, 500)).toEqual({ sessionId: null, inOmni: true, self: false })
  })

  it('canSignalGroup: el trabajo de pnpm dev sí; el que lanzó un agente, omni o un proceso suelto en su propio grupo según su cadena', () => {
    // nuxt (720) está en el grupo de pnpm (710), cuyo líder no es shell: cae el trabajo entero, como con ⌃C.
    expect(canSignalGroup(720, table, owners, 500)).toBe(true)
    // node server.js (820) comparte grupo con claude (810): solo se mata el proceso.
    expect(canSignalGroup(820, table, owners, 500)).toBe(false)
    // El helper de omni está en el grupo de omni.
    expect(canSignalGroup(900, table, owners, 500)).toBe(false)
    // Líder de su propio grupo y sin shell en el camino.
    expect(canSignalGroup(1000, table, owners, 500)).toBe(true)
  })
})

describe('readRepo', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('lee repo, rama y subcarpeta de un checkout y de un worktree enlazado', async () => {
    dir = await mkdtemp(join(tmpdir(), 'omni-ports-'))
    const main = join(dir, 'shop')
    await mkdir(join(main, '.git', 'worktrees', 'feat'), { recursive: true })
    await mkdir(join(main, 'service'), { recursive: true })
    await writeFile(join(main, '.git', 'HEAD'), 'ref: refs/heads/dev\n')
    await writeFile(join(main, '.git', 'worktrees', 'feat', 'HEAD'), 'ref: refs/heads/feature/pagos\n')
    const wt = join(dir, 'wts', 'feat')
    await mkdir(wt, { recursive: true })
    await writeFile(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feat')}\n`)

    expect(await readRepo(join(main, 'service'), dir)).toEqual({ name: 'shop', branch: 'dev', worktree: false, sub: 'service' })
    expect(await readRepo(wt, dir)).toEqual({ name: 'shop', branch: 'feature/pagos', worktree: true, sub: '' })
    expect(await readRepo(join(dir, 'wts'), dir)).toBeNull()
  })
})

describe('PortScanner', () => {
  const exec = async (file: string, args: string[]): Promise<string> => {
    if (file === 'ps') return PS
    if (args.includes('cwd')) return 'p720\nfcwd\nn/\np820\nfcwd\nn/\np1000\nfcwd\nn/\np42\nfcwd\nn/'
    return ['p720', 'cnode', 'n*:3100', 'p820', 'cnode', 'n127.0.0.1:8080', 'p1000', 'cnode', 'n*:7123', 'p42', 'crapportd', 'n*:5000'].join('\n')
  }

  it('lista los servicios de omni y de carpeta antes que el sistema, con su sesión', async () => {
    const scanner = new PortScanner({ owners: async () => ({ root: 600, sessions: { s1: 700, s2: 800 } }), self: 500, exec, home: '/nada' })
    const list = await scanner.list()
    expect(list.map((p) => [p.ports[0], p.kind, p.sessionId])).toEqual([
      [3100, 'dev', 's1'],
      [8080, 'dev', 's2'],
      [5000, 'system', null],
      [7123, 'system', null]
    ])
    expect(list[0].name).toBe('nuxt dev')
  })

  it('stop no toca un pid que ya no escucha en ese puerto ni a omni', async () => {
    const scanner = new PortScanner({ owners: async () => ({ root: 600, sessions: {} }), self: 500, exec, home: '/nada' })
    expect(await scanner.stop(720, 9999)).toMatchObject({ ok: false, error: expect.stringContaining(':9999') })
    expect(await scanner.stop(31337, 3100)).toMatchObject({ ok: false })
  })
})

describe('PortScanner contra procesos de verdad', () => {
  it('encuentra un servidor recién levantado y lo detiene con SIGTERM', async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['-e', "require('http').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port) })"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const port = await new Promise<number>((done) => child.stdout.once('data', (b: Buffer) => done(Number(String(b).trim()))))
    // self ajeno: el servidor es hijo de este proceso de test y si no contaría como omni mismo.
    const scanner = new PortScanner({ owners: async () => ({ root: null, sessions: {} }), self: -1 })
    try {
      const found = (await scanner.list()).find((p) => p.pid === child.pid)
      expect(found).toMatchObject({ ports: [port], hosts: ['127.0.0.1'], kind: 'dev', self: false })
      expect(await scanner.stop(child.pid ?? 0, port)).toEqual({ ok: true, forced: false })
      expect((await scanner.list()).some((p) => p.pid === child.pid)).toBe(false)
    } finally {
      // Si algo falla antes de detenerlo, el servidor no queda huérfano escuchando.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 15_000)
})
