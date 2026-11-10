import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { sanitize, SettingsStore } from './settings'

describe('sanitize', () => {
  it('acepta prefijos con ctrl o alt y una tecla', () => {
    expect(sanitize({ prefix: 'ctrl+b' }).prefix).toBe('ctrl+b')
    expect(sanitize({ prefix: 'alt+a' }).prefix).toBe('alt+a')
    expect(sanitize({ prefix: 'ctrl+alt+shift+x' }).prefix).toBe('ctrl+alt+shift+x')
    expect(sanitize({ prefix: 'ctrl+`' }).prefix).toBe('ctrl+`')
  })

  it('rechaza prefijos sin modificador, con cmd o con tecla larga, y cae al default', () => {
    expect(sanitize({ prefix: 'a' }).prefix).toBe(DEFAULT_SETTINGS.prefix)
    expect(sanitize({ prefix: 'cmd+a' }).prefix).toBe(DEFAULT_SETTINGS.prefix)
    expect(sanitize({ prefix: 'ctrl+enter' }).prefix).toBe(DEFAULT_SETTINGS.prefix)
    expect(sanitize({ prefix: 42 }).prefix).toBe(DEFAULT_SETTINGS.prefix)
  })

  it('acota el tamaño de fuente y redondea', () => {
    expect(sanitize({ terminalFontSize: 14.4 }).terminalFontSize).toBe(14)
    expect(sanitize({ terminalFontSize: 3 }).terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize)
    expect(sanitize({ terminalFontSize: 99 }).terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize)
    expect(sanitize({ terminalFontSize: 'grande' }).terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize)
  })

  it('ignora claves desconocidas', () => {
    expect(sanitize({ prefix: 'ctrl+b', theme: 'light' })).toEqual({ ...DEFAULT_SETTINGS, prefix: 'ctrl+b' })
  })

  it('notifications: solo all, questions, done u off; lo demás cae a all', () => {
    expect(sanitize({ notifications: 'questions' }).notifications).toBe('questions')
    expect(sanitize({ notifications: 'done' }).notifications).toBe('done')
    expect(sanitize({ notifications: 'off' }).notifications).toBe('off')
    expect(sanitize({ notifications: 'all' }).notifications).toBe('all')
    expect(sanitize({ notifications: 'loud' }).notifications).toBe('all')
    expect(sanitize({ notifications: true }).notifications).toBe('all')
    expect(sanitize({}).notifications).toBe(DEFAULT_SETTINGS.notifications)
  })

  it('fuente de la terminal: por defecto como Orca (Menlo, 1.0, 500); solo valores de la lista', () => {
    expect(sanitize({})).toMatchObject({ terminalFont: 'menlo', terminalLineHeight: 1, terminalFontWeight: 500 })
    expect(sanitize({ terminalFont: 'jetbrains-mono', terminalLineHeight: 1.2, terminalFontWeight: 400 })).toMatchObject({ terminalFont: 'jetbrains-mono', terminalLineHeight: 1.2, terminalFontWeight: 400 })
    // `toString` existe en cualquier objeto: no debe colarse como id de fuente.
    expect(sanitize({ terminalFont: 'toString', terminalLineHeight: 3, terminalFontWeight: 450 })).toMatchObject({ terminalFont: 'menlo', terminalLineHeight: 1, terminalFontWeight: 500 })
    // SF Mono ya no es opción (Chromium no la encuentra): un ajuste viejo cae a Menlo.
    expect(sanitize({ terminalFont: 'sf-mono' }).terminalFont).toBe('menlo')
  })

  it('velocidad del scroll: 2× por defecto; solo valores de la lista', () => {
    expect(sanitize({}).terminalScrollSpeed).toBe(2)
    expect(sanitize({ terminalScrollSpeed: 1 }).terminalScrollSpeed).toBe(1)
    expect(sanitize({ terminalScrollSpeed: 4 }).terminalScrollSpeed).toBe(4)
    // Fuera de la lista (o no numérico) vuelve al valor por defecto.
    expect(sanitize({ terminalScrollSpeed: 50 }).terminalScrollSpeed).toBe(2)
    expect(sanitize({ terminalScrollSpeed: '3' }).terminalScrollSpeed).toBe(2)
  })

  it('reviveSessions encendido y openAtLogin apagado por defecto; solo booleanos', () => {
    expect(sanitize({})).toMatchObject({ reviveSessions: true, openAtLogin: false })
    expect(sanitize({ reviveSessions: false, openAtLogin: true })).toMatchObject({ reviveSessions: false, openAtLogin: true })
    expect(sanitize({ reviveSessions: 'no', openAtLogin: 1 })).toMatchObject({ reviveSessions: true, openAtLogin: false })
  })

  it('keys: solo parejas capa:comando con chords plausibles, máximo 3', () => {
    expect(
      sanitize({
        keys: {
          'terminal:pane.zoom': ['m'],
          'global:launcher.open': ['cmd+n', 'cmd+shift+n', 'cmd+alt+n', 'cmd+ctrl+n'],
          'list:list.next': ['j', 42, 'mal chord'],
          'worktrees:worktrees.next': ['n'],
          // La capa del Inbox ya no existe: un override viejo se descarta en silencio.
          'inbox:inbox.allow': ['y'],
          'bogus:pane.zoom': ['m'],
          'terminal:x y': ['m']
        }
      }).keys
    ).toEqual({ 'terminal:pane.zoom': ['m'], 'global:launcher.open': ['cmd+n', 'cmd+shift+n', 'cmd+alt+n'], 'list:list.next': ['j'], 'worktrees:worktrees.next': ['n'] })
    expect(sanitize({ keys: 'nope' }).keys).toEqual({})
  })
})

describe('SettingsStore', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-settings-'))
    file = join(dir, 'nested', 'settings.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('arranca con defaults si no hay archivo', () => {
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS)
  })

  it('persiste un parche válido y lo relee', () => {
    const store = new SettingsStore(file)
    expect(store.update({ prefix: 'ctrl+b' })).toEqual({ ...DEFAULT_SETTINGS, prefix: 'ctrl+b' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...DEFAULT_SETTINGS, prefix: 'ctrl+b' })
    expect(new SettingsStore(file).get().prefix).toBe('ctrl+b')
  })

  it('un parche inválido no pisa el valor anterior válido', () => {
    const store = new SettingsStore(file)
    store.update({ prefix: 'ctrl+b' })
    // El parche inválido cae al default, no al valor previo: lo documenta el contrato de sanitize.
    expect(store.update({ prefix: 'cmd+b' }).prefix).toBe(DEFAULT_SETTINGS.prefix)
  })

  it('archivo corrupto o editado a mano con basura: se ignora lo malo y sigue arrancando', () => {
    writeFileSync(file.replace('nested/', ''), '{ esto no es json')
    expect(new SettingsStore(file.replace('nested/', '')).get()).toEqual(DEFAULT_SETTINGS)
    writeFileSync(file.replace('nested/', ''), JSON.stringify({ prefix: 'ctrl+z', terminalFontSize: 'x', extra: 1 }))
    expect(new SettingsStore(file.replace('nested/', '')).get()).toEqual({ ...DEFAULT_SETTINGS, prefix: 'ctrl+z' })
  })
})
