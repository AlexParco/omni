import { describe, expect, it } from 'vitest'
import { concatFloat32, pcmDurationMs, resampleToPcm16, rms, toInt16 } from './pcm'

describe('toInt16', () => {
  it('escala y satura', () => {
    expect(toInt16(0)).toBe(0)
    expect(toInt16(1)).toBe(32767)
    expect(toInt16(-1)).toBe(-32768)
    expect(toInt16(2)).toBe(32767)
    expect(toInt16(-3)).toBe(-32768)
    expect(toInt16(0.5)).toBe(16384)
  })
})

describe('resampleToPcm16', () => {
  it('a la misma tasa solo convierte', () => {
    const out = resampleToPcm16(new Float32Array([0, 0.5, -0.5, 1]), 16000, 16000)
    expect(Array.from(out)).toEqual([0, 16384, -16384, 32767])
  })

  it('de 48 kHz a 16 kHz deja un tercio de las muestras e interpola', () => {
    const input = new Float32Array(48000).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000))
    const out = resampleToPcm16(input, 48000, 16000)
    expect(out.length).toBe(16000)
    // Muestra 0 y la de un ciclo completo coinciden con la señal original.
    expect(out[0]).toBe(0)
    expect(Math.abs(out[1] - toInt16(input[3]))).toBeLessThanOrEqual(1)
  })

  it('con entrada vacía devuelve vacío', () => {
    expect(resampleToPcm16(new Float32Array(0), 48000).length).toBe(0)
  })
})

describe('concatFloat32 / rms / pcmDurationMs', () => {
  it('une bloques en orden', () => {
    expect(Array.from(concatFloat32([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3])
  })
  it('rms de silencio es 0 y de una onda cuadrada es su amplitud', () => {
    expect(rms(new Float32Array(100))).toBe(0)
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5)
  })
  it('duración de PCM int16 a 16 kHz', () => {
    expect(pcmDurationMs(new ArrayBuffer(16000 * 2))).toBe(1000)
    expect(pcmDurationMs(new ArrayBuffer(0))).toBe(0)
  })
})
