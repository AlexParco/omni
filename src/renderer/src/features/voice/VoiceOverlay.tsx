import { useEffect, useRef, type JSX } from 'react'
import { commands } from '@/core/commands/registry'
import { prettyChord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { useClock } from '@/store/clock'
import { agentOf, sessionStatus, sessionTitle, useSessions, type SessionStatus } from '@/store/sessions'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { elapsedMs, targetIds, useVoice } from '@/store/voice'
import { INSTALL_COMMAND, MODEL_SIZE_LABEL, formatElapsed, unavailableText } from '@/store/voice-logic'
import { Badge } from '@/ui/Badge'
import { Button } from '@/ui/Button'
import { Dot } from '@/ui/Dot'
import { Hint } from '@/ui/Hint'
import { AgentIcon } from '@/ui/icons'
import { Kbd } from '@/ui/Kbd'
import { Row, RowLabel, RowMeta } from '@/ui/Row'
import { TextArea } from '@/ui/TextArea'
import './voice.css'

/** Atajo global vigente de un comando, ya formateado; nada escrito a mano. */
function globalKey(id: string): string | undefined {
  const chord = keymap.chordsFor(id).find((c) => c.layer === 'global')?.chord
  return chord ? prettyChord(chord) : undefined
}

/** Id DOM de una fila de destino, para `aria-activedescendant`. */
const domId = (id: string): string => `voice-target-${id}`

/**
 * Overlay del dictado (ARCHITECTURE §3.22): tarjeta centrada abajo con "Dictando a <sesión>", el
 * nivel del micrófono, el texto y el pie de atajos. Las teclas no se atienden aquí: `useHoldKey`
 * las despacha a los comandos `voice.*` desde `window`, así la terminal conserva el foco DOM mientras
 * se mantiene ⌥Space. Solo la revisión (⇧ al soltar) toma el foco, en su `TextArea`.
 */
export function VoiceOverlay(): JSX.Element {
  const phase = useVoice((s) => s.phase)
  const target = useVoice((s) => s.target)
  const handsFree = useVoice((s) => s.handsFree)
  const choose = useVoice((s) => s.choose)
  const partial = useVoice((s) => s.partial)
  const text = useVoice((s) => s.text)
  const level = useVoice((s) => s.level)
  const startedAt = useVoice((s) => s.startedAt)
  const audioMs = useVoice((s) => s.audioMs)
  const reason = useVoice((s) => s.reason)
  const detail = useVoice((s) => s.detail)
  const downloading = useVoice((s) => s.downloading)
  const copied = useVoice((s) => s.copied)
  const setText = useVoice((s) => s.setText)
  const setTarget = useVoice((s) => s.setTarget)
  // Selectores finos: el overlay se repinta con el nivel del micrófono y no debe depender de todo el store de sesiones.
  const sessionList = useSessions((s) => s.sessions)
  const titles = useSessions((s) => s.titles)
  const agents = useSessions((s) => s.agents)
  const activity = useSessions((s) => s.activity)
  const attention = useSessions((s) => s.attention)
  const busy = useSessions((s) => s.busy)
  const declared = useSessions((s) => s.declared)
  const named = { titles, agents }
  const now = useClock((c) => c.now)
  // Los atajos pintados salen del keymap: se vuelven a pintar cuando el usuario los cambia.
  useSettings((s) => s.settings.keys)
  const prevFocus = useRef<HTMLElement | null>(null)

  // Quién tenía el foco al abrir, para devolvérselo si la revisión lo tomó y el dictado se descartó.
  // Si el overlay desaparece por otra vía (otro overlay encima), el dictado en curso se cancela.
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && !active.closest('.voice')) prevFocus.current = active
    return () => {
      if (useUi.getState().overlay === 'voice') return
      if (useVoice.getState().phase !== 'idle') useVoice.getState().cancel()
      const prev = prevFocus.current
      if (prev?.isConnected && (document.activeElement === document.body || document.activeElement === null)) prev.focus()
    }
  }, [])

  const session = target ? sessionList.find((s) => s.id === target) : undefined
  const title = session ? sessionTitle(named, session) : 'ningún agente'
  const badge = session ? (agentOf(named, session.agent)?.badge ?? session.agent) : null
  const elapsed = formatElapsed(elapsedMs({ phase, startedAt, audioMs }, now))
  const dictateKey = globalKey('voice.dictate') ?? ''
  const chooseKey = globalKey('voice.dictateChoose') ?? ''
  const statusOf = (id: string): SessionStatus => sessionStatus({ activity, attention, busy, declared }, id, now)

  const head = ((): JSX.Element => {
    if (phase === 'unavailable') return <span className="voice__title">Dictar al agente</span>
    if (phase === 'sent')
      return (
        <span className="voice__title">
          Enviado a <b>{title}</b>
        </span>
      )
    if (phase === 'choose') return <span className="voice__title">Elegir destino</span>
    return (
      <span className="voice__title">
        {phase === 'transcribing' ? 'Transcribiendo para' : 'Dictando a'} <b>{title}</b>
      </span>
    )
  })()

  const body = ((): JSX.Element => {
    switch (phase) {
      case 'recording':
        return (
          <div className="voice__body" data-muted={partial ? undefined : true}>
            {partial || (handsFree ? `Manos libres · ${dictateKey} termina y envía` : 'Escuchando')}
          </div>
        )
      case 'transcribing':
        return (
          <div className="voice__body" data-muted>
            Transcribiendo {formatElapsed(audioMs)} de audio
          </div>
        )
      case 'review':
        return (
          <div className="voice__body">
            <TextArea value={text} label="Texto dictado" autoFocus rows={3} onChange={setText} onSubmit={() => void commands.run('voice.send')} onCancel={() => void commands.run('voice.cancel')} />
          </div>
        )
      case 'choose':
        return (
          <div className="voice__body">
            <div>{text}</div>
            <div role="listbox" aria-label="Destino" className="voice__targets" aria-activedescendant={target ? domId(target) : undefined}>
              {targetIds().map((id) => {
                const t = sessionList.find((s) => s.id === id)
                if (!t) return null
                const status = statusOf(id)
                return (
                  <Row key={id} id={domId(id)} level={1} cursor={id === target} status={status} onClick={() => setTarget(id)} onDoubleClick={() => void commands.run('voice.send')}>
                    <Dot status={status} />
                    <AgentIcon agent={t.agent} size={14} />
                    <RowLabel>{sessionTitle(named, t)}</RowLabel>
                    <Badge>{agentOf(named, t.agent)?.badge ?? t.agent}</Badge>
                    <RowMeta>{status === 'question' ? 'pregunta abierta' : status === 'working' ? 'trabajando' : 'listo'}</RowMeta>
                  </Row>
                )
              })}
            </div>
          </div>
        )
      case 'sent':
        return <div className="voice__body">{text}</div>
      case 'unavailable':
        return (
          <div className="voice__body" data-muted={reason === 'model' && downloading !== null ? true : undefined}>
            {reason ? unavailableText(reason, detail) : ''}
            {reason === 'model' && downloading !== null && (
              <div className="voice__progress">
                <div className="voice__level">
                  <div className="voice__level-bar" style={{ width: `${Math.round(downloading * 100)}%` }} />
                </div>
                <span>{Math.round(downloading * 100)}%</span>
              </div>
            )}
          </div>
        )
      default:
        return <div className="voice__body" />
    }
  })()

  const foot = ((): JSX.Element => {
    switch (phase) {
      case 'recording':
        return handsFree ? (
          <>
            <Hint kbd={dictateKey}>terminar y enviar</Hint>
            <Hint kbd={chooseKey}>terminar y revisar</Hint>
            <Hint kbd="Tab">cambiar destino</Hint>
            <Hint kbd="Esc">descartar</Hint>
          </>
        ) : (
          <>
            <Hint kbd="soltar">{choose ? 'elegir destino' : 'enviar'}</Hint>
            <Hint kbd="⇧ soltar">revisar antes de enviar</Hint>
            <Hint kbd="Tab">cambiar destino</Hint>
            <Hint kbd="Esc">descartar</Hint>
          </>
        )
      case 'transcribing':
        return <Hint kbd="Esc">descartar</Hint>
      case 'review':
        return (
          <>
            <Hint kbd="⌘⏎">enviar</Hint>
            <Hint kbd="Tab">cambiar destino</Hint>
            <Hint kbd="Esc">descartar</Hint>
          </>
        )
      case 'choose':
        return (
          <>
            <Hint kbd="↑↓">elegir</Hint>
            <Hint kbd="⏎">enviar</Hint>
            <Hint kbd="Esc">descartar</Hint>
          </>
        )
      case 'unavailable':
        return (
          <>
            {reason === 'binary' && (
              <Button quiet kbd="C" title={`Copiar ${INSTALL_COMMAND}`} onClick={() => void commands.run('voice.copyInstall')}>
                {copied ? 'Copiado' : 'Copiar el comando'}
              </Button>
            )}
            {reason === 'model' && downloading === null && (
              <Button quiet variant="primary" kbd="D" title="Descargar ggml-base.bin a ~/.config/omni/models" onClick={() => void commands.run('voice.downloadModel')}>
                Descargar modelo ({MODEL_SIZE_LABEL})
              </Button>
            )}
            <Hint kbd="Esc">cerrar</Hint>
          </>
        )
      default:
        return <></>
    }
  })()

  return (
    <div className="voice" role="dialog" aria-modal="false" aria-label="Dictado" data-phase={phase} data-focus="list" onMouseDown={(e) => e.stopPropagation()}>
      <div className="voice__head">
        {phase === 'recording' && <Dot status="working" title={handsFree ? 'Grabando, manos libres' : 'Grabando'} />}
        {phase === 'sent' && <Dot status="idle" title="Enviado" />}
        {phase === 'unavailable' && <Dot status="question" title="No se puede dictar" />}
        {head}
        {badge && phase !== 'unavailable' && <Badge>{badge}</Badge>}
        {handsFree && phase === 'recording' && <Badge tone="mark">manos libres</Badge>}
        {(phase === 'recording' || phase === 'transcribing') && <span className="voice__time">{elapsed}</span>}
        {phase === 'unavailable' && dictateKey && <Kbd>{dictateKey}</Kbd>}
      </div>
      {(phase === 'recording' || phase === 'transcribing') && (
        <div className="voice__level" aria-hidden="true">
          <div className="voice__level-bar" style={{ width: `${Math.min(100, Math.round(level * 300))}%` }} />
        </div>
      )}
      {body}
      <div className="voice__foot">{foot}</div>
      <div className="voice__note">whisper local · nada sale de la máquina</div>
    </div>
  )
}
