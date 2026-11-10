import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE, partitionOf, ProfileStore, sanitizeProfileName, sanitizeProfiles } from './profiles'

describe('partitionOf', () => {
  it('arma la partición persistente con el id', () => {
    expect(partitionOf('abc')).toBe('persist:omni-abc')
    expect(partitionOf(DEFAULT_PROFILE)).toBe('persist:omni-default')
  })
})

describe('sanitizeProfileName', () => {
  it('recorta espacios y saltos y limita el largo', () => {
    expect(sanitizeProfileName('  Trabajo \n  ')).toBe('Trabajo')
    expect(sanitizeProfileName('a   b\tc')).toBe('a b c')
    expect(sanitizeProfileName('x'.repeat(100))).toHaveLength(40)
    expect(sanitizeProfileName(42)).toBe('')
    expect(sanitizeProfileName('   ')).toBe('')
  })
})

describe('sanitizeProfiles', () => {
  it('siempre pone el builtin primero con su nombre fijo', () => {
    expect(sanitizeProfiles(null)).toEqual([DEFAULT_PROFILE])
    expect(sanitizeProfiles({ profiles: [{ id: 'default', name: 'Pisado' }] })).toEqual([DEFAULT_PROFILE])
  })

  it('descarta entradas sin forma, ids repetidos o inválidos y nombres vacíos', () => {
    const list = sanitizeProfiles({
      profiles: [
        { id: 'a', name: ' Uno ' },
        { id: 'a', name: 'Repetido' },
        { id: 'b', name: '' },
        { id: 'c:d', name: 'Partición rara' },
        { name: 'sin id' },
        'basura',
        { id: 'e', name: 'Dos' }
      ]
    })
    expect(list).toEqual([DEFAULT_PROFILE, { id: 'a', name: 'Uno' }, { id: 'e', name: 'Dos' }])
  })

  it('acepta también un array suelto', () => {
    expect(sanitizeProfiles([{ id: 'z', name: 'Z' }])).toEqual([DEFAULT_PROFILE, { id: 'z', name: 'Z' }])
  })
})

describe('ProfileStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-profiles-'))
    file = join(dir, 'profiles.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('arranca solo con el builtin si no hay archivo', () => {
    expect(new ProfileStore(file).list()).toEqual([DEFAULT_PROFILE])
  })

  it('crea, persiste sin el builtin y recarga', () => {
    const store = new ProfileStore(file)
    const p = store.create('  Cliente X ')
    expect(p.name).toBe('Cliente X')
    expect(store.get(p.id)).toEqual(p)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { profiles: unknown[] }
    expect(saved.profiles).toEqual([{ id: p.id, name: 'Cliente X' }])
    expect(new ProfileStore(file).list()).toEqual([DEFAULT_PROFILE, p])
  })

  it('no crea con nombre vacío', () => {
    expect(() => new ProfileStore(file).create('   ')).toThrow()
  })

  it('borra cualquiera menos el builtin', () => {
    const store = new ProfileStore(file)
    const p = store.create('Temporal')
    store.remove(p.id)
    expect(store.list()).toEqual([DEFAULT_PROFILE])
    expect(() => store.remove(DEFAULT_PROFILE.id)).toThrow()
  })

  it('resolve cae al builtin con un id desconocido', () => {
    const store = new ProfileStore(file)
    expect(store.resolve('nope')).toEqual(DEFAULT_PROFILE)
    expect(store.resolve(undefined)).toEqual(DEFAULT_PROFILE)
  })

  it('ignora un archivo corrupto', () => {
    writeFileSync(file, '{ nope')
    expect(new ProfileStore(file).list()).toEqual([DEFAULT_PROFILE])
  })
})
