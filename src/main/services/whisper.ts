import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { WhisperStatus } from '@shared/types'
import { CONFIG_DIR } from '../paths'

/**
 * Dictado local (ARCHITECTURE §3.22): transcribe PCM 16 kHz mono int16 con el `whisper-cli` de
 * whisper.cpp (`brew install whisper-cpp`) y el modelo `ggml-base.bin` en `~/.config/omni/models/`.
 * Nada sale de la máquina salvo la descarga del modelo, que el usuario pide a mano.
 */

export const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
export const MODEL_FILE = 'ggml-base.bin'
/** Más de esto y la transcripción se da por colgada. */
export const TRANSCRIBE_TIMEOUT_MS = 60_000
/** Descarga del modelo: tanto tiempo sin recibir bytes y se detiene (red caída, CDN colgada). */
export const DOWNLOAD_IDLE_MS = 30_000
/** Carpetas de Homebrew (Apple Silicon e Intel) por si la app no hereda el PATH de la shell. */
export const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
export const SAMPLE_RATE = 16_000

/** Ejecuta un binario y devuelve stdout; rechaza si falla o expira. Inyectable en tests. */
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<string>

const defaultRunner: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolvePromise(stdout)
    })
  })

/** WAV PCM 16 kHz mono int16 a partir de las muestras crudas (cabecera RIFF canónica de 44 bytes). */
export function wavFromPcm16(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Buffer {
  const channels = 1
  const bitsPerSample = 16
  const blockAlign = (channels * bitsPerSample) / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.byteLength, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.byteLength, 40)
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)])
}

/** Texto limpio: sin marcas entre corchetes o paréntesis de whisper (`[BLANK_AUDIO]`, `(música)`), espacios colapsados. */
export function normalizeTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lo que llega por IPC puede ser ArrayBuffer, Uint8Array o Buffer: siempre se mira como bytes. */
export function toBytes(pcm: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (pcm instanceof ArrayBuffer) return new Uint8Array(pcm)
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
}

export interface WhisperOptions {
  /** Carpeta del modelo; por defecto `~/.config/omni/models`. */
  modelsDir?: string
  /** PATH donde buscar `whisper-cli`; por defecto el del proceso. */
  path?: string
  extraBinDirs?: string[]
  run?: Runner
  fetch?: typeof fetch
  /** Texto que devuelve `transcribe` sin binario (pruebas e2e). Lo pasa `main/index.ts` solo en dev; el servicio no lee el env. */
  fakeText?: string
  tmpDir?: string
  downloadIdleMs?: number
}

export type ProgressListener = (fraction: number) => void

export class WhisperService {
  private readonly modelsDir: string
  private readonly binDirs: string[]
  private readonly run: Runner
  private readonly fetchImpl: typeof fetch
  private readonly fakeText: string | undefined
  private readonly tmpDir: string
  private readonly listeners = new Set<ProgressListener>()
  private readonly downloadIdleMs: number
  private download: Promise<WhisperStatus> | null = null
  /** Descarga en curso, para abortarla desde `cancel()` o por inactividad. */
  private controller: AbortController | null = null

  constructor(opts: WhisperOptions = {}) {
    this.modelsDir = opts.modelsDir ?? join(CONFIG_DIR, 'models')
    const path = opts.path ?? process.env.PATH ?? ''
    this.binDirs = [...path.split(delimiter).filter(Boolean), ...(opts.extraBinDirs ?? EXTRA_BIN_DIRS)]
    this.run = opts.run ?? defaultRunner
    this.fetchImpl = opts.fetch ?? fetch
    this.fakeText = opts.fakeText
    this.tmpDir = opts.tmpDir ?? tmpdir()
    this.downloadIdleMs = opts.downloadIdleMs ?? DOWNLOAD_IDLE_MS
  }

  get modelPath(): string {
    return join(this.modelsDir, MODEL_FILE)
  }

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async status(): Promise<WhisperStatus> {
    const [binary, model] = await Promise.all([this.findBinary(), exists(this.modelPath)])
    return { binary, model: model ? this.modelPath : null }
  }

  /** Baja el modelo a `.part` y lo renombra al final; una sola descarga a la vez. */
  downloadModel(): Promise<WhisperStatus> {
    if (!this.download) {
      const controller = new AbortController()
      this.controller = controller
      this.download = this.fetchModel(controller).finally(() => {
        this.download = null
        if (this.controller === controller) this.controller = null
      })
    }
    return this.download
  }

  /** Detiene la descarga en curso (si la hay): quien la pidió recibe "descarga detenida" y el `.part` se borra. */
  cancel(): void {
    this.controller?.abort()
  }

  /** PCM 16 kHz mono int16 → texto. Con `OMNI_FAKE_WHISPER` no toca el binario. */
  async transcribe(pcm: ArrayBuffer | ArrayBufferView): Promise<{ text: string; ms: number }> {
    const started = Date.now()
    if (this.fakeText !== undefined) return { text: normalizeTranscript(this.fakeText), ms: Date.now() - started }
    const { binary, model } = await this.status()
    if (!binary) throw new Error('whisper-cli no está instalado (brew install whisper-cpp)')
    if (!model) throw new Error('falta el modelo ggml-base.bin: descárgalo desde el overlay de dictado')
    const dir = await mkdtemp(join(this.tmpDir, 'omni-whisper-'))
    const wav = join(dir, 'audio.wav')
    const base = join(dir, 'out')
    try {
      await writeFile(wav, wavFromPcm16(toBytes(pcm)))
      const stdout = await this.run(binary, ['-m', model, '-f', wav, '-l', 'es', '-nt', '-np', '-otxt', '-of', base], TRANSCRIBE_TIMEOUT_MS)
      // `-otxt` deja `out.txt`; si por lo que sea no está, vale lo que salió por stdout.
      const raw = await readFile(`${base}.txt`, 'utf8').catch(() => stdout)
      return { text: normalizeTranscript(raw), ms: Date.now() - started }
    } catch (err) {
      throw new Error(`no se pudo transcribir: ${humanError(err)}`)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async findBinary(): Promise<string | null> {
    for (const dir of this.binDirs) {
      const candidate = join(dir, 'whisper-cli')
      if (await exists(candidate)) return candidate
    }
    return null
  }

  private async fetchModel(controller: AbortController): Promise<WhisperStatus> {
    const part = `${this.modelPath}.part`
    const { signal } = controller
    // Cada byte recibido rearma el reloj; si pasa `downloadIdleMs` sin nada, se aborta con motivo.
    let idle: ReturnType<typeof setTimeout> | null = null
    let idleReason: string | null = null
    const arm = (): void => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => {
        idleReason = `${Math.round(this.downloadIdleMs / 1000)} s sin datos`
        controller.abort()
      }, this.downloadIdleMs)
    }
    try {
      await mkdir(this.modelsDir, { recursive: true })
      arm()
      const res = await this.fetchImpl(MODEL_URL, { signal })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || 0
      let done = 0
      this.notify(0)
      const counter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          arm()
          done += chunk.length
          if (total > 0) this.notify(Math.min(done / total, 0.999))
          cb(null, chunk)
        }
      })
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), counter, createWriteStream(part), { signal })
      await rename(part, this.modelPath)
      this.notify(1)
    } catch (err) {
      await rm(part, { force: true }).catch(() => undefined)
      const reason = signal.aborted ? `descarga detenida${idleReason ? ` (${idleReason})` : ''}` : humanError(err)
      throw new Error(`no se pudo descargar el modelo de whisper: ${reason}`)
    } finally {
      if (idle) clearTimeout(idle)
    }
    return this.status()
  }

  private notify(fraction: number): void {
    this.listeners.forEach((l) => l(fraction))
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Mensaje corto para el overlay: sin stack ni ruido de Metal/BLAS que whisper vuelca por stderr. */
function humanError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'no se encontró el binario'
    if (err.message.includes('ETIMEDOUT') || (err as { killed?: boolean }).killed) return 'tardó más de 60 s'
    return err.message.split('\n')[0] ?? 'error desconocido'
  }
  return String(err)
}
