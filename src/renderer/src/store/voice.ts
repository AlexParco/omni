import { create } from 'zustand'
import type { WhisperStatus } from '@shared/types'
import { pcmDurationMs } from '@/core/audio/pcm'
import { createRecorder, type Recorder } from '@/core/audio/recorder'
import { omni } from '@/lib/omni'
import { getTerminal } from '@/panes/terminal/terminal-host'
import { focusedSessionId, useLayout } from './layout'
import { writeToSession } from './session-write'
import { sessionStatus, useSessions, type SessionStatus } from './sessions'
import { useUi } from './ui'
import { INSTALL_COMMAND, MIN_AUDIO_MS, SENT_MS, TAP_MS, cleanTranscript, defaultTarget, dictationTargets, isTap, nextTarget, unavailableReason, type UnavailableReason } from './voice-logic'

/**
 * Dictado al agente (ARCHITECTURE §3.22). Máquina de estados:
 * `idle → recording → transcribing → (review | choose | sent) → idle`, con `unavailable` cuando falta
 * whisper, el modelo, el micrófono o un destino. Mientras no está en `idle` el overlay `voice` está
 * abierto; las teclas las despacha `features/voice/useHoldKey.ts` a los comandos `voice.*`.
 */
export type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'review' | 'choose' | 'sent' | 'unavailable'

interface VoiceState {
  phase: VoicePhase
  /** Sesión destino. Por defecto el pane con foco si es una terminal; `Tab` rota con `rankTargets`. */
  target: string | null
  /** Graba hasta otra pulsación de ⌥Space (dos toques rápidos). */
  handsFree: boolean
  /** ⌥⇧Space: al soltar, elegir el destino en una lista antes de enviar. */
  choose: boolean
  /** Transcripción parcial. Siempre vacía: whisper no da parciales; el overlay muestra el tiempo. */
  partial: string
  /** Texto transcrito (revisión o elección de destino). */
  text: string
  /** Nivel del micrófono (RMS 0–1), para la barra del overlay. */
  level: number
  /** Cuándo empezó la pulsación; el overlay pinta el tiempo desde aquí. */
  startedAt: number | null
  /** Duración del audio enviado a whisper, para mostrarla mientras transcribe. */
  audioMs: number
  status: WhisperStatus | null
  reason: UnavailableReason | null
  /** Detalle del motivo (mensaje del micrófono o de la transcripción). */
  detail: string | null
  /** Progreso de la descarga del modelo (0–1) o `null` si no está bajando. */
  downloading: number | null
  /** `C` copió el comando de instalación hace un instante. */
  copied: boolean
  /** Primera lectura de `whisper:status` (al abrir); luego se refresca en cada dictado. */
  refreshStatus(): Promise<WhisperStatus>
  /** ⌥Space apretado (o ⌥⇧Space con `choose`). Repetido mientras graba: segundo toque o fin de manos libres. */
  startHold(opts?: { choose?: boolean; handsFree?: boolean }): Promise<void>
  /** ⌥Space soltado. `review` (⇧) deja el texto en el textarea antes de enviar. En manos libres no hace nada. */
  release(opts?: { review?: boolean }): void
  /** Termina la grabación venga de donde venga: fin de manos libres (otra pulsación) o desde la paleta. */
  stop(opts?: { review?: boolean }): void
  /** Envía el texto revisado (⌘⏎) o el destino elegido (⏎). */
  send(): void
  setText(text: string): void
  nextTarget(delta: 1 | -1): void
  setTarget(id: string): void
  downloadModel(): Promise<void>
  copyInstall(): Promise<void>
  cancel(): void
}

/* ---------- destinos ---------- */

const statusOf = (id: string): SessionStatus => sessionStatus(useSessions.getState(), id)
const focusedId = (): string | null => {
  const ws = useSessions.getState().currentWorkspaceId
  return ws ? focusedSessionId(useLayout.getState(), ws) : null
}
/** Ids de destino en el orden de "Enviar al agente". */
export function targetIds(): string[] {
  const s = useSessions.getState()
  return dictationTargets(s.sessions, s.currentWorkspaceId, statusOf, focusedId()).map((x) => x.id)
}
function pickDefaultTarget(): string | null {
  const s = useSessions.getState()
  return defaultTarget(s.sessions, s.currentWorkspaceId, statusOf, focusedId())
}

/** Lleva el teclado a la terminal del destino tras revisar o elegir (el textarea tenía el foco). */
function focusTarget(id: string): void {
  useLayout.getState().focusSession(id)
  useSessions.getState().syncCursor(id)
  useUi.getState().setFocus('terminal')
  getTerminal(id)?.focus()
}

/* ---------- grabación ---------- */

let recorder: Recorder | null = null
let recorderFactory: () => Recorder = createRecorder

/** Sustituye la grabadora (e2e sin micrófono, tests). `null` vuelve a la real. */
export function setRecorderFactory(factory: (() => Recorder) | null): void {
  recorderFactory = factory ?? createRecorder
}
/** La tecla sigue apretada (en manos libres no importa). */
let held = false
/** Primer toque corto: espera `TAP_MS` por el segundo antes de dar por terminada la frase. */
let tapTimer: ReturnType<typeof setTimeout> | null = null
let sentTimer: ReturnType<typeof setTimeout> | null = null
/** Cada dictado tiene un número: lo asíncrono comprueba que sigue siendo el vigente antes de tocar el estado. */
let run = 0
/** El usuario soltó antes de que el micrófono estuviera listo: se termina en cuanto arranque. */
let pendingRelease: { review: boolean } | null = null

function clearTimers(): void {
  if (tapTimer) clearTimeout(tapTimer)
  tapTimer = null
  if (sentTimer) clearTimeout(sentTimer)
  sentTimer = null
}

function openOverlay(): void {
  if (useUi.getState().overlay !== 'voice') useUi.getState().openOverlay('voice')
}
function closeOverlay(): void {
  if (useUi.getState().overlay === 'voice') useUi.getState().closeOverlay()
}

export const useVoice = create<VoiceState>((set, get) => {
  /** Vuelve a reposo soltando el micrófono y cerrando el overlay. */
  const reset = (): void => {
    run++
    clearTimers()
    recorder?.cancel()
    recorder = null
    held = false
    pendingRelease = null
    set({ phase: 'idle', handsFree: false, choose: false, partial: '', text: '', level: 0, startedAt: null, audioMs: 0, reason: null, detail: null, copied: false })
    closeOverlay()
  }

  const unavailable = (reason: UnavailableReason, detail: string | null = null): void => {
    clearTimers()
    recorder?.cancel()
    recorder = null
    held = false
    pendingRelease = null
    set({ phase: 'unavailable', reason, detail, level: 0, handsFree: false })
    openOverlay()
  }

  /** Envía el texto al destino y muestra "Enviado" un instante. */
  const deliver = (text: string, refocus: boolean): void => {
    const { target } = get()
    if (!target || !text) return reset()
    writeToSession(target, text, true)
    if (refocus) focusTarget(target)
    set({ phase: 'sent', text })
    sentTimer = setTimeout(reset, SENT_MS)
  }

  /** Para el micrófono, transcribe y decide qué hacer con el texto. */
  const finish = async (review: boolean): Promise<void> => {
    const current = run
    const rec = recorder
    if (!rec || get().phase !== 'recording') return
    clearTimers()
    held = false
    const { choose } = get()
    set({ phase: 'transcribing', level: 0 })
    let pcm: ArrayBuffer
    try {
      pcm = await rec.stop()
    } catch (err) {
      if (current !== run) return
      return unavailable('mic', err instanceof Error ? err.message : null)
    }
    recorder = null
    if (current !== run) return
    const audioMs = pcmDurationMs(pcm)
    // Un toque sin frase (o el micrófono recién abierto): no hay nada que transcribir.
    if (audioMs < MIN_AUDIO_MS) return reset()
    set({ audioMs })
    let text: string
    try {
      text = cleanTranscript((await omni.invoke('whisper:transcribe', pcm)).text)
    } catch (err) {
      if (current !== run) return
      return unavailable('failed', err instanceof Error ? err.message : null)
    }
    if (current !== run) return
    if (!text) return reset()
    if (review) set({ phase: 'review', text })
    else if (choose) set({ phase: 'choose', text })
    else deliver(text, false)
  }

  return {
    phase: 'idle',
    target: null,
    handsFree: false,
    choose: false,
    partial: '',
    text: '',
    level: 0,
    startedAt: null,
    audioMs: 0,
    status: null,
    reason: null,
    detail: null,
    downloading: null,
    copied: false,

    async refreshStatus() {
      const status = await omni.invoke('whisper:status')
      set({ status })
      return status
    },

    async startHold(opts = {}) {
      const s = get()
      if (s.phase === 'recording') {
        // Segunda pulsación: cierra manos libres, o convierte el primer toque en manos libres.
        if (s.handsFree) return get().stop({ review: false })
        if (tapTimer) {
          clearTimeout(tapTimer)
          tapTimer = null
          held = true
          set({ handsFree: true })
        }
        return
      }
      if (s.phase === 'transcribing' || s.phase === 'review' || s.phase === 'choose') return
      // Desde `sent` o `unavailable` se vuelve a empezar: tras instalar whisper, la misma tecla reintenta.
      if (s.phase !== 'idle') reset()
      const current = ++run
      held = true
      pendingRelease = null
      const target = pickDefaultTarget()
      set({ phase: 'recording', target, choose: opts.choose === true, handsFree: opts.handsFree === true, partial: '', text: '', level: 0, startedAt: Date.now(), audioMs: 0, reason: null, detail: null })
      openOverlay()
      let status: WhisperStatus | null = null
      try {
        status = await get().refreshStatus()
      } catch {
        status = null
      }
      if (current !== run || get().phase !== 'recording') return
      const missing = unavailableReason(status)
      if (missing) return unavailable(missing)
      if (!target) return unavailable('target')
      const rec = recorderFactory()
      recorder = rec
      try {
        await rec.start((level) => {
          if (current === run && get().phase === 'recording') set({ level })
        })
      } catch (err) {
        if (current !== run) return
        return unavailable('mic', err instanceof Error ? err.message : null)
      }
      if (current !== run || get().phase !== 'recording') return
      if (pendingRelease) {
        // Soltó (o paró manos libres) antes de que el micrófono estuviera listo: se termina ya.
        const { review } = pendingRelease
        pendingRelease = null
        void finish(review)
      }
    },

    release(opts = {}) {
      const s = get()
      const review = opts.review === true
      if (s.phase !== 'recording') return
      // En manos libres el keyup no cuenta; termina la siguiente pulsación (`startHold` → `stop`).
      if (s.handsFree) return
      if (!held) return
      held = false
      if (!recorder) {
        // El micrófono aún no arrancó: se termina en cuanto esté listo.
        pendingRelease = { review }
        return
      }
      const heldMs = Date.now() - (s.startedAt ?? Date.now())
      if (isTap(heldMs) && !tapTimer) {
        // Un toque: espera el segundo (manos libres); si no llega, la frase corta se transcribe igual.
        tapTimer = setTimeout(() => {
          tapTimer = null
          void finish(review)
        }, TAP_MS)
        return
      }
      void finish(review)
    },

    stop(opts = {}) {
      if (get().phase !== 'recording') return
      if (!recorder) {
        pendingRelease = { review: opts.review === true }
        return
      }
      void finish(opts.review === true)
    },

    send() {
      const s = get()
      if (s.phase === 'review' || s.phase === 'choose') deliver(cleanTranscript(s.text), true)
    },

    setText: (text) => set({ text }),

    nextTarget(delta) {
      const s = get()
      if (s.phase !== 'recording' && s.phase !== 'review' && s.phase !== 'choose') return
      const next = nextTarget(targetIds(), s.target, delta)
      if (next) set({ target: next })
    },

    setTarget(id) {
      if (targetIds().includes(id)) set({ target: id })
    },

    async downloadModel() {
      if (get().downloading !== null) return
      if (get().phase === 'idle' || get().phase === 'sent') {
        if (get().phase === 'sent') reset()
        set({ phase: 'unavailable', reason: 'model', detail: null })
        openOverlay()
      }
      set({ downloading: 0 })
      const off = omni.on('whisper:progress', (fraction) => set({ downloading: fraction }))
      try {
        const status = await omni.invoke('whisper:downloadModel')
        set({ status, downloading: null })
        if (get().phase !== 'unavailable') return
        const missing = unavailableReason(status)
        if (missing) set({ reason: missing })
        else reset()
      } catch (err) {
        set({ downloading: null, phase: 'unavailable', reason: 'failed', detail: err instanceof Error ? err.message : 'no se pudo descargar el modelo' })
      } finally {
        off()
      }
    },

    async copyInstall() {
      try {
        await navigator.clipboard.writeText(INSTALL_COMMAND)
        set({ copied: true })
        setTimeout(() => set({ copied: false }), 1500)
      } catch {
        /* sin portapapeles (tests): el comando sigue a la vista */
      }
    },

    cancel: reset
  }
})

/** Cuánto lleva grabando (o grabó), para el overlay. */
export function elapsedMs(s: Pick<VoiceState, 'phase' | 'startedAt' | 'audioMs'>, now: number): number {
  if (s.phase === 'recording') return s.startedAt === null ? 0 : now - s.startedAt
  return s.audioMs
}
