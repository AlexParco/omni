import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expandInclude, listSshConfigHosts, parseSshConfig, parseSshG, readConfigAliases } from './ssh-config'

const FAKE_SSH = resolve(__dirname, '../../../e2e/fake-ssh/ssh')

describe('parseSshConfig', () => {
  it('en orden: alias sin comodines, Include y Clave=valor', () => {
    const text = [
      '# comentario',
      'Host vps cloud-dev',
      '  HostName 1.2.3.4',
      'Host *.internal bastion? !nope',
      'host=lower',
      'Host "con espacio" vps',
      'Include config.d/* ~/.ssh/extra',
      'Match host foo',
      '  Include  other'
    ].join('\n')
    expect(parseSshConfig(text)).toEqual([
      { kind: 'host', alias: 'vps' },
      { kind: 'host', alias: 'cloud-dev' },
      { kind: 'host', alias: 'lower' },
      { kind: 'host', alias: 'con espacio' },
      { kind: 'host', alias: 'vps' },
      { kind: 'include', pattern: 'config.d/*' },
      { kind: 'include', pattern: '~/.ssh/extra' },
      { kind: 'include', pattern: 'other' }
    ])
  })
})

describe('parseSshG', () => {
  it('hostname, user y port', () => {
    expect(parseSshG('user alex\nhostname 10.0.0.5\nport 2222\nidentityfile ~/.ssh/id_ed25519\n')).toEqual({ hostname: '10.0.0.5', user: 'alex', port: 2222 })
    expect(parseSshG('hostname h\n')).toEqual({ hostname: 'h', user: null, port: 22 })
  })
})

describe('~/.ssh/config con Include', () => {
  let home: string
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'omni-sshcfg-'))
    mkdirSync(join(home, '.ssh', 'config.d'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'config'), 'Include config.d/*.conf\nHost main *\nInclude ~/.ssh/config\n')
    writeFileSync(join(home, '.ssh', 'config.d', 'b.conf'), 'Host bee\n')
    writeFileSync(join(home, '.ssh', 'config.d', 'a.conf'), 'Host ay\nInclude /nonexistent/*\n')
    writeFileSync(join(home, '.ssh', 'config.d', 'skip.txt'), 'Host skipped\n')
    writeFileSync(join(home, '.ssh', 'config.d', '.hidden.conf'), 'Host hidden\n')
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'Host not-a-config\n')
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('expandInclude: relativo a ~/.ssh, ordenado, sin ocultos', async () => {
    expect(await expandInclude('config.d/*.conf', home)).toEqual([join(home, '.ssh/config.d/a.conf'), join(home, '.ssh/config.d/b.conf')])
    expect(await expandInclude('~/.ssh/config', home)).toEqual([join(home, '.ssh/config')])
  })

  it('sigue Include (sin ciclos) y salta comodines', async () => {
    expect(await readConfigAliases(home)).toEqual(['ay', 'bee', 'main'])
  })

  it('resuelve cada alias con ssh -G', async () => {
    const hosts = await listSshConfigHosts({ home, sshBin: FAKE_SSH })
    expect(hosts.map((h) => h.alias)).toEqual(['ay', 'bee', 'main'])
    expect(hosts[0]?.resolved).toMatch(/^.+@ay:22$/)
  })

  it('sin config: lista vacía', async () => {
    expect(await listSshConfigHosts({ home: join(home, 'nada'), sshBin: FAKE_SSH })).toEqual([])
  })
})
