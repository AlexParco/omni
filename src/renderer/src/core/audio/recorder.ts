import { resampleToPcm16 } from './pcm'
import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from './worklet-source'

/**
 * Captura del micrófono para el dictado (ARCHITECTURE §3.22). `getUserMedia({ audio })` + un
 * `AudioContext` a la tasa nativa con un `AudioWorklet` que acumula Float32; al parar se remuestrea a
 * 16 kHz int16 mono, que es lo que recibe `whisper:transcribe`. El micrófono se suelta al parar o al
 * cancelar: la luz del sistema se apaga en cuanto termina el dictado.
 */
export interface Recorder {
  /** Pide el micrófono y empieza a acumular. `onLevel` recibe el nivel RMS (0–1) unas 20 veces por segundo. */
  start(onLevel?: (level: number) => void): Promise<void>
  /** Para, suelta el micrófono y devuelve el PCM 16 kHz int16 mono. */
  stop(): Promise<ArrayBuffer>
  /** Para y descarta lo grabado. Idempotente. */
  cancel(): void
}

/** Mensajes que manda el worklet por su `port`. */
type WorkletMessage = { type: 'level'; value: number } | { type: 'done'; samples: Float32Array }

/** Error de micrófono con un texto para el overlay, no el nombre DOM del error. */
export class MicrophoneError extends Error {}

/** Traduce los errores de `getUserMedia` a algo que el usuario pueda arreglar. */
export function describeMicError(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Sin permiso de micrófono: actívalo para omni en Ajustes del Sistema → Privacidad y seguridad → Micrófono'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No se encontró ningún micrófono'
  if (name === 'NotReadableError' || name === 'AbortError') return 'El micrófono está ocupado por otra app'
  return err instanceof Error && err.message ? `No se pudo abrir el micrófono: ${err.message}` : 'No se pudo abrir el micrófono'
}

let workletUrl: string | null = null
/** El worklet se carga una vez por `AudioContext`; la URL del blob se comparte. */
function workletModuleUrl(): string {
  if (workletUrl === null) workletUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' }))
  return workletUrl
}

export function createRecorder(): Recorder {
  let context: AudioContext | null = null
  let stream: MediaStream | null = null
  let node: AudioWorkletNode | null = null
  let done: ((samples: Float32Array) => void) | null = null

  const release = (): void => {
    node?.port.close()
    node?.disconnect()
    node = null
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    void context?.close().catch(() => undefined)
    context = null
    done = null
  }

  return {
    async start(onLevel) {
      if (context) return
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new MicrophoneError('Este entorno no tiene acceso al micrófono')
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
      } catch (err) {
        throw new MicrophoneError(describeMicError(err))
      }
      try {
        context = new AudioContext()
        await context.audioWorklet.addModule(workletModuleUrl())
        node = new AudioWorkletNode(context, PCM_WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 })
        node.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
          if (e.data.type === 'level') onLevel?.(e.data.value)
          else if (e.data.type === 'done') done?.(e.data.samples)
        }
        context.createMediaStreamSource(stream).connect(node)
        if (context.state !== 'running') await context.resume()
      } catch (err) {
        release()
        throw new MicrophoneError(describeMicError(err))
      }
    },
    async stop() {
      if (!context || !node) return new ArrayBuffer(0)
      const rate = context.sampleRate
      const samples = await new Promise<Float32Array>((resolve) => {
        done = resolve
        node?.port.postMessage('stop')
      })
      release()
      const pcm = resampleToPcm16(samples, rate)
      return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer
    },
    cancel() {
      node?.port.postMessage('cancel')
      release()
    }
  }
}
