import { describe, expect, it } from 'vitest'
import { holdFocusLost, holdKeyDown, holdKeyUp, isHoldKey, type HoldKey, type HoldState } from './hold-key'

const key = (over: Partial<HoldKey> & Pick<HoldKey, 'chord'>): HoldKey => ({ key: '', code: '', shiftKey: false, repeat: false, defaultPrevented: false, inReviewText: false, ...over })
const space = (over: Partial<HoldKey> = {}): HoldKey => key({ chord: 'alt+space', key: ' ', code: 'Space', ...over })
const state = (over: Partial<HoldState> = {}): HoldState => ({ phase: 'recording', handsFree: false, choose: false, overlayOpen: true, ...over })

describe('holdKeyUp', () => {
  it('soltar Space o ⌥ envía; con ⇧ revisa', () => {
    expect(holdKeyUp({ code: 'Space', key: ' ', shiftKey: false }, state())).toEqual({ kind: 'run', id: 'voice.send' })
    expect(holdKeyUp({ code: 'AltLeft', key: 'Alt', shiftKey: false }, state())).toEqual({ kind: 'run', id: 'voice.send' })
    expect(holdKeyUp({ code: 'Space', key: ' ', shiftKey: true }, state())).toEqual({ kind: 'run', id: 'voice.review' })
    expect(holdKeyUp({ code: 'AltLeft', key: 'Alt', shiftKey: true }, state())).toEqual({ kind: 'run', id: 'voice.review' })
  })

  it('con choose (⌥⇧Space) el ⇧ del keyup no significa revisar: envía y se elige destino', () => {
    expect(holdKeyUp({ code: 'Space', key: ' ', shiftKey: true }, state({ choose: true }))).toEqual({ kind: 'run', id: 'voice.send' })
    expect(holdKeyUp({ code: 'AltLeft', key: 'Alt', shiftKey: true }, state({ choose: true }))).toEqual({ kind: 'run', id: 'voice.send' })
  })

  it('otras teclas, manos libres o fuera de la grabación no hacen nada', () => {
    expect(holdKeyUp({ code: 'ShiftLeft', key: 'Shift', shiftKey: false }, state())).toEqual({ kind: 'pass' })
    expect(holdKeyUp({ code: 'Space', key: ' ', shiftKey: false }, state({ handsFree: true }))).toEqual({ kind: 'pass' })
    expect(holdKeyUp({ code: 'Space', key: ' ', shiftKey: false }, state({ phase: 'transcribing' }))).toEqual({ kind: 'pass' })
    expect(holdKeyUp({ code: 'Space', key: ' ', shiftKey: false }, state({ phase: 'idle' }))).toEqual({ kind: 'pass' })
  })
})

describe('holdFocusLost (blur de la ventana / pestaña oculta)', () => {
  it('con la tecla mantenida suelta y envía; en manos libres o sin grabar no hace nada', () => {
    expect(holdFocusLost(state())).toEqual({ kind: 'run', id: 'voice.send' })
    expect(holdFocusLost(state({ handsFree: true }))).toEqual({ kind: 'pass' })
    expect(holdFocusLost(state({ phase: 'review' }))).toEqual({ kind: 'pass' })
    expect(holdFocusLost(state({ phase: 'idle' }))).toEqual({ kind: 'pass' })
  })
})

describe('holdKeyDown', () => {
  it('sin dictado o sin overlay deja pasar todo', () => {
    expect(holdKeyDown(space(), state({ phase: 'idle' }))).toEqual({ kind: 'pass' })
    expect(holdKeyDown(space(), state({ overlayOpen: false }))).toEqual({ kind: 'pass' })
  })

  it('⌥Space: la repetición y la pulsación ya corrida por el keymap se tragan; otra pulsación va a voice.dictate', () => {
    expect(holdKeyDown(space({ repeat: true }), state())).toEqual({ kind: 'swallow' })
    expect(holdKeyDown(space({ defaultPrevented: true }), state())).toEqual({ kind: 'swallow' })
    expect(holdKeyDown(space(), state())).toEqual({ kind: 'run', id: 'voice.dictate' })
    // En manos libres, ⌥⇧Space termina revisando.
    expect(holdKeyDown(space({ chord: 'alt+shift+space', shiftKey: true }), state({ handsFree: true }))).toEqual({ kind: 'run', id: 'voice.review' })
    expect(holdKeyDown(space({ chord: 'alt+shift+space', shiftKey: true }), state())).toEqual({ kind: 'run', id: 'voice.dictate' })
    // También en sent/unavailable (reinicia el dictado).
    expect(holdKeyDown(space({ repeat: true }), state({ phase: 'unavailable' }))).toEqual({ kind: 'swallow' })
    expect(holdKeyDown(space(), state({ phase: 'sent' }))).toEqual({ kind: 'run', id: 'voice.dictate' })
  })

  it('Tab y ⇧Tab rotan el destino, también desde el textarea de la revisión', () => {
    expect(holdKeyDown(key({ chord: 'tab', inReviewText: true }), state({ phase: 'review' }))).toEqual({ kind: 'run', id: 'voice.nextTarget' })
    expect(holdKeyDown(key({ chord: 'shift+tab' }), state())).toEqual({ kind: 'run', id: 'voice.prevTarget' })
  })

  it('en el textarea de la revisión el resto de teclas es texto (⌘⏎ y Esc los atiende el TextArea)', () => {
    expect(holdKeyDown(key({ chord: 'escape', inReviewText: true }), state({ phase: 'review' }))).toEqual({ kind: 'pass' })
    expect(holdKeyDown(key({ chord: 'cmd+enter', inReviewText: true }), state({ phase: 'review' }))).toEqual({ kind: 'pass' })
    expect(holdKeyDown(key({ chord: 'a', inReviewText: true }), state({ phase: 'review' }))).toEqual({ kind: 'pass' })
  })

  it('Esc descarta, ⌘⏎ envía; al elegir destino valen ⏎, J K y flechas', () => {
    expect(holdKeyDown(key({ chord: 'escape' }), state())).toEqual({ kind: 'run', id: 'voice.cancel' })
    expect(holdKeyDown(key({ chord: 'cmd+enter' }), state({ phase: 'review' }))).toEqual({ kind: 'run', id: 'voice.send' })
    expect(holdKeyDown(key({ chord: 'enter' }), state({ phase: 'choose' }))).toEqual({ kind: 'run', id: 'voice.send' })
    expect(holdKeyDown(key({ chord: 'j' }), state({ phase: 'choose' }))).toEqual({ kind: 'run', id: 'voice.nextTarget' })
    expect(holdKeyDown(key({ chord: 'up' }), state({ phase: 'choose' }))).toEqual({ kind: 'run', id: 'voice.prevTarget' })
    expect(holdKeyDown(key({ chord: 'enter' }), state())).toEqual({ kind: 'swallow' })
  })

  it('en unavailable C copia y D descarga; lo demás sigue a la terminal', () => {
    expect(holdKeyDown(key({ chord: 'c' }), state({ phase: 'unavailable' }))).toEqual({ kind: 'run', id: 'voice.copyInstall' })
    expect(holdKeyDown(key({ chord: 'd' }), state({ phase: 'unavailable' }))).toEqual({ kind: 'run', id: 'voice.downloadModel' })
    expect(holdKeyDown(key({ chord: 'x' }), state({ phase: 'unavailable' }))).toEqual({ kind: 'pass' })
    expect(holdKeyDown(key({ chord: 'x' }), state({ phase: 'sent' }))).toEqual({ kind: 'pass' })
  })

  it('grabando o transcribiendo las teclas sueltas se tragan; ⌘ sigue su camino', () => {
    expect(holdKeyDown(key({ chord: 'x' }), state())).toEqual({ kind: 'swallow' })
    expect(holdKeyDown(key({ chord: 'shift' }), state())).toEqual({ kind: 'swallow' })
    expect(holdKeyDown(key({ chord: 'x' }), state({ phase: 'transcribing' }))).toEqual({ kind: 'swallow' })
    expect(holdKeyDown(key({ chord: 'cmd+c' }), state())).toEqual({ kind: 'pass' })
    expect(holdKeyDown(key({ chord: 'x' }), state({ phase: 'review' }))).toEqual({ kind: 'pass' })
    expect(holdKeyDown(key({ chord: 'x' }), state({ phase: 'choose' }))).toEqual({ kind: 'pass' })
  })
})

describe('isHoldKey', () => {
  it('⌥ + Space por tecla física, espacio normal o duro', () => {
    expect(isHoldKey({ chord: 'alt+space', code: 'Space', key: ' ' })).toBe(true)
    expect(isHoldKey({ chord: 'alt+space', code: 'Space', key: ' ' })).toBe(true)
    expect(isHoldKey({ chord: 'alt+shift+space', code: 'Space', key: ' ' })).toBe(true)
    expect(isHoldKey({ chord: 'space', code: 'Space', key: ' ' })).toBe(false)
    expect(isHoldKey({ chord: 'alt+a', code: 'KeyA', key: 'å' })).toBe(false)
  })
})
