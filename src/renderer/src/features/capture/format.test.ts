import { describe, expect, it, vi } from 'vitest'
import type { CaptureAttachments, CapturePayload } from '@shared/types'
import { describeCapture, formatCapturePayload, sanitizeForPty } from './format'

// `sanitizeForPty` vive en store/session-write, que carga el puente IPC: sin DOM en los tests se mockea.
vi.mock('@/lib/omni', () => ({ omni: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(() => () => {}) } }))

const base: CapturePayload = {
  browserId: 'web',
  capture: { path: '/tmp/cap.png', width: 1180, height: 640 },
  thumb: 'data:,',
  url: 'http://localhost:4321/status',
  viewport: { width: 1180, height: 640 },
  consoleTail: ['warn: dos', 'error: tres']
}
const withElement: CapturePayload = {
  ...base,
  capture: { path: '/tmp/el.png', width: 2168, height: 424 },
  element: { selector: 'table.endpoints', tag: 'table', text: 'GET /agencies', rect: { x: 10, y: 20, width: 1084, height: 212 }, html: '<table class="endpoints"></table>\n', css: 'display: table;\n' }
}
const all: CaptureAttachments = { image: true, html: true, css: true, context: true, console: true }
const none: CaptureAttachments = { image: false, html: false, css: false, context: false, console: false }

describe('formatCapturePayload', () => {
  it('mensaje, línea en blanco y los adjuntos en orden', () => {
    expect(formatCapturePayload(withElement, all, 'Arregla el badge ')).toBe(
      [
        'Arregla el badge',
        '',
        'Imagen: /tmp/el.png',
        'URL: http://localhost:4321/status · viewport 1180×640',
        'Elemento: table.endpoints (1084×212)',
        '```html',
        '<table class="endpoints"></table>',
        '```',
        '```css',
        'display: table;',
        '```',
        'Consola (últimas 2):',
        'warn: dos',
        'error: tres'
      ].join('\n')
    )
  })

  it('sin mensaje no deja la línea en blanco; sin elemento no hay bloques html/css', () => {
    expect(formatCapturePayload(base, all, '')).toBe(['Imagen: /tmp/cap.png', 'URL: http://localhost:4321/status · viewport 1180×640', 'Consola (últimas 2):', 'warn: dos', 'error: tres'].join('\n'))
  })

  it('solo lo marcado; el mensaje solo si no hay adjuntos', () => {
    expect(formatCapturePayload(base, { ...none, image: true }, 'hola')).toBe('hola\n\nImagen: /tmp/cap.png')
    expect(formatCapturePayload(base, none, 'hola')).toBe('hola')
    expect(formatCapturePayload({ ...base, consoleTail: [] }, { ...none, console: true }, '')).toBe('')
  })
})

describe('sanitizeForPty', () => {
  it('quita escapes y retornos de carro pero conserva saltos de línea y tabs', () => {
    expect(sanitizeForPty('a\x1b[201~echo PWNED\rb\n\tc\x00\x7f')).toBe('a[201~echo PWNEDb\n\tc')
  })

  it('una página hostil no puede cerrar el bracketed paste ni ejecutar nada', () => {
    const hostile: CapturePayload = {
      ...withElement,
      url: 'http://x/\x1b[201~',
      consoleTail: ['log: \x1b[201~rm -rf ~\r'],
      element: { ...withElement.element!, html: '<div data-x="\x1b[201~echo PWNED\r"></div>', css: 'content: "\x1b";' }
    }
    const text = formatCapturePayload(hostile, all, 'hola\x1b[201~\r')
    expect(text).not.toContain('\x1b')
    expect(text).not.toContain('\r')
    expect(text).toContain('echo PWNED')
  })
})

describe('describeCapture', () => {
  it('selector y tamaño del elemento, o captura (con o sin dibujo) y su tamaño', () => {
    expect(describeCapture(withElement)).toBe('table.endpoints · 1084×212')
    expect(describeCapture(base)).toBe('captura · 1180×640')
    expect(describeCapture(base, 'markup')).toBe('captura con dibujo · 1180×640')
  })
})
