import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CostSummary } from '@shared/types'
import { COST_REFRESH_MS, useCost } from './cost'

const invoke = vi.fn()
/** Listeners de `omni.on` por canal, para disparar `cost:changed` a mano. */
const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}

vi.mock('@/lib/omni', () => ({
  omni: {
    invoke: (...args: unknown[]) => invoke(...args),
    send: vi.fn(),
    on: (channel: string, cb: (...args: unknown[]) => void) => {
      ;(listeners[channel] ??= []).push(cb)
      return () => {
        listeners[channel] = (listeners[channel] ?? []).filter((x) => x !== cb)
      }
    }
  }
}))

const summary = (today: number): CostSummary => ({ today, bySession: {}, byAgent: {} })
const emit = (channel: string, ...args: unknown[]): void => (listeners[channel] ?? []).forEach((cb) => cb(...args))
/** `document.hasFocus` simulado: en Node no hay DOM, así que se inyecta y se retira en cada test. */
let focused = true

let stop: () => void = () => {}

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  invoke.mockResolvedValue(summary(1))
  Object.keys(listeners).forEach((k) => delete listeners[k])
  useCost.setState({ summary: null })
  focused = true
  vi.stubGlobal('document', { hasFocus: () => focused })
})

afterEach(() => {
  stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useCost.init', () => {
  it('pide cost:summary al arrancar y guarda la respuesta', async () => {
    stop = useCost.getState().init()
    expect(invoke).toHaveBeenCalledWith('cost:summary')
    await vi.advanceTimersByTimeAsync(0)
    expect(useCost.getState().summary).toEqual(summary(1))
  })

  it('cost:changed reemplaza el resumen sin volver a pedirlo', async () => {
    stop = useCost.getState().init()
    await vi.advanceTimersByTimeAsync(0)
    emit('cost:changed', summary(18.6))
    expect(useCost.getState().summary).toEqual(summary(18.6))
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('repide cada minuto solo si la ventana tiene el foco', async () => {
    stop = useCost.getState().init()
    await vi.advanceTimersByTimeAsync(0)
    invoke.mockResolvedValue(summary(2))
    await vi.advanceTimersByTimeAsync(COST_REFRESH_MS)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(useCost.getState().summary).toEqual(summary(2))
    focused = false
    await vi.advanceTimersByTimeAsync(COST_REFRESH_MS * 3)
    expect(invoke).toHaveBeenCalledTimes(2)
    focused = true
    await vi.advanceTimersByTimeAsync(COST_REFRESH_MS)
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('un fallo de main deja el resumen anterior', async () => {
    stop = useCost.getState().init()
    await vi.advanceTimersByTimeAsync(0)
    invoke.mockRejectedValue(new Error('sin logs'))
    await vi.advanceTimersByTimeAsync(COST_REFRESH_MS)
    expect(useCost.getState().summary).toEqual(summary(1))
  })

  it('al deshacer deja de escuchar y de repedir', async () => {
    stop = useCost.getState().init()
    await vi.advanceTimersByTimeAsync(0)
    stop()
    stop = () => {}
    emit('cost:changed', summary(99))
    await vi.advanceTimersByTimeAsync(COST_REFRESH_MS * 2)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(useCost.getState().summary).toEqual(summary(1))
  })
})
