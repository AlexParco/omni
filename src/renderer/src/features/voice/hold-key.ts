import type { VoicePhase } from '@/store/voice'

/**
 * Decisiones de teclado del dictado (ARCHITECTURE §3.22), puras: `useHoldKey` lee el evento y el
 * estado, pregunta aquí y ejecuta. Sin DOM ni stores, para testearse en Node.
 */

/** Lo que el hook extrae de un `KeyboardEvent`. */
export interface HoldKey {
  /** Chord canónico (`chordOf`). */
  chord: string
  key: string
  code: string
  shiftKey: boolean
  repeat: boolean
  /** `useKeyboard` ya corrió el comando de esta tecla (la pulsación que abrió el dictado). */
  defaultPrevented: boolean
  /** La tecla cayó en el textarea de la revisión: ahí las teclas sueltas son texto. */
  inReviewText: boolean
}

export interface HoldState {
  phase: VoicePhase
  handsFree: boolean
  /** El dictado empezó con ⌥⇧Space: al soltar se elige destino, y ⇧ en el keyup ya no significa revisar. */
  choose: boolean
  /** `ui.overlay === 'voice'`. */
  overlayOpen: boolean
}

/** `run` ejecuta un comando y cancela el evento; `swallow` solo lo cancela; `pass` lo deja seguir. */
export type HoldAction = { kind: 'run'; id: string } | { kind: 'swallow' } | { kind: 'pass' }

const run = (id: string): HoldAction => ({ kind: 'run', id })
const SWALLOW: HoldAction = { kind: 'swallow' }
const PASS: HoldAction = { kind: 'pass' }

/** La tecla es ⌥Space (con o sin ⇧), por tecla física: con ⌥ macOS entrega un espacio duro. */
export const isHoldKey = (e: Pick<HoldKey, 'chord' | 'code' | 'key'>): boolean => {
  const parts = e.chord.split('+')
  return parts.includes('alt') && (e.code === 'Space' || e.key === ' ' || e.key === ' ' || parts[parts.length - 1] === 'space')
}

/** Space o ⌥ soltados: cualquiera de las dos termina la pulsación (⌥ suele soltarse después de Space). */
const isReleaseKey = (e: Pick<HoldKey, 'code' | 'key'>): boolean => e.code === 'Space' || e.key === ' ' || e.key === ' ' || e.key === 'Alt'

/** Mientras se graba o transcribe, nada suelto llega a la terminal; en `sent`, `unavailable`, `review` y `choose` el resto de teclas sigue su camino. */
const swallowsLooseKeys = (phase: VoicePhase): boolean => phase === 'recording' || phase === 'transcribing'

export function holdKeyDown(e: HoldKey, s: HoldState): HoldAction {
  if (s.phase === 'idle' || !s.overlayOpen) return PASS
  if (isHoldKey(e)) {
    // Repetición del keydown mientras se mantiene, o la pulsación que abrió el dictado (ya corrida por el keymap).
    if (e.repeat || e.defaultPrevented) return SWALLOW
    // Otra pulsación: segundo toque (manos libres) o fin de manos libres; con ⇧ en manos libres, termina revisando.
    return run(e.shiftKey && s.handsFree ? 'voice.review' : 'voice.dictate')
  }
  if (e.chord === 'tab') return run('voice.nextTarget')
  if (e.chord === 'shift+tab') return run('voice.prevTarget')
  if (e.inReviewText) return PASS
  if (e.chord === 'escape') return run('voice.cancel')
  if (e.chord === 'cmd+enter' || (s.phase === 'choose' && e.chord === 'enter')) return run('voice.send')
  if (s.phase === 'choose' && (e.chord === 'j' || e.chord === 'down')) return run('voice.nextTarget')
  if (s.phase === 'choose' && (e.chord === 'k' || e.chord === 'up')) return run('voice.prevTarget')
  if (s.phase === 'unavailable' && e.chord === 'c') return run('voice.copyInstall')
  if (s.phase === 'unavailable' && e.chord === 'd') return run('voice.downloadModel')
  // ⌘ sigue su camino siempre (copiar en xterm, etc.).
  if (swallowsLooseKeys(s.phase) && !e.chord.split('+').includes('cmd')) return SWALLOW
  return PASS
}

/**
 * Keyup de Space o ⌥ con la tecla mantenida: envía, o revisa si ⇧ está apretado. Con `choose` (el
 * dictado empezó con ⌥⇧Space) ⇧ sigue apretado al soltar y no significa revisar: se envía (→ elegir destino).
 */
export function holdKeyUp(e: Pick<HoldKey, 'code' | 'key' | 'shiftKey'>, s: Pick<HoldState, 'phase' | 'handsFree' | 'choose'>): HoldAction {
  if (s.phase !== 'recording' || s.handsFree) return PASS
  if (!isReleaseKey(e)) return PASS
  return run(e.shiftKey && !s.choose ? 'voice.review' : 'voice.send')
}

/** La ventana perdió el foco o se ocultó con la tecla mantenida: el keyup no va a llegar, así que se suelta y envía. */
export function holdFocusLost(s: Pick<HoldState, 'phase' | 'handsFree'>): HoldAction {
  if (s.phase !== 'recording' || s.handsFree) return PASS
  return run('voice.send')
}
