import { describe, it, expect, beforeEach } from 'vitest'
import { Keymap } from './keymap'

describe('Keymap', () => {
  let mapa: Keymap

  beforeEach(() => {
    mapa = new Keymap()
  })

  describe('bind y resolve', () => {
    it('normaliza el chord al enlazar y lo encuentra en forma canónica', () => {
      mapa.bind('global', 'cmd+shift+d', 'session.debug')
      expect(mapa.resolve(['global'], 'shift+cmd+d')).toBe('session.debug')
    })

    it('devuelve undefined si ninguna capa tiene el chord', () => {
      mapa.bind('global', 'cmd+k', 'palette.open')
      expect(mapa.resolve(['global', 'list'], 'cmd+j')).toBeUndefined()
    })

    it('la primera capa que resuelve gana', () => {
      mapa.bind('list', 'j', 'list.next')
      mapa.bind('global', 'j', 'global.j')
      expect(mapa.resolve(['list', 'global'], 'j')).toBe('list.next')
      expect(mapa.resolve(['global', 'list'], 'j')).toBe('global.j')
    })

    it('ignora capas que no están en la lista de búsqueda', () => {
      mapa.bind('terminal', 'x', 'terminal.close')
      expect(mapa.resolve(['global', 'list'], 'x')).toBeUndefined()
    })

    it('volver a enlazar un chord reemplaza el comando', () => {
      mapa.bind('global', 'cmd+k', 'palette.open')
      mapa.bind('global', 'cmd+k', 'other.open')
      expect(mapa.resolve(['global'], 'cmd+k')).toBe('other.open')
    })
  })

  describe('bindings', () => {
    it('lista los atajos de una capa en orden de registro', () => {
      mapa.bind('global', 'cmd+t', 'tab.new')
      mapa.bind('global', 'cmd+w', 'tab.close')
      mapa.bind('list', 'j', 'list.next')
      expect(mapa.bindings('global')).toEqual([
        { chord: 'cmd+t', commandId: 'tab.new' },
        { chord: 'cmd+w', commandId: 'tab.close' }
      ])
    })

    it('una capa vacía devuelve lista vacía', () => {
      expect(mapa.bindings('terminal')).toEqual([])
    })
  })

  describe('chordsFor', () => {
    it('devuelve capa y chord normalizados de cada atajo del comando', () => {
      mapa.bind('global', 'cmd+shift+d', 'session.debug')
      mapa.bind('terminal', 'd', 'session.debug')
      mapa.bind('global', 'cmd+k', 'palette.open')
      expect(mapa.chordsFor('session.debug')).toEqual([
        { layer: 'global', chord: 'shift+cmd+d' },
        { layer: 'terminal', chord: 'd' }
      ])
    })

    it('devuelve lista vacía para un comando sin atajos', () => {
      expect(mapa.chordsFor('nada')).toEqual([])
    })
  })
})

describe('unbind', () => {
  it('quita el chord de la capa y deja las demás', () => {
    const km = new Keymap()
    km.bind('terminal', 'ctrl+a', 'x')
    km.bind('global', 'ctrl+a', 'y')
    km.unbind('terminal', 'ctrl+a')
    expect(km.resolve(['terminal'], 'ctrl+a')).toBeUndefined()
    expect(km.resolve(['global'], 'ctrl+a')).toBe('y')
  })
})
