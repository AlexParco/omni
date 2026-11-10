import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { CaptureAttachments, SessionInfo } from '@shared/types'
import { chordOf } from '@/core/keys/chord'
import { omni } from '@/lib/omni'
import { getTerminal } from '@/panes/terminal/terminal-host'
import { liveBrowserId, useBrowser } from '@/store/browser'
import { captureTarget, rankTargets } from '@/store/capture-target'
import { useClock } from '@/store/clock'
import { useLayout } from '@/store/layout'
import { agentOf, sessionStatus, sessionTitle, useSessions, type SessionStatus } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { Badge } from '@/ui/Badge'
import { Button } from '@/ui/Button'
import { Check } from '@/ui/Check'
import { Dialog } from '@/ui/Dialog'
import { Dot } from '@/ui/Dot'
import { Hint } from '@/ui/Hint'
import { AgentIcon } from '@/ui/icons'
import { Kbd } from '@/ui/Kbd'
import { Row, RowLabel, RowMeta } from '@/ui/Row'
import { describeCapture, formatCapturePayload } from './format'
import './send-capture.css'

/** Adjuntos en el orden de sus teclas `⌘1`…`⌘5`. */
const ATTACHMENTS: Array<{ key: keyof CaptureAttachments; label: string; needsElement?: boolean }> = [
  { key: 'image', label: 'Imagen recortada · 2x' },
  { key: 'html', label: 'HTML del elemento', needsElement: true },
  { key: 'css', label: 'CSS computado', needsElement: true },
  { key: 'context', label: 'URL y viewport' },
  { key: 'console', label: 'Últimas 20 líneas de consola' }
]

/** Tiempo desde la última actividad, con segundos (41s, 2m, 3h). */
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

/** Lleva el teclado a la terminal de una sesión (tab, pane, cursor y foco DOM), soltando la página de un navegador si lo tenía. */
function focusSessionTerminal(id: string): void {
  const live = liveBrowserId(useBrowser.getState())
  if (live) useBrowser.getState().blur(live)
  useLayout.getState().focusSession(id)
  useSessions.getState().syncCursor(id)
  useUi.getState().setFocus('terminal')
  getTerminal(id)?.focus()
}

/**
 * Overlay "Enviar al agente" (ARCHITECTURE §3.9): miniatura y adjuntos a la izquierda, destino y
 * mensaje a la derecha. El textarea tiene el foco al abrir, así que las teclas sueltas escriben; los
 * atajos del diálogo llevan ⌘: `⌘1`…`⌘5` alternan adjuntos, `⌘J` `⌘K` mueven el destino, `⌘N` manda
 * a un agente nuevo, `⌘⏎` envía, `⌘C` sin selección en el textarea copia el paquete como texto,
 * `⌘⇧C` copia solo la imagen (para pegarla donde sea) y cierra, Esc cierra.
 * Con el foco fuera del textarea (clic en una fila) también valen `1–5`, `J K`, `↑↓` y `N`.
 */
export function SendCapture(): JSX.Element | null {
  const payload = useBrowser((s) => s.sendPayload)
  const kind = useBrowser((s) => s.sendKind)
  const closeSendDialog = useBrowser((s) => s.closeSendDialog)
  const sendToSession = useBrowser((s) => s.sendToSession)
  const sendToNewAgent = useBrowser((s) => s.sendToNewAgent)
  const notify = useBrowser((s) => s.notify)
  const recentFocus = useBrowser((s) => s.recentFocus)
  const sessions = useSessions()
  const tabs = useLayout((s) => s.tabs)
  const now = useClock((c) => c.now)
  const [attachments, setAttachments] = useState<CaptureAttachments>(() => ({ image: true, html: payload?.element !== undefined, css: false, context: true, console: false }))
  const [message, setMessage] = useState('')
  // El destino elegido se guarda por id, no por posición: la lista se reordena mientras el diálogo
  // está abierto (un shell que recibe salida cambia de estado) y un índice mandaría a otro agente.
  const [cursorId, setCursorId] = useState<string | null>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textRef.current?.focus()
  }, [])

  if (!payload) return null
  const browser = sessions.sessions.find((x) => x.id === payload.browserId)
  const statusOf = (id: string): SessionStatus => sessionStatus(sessions, id, now)
  const preferred = captureTarget(payload.browserId, sessions.sessions, tabs, recentFocus)
  const targets = browser ? rankTargets(sessions.sessions, browser.workspaceId, statusOf, preferred) : []
  /** Última fila: nuevo agente con esta captura. */
  const rows = targets.length + 1
  const index = cursorId === 'new' ? targets.length : Math.max(0, targets.findIndex((t) => t.id === cursorId))

  const text = (): string => formatCapturePayload(payload, attachments, message)
  const toggle = (i: number): void => {
    const item = ATTACHMENTS[i]
    if (!item || (item.needsElement && !payload.element)) return
    setAttachments((a) => ({ ...a, [item.key]: !a[item.key] }))
  }
  const pick = (id: string): void => {
    setCursorId(id)
    // El clic en una fila no debe dejar el teclado fuera del texto: ⌘⏎ y escribir siguen funcionando.
    textRef.current?.focus()
  }
  const move = (delta: number): void => {
    const next = (index + delta + rows) % rows
    setCursorId(next === targets.length ? 'new' : (targets[next]?.id ?? null))
  }

  const sendTo = (target: SessionInfo): void => {
    const body = text()
    if (!body) return
    sendToSession(target.id, body)
    closeSendDialog()
    focusSessionTerminal(target.id)
    notify(payload.browserId, `Enviado a ${agentOf(sessions, target.agent)?.name ?? target.agent}`)
  }
  const sendToNew = async (): Promise<void> => {
    const body = text()
    if (!body) return
    closeSendDialog()
    const info = await sendToNewAgent(payload.browserId, body)
    if (!info) return
    focusSessionTerminal(info.id)
    notify(payload.browserId, `Enviado a ${agentOf(sessions, info.agent)?.name ?? info.agent} nuevo`)
  }
  const send = (): void => {
    if (index === targets.length) void sendToNew()
    else sendTo(targets[index])
  }
  const copy = async (): Promise<void> => {
    const body = text()
    if (!body) return
    // El portapapeles es uno: el texto reemplaza la imagen que main dejó al capturar (queda en disco).
    await navigator.clipboard.writeText(body)
    notify(payload.browserId, 'Texto copiado al portapapeles')
  }

  const copyImage = async (): Promise<void> => {
    try {
      await omni.invoke('capture:copyImage', payload.capture.path)
    } catch {
      notify(payload.browserId, 'No se pudo copiar la imagen')
      return
    }
    closeSendDialog()
    notify(payload.browserId, 'Imagen copiada al portapapeles')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const chord = chordOf(e.nativeEvent)
    const inText = e.target === textRef.current
    const act = (fn: () => void): void => {
      e.preventDefault()
      e.stopPropagation()
      fn()
    }
    if (chord === 'cmd+enter') return act(send)
    if (chord === 'shift+cmd+c') return act(() => void copyImage())
    if (chord === 'cmd+c') {
      // Con algo seleccionado (en el textarea o en cualquier texto del diálogo) ⌘C es el copiar nativo.
      const ta = textRef.current
      const selected = (inText && ta && ta.selectionStart !== ta.selectionEnd) || (window.getSelection()?.toString() ?? '') !== ''
      if (selected) return
      return act(() => void copy())
    }
    const digit = /^(cmd\+)?([1-5])$/.exec(chord)
    if (digit && (digit[1] || !inText)) return act(() => toggle(Number(digit[2]) - 1))
    if (chord === 'cmd+j' || (!inText && (chord === 'j' || chord === 'down'))) return act(() => move(1))
    if (chord === 'cmd+k' || (!inText && (chord === 'k' || chord === 'up'))) return act(() => move(-1))
    if (chord === 'cmd+n' || (!inText && chord === 'n')) return act(() => void sendToNew())
  }

  return (
    <Dialog
      wide
      title="Enviar al agente"
      subtitle={describeCapture(payload, kind)}
      onClose={closeSendDialog}
      footer={
        <>
          <Hint kbd="⌘J ⌘K">destino</Hint>
          <Hint kbd="⌘1–5">adjuntos</Hint>
          <Hint kbd="⌘⏎">enviar</Hint>
          <Hint kbd="⌘C">copiar texto</Hint>
          <Hint kbd="⌘⇧C">copiar imagen</Hint>
          <Hint kbd="Esc">cerrar</Hint>
          <span className="send__note">Claude Code, Codex y OpenCode aceptan rutas de imagen en el prompt.</span>
        </>
      }
    >
      <div className="send" onKeyDown={onKeyDown}>
        <div className="send__left">
          <img className="send__thumb" src={payload.thumb} alt="Captura" />
          <div>
            <div className="send__label">
              Adjuntar <Kbd>⌘1–5</Kbd>
            </div>
            <div role="group" aria-label="Adjuntos" className="send__attach">
              {ATTACHMENTS.map((a, i) => (
                <Check key={a.key} on={attachments[a.key]} kbd={`⌘${i + 1}`} disabled={a.needsElement && !payload.element} onClick={() => toggle(i)}>
                  {a.label}
                </Check>
              ))}
            </div>
          </div>
        </div>
        <div className="send__right">
          <div>
            <div className="send__label">
              Destino <Kbd>⌘J ⌘K</Kbd>
            </div>
            <div role="listbox" aria-label="Destino" className="send__targets">
              {targets.map((t, i) => {
                const status = statusOf(t.id)
                const last = sessions.activity[t.id]?.lastOutput ?? t.createdAt
                const meta = status === 'question' ? 'pregunta abierta' : `${status === 'working' ? 'trabajando' : 'listo'} · ${ago(last, now)}`
                return (
                  <Row key={t.id} id={`send-target-${t.id}`} level={1} active={i === index} status={status} onClick={() => pick(t.id)} onDoubleClick={() => sendTo(t)}>
                    <Dot status={status} />
                    <AgentIcon agent={t.agent} size={14} />
                    <RowLabel>{sessionTitle(sessions, t)}</RowLabel>
                    <Badge>{agentOf(sessions, t.agent)?.badge ?? t.agent}</Badge>
                    <RowMeta>{meta}</RowMeta>
                  </Row>
                )
              })}
              <Row id="send-target-new" level={1} active={index === targets.length} onClick={() => pick('new')} onDoubleClick={() => void sendToNew()}>
                <Kbd>⌘N</Kbd>
                <AgentIcon agent="claude" size={14} />
                <RowLabel>Nuevo agente con esta captura</RowLabel>
              </Row>
            </div>
          </div>
          <div className="send__message">
            <div className="send__label">Mensaje</div>
            <textarea ref={textRef} className="send__text" rows={4} value={message} placeholder="Qué quieres que haga con esto" spellCheck={false} onChange={(e) => setMessage(e.target.value)} />
          </div>
          <div className="send__actions">
            <Button kbd="⌘C" title="Copiar el mensaje y los adjuntos como texto" onClick={() => void copy()}>
              Copiar texto
            </Button>
            <Button kbd="⌘⇧C" title="Copiar solo la imagen para pegarla donde quieras" onClick={() => void copyImage()}>
              Copiar imagen
            </Button>
            <Button variant="primary" kbd="⌘⏎" title="Enviar al destino elegido" onClick={send}>
              Enviar
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
