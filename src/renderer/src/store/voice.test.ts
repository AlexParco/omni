import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, WhisperStatus, Workspace } from '@shared/types'
import { useLayout } from './layout'
import { useSessions } from './sessions'
import { useUi } from './ui'
import { elapsedMs, targetIds, useVoice } from './voice'
import { INSTALL_COMMAND, MIN_AUDIO_MS, SENT_MS, TAP_MS } from './voice-logic'

const invoke = vi.fn()
const send = vi.fn()
const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
const focusTerminal = vi.fn()

vi.mock('@/lib/omni', () => ({
  omni: {
    invoke: (...args: unknown[]) => invoke(...args),
    send: (...args: unknown[]) => send(...args),
    on: (channel: string, cb: (...args: unknown[]) => void) => {
      ;(listeners[channel] ??= []).push(cb)
      return () => {
        listeners[channel] = (listeners[channel] ?? []).filter((x) => x !== cb)
      }
    }
  }
}))
vi.mock('@/panes/terminal/terminal-host', () => ({
  screenLines: () => null, disposeTerminal: vi.fn(), getTerminal: vi.fn(() => ({ focus: focusTerminal })) }))
vi.mock('./browser', () => ({ liveBrowserId: () => null, useBrowser: { getState: () => ({ blur: vi.fn() }) } }))

/** Grabadora falsa: `start` resuelve al tick siguiente y `stop` devuelve `audioMs` de PCM a 16 kHz. */
const rec = { started: 0, stopped: 0, cancelled: 0, audioMs: 2000, failStart: null as string | null, level: null as ((l: number) => void) | null }
vi.mock('@/core/audio/recorder', () => ({
  createRecorder: () => ({
    async start(onLevel?: (l: number) => void) {
      await Promise.resolve()
      if (rec.failStart) throw new Error(rec.failStart)
      rec.started++
      rec.level = onLevel ?? null
    },
    async stop() {
      rec.stopped++
      return new ArrayBuffer(Math.round((rec.audioMs / 1000) * 16000) * 2)
    },
    cancel() {
      rec.cancelled++
    }
  })
}))

const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime()
const OK: WhisperStatus = { binary: '/opt/homebrew/bin/whisper-cli', model: '/home/.config/omni/models/ggml-base.bin' }
const ws = (id: string, projectId: string): Workspace => ({ id, projectId, name: id, path: `/x/${projectId}`, kind: 'local' })
const session = (id: string, workspaceId: string, agent: SessionInfo['agent'], createdAt = NOW): SessionInfo => ({ id, agent, workspaceId, cwd: '/x', createdAt }) as SessionInfo
const emit = (channel: string, ...args: unknown[]): void => (listeners[channel] ?? []).forEach((cb) => cb(...args))

/** Respuestas de main por canal. */
function mainAnswers(status: WhisperStatus | null = OK, text = 'hola agente'): void {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'whisper:status') return status ?? { binary: null, model: null }
    if (channel === 'whisper:transcribe') return { text, ms: 120 }
    if (channel === 'whisper:downloadModel') return OK
    return undefined
  })
}

/** Deja correr las promesas pendientes (status, micrófono, transcripción). */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

const voice = useVoice.getState

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  invoke.mockReset()
  send.mockReset()
  focusTerminal.mockReset()
  Object.keys(listeners).forEach((k) => delete listeners[k])
  Object.assign(rec, { started: 0, stopped: 0, cancelled: 0, audioMs: 2000, failStart: null, level: null })
  useSessions.setState({
    sessions: [session('cc', 'w1', 'claude', NOW - 3000), session('cx', 'w1', 'codex', NOW - 2000), session('sh', 'w1', 'shell', NOW - 1000), session('br', 'w1', 'browser')],
    workspaces: [ws('w1', 'p1')],
    currentWorkspaceId: 'w1',
    activity: {},
    attention: {},
    busy: {},
    titles: {},
    ready: true
  })
  useLayout.setState({ tabs: [], activeTab: {} })
  useUi.setState({ overlay: null, focus: 'list', view: 'fleet' })
  voice().cancel()
  useVoice.setState({ status: null, downloading: null })
})

afterEach(() => {
  voice().cancel()
  vi.useRealTimers()
})

describe('useVoice: mantener y soltar', () => {
  it('abre el overlay, elige destino, graba y al soltar transcribe y escribe con ⏎', async () => {
    mainAnswers()
    void voice().startHold()
    expect(voice().phase).toBe('recording')
    expect(useUi.getState().overlay).toBe('voice')
    // Sin pane enfocado el destino es el primero rankeado: agentes antes que shells, el más nuevo primero.
    expect(voice().target).toBe('cx')
    await settle()
    expect(rec.started).toBe(1)
    expect(voice().status).toEqual(OK)
    rec.level?.(0.4)
    expect(voice().level).toBe(0.4)
    vi.setSystemTime(NOW + 2000)
    voice().release()
    expect(voice().phase).toBe('transcribing')
    await settle()
    expect(invoke).toHaveBeenCalledWith('whisper:transcribe', expect.any(ArrayBuffer))
    expect(send).toHaveBeenCalledWith('session:write', 'cx', 'hola agente')
    vi.advanceTimersByTime(200)
    expect(send).toHaveBeenCalledWith('session:write', 'cx', '\r')
    expect(voice().phase).toBe('sent')
    expect(focusTerminal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SENT_MS)
    expect(voice().phase).toBe('idle')
    expect(useUi.getState().overlay).toBeNull()
  })

  it('la repetición del keydown y un keyup fuera de la grabación no hacen nada', async () => {
    mainAnswers()
    void voice().startHold()
    await settle()
    void voice().startHold()
    expect(voice().phase).toBe('recording')
    expect(voice().handsFree).toBe(false)
    expect(rec.started).toBe(1)
    vi.setSystemTime(NOW + 1000)
    voice().release()
    voice().release()
    expect(rec.stopped).toBe(1)
  })

  it('con ⇧ al soltar deja el texto en revisión; ⌘⏎ envía lo editado y lleva el foco al destino', async () => {
    mainAnswers()
    void voice().startHold()
    await settle()
    vi.setSystemTime(NOW + 1500)
    voice().release({ review: true })
    await settle()
    expect(voice().phase).toBe('review')
    expect(voice().text).toBe('hola agente')
    expect(send).not.toHaveBeenCalled()
    voice().setText('hola agente, revisado')
    voice().send()
    expect(send).toHaveBeenCalledWith('session:write', 'cx', 'hola agente, revisado')
    vi.advanceTimersByTime(200)
    expect(send).toHaveBeenCalledWith('session:write', 'cx', '\r')
    expect(focusTerminal).toHaveBeenCalled()
    expect(useUi.getState().focus).toBe('terminal')
  })

  it('un toque corto espera el segundo; sin segundo, transcribe la frase corta', async () => {
    mainAnswers()
    void voice().startHold()
    await settle()
    vi.setSystemTime(NOW + 150)
    voice().release()
    expect(voice().phase).toBe('recording')
    expect(rec.stopped).toBe(0)
    await vi.advanceTimersByTimeAsync(TAP_MS)
    expect(rec.stopped).toBe(1)
    await settle()
    expect(send).toHaveBeenCalledWith('session:write', 'cx', 'hola agente')
    vi.advanceTimersByTime(200)
    expect(send).toHaveBeenCalledWith('session:write', 'cx', '\r')
  })

  it('dos toques rápidos = manos libres: el keyup no corta y otra pulsación termina y envía', async () => {
    mainAnswers()
    void voice().startHold()
    await settle()
    vi.setSystemTime(NOW + 120)
    voice().release()
    vi.setSystemTime(NOW + 300)
    void voice().startHold()
    expect(voice().handsFree).toBe(true)
    voice().release()
    await vi.advanceTimersByTimeAsync(TAP_MS * 2)
    expect(voice().phase).toBe('recording')
    expect(rec.stopped).toBe(0)
    void voice().startHold()
    expect(voice().phase).toBe('transcribing')
    await settle()
    expect(send).toHaveBeenCalledWith('session:write', 'cx', 'hola agente')
    vi.advanceTimersByTime(200)
    expect(send).toHaveBeenCalledWith('session:write', 'cx', '\r')
  })

  it('un toque sin frase (audio corto) no transcribe ni envía', async () => {
    mainAnswers()
    rec.audioMs = MIN_AUDIO_MS - 100
    void voice().startHold()
    await settle()
    vi.setSystemTime(NOW + 1000)
    voice().release()
    await settle()
    expect(invoke).not.toHaveBeenCalledWith('whisper:transcribe', expect.anything())
    expect(send).not.toHaveBeenCalled()
    expect(voice().phase).toBe('idle')
  })

  it('soltar antes de que el micrófono esté listo termina en cuanto arranca', async () => {
    mainAnswers()
    void voice().startHold()
    vi.setSystemTime(NOW + 1000)
    voice().release()
    expect(voice().phase).toBe('recording')
    await settle()
    expect(rec.stopped).toBe(1)
    await settle()
    expect(send).toHaveBeenCalledWith('session:write', 'cx', 'hola agente')
    vi.advanceTimersByTime(200)
    expect(send).toHaveBeenCalledWith('session:write', 'cx', '\r')
  })

  it('Esc cancela: suelta el micrófono, no transcribe y cierra el overlay', async () => {
    mainAnswers()
    void voice().startHold()
    await settle()
    voice().cancel()
    expect(rec.cancelled).toBeGreaterThan(0)
    expect(voice().phase).toBe('idle')
    expect(useUi.getState().overlay).toBeNull()
    voice().release()
    await settle()
    expect(invoke).not.toHaveBeenCalledWith('whisper:transcribe', expect.anything())
  })
})

describe('useVoice: destino', () => {
  it('el pane con foco es el destino por defecto si es una terminal; Tab rota con rankTargets', async () => {
    mainAnswers()
    useLayout.setState({ tabs: [{ id: 't1', workspaceId: 'w1', root: { kind: 'leaf', id: 'l1', sessionId: 'sh' }, focusedPaneId: 'l1', zoomedPaneId: null }], activeTab: { w1: 't1' } })
    void voice().startHold()
    expect(voice().target).toBe('sh')
    // Preferido primero dentro de su grupo: shells van detrás de los agentes.
    expect(targetIds()).toEqual(['cx', 'cc', 'sh'])
    voice().nextTarget(1)
    expect(voice().target).toBe('cx')
    voice().nextTarget(-1)
    expect(voice().target).toBe('sh')
    voice().nextTarget(-1)
    expect(voice().target).toBe('cc')
    voice().setTarget('br')
    expect(voice().target).toBe('cc')
    await settle()
  })

  it('⌥⇧Space: al soltar deja elegir el destino y ⏎ envía al elegido', async () => {
    mainAnswers()
    void voice().startHold({ choose: true })
    await settle()
    vi.setSystemTime(NOW + 1500)
    voice().release()
    await settle()
    expect(voice().phase).toBe('choose')
    voice().nextTarget(1)
    expect(voice().target).toBe('cc')
    voice().send()
    expect(send).toHaveBeenCalledWith('session:write', 'cc', 'hola agente')
    vi.advanceTimersByTime(200)
    expect(send).toHaveBeenCalledWith('session:write', 'cc', '\r')
    expect(focusTerminal).toHaveBeenCalled()
  })

  it('sin terminales en el workspace: unavailable con motivo target', async () => {
    mainAnswers()
    useSessions.setState({ sessions: [session('br', 'w1', 'browser')] })
    void voice().startHold()
    await settle()
    expect(voice().phase).toBe('unavailable')
    expect(voice().reason).toBe('target')
    expect(rec.started).toBe(0)
  })
})

describe('useVoice: whisper y micrófono', () => {
  it('sin binario: unavailable con motivo binary y C copia el brew install', async () => {
    mainAnswers({ binary: null, model: null })
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    void voice().startHold()
    await settle()
    expect(voice().phase).toBe('unavailable')
    expect(voice().reason).toBe('binary')
    expect(rec.started).toBe(0)
    expect(useUi.getState().overlay).toBe('voice')
    await voice().copyInstall()
    expect(writeText).toHaveBeenCalledWith(INSTALL_COMMAND)
    expect(voice().copied).toBe(true)
    vi.unstubAllGlobals()
    // Otra pulsación reintenta (tras instalar).
    mainAnswers()
    void voice().startHold()
    expect(voice().phase).toBe('recording')
    await settle()
    expect(rec.started).toBe(1)
  })

  it('sin modelo: D descarga con progreso y al terminar vuelve a reposo', async () => {
    mainAnswers({ binary: '/b', model: null })
    void voice().startHold()
    await settle()
    expect(voice().reason).toBe('model')
    const p = voice().downloadModel()
    expect(voice().downloading).toBe(0)
    emit('whisper:progress', 0.5)
    expect(voice().downloading).toBe(0.5)
    await p
    expect(voice().downloading).toBeNull()
    expect(voice().status).toEqual(OK)
    expect(voice().phase).toBe('idle')
    expect(listeners['whisper:progress']).toHaveLength(0)
  })

  it('la descarga se puede lanzar desde la paleta en reposo: abre el overlay con el progreso', async () => {
    mainAnswers()
    const p = voice().downloadModel()
    expect(voice().phase).toBe('unavailable')
    expect(useUi.getState().overlay).toBe('voice')
    await p
    expect(voice().phase).toBe('idle')
  })

  it('sin permiso de micrófono: unavailable con el mensaje humano', async () => {
    mainAnswers()
    rec.failStart = 'Sin permiso de micrófono'
    void voice().startHold()
    await settle()
    expect(voice().phase).toBe('unavailable')
    expect(voice().reason).toBe('mic')
    expect(voice().detail).toBe('Sin permiso de micrófono')
  })

  it('si whisper falla, lo dice y no escribe nada', async () => {
    mainAnswers()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'whisper:status') return OK
      throw new Error('timeout')
    })
    void voice().startHold()
    await settle()
    vi.setSystemTime(NOW + 1000)
    voice().release()
    await settle()
    expect(voice().phase).toBe('unavailable')
    expect(voice().reason).toBe('failed')
    expect(voice().detail).toBe('timeout')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('elapsedMs', () => {
  it('grabando cuenta desde startedAt; después es la duración del audio', () => {
    expect(elapsedMs({ phase: 'recording', startedAt: NOW, audioMs: 0 }, NOW + 7400)).toBe(7400)
    expect(elapsedMs({ phase: 'transcribing', startedAt: NOW, audioMs: 2000 }, NOW + 9000)).toBe(2000)
    expect(elapsedMs({ phase: 'recording', startedAt: null, audioMs: 0 }, NOW)).toBe(0)
  })
})
