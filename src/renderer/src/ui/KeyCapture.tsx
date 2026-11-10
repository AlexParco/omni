import { useEffect, useState, type JSX } from 'react'
import { chordOf, isModifierOnly, prettyChord, type Chord } from '@/core/keys/chord'
import { Kbd } from './Kbd'
import './key-capture.css'

interface Props {
  value: Chord
  /** Devuelve una razón si el chord no sirve; `null` si es válido. */
  validate?(chord: Chord): string | null
  /** Cómo pintar el chord; por defecto `prettyChord` (⌘T). Tras un prefijo conviene `prettyKey` (caja exacta). */
  format?(chord: Chord): string
  onChange(chord: Chord): void
}

/**
 * Botón que muestra un atajo y, al activarlo, captura la siguiente combinación de teclas.
 * Mientras captura, ninguna tecla llega a la app (se escucha en captura y se detiene la
 * propagación); Esc cancela. Estado por `data-*`: `data-capturing`, `data-error`.
 */
export function KeyCapture({ value, validate, format = prettyChord, onChange }: Props): JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!capturing) return
    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const chord = chordOf(e)
      if (isModifierOnly(chord)) return
      if (chord === 'escape') {
        setCapturing(false)
        return
      }
      const reason = validate?.(chord) ?? null
      if (reason) {
        setError(reason)
        return
      }
      setError(null)
      setCapturing(false)
      onChange(chord)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturing, validate, onChange])

  return (
    <span className="keycap" data-capturing={capturing || undefined} data-error={error ? true : undefined}>
      <button
        type="button"
        className="keycap__button"
        aria-live="polite"
        onClick={() => {
          setError(null)
          setCapturing((c) => !c)
        }}
      >
        {capturing ? 'Presiona la combinación' : value ? <Kbd>{format(value)}</Kbd> : 'Sin atajo'}
      </button>
      {error && <span className="keycap__error">{error}</span>}
    </span>
  )
}
