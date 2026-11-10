/**
 * Código del `AudioWorkletProcessor` del dictado, como texto: se carga por `Blob` URL para no
 * depender de cómo empaqueta Vite un módulo de worklet (y sin dependencias nuevas). Corre en el hilo
 * de audio: acumula los bloques Float32 del micrófono y manda el nivel RMS cada ~40 ms. Al recibir
 * `stop` devuelve todo lo grabado en un solo buffer (transferido, sin copia); `cancel` lo descarta.
 */
export const PCM_WORKLET_NAME = 'omni-pcm-capture'

export const PCM_WORKLET_SOURCE = `
class OmniPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.chunks = []
    this.length = 0
    this.levelSum = 0
    this.levelCount = 0
    this.stopped = false
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        const out = new Float32Array(this.length)
        let offset = 0
        for (const c of this.chunks) { out.set(c, offset); offset += c.length }
        this.chunks = []
        this.length = 0
        this.stopped = true
        this.port.postMessage({ type: 'done', samples: out }, [out.buffer])
      } else if (e.data === 'cancel') {
        this.chunks = []
        this.length = 0
        this.stopped = true
      }
    }
  }
  process(inputs) {
    if (this.stopped) return false
    const channel = inputs[0] && inputs[0][0]
    if (!channel || channel.length === 0) return true
    const copy = new Float32Array(channel.length)
    copy.set(channel)
    this.chunks.push(copy)
    this.length += copy.length
    let sum = 0
    for (let i = 0; i < copy.length; i++) sum += copy[i] * copy[i]
    this.levelSum += sum
    this.levelCount += copy.length
    if (this.levelCount >= 2048) {
      this.port.postMessage({ type: 'level', value: Math.min(1, Math.sqrt(this.levelSum / this.levelCount)) })
      this.levelSum = 0
      this.levelCount = 0
    }
    return true
  }
}
registerProcessor('${PCM_WORKLET_NAME}', OmniPcmCapture)
`
