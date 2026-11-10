import { describe, expect, it } from 'vitest'
import { captureFileName, chordOfInput, isCaptureFile, consoleLevel, consoleSource, isAllowedUrl, keyDisposition, matchesPrefix, nextCapturePath, type KeyInput } from './browser'

/** `Input` mínimo de `before-input-event`. */
function input(partial: Partial<KeyInput> & { key: string }): KeyInput {
  return { code: `Key${partial.key.toUpperCase()}`, control: false, alt: false, shift: false, meta: false, ...partial }
}

describe('consoleLevel', () => {
  it('mapea los niveles string de Electron 44', () => {
    expect(consoleLevel('debug')).toBe('log')
    expect(consoleLevel('info')).toBe('info')
    expect(consoleLevel('warning')).toBe('warn')
    expect(consoleLevel('error')).toBe('error')
  })

  it('sigue aceptando los niveles numéricos deprecados (0-3)', () => {
    expect(consoleLevel(0)).toBe('log')
    expect(consoleLevel(1)).toBe('info')
    expect(consoleLevel(2)).toBe('warn')
    expect(consoleLevel(3)).toBe('error')
  })

  it('cualquier cosa rara cae a log', () => {
    expect(consoleLevel(42)).toBe('log')
    expect(consoleLevel('verbose')).toBe('log')
  })
})

describe('chordOfInput', () => {
  it('ordena modificadores ctrl, alt, shift, cmd y baja la tecla a minúscula', () => {
    expect(chordOfInput(input({ key: 'A', control: true, shift: true, meta: true, alt: true }))).toBe('ctrl+alt+shift+cmd+a')
    expect(chordOfInput(input({ key: 'x', control: true }))).toBe('ctrl+x')
    expect(chordOfInput(input({ key: 't', meta: true }))).toBe('cmd+t')
  })

  it('con ⌥ usa la tecla física (macOS entrega el carácter alterno)', () => {
    expect(chordOfInput(input({ key: '†', code: 'KeyT', alt: true }))).toBe('alt+t')
    expect(chordOfInput(input({ key: '¡', code: 'Digit1', alt: true }))).toBe('alt+1')
  })

  it('símbolos imprimibles sin shift; teclas especiales con alias', () => {
    expect(chordOfInput(input({ key: '|', code: 'Backslash', shift: true }))).toBe('|')
    expect(chordOfInput(input({ key: 'Escape', code: 'Escape' }))).toBe('escape')
    expect(chordOfInput(input({ key: ' ', code: 'Space' }))).toBe('space')
    expect(chordOfInput(input({ key: 'ArrowUp', code: 'ArrowUp', meta: true }))).toBe('cmd+up')
  })

  it('un modificador solo no es un chord', () => {
    expect(chordOfInput(input({ key: 'Meta', code: 'MetaLeft', meta: true }))).toBe('')
    expect(chordOfInput(input({ key: 'Control', code: 'ControlLeft', control: true }))).toBe('')
  })
})

describe('matchesPrefix', () => {
  it('reconoce el prefijo por defecto y variantes con alt/shift', () => {
    expect(matchesPrefix(input({ key: 'a', control: true }), 'ctrl+a')).toBe(true)
    expect(matchesPrefix(input({ key: 'x', control: true, shift: true }), 'ctrl+shift+x')).toBe(true)
    expect(matchesPrefix(input({ key: 'å', code: 'KeyA', alt: true }), 'alt+a')).toBe(true)
    expect(matchesPrefix(input({ key: '`', code: 'Backquote', control: true }), 'ctrl+`')).toBe(true)
  })

  it('no confunde teclas parecidas ni modificadores de más o de menos', () => {
    expect(matchesPrefix(input({ key: 'a' }), 'ctrl+a')).toBe(false)
    expect(matchesPrefix(input({ key: 'b', control: true }), 'ctrl+a')).toBe(false)
    expect(matchesPrefix(input({ key: 'a', control: true, shift: true }), 'ctrl+a')).toBe(false)
    expect(matchesPrefix(input({ key: 'a', meta: true }), 'ctrl+a')).toBe(false)
    expect(matchesPrefix(input({ key: 'Control', code: 'ControlLeft', control: true }), 'ctrl+a')).toBe(false)
  })

  it('tolera prefijo en mayúsculas, con espacios o con modificadores desordenados; vacío nunca coincide', () => {
    expect(matchesPrefix(input({ key: 'a', control: true }), ' CTRL+A ')).toBe(true)
    expect(matchesPrefix(input({ key: 'a', control: true, alt: true }), 'alt+ctrl+a')).toBe(true)
    expect(matchesPrefix(input({ key: 'x', control: true, shift: true }), 'shift+ctrl+x')).toBe(true)
    expect(matchesPrefix(input({ key: 'a', control: true }), '')).toBe(false)
  })
})

describe('keyDisposition', () => {
  const PREFIX = 'ctrl+a'

  it('el prefijo se reenvía y devuelve el foco; ⌘ normal se reenvía', () => {
    expect(keyDisposition(input({ key: 'a', control: true }), PREFIX)).toBe('prefix')
    expect(keyDisposition(input({ key: 't', meta: true }), PREFIX)).toBe('forward')
    expect(keyDisposition(input({ key: ',', code: 'Comma', meta: true }), PREFIX)).toBe('forward')
    expect(keyDisposition(input({ key: '1', code: 'Digit1', meta: true }), PREFIX)).toBe('forward')
  })

  it('teclas sin ⌘ que no son el prefijo se las queda la página', () => {
    expect(keyDisposition(input({ key: 'j' }), PREFIX)).toBe('page')
    expect(keyDisposition(input({ key: 'b', control: true }), PREFIX)).toBe('page')
    expect(keyDisposition(input({ key: 'Meta', code: 'MetaLeft', meta: true }), PREFIX)).toBe('page')
  })

  it('los atajos del menú (salir, ocultar, minimizar, pantalla completa) pasan al menú', () => {
    expect(keyDisposition(input({ key: 'q', meta: true }), PREFIX)).toBe('page')
    expect(keyDisposition(input({ key: 'h', meta: true }), PREFIX)).toBe('page')
    expect(keyDisposition(input({ key: '˙', code: 'KeyH', alt: true, meta: true }), PREFIX)).toBe('page')
    expect(keyDisposition(input({ key: 'm', meta: true }), PREFIX)).toBe('page')
    expect(keyDisposition(input({ key: 'f', control: true, meta: true }), PREFIX)).toBe('page')
  })

  it('los atajos de edición con ⌘ se los queda la página; ⌥⌘← / → (historial) sí se reenvían', () => {
    for (const key of ['c', 'v', 'x', 'a', 'z']) expect(keyDisposition(input({ key, meta: true }), PREFIX)).toBe('page')
    expect(keyDisposition(input({ key: 'z', meta: true, shift: true }), PREFIX)).toBe('page')
    expect(keyDisposition(input({ key: 'v', meta: true, shift: true }), PREFIX)).toBe('page')
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(keyDisposition(input({ key, code: key, meta: true }), PREFIX)).toBe('page')
      expect(keyDisposition(input({ key, code: key, meta: true, shift: true }), PREFIX)).toBe('page')
    }
    expect(keyDisposition(input({ key: 'Backspace', code: 'Backspace', meta: true }), PREFIX)).toBe('page')
    expect(keyDisposition(input({ key: 'Delete', code: 'Delete', meta: true }), PREFIX)).toBe('page')
    expect(keyDisposition(input({ key: 'ArrowLeft', code: 'ArrowLeft', meta: true, alt: true }), PREFIX)).toBe('forward')
    expect(keyDisposition(input({ key: 'ArrowRight', code: 'ArrowRight', meta: true, alt: true }), PREFIX)).toBe('forward')
  })

  it('los atajos del navegador (⌘R, ⌘⇧M, ⌘⇧S, ⌘⇧A, ⌘⌥J) se reenvían, no son del menú', () => {
    expect(keyDisposition(input({ key: 'r', meta: true }), PREFIX)).toBe('forward')
    expect(keyDisposition(input({ key: 'm', meta: true, shift: true }), PREFIX)).toBe('forward')
    expect(keyDisposition(input({ key: 's', meta: true, shift: true }), PREFIX)).toBe('forward')
    expect(keyDisposition(input({ key: 'a', meta: true, shift: true }), PREFIX)).toBe('forward')
    expect(keyDisposition(input({ key: '∆', code: 'KeyJ', meta: true, alt: true }), PREFIX)).toBe('forward')
  })

  it('con grab (modo elemento, área con teclado) se reenvía todo: letras, Enter, Escape, Backspace, edición con ⌘', () => {
    expect(keyDisposition(input({ key: 'j' }), PREFIX, true)).toBe('forward')
    expect(keyDisposition(input({ key: 'H', shift: true }), PREFIX, true)).toBe('forward')
    expect(keyDisposition(input({ key: 'Enter', code: 'Enter' }), PREFIX, true)).toBe('forward')
    expect(keyDisposition(input({ key: 'Escape', code: 'Escape' }), PREFIX, true)).toBe('forward')
    expect(keyDisposition(input({ key: 'Backspace', code: 'Backspace' }), PREFIX, true)).toBe('forward')
    expect(keyDisposition(input({ key: 'c', meta: true }), PREFIX, true)).toBe('forward')
    expect(keyDisposition(input({ key: 'b', control: true }), PREFIX, true)).toBe('forward')
  })

  it('con grab el prefijo sigue devolviendo el foco, y modificadores sueltos y el menú siguen siendo de la página', () => {
    expect(keyDisposition(input({ key: 'a', control: true }), PREFIX, true)).toBe('prefix')
    expect(keyDisposition(input({ key: 'Shift', code: 'ShiftLeft', shift: true }), PREFIX, true)).toBe('page')
    expect(keyDisposition(input({ key: 'q', meta: true }), PREFIX, true)).toBe('page')
    expect(keyDisposition(input({ key: 'h', meta: true }), PREFIX, true)).toBe('page')
  })

  it('sin grab (por defecto) nada cambia para las teclas sueltas', () => {
    expect(keyDisposition(input({ key: 'j' }), PREFIX, false)).toBe('page')
    expect(keyDisposition(input({ key: 'Escape', code: 'Escape' }), PREFIX)).toBe('page')
  })
})

describe('isAllowedUrl', () => {
  it('acepta http, https, about, data, blob y chrome', () => {
    for (const url of ['http://localhost:3000', 'https://example.com', 'about:blank', 'data:text/html,hi', 'blob:https://x/y', 'chrome://gpu']) {
      expect(isAllowedUrl(url)).toBe(true)
    }
  })

  it('rechaza file, javascript, ftp y basura', () => {
    for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'ftp://host', 'no es url', '']) expect(isAllowedUrl(url)).toBe(false)
  })
})

describe('consoleSource', () => {
  it('archivo:línea solo con origen http/https/file', () => {
    expect(consoleSource('https://example.com/static/app.js', 12)).toBe('app.js:12')
    expect(consoleSource('http://localhost:5173/src/main.ts', 3)).toBe('main.ts:3')
    expect(consoleSource('file:///tmp/x.js', 1)).toBe('x.js:1')
  })

  it('sin origen real no hay source', () => {
    expect(consoleSource('script>', 1)).toBeUndefined()
    expect(consoleSource('', 1)).toBeUndefined()
    expect(consoleSource(undefined, 1)).toBeUndefined()
  })
})

describe('nextCapturePath', () => {
  it('sufijo incremental sin pisar la hora del nombre', () => {
    const taken = new Set(['/c/omni-20260105-090703.png', '/c/omni-20260105-090703-2.png'])
    expect(nextCapturePath('/c', 'omni-20260105-090703.png', (p) => taken.has(p))).toBe('/c/omni-20260105-090703-3.png')
    expect(nextCapturePath('/c', 'omni-20260105-090704.png', (p) => taken.has(p))).toBe('/c/omni-20260105-090704.png')
  })
})

describe('captureFileName', () => {
  it('usa fecha y hora local con ceros a la izquierda', () => {
    expect(captureFileName(new Date(2026, 0, 5, 9, 7, 3))).toBe('omni-20260105-090703.png')
  })
})

describe('isCaptureFile', () => {
  const dir = '/Users/x/.config/omni/captures'
  it('acepta un PNG de la carpeta de capturas', () => {
    expect(isCaptureFile(dir, `${dir}/omni-20261027-150000.png`)).toBe(true)
  })

  it('rechaza lo de fuera, las subidas con .. y lo que no es PNG', () => {
    expect(isCaptureFile(dir, '/Users/x/.ssh/id_rsa')).toBe(false)
    expect(isCaptureFile(dir, `${dir}/../state.json`)).toBe(false)
    expect(isCaptureFile(dir, `${dir}/../../omni.png`)).toBe(false)
    expect(isCaptureFile(dir, `${dir}/notas.txt`)).toBe(false)
    expect(isCaptureFile(dir, dir)).toBe(false)
  })
})
