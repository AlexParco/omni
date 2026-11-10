import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUBMIT_DELAY_MS, VERIFY_MS, sanitizeForPty, writeToSession, writeWhenSettled } from './session-write'

const send = vi.fn()
const listeners: Array<(...args: unknown[]) => void> = []

vi.mock('@/lib/omni', () => ({
  omni: {
    invoke: vi.fn(),
    send: (...args: unknown[]) => send(...args),
    on: (_channel: string, cb: (...args: unknown[]) => void) => {
      listeners.push(cb)
      return () => listeners.splice(listeners.indexOf(cb), 1)
    }
  }
}))

const emit = (...args: unknown[]): void => [...listeners].forEach((cb) => cb(...args))

beforeEach(() => {
  vi.useFakeTimers()
  send.mockReset()
  listeners.length = 0
})
afterEach(() => vi.useRealTimers())

describe('sanitizeForPty', () => {
  it('quita escapes y retornos de carro pero conserva saltos de línea y tabs', () => {
    expect(sanitizeForPty('a\x1b[201~echo PWNED\rb\n\tc\x00\x7f')).toBe('a[201~echo PWNEDb\n\tc')
  })
})

describe('writeToSession', () => {
  it('sanea siempre: un texto hostil no puede cerrar el pegado ni meter un ⏎', () => {
    writeToSession('s1', 'hola\x1b[201~\rrm -rf /', true)
    expect(send).toHaveBeenCalledWith('session:write', 's1', 'hola[201~rm -rf /')
    vi.advanceTimersByTime(SUBMIT_DELAY_MS)
    expect(send).toHaveBeenLastCalledWith('session:write', 's1', '\r')
  })

  it('varias líneas van como pegado (bracketed paste) y `submit` agrega ⏎', () => {
    writeToSession('s1', 'a\nb', true)
    expect(send).toHaveBeenCalledWith('session:write', 's1', '\x1b[200~a\nb\x1b[201~')
    vi.advanceTimersByTime(SUBMIT_DELAY_MS)
    expect(send).toHaveBeenLastCalledWith('session:write', 's1', '\r')
    writeToSession('s1', 'a\nb', false, false)
    expect(send).toHaveBeenLastCalledWith('session:write', 's1', 'a\nb')
  })
})

describe('writeWhenSettled', () => {
  it('escribe cuando la TUI pidió bracketed paste y lleva 2.5 s callada; deja de escuchar', () => {
    writeWhenSettled('s1', 'prompt')
    emit('s1', 'arrancando')
    vi.advanceTimersByTime(5000)
    expect(send).not.toHaveBeenCalled()
    emit('s1', '\x1b[?2004h')
    emit('s1', 'más salida')
    vi.advanceTimersByTime(2499)
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledWith('session:write', 's1', 'prompt')
    vi.advanceTimersByTime(SUBMIT_DELAY_MS)
    expect(send).toHaveBeenLastCalledWith('session:write', 's1', '\r')
    // La TUI repinta el texto (con saltos de cursor entre palabras, como Ink): entregado, deja de escuchar.
    emit('s1', '\x1b[3Gprompt')
    vi.advanceTimersByTime(VERIFY_MS)
    expect(listeners).toHaveLength(0)
  })

  it('reintenta solo si la TUI reinició su entrada y el texto no aparece; un pegado abreviado cuenta como entregado', async () => {
    const { shouldRetry } = await import('./session-write')
    expect(shouldRetry('Agrega mul', null, 'repintado sin reinicio')).toBe(false)
    expect(shouldRetry('Agrega mul', null, '\x1b[?2004l…\x1b[?2004h❯ ')).toBe(true)
    expect(shouldRetry('Agrega mul', null, '\x1b[?2004l❯ \x1b[3GAgrega\x1b[10Gmul')).toBe(false)
    expect(shouldRetry('Agrega mul', null, '\x1b[?2004l❯ [Pasted text #1 +3 lines]')).toBe(false)
    expect(shouldRetry('Agrega mul', ['❯ Agrega mul a sum.js'], '\x1b[?2004l')).toBe(false)
  })

  it('una TUI que arranca y se traga el prompt recibe un reintento; luego para', () => {
    writeWhenSettled('s3', 'Agrega mul a sum.js')
    emit('s3', '\x1b[?2004h')
    vi.advanceTimersByTime(2500)
    const sent = (): number => send.mock.calls.filter((c) => c[1] === 's3' && c[2] === 'Agrega mul a sum.js').length
    expect(sent()).toBe(1)
    emit('s3', '\x1b[?2004l\x1b[?1049h❯ \x1b[?2004h')
    vi.advanceTimersByTime(VERIFY_MS + 2500)
    expect(sent()).toBe(2)
    emit('s3', '\x1b[3GAgrega\x1b[10Gmul\x1b[14Ga\x1b[16Gsum.js')
    vi.advanceTimersByTime(VERIFY_MS + 5000)
    expect(sent()).toBe(2)
  })
})
