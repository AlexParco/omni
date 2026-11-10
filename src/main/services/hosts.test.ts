import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostStore, sanitizeHosts, validateTarget } from './hosts'

describe('validateTarget', () => {
  it('acepta alias, usuario@host, dominios e IPv6 entre corchetes; recorta espacios de los bordes', () => {
    for (const ok of ['vps', 'alex@vps', 'deploy@api.example.com', 'root@10.0.0.2', 'alex@[::1]', '[2001:db8::1]', 'my_host-2']) expect(validateTarget(ok)).toBe(ok)
    expect(validateTarget('  alex@vps \n')).toBe('alex@vps')
  })

  it('rechaza vacío, espacios internos, un guion al inicio (ssh lo leería como opción) y caracteres de shell', () => {
    for (const bad of ['', '   ', 'alex @vps', 'a b', '-oProxyCommand=evil', '-v', ' -x', 'a;b', 'a$b', 'a/b', "a'b", 'x'.repeat(256)]) {
      expect(() => validateTarget(bad), bad).toThrow(/destino SSH inválido/)
    }
  })
})

describe('sanitizeHosts', () => {
  it('deja solo hosts con forma; ids y destinos únicos; el nombre cae al destino', () => {
    const raw = {
      hosts: [
        { id: 'h1', name: ' VPS ', target: 'alex@vps' },
        { id: 'h2', target: 'deploy@api' },
        { id: 'h1', name: 'repetido', target: 'otro' },
        { id: 'h3', name: 'mismo destino', target: 'alex@vps' },
        { id: 'h4', target: '-oProxyCommand=x' },
        { id: '', target: 'x' },
        { id: 'h5', target: 'con espacio' },
        { id: 'h6', name: '   ', target: 'h6' },
        'basura',
        null
      ]
    }
    expect(sanitizeHosts(raw)).toEqual([
      { id: 'h1', name: 'VPS', target: 'alex@vps' },
      { id: 'h2', name: 'deploy@api', target: 'deploy@api' },
      { id: 'h6', name: 'h6', target: 'h6' }
    ])
  })

  it('lo que no tiene forma es vacío', () => {
    for (const raw of [null, 'x', 3, {}, { hosts: 'x' }, []]) expect(sanitizeHosts(raw)).toEqual([])
  })
})

describe('HostStore', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-hosts-store-'))
    file = join(dir, 'conf', 'hosts.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('add persiste (atómico), el mismo destino devuelve el existente y remove olvida', () => {
    const store = new HostStore(file)
    expect(store.list()).toEqual([])
    const vps = store.add(' Mi VPS ', ' alex@vps ')
    expect(vps).toEqual({ id: vps.id, name: 'Mi VPS', target: 'alex@vps' })
    expect(store.add('otro nombre', 'alex@vps')).toBe(vps)
    const api = store.add('', 'deploy@api')
    expect(api.name).toBe('deploy@api')
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ hosts: [vps, api] })

    const reloaded = new HostStore(file)
    expect(reloaded.list()).toEqual([vps, api])
    expect(reloaded.get(api.id)).toEqual(api)
    reloaded.remove(vps.id)
    reloaded.remove('nope')
    expect(new HostStore(file).list()).toEqual([api])
    expect(() => store.add('x', '-oProxyCommand=evil')).toThrow(/destino SSH inválido/)
  })

  it('un archivo corrupto se ignora sin tirar', () => {
    const corrupt = join(dir, 'hosts.json')
    writeFileSync(corrupt, '{no es json')
    expect(new HostStore(corrupt).list()).toEqual([])
  })
})
