import { describe, expect, it } from 'vitest'
import { forgetPasteMode, notePasteMode, pasteModeOf } from './paste-mode'

describe('paste-mode', () => {
  it('sigue el último cambio de modo del chunk', () => {
    expect(pasteModeOf('s')).toBe(false)
    notePasteMode('s', 'hola \x1b[?2004h')
    expect(pasteModeOf('s')).toBe(true)
    notePasteMode('s', 'sin cambios')
    expect(pasteModeOf('s')).toBe(true)
    notePasteMode('s', '\x1b[?2004h…\x1b[?2004l')
    expect(pasteModeOf('s')).toBe(false)
    notePasteMode('s', '\x1b[?2004l…\x1b[?2004h')
    expect(pasteModeOf('s')).toBe(true)
    forgetPasteMode('s')
    expect(pasteModeOf('s')).toBe(false)
  })
})
