import { describe, it, expect } from 'vitest'
import { chordFromForwarded, chordOf, isModifierOnly, normalizeChord, prefixLabel, prettyChord } from './chord'

/** Evento tipo KeyboardEvent con los campos que lee `chordOf`. */
interface TeclaFalsa {
  key: string
  code?: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

function evento(tecla: TeclaFalsa): KeyboardEvent {
  return {
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...tecla
  } as unknown as KeyboardEvent
}

describe('chordOf', () => {
  it('arma cmd+t', () => {
    expect(chordOf(evento({ key: 't', metaKey: true }))).toBe('cmd+t')
  })

  it('usa el orden canónico ctrl, alt, shift, cmd', () => {
    expect(chordOf(evento({ key: 'D', metaKey: true, shiftKey: true }))).toBe('shift+cmd+d')
    expect(chordOf(evento({ key: 'a', ctrlKey: true, metaKey: true, altKey: true }))).toBe(
      'ctrl+alt+cmd+a'
    )
  })

  it('usa la tecla física cuando ⌥ cambia el carácter (⌥T llega como †)', () => {
    expect(chordOf(evento({ key: '†', code: 'KeyT', altKey: true }))).toBe('alt+t')
  })

  it('no agrega shift a un símbolo imprimible', () => {
    expect(chordOf(evento({ key: '%', shiftKey: true }))).toBe('%')
  })

  it('conserva shift en teclas no imprimibles', () => {
    expect(chordOf(evento({ key: 'Enter', shiftKey: true }))).toBe('shift+enter')
  })

  it('una tecla modificadora sola da solo el modificador', () => {
    expect(chordOf(evento({ key: 'Shift', shiftKey: true }))).toBe('shift')
    expect(chordOf(evento({ key: 'Meta', metaKey: true }))).toBe('cmd')
    expect(chordOf(evento({ key: 'Control', ctrlKey: true }))).toBe('ctrl')
  })

  it('traduce ArrowDown, espacio y Escape a su alias', () => {
    expect(chordOf(evento({ key: 'ArrowDown' }))).toBe('down')
    expect(chordOf(evento({ key: ' ' }))).toBe('space')
    expect(chordOf(evento({ key: 'Escape' }))).toBe('escape')
  })
})

describe('chordOf: ⌥Space', () => {
  it('el espacio duro que entrega macOS con ⌥ es la misma tecla (dictado, §3.22)', () => {
    expect(chordOf(evento({ key: ' ', code: 'Space', altKey: true }))).toBe('alt+space')
    expect(chordOf(evento({ key: '\u00a0', code: 'Space', altKey: true }))).toBe('alt+space')
    expect(chordOf(evento({ key: '\u00a0', code: 'Space', altKey: true, shiftKey: true }))).toBe('alt+shift+space')
  })
})

describe('normalizeChord', () => {
  it('reordena modificadores a la forma canónica', () => {
    expect(normalizeChord('cmd+shift+d')).toBe('shift+cmd+d')
  })

  it('pasa a minúsculas', () => {
    expect(normalizeChord('CMD+K')).toBe('cmd+k')
  })

  it('deja intactas las teclas sin modificadores y las ya canónicas', () => {
    expect(normalizeChord('j')).toBe('j')
    expect(normalizeChord('ctrl+a')).toBe('ctrl+a')
  })
})

describe('isModifierOnly', () => {
  it('es verdadero para modificadores solos o vacío', () => {
    expect(isModifierOnly('shift')).toBe(true)
    expect(isModifierOnly('cmd')).toBe(true)
    expect(isModifierOnly('')).toBe(true)
  })

  it('es falso cuando hay una tecla no modificadora', () => {
    expect(isModifierOnly('cmd+k')).toBe(false)
    expect(isModifierOnly('j')).toBe(false)
  })
})

describe('prettyChord', () => {
  it('muestra modificadores como símbolos y la letra en mayúscula', () => {
    expect(prettyChord('shift+cmd+d')).toBe('⇧⌘D')
  })

  it('muestra ctrl+a como C-a', () => {
    expect(prettyChord('ctrl+a')).toBe('C-a')
  })

  it('antepone el prefijo C-a', () => {
    expect(prettyChord('ctrl+a', 'ctrl+a')).toBe('C-a C-a')
  })

  it('muestra enter, escape y símbolos imprimibles', () => {
    expect(prettyChord('enter')).toBe('⏎')
    expect(prettyChord('escape')).toBe('Esc')
    expect(prettyChord('%')).toBe('%')
  })

  it('con prefijo, una tecla suelta va en minúscula como en el doc del módulo', () => {
    // Tras el prefijo la mayúscula importa (`C-a h` ≠ `C-a H`), así que no se sube a mayúscula.
    expect(prettyChord('x', 'ctrl+a')).toBe('C-a x')
  })
})

describe('prefixLabel', () => {
  it('escribe ctrl/alt + tecla como tmux', () => {
    expect(prefixLabel('ctrl+a')).toBe('C-a')
    expect(prefixLabel('ctrl+b')).toBe('C-b')
    expect(prefixLabel('alt+a')).toBe('M-a')
  })
  it('con otro prefijo, prettyChord lo antepone', () => {
    expect(prettyChord('%', 'ctrl+b')).toBe('C-b %')
    expect(prettyChord('ctrl+b', 'ctrl+b')).toBe('C-b C-b')
  })
})

describe('chordFromForwarded', () => {
  it('produce la misma forma canónica que chordOf', () => {
    expect(chordFromForwarded({ key: 'l', code: 'KeyL', ctrl: false, alt: false, shift: false, meta: true })).toBe('cmd+l')
    expect(chordFromForwarded({ key: 'S', code: 'KeyS', ctrl: false, alt: false, shift: true, meta: true })).toBe('shift+cmd+s')
    expect(chordFromForwarded({ key: 'a', code: 'KeyA', ctrl: true, alt: false, shift: false, meta: false })).toBe('ctrl+a')
  })

  it('usa la tecla física cuando ⌥ cambia el carácter (⌥J llega como ∆)', () => {
    expect(chordFromForwarded({ key: '∆', code: 'KeyJ', ctrl: false, alt: true, shift: false, meta: true })).toBe('alt+cmd+j')
  })

  it('un símbolo imprimible va sin shift y un modificador suelto no es tecla', () => {
    expect(chordFromForwarded({ key: '|', code: 'Backslash', ctrl: false, alt: false, shift: true, meta: false })).toBe('|')
    expect(isModifierOnly(chordFromForwarded({ key: 'Meta', code: 'MetaLeft', ctrl: false, alt: false, shift: false, meta: true }))).toBe(true)
  })
})

describe('chords con + como tecla', () => {
  it('cmd++ y + conservan la tecla al normalizar y al mostrarse', async () => {
    const { normalizeChord, prettyChord, prettyKey, isModifierOnly } = await import('./chord')
    expect(normalizeChord('cmd++')).toBe('cmd++')
    expect(normalizeChord('+')).toBe('+')
    expect(prettyChord('cmd++')).toBe('⌘+')
    expect(prettyKey('+')).toBe('+')
    expect(isModifierOnly('cmd++')).toBe(false)
  })

  it('backspace se muestra con su glifo', async () => {
    const { prettyKey } = await import('./chord')
    expect(prettyKey('backspace')).toBe('⌫')
  })
})
