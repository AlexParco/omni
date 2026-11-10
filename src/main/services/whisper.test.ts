import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_IDLE_MS, EXTRA_BIN_DIRS, MODEL_FILE, SAMPLE_RATE, WhisperService, normalizeTranscript, toBytes, wavFromPcm16, type Runner } from './whisper'

describe('wavFromPcm16', () => {
  it('escribe la cabecera RIFF canónica para 16 kHz mono int16 y pega las muestras', () => {
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]) // 4 muestras int16 LE
    const wav = wavFromPcm16(pcm)
    expect(wav.length).toBe(44 + 8)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + 8)
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ')
    expect(wav.readUInt32LE(16)).toBe(16)
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE)
    expect(wav.readUInt32LE(28)).toBe(SAMPLE_RATE * 2) // byte rate
    expect(wav.readUInt16LE(32)).toBe(2) // block align
    expect(wav.readUInt16LE(34)).toBe(16) // bits
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(8)
    expect([...wav.subarray(44)]).toEqual([1, 0, 2, 0, 3, 0, 4, 0])
  })

  it('respeta el byteOffset de una vista sobre un buffer más grande', () => {
    const backing = new Uint8Array([9, 9, 7, 0, 8, 0, 9, 9])
    const wav = wavFromPcm16(new Uint8Array(backing.buffer, 2, 4))
    expect([...wav.subarray(44)]).toEqual([7, 0, 8, 0])
  })
})

describe('normalizeTranscript', () => {
  it('quita marcas entre corchetes y paréntesis y colapsa espacios', () => {
    expect(normalizeTranscript(' [BLANK_AUDIO] ')).toBe('')
    expect(normalizeTranscript('\n hola   mundo\n (música) [inaudible] ya\n')).toBe('hola mundo ya')
    expect(normalizeTranscript('abre el archivo.')).toBe('abre el archivo.')
  })
})

describe('toBytes', () => {
  it('acepta ArrayBuffer, Uint8Array y Buffer', () => {
    const ab = new Uint8Array([1, 2, 3]).buffer
    expect([...toBytes(ab)]).toEqual([1, 2, 3])
    expect([...toBytes(new Uint8Array(ab, 1))]).toEqual([2, 3])
    expect([...toBytes(Buffer.from([4, 5]))]).toEqual([4, 5])
  })
})

const real = new WhisperService()
const ready = await real.status()

describe('WhisperService', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-whisper-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('status busca whisper-cli en el PATH dado y el modelo en la carpeta de modelos', async () => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const models = join(dir, 'models')
    const svc = new WhisperService({ modelsDir: models, path: `${join(dir, 'nada')}:${bin}`, extraBinDirs: [] })
    expect(await svc.status()).toEqual({ binary: null, model: null })
    writeFileSync(join(bin, 'whisper-cli'), '')
    mkdirSync(models)
    writeFileSync(join(models, MODEL_FILE), '')
    expect(await svc.status()).toEqual({ binary: join(bin, 'whisper-cli'), model: join(models, MODEL_FILE) })
  })

  it('status cae a las carpetas de Homebrew cuando el PATH no lo trae', async () => {
    const brew = join(dir, 'homebrew')
    mkdirSync(brew)
    writeFileSync(join(brew, 'whisper-cli'), '')
    const svc = new WhisperService({ modelsDir: dir, path: '', extraBinDirs: [join(dir, 'x'), brew] })
    expect((await svc.status()).binary).toBe(join(brew, 'whisper-cli'))
    expect(EXTRA_BIN_DIRS).toContain('/opt/homebrew/bin')
  })

  it('transcribe con fakeText devuelve ese texto sin binario ni modelo', async () => {
    const svc = new WhisperService({ modelsDir: dir, path: '', extraBinDirs: [], fakeText: '  hola  [BLANK_AUDIO] causa ' })
    const out = await svc.transcribe(new ArrayBuffer(0))
    expect(out.text).toBe('hola causa')
    expect(out.ms).toBeGreaterThanOrEqual(0)
  })

  it('el servicio no lee OMNI_FAKE_WHISPER por su cuenta: eso lo decide index.ts y solo en dev', async () => {
    const prev = process.env.OMNI_FAKE_WHISPER
    process.env.OMNI_FAKE_WHISPER = 'texto falso'
    try {
      const svc = new WhisperService({ modelsDir: dir, path: '', extraBinDirs: [] })
      await expect(svc.transcribe(new ArrayBuffer(0))).rejects.toThrow(/whisper-cli no está instalado/)
    } finally {
      if (prev === undefined) delete process.env.OMNI_FAKE_WHISPER
      else process.env.OMNI_FAKE_WHISPER = prev
    }
  })

  it('transcribe corre whisper-cli con los flags acordados, lee out.txt y limpia los temporales', async () => {
    const bin = join(dir, 'bin')
    const models = join(dir, 'models')
    mkdirSync(bin)
    mkdirSync(models)
    writeFileSync(join(bin, 'whisper-cli'), '')
    writeFileSync(join(models, MODEL_FILE), '')
    let wavPath = ''
    const run = vi.fn<Runner>(async (_cmd, args) => {
      wavPath = args[args.indexOf('-f') + 1] ?? ''
      expect(existsSync(wavPath)).toBe(true)
      writeFileSync(`${args[args.indexOf('-of') + 1]}.txt`, ' abre el archivo\n')
      return ''
    })
    const svc = new WhisperService({ modelsDir: models, path: bin, extraBinDirs: [], run, tmpDir: dir })
    const out = await svc.transcribe(new Uint8Array([0, 0, 0, 0]))
    expect(out.text).toBe('abre el archivo')
    const args = run.mock.calls[0]?.[1] ?? []
    expect(run.mock.calls[0]?.[0]).toBe(join(bin, 'whisper-cli'))
    expect(args.slice(0, 2)).toEqual(['-m', join(models, MODEL_FILE)])
    expect(args).toEqual(expect.arrayContaining(['-l', 'es', '-nt', '-otxt', '-of']))
    expect(existsSync(wavPath)).toBe(false)
  })

  it('sin binario o sin modelo, transcribe falla con un mensaje humano', async () => {
    const svc = new WhisperService({ modelsDir: dir, path: '', extraBinDirs: [] })
    await expect(svc.transcribe(new ArrayBuffer(0))).rejects.toThrow(/whisper-cli no está instalado/)
  })

  it('downloadModel escribe .part, renombra, avisa el progreso y comparte una sola descarga', async () => {
    const models = join(dir, 'models')
    const body = new Blob([new Uint8Array(1000)]).stream()
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-length': '1000' } }))
    const svc = new WhisperService({ modelsDir: models, path: '', extraBinDirs: [], fetch: fetchImpl as unknown as typeof fetch })
    const progress: number[] = []
    svc.onProgress((f) => progress.push(f))
    const [a, b] = await Promise.all([svc.downloadModel(), svc.downloadModel()])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(a.model).toBe(join(models, MODEL_FILE))
    expect(existsSync(`${join(models, MODEL_FILE)}.part`)).toBe(false)
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(1)
  })

  it('downloadModel se detiene tras un rato sin recibir bytes y limpia el .part', async () => {
    const models = join(dir, 'models')
    // Un chunk y luego silencio: el stream nunca cierra.
    const body = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new Uint8Array(10)) })
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-length': '1000' } }))
    const svc = new WhisperService({ modelsDir: models, path: '', extraBinDirs: [], fetch: fetchImpl as unknown as typeof fetch, downloadIdleMs: 50 })
    await expect(svc.downloadModel()).rejects.toThrow(/no se pudo descargar el modelo de whisper: descarga detenida \(0 s sin datos\)/)
    expect(existsSync(`${join(models, MODEL_FILE)}.part`)).toBe(false)
    expect(DOWNLOAD_IDLE_MS).toBe(30_000)
  })

  it('cancel() aborta la descarga en curso para todos los que la esperaban y limpia el .part', async () => {
    const models = join(dir, 'models')
    let seen = false
    const body = new ReadableStream<Uint8Array>({
      start: (c) => c.enqueue(new Uint8Array(10)),
      pull: () => new Promise(() => undefined)
    })
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = init?.signal instanceof AbortSignal
      return new Response(body, { status: 200, headers: { 'content-length': '1000' } })
    })
    const svc = new WhisperService({ modelsDir: models, path: '', extraBinDirs: [], fetch: fetchImpl as unknown as typeof fetch })
    const a = svc.downloadModel()
    const b = svc.downloadModel()
    await new Promise((r) => setTimeout(r, 20))
    svc.cancel()
    await expect(a).rejects.toThrow(/descarga detenida$/)
    await expect(b).rejects.toThrow(/descarga detenida$/)
    expect(seen).toBe(true)
    expect(existsSync(`${join(models, MODEL_FILE)}.part`)).toBe(false)
    // Sin descarga en curso, cancel() no hace nada.
    svc.cancel()
  })

  it('downloadModel con HTTP de error tira un mensaje humano y no deja .part', async () => {
    const models = join(dir, 'models')
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }))
    const svc = new WhisperService({ modelsDir: models, path: '', extraBinDirs: [], fetch: fetchImpl as unknown as typeof fetch })
    await expect(svc.downloadModel()).rejects.toThrow(/no se pudo descargar el modelo de whisper: HTTP 503/)
    expect(existsSync(`${join(models, MODEL_FILE)}.part`)).toBe(false)
  })

  // Real: solo corre si esta máquina tiene whisper-cli y el modelo base. Un segundo de silencio debe dar texto vacío sin tirar.
  it.skipIf(!ready.binary || !ready.model)('transcribe un WAV de silencio con el binario real sin tirar', async () => {
    const out = await real.transcribe(new Int16Array(SAMPLE_RATE))
    expect(out.text).toBe('')
  }, 60_000)
})
