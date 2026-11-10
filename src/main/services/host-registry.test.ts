import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { HostStatus } from '@shared/types'
import { SshHost } from '../hosts/ssh-host'
import { remoteLine } from '../hosts/shq'
import { dtachPattern, HostRegistry, killCommand, sessionCheckCommand, terminalCommand } from './host-registry'
import { HostStore } from './hosts'

const FAKE_SSH = resolve(__dirname, '../../../e2e/fake-ssh/ssh')

/** Corre un comando de shell con el env dado y devuelve stdout. */
function sh(command: string, env: Record<string, string>, cwd: string): string {
  return execFileSync('/bin/sh', ['-c', command], { env, cwd, encoding: 'utf8' })
}

/**
 * Proceso que se ve como `dtach -A <sock> …` para `pgrep -f` (perl reescribe su `$0`). Resuelve
 * cuando ya cambió el título. `argv0` puede ser `dtach` o una ruta absoluta.
 */
async function fakeDtach(sock: string, argv0 = 'dtach'): Promise<ChildProcess> {
  const title = `${argv0} -A ${sock} -r winch -z /bin/sh -l`
  // El título nuevo no puede pasar del largo del argv original (macOS lo corta): se rellena con un argumento de sobra.
  const child = spawn('perl', ['-e', '$0 = $ENV{OMNI_TITLE}; sleep 60', 'x'.repeat(title.length + 64)], { env: { ...process.env, OMNI_TITLE: title }, stdio: 'ignore' })
  const end = Date.now() + 5_000
  for (;;) {
    try {
      const out = execFileSync('ps', ['-o', 'args=', '-p', String(child.pid)], { encoding: 'utf8' })
      if (out.startsWith(argv0)) return child
    } catch {
      // Todavía no aparece.
    }
    if (Date.now() > end) throw new Error('el dtach falso no cambió su título')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** `true` mientras el proceso exista. */
function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

/** Socket unix muerto (sin nadie escuchando), como el que deja un reinicio del host. */
function deadSocket(path: string): void {
  execFileSync('python3', ['-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', path])
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('tiempo agotado esperando la condición')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Script ejecutable en `dir/name` con el cuerpo dado. */
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('terminalCommand y killCommand', () => {
  let root: string
  let home: string
  let bin: string
  let shell: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync('/tmp/omni-term-'))
    home = join(root, 'home')
    bin = join(root, 'bin')
    mkdirSync(home)
    mkdirSync(bin)
    // El "shell de login": dice dónde arrancó y qué variables recibió.
    shell = script(bin, 'fake-shell', 'printf "pwd=%s\\n" "$(pwd)"; printf "env=%s %s\\n" "$TERM_PROGRAM" "$OMNI_SESSION"; printf "arg=%s\\n" "$@"')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const env = (): Record<string, string> => ({ HOME: home, SHELL: shell, PATH: `${bin}:/usr/bin:/bin` })

  it('sin dtach: entra al cwd (con espacios y comillas) y hace exec del shell de login', () => {
    const cwd = join(root, `con espacios 'y' "comillas" $HOME`)
    mkdirSync(cwd)
    const out = sh(terminalCommand('sess-1', cwd, null), env(), root)
    expect(out).toBe(`pwd=${cwd}\nenv=omni 1\narg=-l\n`)
  })

  it('un cwd que no existe cae al $HOME en vez de fallar', () => {
    expect(sh(terminalCommand('sess-1', join(root, 'nope'), null), env(), root)).toContain(`pwd=${home}\n`)
  })

  it('con dtach: crea ~/.omni/run (700) y se engancha o crea la sesión con su socket', () => {
    script(bin, 'dtach', 'printf "dtach=%s\\n" "$@"; printf "pwd=%s\\n" "$(pwd)"')
    const cwd = join(root, "it's")
    mkdirSync(cwd)
    const out = sh(terminalCommand('abc_123', cwd, 'dtach'), env(), root)
    expect(out).toBe(['-A', `${home}/.omni/run/abc_123.sock`, '-r', 'winch', '-z', shell, '-l'].map((a) => `dtach=${a}\n`).join('') + `pwd=${cwd}\n`)
    expect(statSync(join(home, '.omni/run')).mode & 0o777).toBe(0o700)
  })

  it('ids de sesión inválidos se rechazan', () => {
    for (const bad of ['', 'a b', 'a;b', '../x', '$(id)', 'x'.repeat(81)]) {
      expect(() => terminalCommand(bad, '/tmp', 'dtach'), bad).toThrow(/id de sesión inválido/)
      expect(() => killCommand(bad), bad).toThrow(/id de sesión inválido/)
    }
  })

  it('killCommand: el patrón va entero entre comillas simples, sin un * suelto que el shell expanda', () => {
    const cmd = killCommand('sess-1')
    expect(cmd.replace(/'[^']*'/g, '')).not.toContain('*')
    // Con carpetas que el glob `.*/…` sí encontraría, el patrón llega intacto a pkill.
    mkdirSync(join(root, '.omni/run'), { recursive: true })
    writeFileSync(join(root, '.omni/run/sess-1.sock'), '')
    const out = sh(`pkill() { printf 'pkill=%s\\n' "$@"; }; ${cmd}`, env(), root)
    expect(out).toBe(['-f', '--', '^([^ ]*/)?dtach -A .*/\\.omni/run/sess-1\\.sock( |$)'].map((a) => `pkill=${a}\n`).join(''))
  })

  it('con la ruta absoluta de dtach del preflight: la usa aunque no esté en el PATH del shell', () => {
    const tools = join(root, 'herramientas con espacio')
    mkdirSync(tools)
    const dtach = script(tools, 'dtach', 'printf "dtach=%s\\n" "$1"')
    const out = sh(terminalCommand('abc', root, dtach), env(), root)
    expect(out).toBe('dtach=-A\n')
  })

  it('dtachPattern: calza con dtach (y /ruta/dtach) de esa sesión, nunca con el sh -c que corre pkill ni con otra sesión', () => {
    const re = new RegExp(dtachPattern('sess-1'))
    expect(re.test('dtach -A /home/u/.omni/run/sess-1.sock -r winch -z /bin/bash -l')).toBe(true)
    expect(re.test('/usr/bin/dtach -A /home/mi usuario/.omni/run/sess-1.sock -r winch -z /bin/bash -l')).toBe(true)
    expect(re.test('dtach -A /home/u/.omni/run/sess-10.sock -r winch')).toBe(false)
    expect(re.test('dtach -A /home/u/.omni/run/sess-1Xsock -r winch')).toBe(false)
    // Lo que ve pkill del shell que lo corre: con el patrón sin anclar se mataba a sí mismo y el `rm` nunca corría.
    expect(re.test(`/bin/sh -c ${killCommand('sess-1')}`)).toBe(false)
    expect(re.test(`sh -c ${killCommand('sess-1')}`)).toBe(false)
    expect(re.test(`/bin/sh -c ${remoteLine(killCommand('sess-1'))}`)).toBe(false)
    expect(re.test(`bash -c ${remoteLine(killCommand('sess-1'))}`)).toBe(false)
    expect(re.test(`ssh -tt vps -- exec /bin/dtach -A "$HOME"/.omni/run/sess-1.sock`)).toBe(false)
  })

  it('killCommand con pkill de verdad: mata el dtach de la sesión, no el shell que lo corre, y borra el socket', async () => {
    const id = `t${process.pid}x${Date.now()}`
    mkdirSync(join(home, '.omni/run'), { recursive: true })
    const sock = join(home, '.omni/run', `${id}.sock`)
    writeFileSync(sock, '')
    const target = await fakeDtach(sock)
    const other = await fakeDtach(join(home, '.omni/run', `${id}0.sock`), '/usr/local/bin/dtach')
    try {
      // `sh -c` como lo corre sshd: si pkill matara a este shell, el `rm` no correría y saldría por señal.
      // El pkill de Linux (procps) solo se excluye a sí mismo; el de macOS también a sus ancestros
      // salvo con `-a`, que aquí reproduce el comportamiento de Linux (con el patrón viejo, sin `^`,
      // este shell moría antes del `rm`).
      const linuxLike = process.platform === 'darwin' ? 'pkill() { command pkill -a "$@"; }; ' : ''
      execFileSync('/bin/sh', ['-c', `${linuxLike}${killCommand(id)}`], { env: { ...env(), PATH: '/usr/bin:/bin' } })
      await until(() => !alive(target))
      expect(existsSync(sock)).toBe(false)
      expect(alive(other)).toBe(true)
    } finally {
      target.kill('SIGKILL')
      other.kill('SIGKILL')
    }
  })

  it('sessionCheckCommand: socket con su dtach vivo → 0; socket muerto (host reiniciado) → 1 y se borra; sin socket → 1', async () => {
    const id = `c${process.pid}x${Date.now()}`
    const run = (): number => {
      try {
        execFileSync('/bin/sh', ['-c', sessionCheckCommand(id)], { env: { ...env(), PATH: '/usr/bin:/bin' } })
        return 0
      } catch (err) {
        return (err as { status: number }).status
      }
    }
    mkdirSync(join(home, '.omni/run'), { recursive: true })
    const sock = join(home, '.omni/run', `${id}.sock`)
    expect(run()).toBe(1)
    deadSocket(sock)
    expect(run()).toBe(1)
    expect(existsSync(sock)).toBe(false)
    deadSocket(sock)
    const dtach = await fakeDtach(sock, '/usr/bin/dtach')
    try {
      expect(run()).toBe(0)
      expect(existsSync(sock)).toBe(true)
    } finally {
      dtach.kill('SIGKILL')
    }
  })

  it('killCommand borra el socket del $HOME', () => {
    mkdirSync(join(home, '.omni/run'), { recursive: true })
    writeFileSync(join(home, '.omni/run/sess-1.sock'), '')
    sh(`pkill() { :; }; ${killCommand('sess-1')}`, env(), root)
    expect(() => statSync(join(home, '.omni/run/sess-1.sock'))).toThrow()
  })
})

// Cada llamada al ssh falso arranca un python: con la máquina cargada, 5 s se quedan cortos.
describe('HostRegistry contra el ssh falso', { timeout: 30_000 }, () => {
  const saved = { ...process.env }
  let root: string
  let registry: HostRegistry
  let statuses: HostStatus[]
  let hostId: string

  beforeAll(() => {
    // /tmp y no tmpdir(): ruta corta para los sockets y `realpath` la resuelve (sirve para probar symlinks).
    root = realpathSync(mkdtempSync('/tmp/omni-hostreg-'))
    process.env.FAKE_SSH_HOME = root
    process.env.FAKE_SSH_REMOTE_SHELL = '/bin/sh'
    for (const d of ['proyectos/omni', 'proyectos/omnibus', 'proyectos/zeta', 'Docs', '.config']) mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, 'proyectos/omni.txt'), 'x')
    symlinkSync(join(root, 'proyectos/omni'), join(root, 'atajo'))
  })
  afterAll(() => {
    process.env = saved
    rmSync(root, { recursive: true, force: true })
  })
  beforeEach(() => {
    delete process.env.FAKE_SSH_FAIL
    const store = new HostStore(join(root, `hosts-${Math.random()}.json`))
    hostId = store.add('vps', 'alex@vps').id
    registry = new HostRegistry({ store, createSsh: (spec) => new SshHost(spec, { sshBin: FAKE_SSH, controlDir: join(root, '.ctl') }) })
    statuses = []
    registry.onStatus((s) => statuses.push(s))
  })

  it('connect: conectado con home, sistema y herramientas del preflight; avisa cada cambio', async () => {
    expect(registry.statusOf(hostId).state).toBe('disconnected')
    const status = await registry.connect(hostId)
    expect(status).toMatchObject({ hostId, state: 'connected', error: null, home: root })
    // El "host" es este Mac: el sistema y git son los de aquí.
    expect(status.system).toBe(execFileSync('uname', ['-sm'], { encoding: 'utf8' }).trim())
    expect(status.tools?.git).toBe(true)
    expect(typeof status.tools?.dtach).toBe('boolean')
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'connected'])
    expect(registry.statuses()).toEqual([status])
    expect(registry.connected(hostId)).toBe(registry.for(hostId))

    await registry.disconnect(hostId)
    expect(registry.statusOf(hostId).state).toBe('disconnected')
    expect(statuses.at(-1)?.state).toBe('disconnected')
    expect(() => registry.connected(hostId)).toThrow('vps no está conectado')
  })

  it('costLogs: lista los .jsonl recientes del host con find + stat y lee desde un offset con tail', async () => {
    const dir = join(root, '.claude', 'projects', '-srv-app')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'una sesión.jsonl'), 'linea-1\nlinea-2\n')
    await registry.connect(hostId)
    const logs = await registry.costLogs(hostId)
    expect(logs.home).toBe(root)
    const files = await logs.list(join(root, '.claude', 'projects'), Date.now() - 60_000)
    expect(files).toEqual([expect.objectContaining({ rel: '-srv-app/una sesión.jsonl', size: 16 })])
    expect((await logs.read(join(dir, 'una sesión.jsonl'), 8, 100)).toString()).toBe('linea-2\n')
    expect((await logs.read(join(dir, 'una sesión.jsonl'), 0, 3)).toString()).toBe('lin')
    // Sin la carpeta (el host nunca corrió el CLI): lista vacía, no error.
    expect(await logs.list(join(root, '.codex', 'sessions'), 0)).toEqual([])
  })

  it('forwardPort: reenvía por el master, reusa el túnel vivo y lo cancela al desconectar', async () => {
    const { createServer } = await import('node:net')
    // El sondeo de "¿sigue vivo el túnel?" abre y corta una conexión: el reset no es un error del test.
    const server = createServer((c) => {
      c.on('error', () => undefined)
      c.end('hola desde el host')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const remotePort = (server.address() as { port: number }).port
    try {
      await registry.connect(hostId)
      // El "host" es este Mac: el puerto remoto está ocupado aquí, así que el local es otro.
      const local = await registry.forwardPort(hostId, remotePort)
      expect(local).not.toBe(remotePort)
      const { createConnection } = await import('node:net')
      const text = await new Promise<string>((resolve, reject) => {
        const c = createConnection({ host: '127.0.0.1', port: local })
        let buf = ''
        c.on('data', (d) => (buf += d.toString()))
        c.on('end', () => resolve(buf))
        c.on('error', reject)
      })
      expect(text).toBe('hola desde el host')
      expect(await registry.forwardPort(hostId, remotePort)).toBe(local)
      expect(registry.forwardsOf(hostId)).toEqual([{ remote: remotePort, local }])
      await registry.disconnect(hostId)
      expect(registry.forwardsOf(hostId)).toEqual([])
    } finally {
      server.close()
    }
  })

  it('connect en paralelo reusa la misma conexión en curso', async () => {
    const [a, b] = await Promise.all([registry.connect(hostId), registry.connect(hostId)])
    expect(a).toBe(b)
    expect(statuses.filter((s) => s.state === 'connecting')).toHaveLength(1)
  })

  it('fallo de autenticación: estado error con mensaje en español, sin tirar; ensure sí tira', async () => {
    process.env.FAKE_SSH_FAIL = 'auth'
    const status = await registry.connect(hostId)
    expect(status.state).toBe('error')
    expect(status.error).toMatch(/llaves o el agente/)
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'error'])
    await expect(registry.ensure(hostId)).rejects.toThrow(/llaves o el agente/)
  })

  it('un host que no está en hosts.json: estado error, y for() tira con error humano', async () => {
    expect(await registry.connect('nope')).toMatchObject({ state: 'error', error: 'host desconocido: nope' })
    expect(() => registry.for('nope')).toThrow('host desconocido: nope')
    expect(registry.for(undefined)).toBe(registry.local)
  })

  it('suggestPaths: ~/ lista carpetas del home; con prefijo filtra; ocultas solo si se escribe el punto', async () => {
    const all = await registry.suggestPaths(hostId, '~/')
    expect(all).toEqual(expect.arrayContaining([join(root, 'Docs'), join(root, 'proyectos')]))
    expect(all).not.toContain(join(root, '.config'))
    expect(all).not.toContain(join(root, 'proyectos/omni.txt'))
    expect(await registry.suggestPaths(hostId, '')).toEqual(all)
    expect(await registry.suggestPaths(hostId, '~/proyectos/OM')).toEqual([join(root, 'proyectos/omni'), join(root, 'proyectos/omnibus')])
    expect(await registry.suggestPaths(hostId, `${root}/proyectos/z`)).toEqual([join(root, 'proyectos/zeta')])
    expect(await registry.suggestPaths(hostId, '~/.co')).toEqual([join(root, '.config')])
    expect(await registry.suggestPaths(hostId, 'relativa')).toEqual([])
    expect(await registry.suggestPaths(hostId, '~/nope/')).toEqual([])
  })

  it('resolveDir: ruta real de una carpeta; error si no existe, si es un archivo o si es relativa', async () => {
    expect(await registry.resolveDir(hostId, '~/proyectos/omni')).toBe(join(root, 'proyectos/omni'))
    expect(await registry.resolveDir(hostId, '~')).toBe(root)
    expect(await registry.resolveDir(hostId, join(root, 'atajo'))).toBe(join(root, 'proyectos/omni'))
    await expect(registry.resolveDir(hostId, '~/nope')).rejects.toThrow(`no existe en vps: ${join(root, 'nope')}`)
    await expect(registry.resolveDir(hostId, '~/proyectos/omni.txt')).rejects.toThrow(/no es una carpeta/)
    await expect(registry.resolveDir(hostId, 'proyectos')).rejects.toThrow(/absoluta o empezar con ~/)
  })

  it('terminalSpawn: ssh del transporte, -tt, -- y el comando; reconecta solo si hay dtach', async () => {
    const spawn = await registry.terminalSpawn(hostId, 'sess-1', '/srv/app')
    const status = registry.statusOf(hostId)
    expect(spawn.file).toBe(FAKE_SSH)
    const dtach = status.tools?.dtach === true
    expect(spawn.reconnect).toBe(dtach)
    const target = spawn.args.indexOf('alex@vps')
    expect(target).toBeGreaterThan(0)
    expect(spawn.args.slice(target)).toEqual(['alex@vps', '-tt', '--', remoteLine(terminalCommand('sess-1', '/srv/app', dtach ? (status.tools?.dtachPath ?? 'dtach') : null))])
    expect(spawn.args).toContain('BatchMode=yes')
    await expect(registry.terminalSpawn(hostId, 'mal id', '/srv')).rejects.toThrow(/id de sesión inválido/)
  })

  it('connect ya conectado: no vuelve a avisar connecting/connected (no re-dispara revivir)', async () => {
    await registry.connect(hostId)
    const status = await registry.connect(hostId)
    expect(status.state).toBe('connected')
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'connected'])
  })

  it('connect ya conectado con el master caído: lo levanta y avisa connected (sin connecting)', async () => {
    await registry.connect(hostId)
    process.env.FAKE_SSH_NO_MASTER = '1'
    try {
      expect((await registry.connect(hostId)).state).toBe('connected')
    } finally {
      delete process.env.FAKE_SSH_NO_MASTER
    }
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'connected', 'connected'])
  })

  it('connect ya conectado pero el host ya no responde: reconecta de cero y queda en error', async () => {
    await registry.connect(hostId)
    process.env.FAKE_SSH_FAIL = 'unreachable'
    expect((await registry.connect(hostId)).state).toBe('error')
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'connected', 'connecting', 'error'])
  })

  it('hasSession: socket muerto tras reiniciar el host → false (y se borra); con su dtach vivo → true', async () => {
    const id = `h${process.pid}x${Date.now()}`
    mkdirSync(join(root, '.omni/run'), { recursive: true })
    const sock = join(root, '.omni/run', `${id}.sock`)
    deadSocket(sock)
    expect(await registry.hasSession(hostId, id)).toBe(false)
    expect(existsSync(sock)).toBe(false)
    deadSocket(sock)
    const dtach = await fakeDtach(sock)
    try {
      expect(await registry.hasSession(hostId, id)).toBe(true)
    } finally {
      dtach.kill('SIGKILL')
    }
  })

  it('killSession sin conexión: queda pendiente y se cumple al conectar', async () => {
    const id = `k${process.pid}x${Date.now()}`
    mkdirSync(join(root, '.omni/run'), { recursive: true })
    const sock = join(root, '.omni/run', `${id}.sock`)
    writeFileSync(sock, '')
    const dtach = await fakeDtach(sock)
    try {
      process.env.FAKE_SSH_FAIL = 'unreachable'
      await registry.killSession(hostId, id)
      expect(registry.pendingKillsOf(hostId)).toEqual([id])
      expect(alive(dtach)).toBe(true)
      delete process.env.FAKE_SSH_FAIL
      expect((await registry.connect(hostId)).state).toBe('connected')
      // El `rm` del socket corre justo después del `pkill`, en el mismo ssh.
      await until(() => !alive(dtach) && !existsSync(sock), 15_000)
      expect(registry.pendingKillsOf(hostId)).toEqual([])
    } finally {
      dtach.kill('SIGKILL')
    }
  })

  it('killSession con el host desconectado pero alcanzable: conecta y mata (antes no hacía nada)', async () => {
    const id = `d${process.pid}x${Date.now()}`
    mkdirSync(join(root, '.omni/run'), { recursive: true })
    const dtach = await fakeDtach(join(root, '.omni/run', `${id}.sock`))
    try {
      expect(registry.statusOf(hostId).state).toBe('disconnected')
      await registry.killSession(hostId, id)
      await until(() => !alive(dtach))
      expect(registry.pendingKillsOf(hostId)).toEqual([])
    } finally {
      dtach.kill('SIGKILL')
    }
  })

  it('preflight guarda la ruta absoluta de dtach y terminalSpawn la usa', async () => {
    const bin = join(root, 'bin-dtach')
    mkdirSync(bin, { recursive: true })
    script(bin, 'dtach', 'exit 0')
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path ?? ''}`
    try {
      const status = await registry.connect(hostId)
      expect(status.tools).toMatchObject({ dtach: true, dtachPath: join(bin, 'dtach') })
      const spawn = await registry.terminalSpawn(hostId, 'sess-1', '/srv')
      expect(spawn.reconnect).toBe(true)
      expect(spawn.args.at(-1)).toBe(remoteLine(terminalCommand('sess-1', '/srv', join(bin, 'dtach'))))
    } finally {
      process.env.PATH = path
    }
  })
})

// sshd corre la línea con el shell de passwd del usuario: con csh (o fish) nada POSIX puede llegarle crudo.
describe('HostRegistry con un shell de login csh', { timeout: 30_000 }, () => {
  const saved = { ...process.env }
  let root: string
  let registry: HostRegistry
  let hostId: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync('/tmp/omni-csh-'))
    mkdirSync(join(root, 'proyecto'))
    process.env.FAKE_SSH_HOME = root
    process.env.FAKE_SSH_LOGIN_SHELL = '/bin/csh'
    process.env.FAKE_SSH_REMOTE_SHELL = '/bin/csh'
    delete process.env.FAKE_SSH_FAIL
    const store = new HostStore(join(root, 'hosts.json'))
    hostId = store.add('vps', 'alex@vps').id
    registry = new HostRegistry({ store, createSsh: (spec) => new SshHost(spec, { sshBin: FAKE_SSH, controlDir: join(root, '.ctl') }) })
  })
  afterAll(() => {
    process.env = saved
    rmSync(root, { recursive: true, force: true })
  })

  it('conecta (preflight con saltos de línea y $(…)), exec, archivos con ñ y comillas, y hasSession', async () => {
    const status = await registry.connect(hostId)
    expect(status).toMatchObject({ state: 'connected', home: root })
    expect(status.tools?.git).toBe(true)
    const host = registry.connected(hostId)
    const r = await host.exec('printf', ['%s|', "it's", '$HOME', 'a!b', 'ñ'], { cwd: join(root, 'proyecto'), timeoutMs: 10_000 })
    expect(r.stdout).toBe("it's|$HOME|a!b|ñ|")
    const login = await host.execLogin('printf', ['%s', 'login ok!'], { cwd: '/', timeoutMs: 10_000 })
    expect(login.stdout).toContain('login ok!')
    const file = join(root, 'proyecto', "nuevo 'ñ'.txt")
    await host.fs.writeFile(file, 'hola\n')
    expect((await host.fs.readFile(file)).toString()).toBe('hola\n')
    expect(await registry.hasSession(hostId, 'no-existe')).toBe(false)
  })

  it('la línea de la terminal corre aunque el shell sea csh', () => {
    const out = execFileSync('/bin/csh', ['-c', remoteLine(terminalCommand('sess-1', join(root, 'proyecto'), null))], {
      env: { HOME: root, SHELL: '/bin/echo', PATH: '/usr/bin:/bin' },
      encoding: 'utf8'
    })
    expect(out).toBe('-l\n')
  })
})

describe('parseStatLines', () => {
  it('lee el stat GNU o BSD de costLogs y deja rutas relativas a la raíz', async () => {
    const { parseStatLines } = await import('./host-registry')
    const out = '120 1793110000 42 /home/a/.claude/projects/-srv-app/x.jsonl\nbasura\n5 1793110001 43 /otra/raiz/y.jsonl\n9 1793110002 44 /home/a/.claude/projects/-srv-app/sub agentes/z.jsonl\n'
    expect(parseStatLines(out, '/home/a/.claude/projects')).toEqual([
      { rel: '-srv-app/x.jsonl', size: 120, mtime: 1793110000000, ino: 42 },
      { rel: '-srv-app/sub agentes/z.jsonl', size: 9, mtime: 1793110002000, ino: 44 }
    ])
  })
})
