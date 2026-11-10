import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loginWrap, remoteLine, shCommand } from './shq'
import { assertTarget, controlPath, describeSshFailure, ensureControlDir, SshError, SshTransport } from './ssh'

const FAKE_SSH = resolve(__dirname, '../../../e2e/fake-ssh/ssh')

describe('describeSshFailure', () => {
  const cases: [string, string, RegExp][] = [
    ['auth', 'alex@vps: Permission denied (publickey,password).', /llaves o el agente/],
    ['resolve', 'ssh: Could not resolve hostname nope: nodename nor servname provided, or not known', /No se encuentra el host vps/],
    ['refused', 'ssh: connect to host vps port 22: Connection refused', /rechazó la conexión/],
    ['timeout', 'ssh: connect to host vps port 22: Connection timed out', /no responde/],
    ['timeout', 'ssh: connect to host vps port 22: Operation timed out', /no responde/],
    ['unreachable', 'ssh: connect to host vps port 22: No route to host', /No hay ruta/],
    ['hostkey', 'No ED25519 host key is known for vps and you have requested strict checking.\nHost key verification failed.', /known_hosts.*ssh-keygen -R vps/],
    ['other', 'kex_exchange_identification: read: Connection reset by peer\n', /Connection reset by peer/]
  ]
  it.each(cases)('%s: %s', (kind, stderr, message) => {
    const err = describeSshFailure(stderr, 'alex@vps')
    expect(err).toBeInstanceOf(SshError)
    expect(err.kind).toBe(kind)
    expect(err.message).toMatch(message)
  })

  it('llave cambiada: sugiere ssh-keygen -R con el host que nombra OpenSSH', () => {
    const err = describeSshFailure(
      '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key for [vps.example.com]:2222 has changed and you have requested strict checking.\nHost key verification failed.',
      'vps'
    )
    expect(err.kind).toBe('hostkey')
    expect(err.message).toContain('ssh-keygen -R [vps.example.com]:2222')
  })
})

describe('assertTarget', () => {
  it('rechaza destinos que ssh leería como opción o con espacios', () => {
    expect(() => assertTarget('-oProxyCommand=evil')).toThrow()
    expect(() => assertTarget('a b')).toThrow()
    expect(() => assertTarget('a\nb')).toThrow()
    expect(() => assertTarget('')).toThrow()
    expect(() => assertTarget('alex@vps.example.com')).not.toThrow()
  })
})

describe('control socket', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync('/tmp/omni-sshtest-')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('ruta corta y estable por destino', () => {
    const a = controlPath('/tmp/omni-ssh-501', 'alex@vps')
    expect(a).toBe(controlPath('/tmp/omni-ssh-501', 'alex@vps'))
    expect(a).not.toBe(controlPath('/tmp/omni-ssh-501', 'vps'))
    expect(Buffer.byteLength(a)).toBeLessThan(104)
  })

  it('crea la carpeta con 0700 y corrige permisos abiertos', async () => {
    const dir = join(root, 'ctl')
    await ensureControlDir(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    chmodSync(dir, 0o755)
    await ensureControlDir(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('rechaza un symlink', async () => {
    const real = join(root, 'real')
    mkdirSync(real, { mode: 0o700 })
    const link = join(root, 'link')
    symlinkSync(real, link)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    await expect(ensureControlDir(link)).rejects.toThrow(/symlink/)
  })
})

describe('SshTransport contra el ssh falso', () => {
  let root: string
  let log: string
  const env = { ...process.env }

  beforeAll(() => {
    root = mkdtempSync('/tmp/omni-sshtest-')
    log = join(root, 'ssh.log')
    process.env.FAKE_SSH_HOME = root
    process.env.FAKE_SSH_REMOTE_SHELL = '/bin/sh'
    process.env.FAKE_SSH_LOG = log
  })
  afterEach(() => {
    delete process.env.FAKE_SSH_FAIL
  })
  afterAll(() => {
    process.env = env
    rmSync(root, { recursive: true, force: true })
  })

  const transport = (): SshTransport => new SshTransport({ id: 'h1', name: 'vps', target: 'alex@vps' }, { sshBin: FAKE_SSH, controlDir: join(root, 'ctl') })
  const lastArgv = (): string[] => {
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    return JSON.parse(lines.at(-1) ?? '[]') as string[]
  }

  it('baseArgs: opciones de ControlMaster y BatchMode, destino al final', () => {
    const t = transport()
    const args = t.baseArgs()
    expect(args.at(-1)).toBe('alex@vps')
    expect(args).toContain('ControlMaster=auto')
    expect(args).toContain('ControlPersist=600')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain(`ControlPath=${t.controlPath}`)
  })

  it('connect: -O check, y close: -O exit', async () => {
    const t = transport()
    await t.connect()
    expect(lastArgv()).toEqual(expect.arrayContaining(['-O', 'check', 'alex@vps']))
    await t.close()
    expect(lastArgv()).toEqual(expect.arrayContaining(['-O', 'exit', 'alex@vps']))
  })

  it('connect sin master: lo levanta con un comando trivial', async () => {
    process.env.FAKE_SSH_NO_MASTER = '1'
    try {
      expect(await transport().connect()).toBe(true)
      expect(lastArgv().at(-1)).toBe(remoteLine('printf omni-ssh-ok'))
    } finally {
      delete process.env.FAKE_SSH_NO_MASTER
    }
  })

  it('exec: argumentos difíciles intactos, cwd remoto y código del comando', async () => {
    const t = transport()
    const dir = join(root, "it's a $dir")
    mkdirSync(dir)
    const args = ["it's", '$HOME', '`id`', 'a\nb', 'ñ 🚀', '', '-n']
    const r = await t.exec('printf', ['%s\\0', ...args], { cwd: dir, timeoutMs: 10_000 })
    expect(r.code).toBe(0)
    expect(r.stdout.split('\0').slice(0, -1)).toEqual(args)
    const pwd = await t.exec('pwd', [], { cwd: dir, timeoutMs: 10_000 })
    expect(pwd.stdout.trim()).toBe(dir)
    const fail = await t.exec('sh', ['-c', 'echo boom >&2; exit 3'], { cwd: '/', timeoutMs: 10_000 })
    expect(fail).toMatchObject({ code: 3, stderr: 'boom\n' })
    // El comando remoto viaja como UN argumento tras `--`, sin stdin, y lo corre `/bin/sh` sea cual sea el shell del usuario.
    const argv = lastArgv()
    expect(argv.slice(-3)).toEqual(['alex@vps', '--', `exec /bin/sh -c 'cd -- '\\''/'\\'' && exec '\\''sh'\\'' '\\''-c'\\'' '\\''echo boom >&2; exit 3'\\'''`])
    expect(argv).toContain('-n')
  })

  it('exec: no reenvía opts.env', async () => {
    const r = await transport().exec('sh', ['-c', 'printf %s "${OMNI_SECRET-unset}"'], { cwd: '/', timeoutMs: 10_000, env: { OMNI_SECRET: 'x' } })
    expect(r.stdout).toBe('unset')
  })

  it('execLogin: corre en "$SHELL" -lc', async () => {
    const r = await transport().execLogin('sh', ['-c', 'printf "%s" "$0"; printf "|%s" "$1"', 'zero', "o'ne"], { cwd: '/', timeoutMs: 10_000 })
    expect(r).toMatchObject({ code: 0, stdout: "zero|o'ne" })
    expect(lastArgv().at(-1)).toBe(remoteLine(loginWrap(shCommand(['sh', '-c', 'printf "%s" "$0"; printf "|%s" "$1"', 'zero', "o'ne"], '/'))))
  })

  it('timeout: código null', async () => {
    const r = await transport().exec('sleep', ['5'], { cwd: '/', timeoutMs: 300 })
    expect(r.code).toBeNull()
  })

  it('run: stdin binario y stdout Buffer', async () => {
    const data = Buffer.from([0, 1, 2, 255, 10, 13, 0, 39, 36])
    const r = await transport().run('cat', { input: data })
    expect(r.code).toBe(0)
    expect(Buffer.compare(r.stdout, data)).toBe(0)
  })

  it.each([
    ['auth', 'auth'],
    ['unreachable', 'refused'],
    ['resolve', 'resolve'],
    ['timeout', 'timeout'],
    ['hostkey', 'hostkey'],
    ['hostkey-changed', 'hostkey']
  ])('FAKE_SSH_FAIL=%s → SshError %s en exec, run y connect', async (fail, kind) => {
    process.env.FAKE_SSH_FAIL = fail
    const t = transport()
    await expect(t.exec('true', [], { cwd: '/', timeoutMs: 10_000 })).rejects.toMatchObject({ kind })
    await expect(t.run('true')).rejects.toMatchObject({ kind })
    await expect(t.connect()).rejects.toMatchObject({ kind })
  })

  it('ssh que no existe: rechaza', async () => {
    const t = new SshTransport({ id: 'h', name: 'x', target: 'x' }, { sshBin: join(root, 'no-ssh'), controlDir: join(root, 'ctl') })
    await expect(t.run('true')).rejects.toThrow(/ENOENT/)
  })
})
