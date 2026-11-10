/**
 * Conversión de audio para el dictado (ARCHITECTURE §3.22): el micrófono entrega Float32 a la tasa
 * nativa del `AudioContext` (44.1 o 48 kHz) y whisper quiere PCM int16 mono a 16 kHz. Funciones
 * puras, sin DOM, para testearse en Node.
 */

/** Tasa que espera `whisper:transcribe`. */
export const WHISPER_RATE = 16000

/** Une varios bloques Float32 en uno solo. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/**
 * Remuestrea por interpolación lineal y convierte a int16 con saturación. Para voz a 16 kHz la
 * interpolación lineal sobra (whisper vuelve a filtrar a 80 bandas mel); no hace falta un filtro
 * antialias aparte. Misma tasa de entrada y salida: solo convierte.
 */
export function resampleToPcm16(input: Float32Array, fromRate: number, toRate = WHISPER_RATE): Int16Array {
  if (input.length === 0 || fromRate <= 0 || toRate <= 0) return new Int16Array(0)
  const ratio = fromRate / toRate
  const length = ratio === 1 ? input.length : Math.max(1, Math.floor(input.length / ratio))
  const out = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const t = pos - i0
    const sample = input[i0] * (1 - t) + input[i1] * t
    out[i] = toInt16(sample)
  }
  return out
}

/** Float [-1, 1] → int16 con saturación. */
export function toInt16(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample))
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
}

/** Nivel RMS de un bloque, en [0, 1]. Para la barra de nivel del overlay. */
export function rms(chunk: Float32Array): number {
  if (chunk.length === 0) return 0
  let sum = 0
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
  return Math.min(1, Math.sqrt(sum / chunk.length))
}

/** Duración en milisegundos de un buffer PCM int16 mono a `rate`. */
export function pcmDurationMs(pcm: ArrayBuffer, rate = WHISPER_RATE): number {
  return (pcm.byteLength / 2 / rate) * 1000
}
