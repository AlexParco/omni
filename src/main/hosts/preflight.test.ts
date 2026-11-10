import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parsePreflight, preflight } from './preflight'
import { SshTransport } from './ssh'

const FAKE_SSH = resolve(__dirname, '../../../e2e/fake-ssh/ssh')

describe('parsePreflight', () => {
  it('ignora lo que imprime el perfil antes del marcador', () => {
    const out = 'Welcome to Ubuntu\ntool=claude\n__omni_preflight__\nsystem=Linux x86_64\nhome=/home/alex\ntool=git\ntool=claude\ntool=goose\n'
    expect(parsePreflight(out)).toEqual({
      system: 'Linux x86_64',
      home: '/home/alex',
      tools: { dtach: false, git: true, agents: ['claude', 'goose'] }
    })
  })

  it('guarda la ruta absoluta de dtach (con espacios); una ruta relativa o ausente solo dice que está', () => {
    const out = '__omni_preflight__\ntool=dtach /opt/mis herramientas/dtach\ntool=git git\ntool=claude /home/a/.nvm/bin/claude\n'
    expect(parsePreflight(out).tools).toEqual({ dtach: true, dtachPath: '/opt/mis herramientas/dtach', git: true, agents: ['claude'] })
    expect(parsePreflight('__omni_preflight__\ntool=dtach dtach\n').tools).toEqual({ dtach: true, git: false, agents: [] })
  })

  it('sin dtach ofrece instalarlo con el gestor de paquetes del host (el primero en orden de preferencia)', () => {
    expect(parsePreflight('__omni_preflight__\ntool=apt-get /usr/bin/apt-get\ntool=brew /home/linuxbrew/bin/brew\n').tools.dtachInstall).toBe('sudo apt-get install -y dtach')
    expect(parsePreflight('__omni_preflight__\ntool=apk /sbin/apk\n').tools.dtachInstall).toBe('sudo apk add dtach')
    expect(parsePreflight('__omni_preflight__\n').tools.dtachInstall).toBeUndefined()
    // Con dtach no hay nada que instalar.
    expect(parsePreflight('__omni_preflight__\ntool=dtach /usr/bin/dtach\ntool=apt-get /usr/bin/apt-get\n').tools.dtachInstall).toBeUndefined()
  })

  it('sin marcador: error', () => {
    expect(() => parsePreflight('bash: error\n')).toThrow(/preflight/)
  })
})

describe('preflight contra el ssh falso', () => {
  let root: string
  const env = { ...process.env }
  beforeAll(() => {
    root = mkdtempSync('/tmp/omni-preflight-')
    process.env.FAKE_SSH_HOME = root
    process.env.FAKE_SSH_REMOTE_SHELL = '/bin/sh'
    // PATH mínimo: solo lo del sistema (sh, uname, git de /usr/bin), así el resultado es estable.
    process.env.PATH = '/usr/bin:/bin'
  })
  afterAll(() => {
    process.env = env
    rmSync(root, { recursive: true, force: true })
  })

  it('una sola llamada con sistema, home y herramientas', async () => {
    const t = new SshTransport({ id: 'h', name: 'vps', target: 'vps' }, { sshBin: FAKE_SSH, controlDir: join(root, 'ctl') })
    const result = await preflight(t)
    expect(result.system).toMatch(/^Darwin (arm64|x86_64)$/)
    expect(result.home).toBe(root)
    expect(result.tools.git).toBe(true)
    expect(result.tools.agents).toEqual([])
  })
})
