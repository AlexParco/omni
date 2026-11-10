import { useEffect } from 'react'
import { commands } from '@/core/commands/registry'
import { chordOf } from '@/core/keys/chord'
import { useUi } from '@/store/ui'
import { useVoice } from '@/store/voice'
import { holdFocusLost, holdKeyDown, holdKeyUp, type HoldAction, type HoldKey, type HoldState } from './hold-key'

/** El evento cayó en el textarea de la revisión: ahí las teclas sueltas son texto y ⌘⏎/Esc los atiende el `TextArea`. */
const inReviewText = (e: KeyboardEvent): boolean => e.target instanceof HTMLElement && e.target.closest('.voice textarea') !== null

const keyOf = (e: KeyboardEvent): HoldKey => ({ chord: chordOf(e), key: e.key, code: e.code, shiftKey: e.shiftKey, repeat: e.repeat, defaultPrevented: e.defaultPrevented, inReviewText: inReviewText(e) })
const stateOf = (): HoldState => {
  const { phase, handsFree, choose } = useVoice.getState()
  return { phase, handsFree, choose, overlayOpen: useUi.getState().overlay === 'voice' }
}

/**
 * Mantener y soltar ⌥Space (ARCHITECTURE §3.22). La primera pulsación la resuelve el keymap como
 * cualquier atajo (`voice.dictate` / `voice.dictateChoose`); desde ahí el overlay `voice` está abierto
 * y `useKeyboard` se aparta, así que este hook atiende en `window` (fase de captura, antes que xterm)
 * y decide con `hold-key.ts`: traga los keydown repetidos de ⌥Space, manda otra pulsación a
 * `voice.dictate`/`voice.review`, el keyup de Space o ⌥ a `voice.send`/`voice.review`, Tab/Esc/⌘⏎/↑↓/⏎/C/D a
 * sus comandos, y mientras graba o transcribe traga el resto de teclas sueltas para que nada llegue a
 * la terminal. Si la ventana pierde el foco con la tecla mantenida (`blur`, `visibilitychange`), el
 * keyup no va a llegar: se suelta y envía. Siempre montado (en `App`): el keyup puede llegar antes de
 * que el overlay haya pintado.
 */
export function useHoldKey(): void {
  useEffect(() => {
    const apply = (action: HoldAction, e?: Event): void => {
      if (action.kind === 'pass') return
      e?.preventDefault()
      e?.stopPropagation()
      if (action.kind === 'run') void commands.run(action.id)
    }
    const onKeyDown = (e: KeyboardEvent): void => apply(holdKeyDown(keyOf(e), stateOf()), e)
    const onKeyUp = (e: KeyboardEvent): void => apply(holdKeyUp(keyOf(e), stateOf()), e)
    const onBlur = (): void => apply(holdFocusLost(stateOf()))
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') apply(holdFocusLost(stateOf()))
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}
