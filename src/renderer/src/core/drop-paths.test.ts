import { describe, expect, it } from 'vitest'
import { dropText, isEphemeralDrop, shellEscapePath } from './drop-paths'

describe('shellEscapePath', () => {
  it('escapa espacios y metacaracteres como Terminal.app', () => {
    expect(shellEscapePath('/tmp/Screenshot 2026-10-16 at 10.06.10 AM.png')).toBe('/tmp/Screenshot\\ 2026-10-16\\ at\\ 10.06.10\\ AM.png')
    expect(shellEscapePath("/tmp/a'b(1)&$x.png")).toBe("/tmp/a\\'b\\(1\\)\\&\\$x.png")
  })

  it('deja intacto el espacio angosto (U+202F) de las capturas de macOS', () => {
    expect(shellEscapePath('/tmp/10.06 AM.png')).toBe('/tmp/10.06 AM.png')
  })
})

describe('dropText', () => {
  it('une varias rutas y deja un espacio final; sin rutas no pega nada', () => {
    expect(dropText(['/a b.png', '/c.txt'])).toBe('/a\\ b.png /c.txt ')
    expect(dropText(['', ''])).toBe('')
  })
})

describe('isEphemeralDrop', () => {
  it('la miniatura de una captura de macOS vive en una carpeta temporal protegida: se copia', () => {
    expect(isEphemeralDrop('/var/folders/rp/x/T/TemporaryItems/NSIRD_screencaptureui_ng9pQq/Screenshot 2026-10-22 at 3.05.53\u202fPM.png')).toBe(true)
    expect(isEphemeralDrop('/private/var/folders/rp/x/T/TemporaryItems/foo.png')).toBe(true)
  })
  it('un archivo normal (Escritorio, proyecto, temporal propio) se pega tal cual', () => {
    expect(isEphemeralDrop('/Users/ana/Desktop/Screenshot.png')).toBe(false)
    expect(isEphemeralDrop('/var/folders/rp/x/T/omni-drops/1-a.png')).toBe(false)
  })
})
