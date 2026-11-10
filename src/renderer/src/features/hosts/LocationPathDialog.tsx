import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { useControl } from '@/store/control'
import { humanError } from '@/store/control-logic'
import { hostStateLabel, useHosts } from '@/store/hosts'
import { projectOf, useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { Button } from '@/ui/Button'
import { Dialog } from '@/ui/Dialog'
import { Hint } from '@/ui/Hint'
import { Folder, ICON_SM } from '@/ui/icons'
import { Row, RowLabel, RowMeta } from '@/ui/Row'
import { TextInput } from '@/ui/TextInput'
import './hosts.css'

/** Espera tras teclear antes de pedir sugerencias (en un servidor cada pedido es un viaje por SSH). */
const SUGGEST_DELAY_MS = 150

/**
 * Segundo paso: la carpeta. Se escribe la ruta (`~/…` o absoluta) con sugerencias de carpetas del
 * lugar elegido: ↑↓ eligen, Tab completa, ⏎ abre lo escrito (o la sugerencia elegida). En un
 * servidor muestra el estado de la conexión y su error si no conecta.
 */
export function LocationPathDialog(): JSX.Element | null {
  const place = useHosts((s) => s.place)
  const target = useHosts((s) => s.target)
  const status = useHosts((s) => (place?.host ? s.status[place.host] : undefined))
  const hostName = useHosts((s) => (place?.host ? s.nameOf(place.host) : null))
  const projects = useSessions((s) => s.projects)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const [path, setPath] = useState('~/')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [index, setIndex] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const connected = !place?.host || status?.state === 'connected'
  // `~` del lugar elegido: el del Mac o el del servidor (lo trae el preflight).
  const home = place?.host ? (status?.home ?? null) : (useSessions.getState().workspaces.find((w) => !w.host)?.path.match(/^\/Users\/[^/]+/)?.[0] ?? null)

  useEffect(() => {
    if (!place || !connected) return
    const mine = ++seq.current
    const timer = window.setTimeout(() => {
      useHosts
        .getState()
        .suggest(place, path)
        .then((list) => {
          if (seq.current !== mine) return
          setSuggestions(list)
          setIndex(-1)
        })
        .catch(() => seq.current === mine && setSuggestions([]))
    }, SUGGEST_DELAY_MS)
    return () => clearTimeout(timer)
  }, [place, path, connected])

  if (!place || !target) return null
  const project = target.mode === 'addTo' ? projectOf({ projects }, target.projectId) : undefined
  const where = place.host ? `${hostName} · ${hostStateLabel(status)}` : 'este Mac'

  const submit = async (value: string): Promise<void> => {
    const chosen = index >= 0 ? (suggestions[index] ?? value) : value
    if (chosen.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      await useHosts.getState().finishLocation(chosen.trim())
      closeOverlay()
    } catch (e) {
      setError(humanError(e, 'No se pudo abrir la carpeta'))
    } finally {
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>): boolean => {
    if (e.key === 'ArrowDown' && suggestions.length > 0) {
      setIndex((i) => (i + 1) % suggestions.length)
      return true
    }
    if (e.key === 'ArrowUp' && suggestions.length > 0) {
      setIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
      return true
    }
    if (e.key === 'Tab' && !e.shiftKey && suggestions.length > 0) {
      setPath(`${suggestions[Math.max(0, index)]}/`)
      return true
    }
    return false
  }

  return (
    <Dialog
      title={project ? `Agregar carpeta a ${project.name}` : place.host ? 'Abrir carpeta remota' : 'Abrir carpeta'}
      subtitle={`En ${where}`}
      onClose={closeOverlay}
      footer={
        <>
          <Hint kbd="Tab">completar</Hint>
          <Hint kbd="⏎">abrir</Hint>
          <Hint kbd="Esc">cancelar</Hint>
          <span className="hosts-dialog__actions">
            <Button onClick={closeOverlay}>Cancelar</Button>
            <Button variant="primary" disabled={busy || !connected} onClick={() => void submit(path)}>
              {busy ? 'Abriendo' : 'Abrir'}
            </Button>
          </span>
        </>
      }
    >
      <div className="hosts-dialog">
        <TextInput label="Ruta de la carpeta" value={path} placeholder="~/proyectos/api" autoFocus onChange={(v) => setPath(v)} onSubmit={(v) => void submit(v)} onKey={onKey} />
        {place.host && status?.state === 'error' && <p className="hosts-dialog__error">{status.error}</p>}
        {place.host && status?.state !== 'connected' && status?.state !== 'error' && <p className="hosts-dialog__note">Conectando a {hostName}</p>}
        {place.host && status?.state === 'connected' && status.tools && !status.tools.dtach && (
          <p className="hosts-dialog__note">
            {hostName} no tiene dtach: las terminales abren igual, pero mueren si se corta la conexión.{' '}
            {status.tools.dtachInstall ? `Después de agregar la carpeta, "Instalar dtach en el servidor" lo deja listo (${status.tools.dtachInstall}).` : 'Instálalo con el gestor de paquetes del servidor.'}
          </p>
        )}
        {error && <p className="hosts-dialog__error">{error}</p>}
        {suggestions.length > 0 && (
          <div className="hosts-dialog__list" role="listbox" aria-label="Carpetas">
            {suggestions.map((s, i) => (
              <Row key={s} id={`loc-${i}`} level={1} cursor={i === index} onClick={() => setPath(`${s}/`)} title={s}>
                <Folder {...ICON_SM} aria-hidden="true" className="hosts-dialog__icon" />
                <RowLabel strong>{s.slice(s.lastIndexOf('/') + 1)}</RowLabel>
                <RowMeta>{tilde(s.slice(0, s.lastIndexOf('/')) || '/', home)}</RowMeta>
              </Row>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** Aviso de error fuera del diálogo (p. ej. cuando el flujo se corta). */
export function announceLocationError(e: unknown): void {
  useControl.getState().announce(humanError(e, 'No se pudo agregar la carpeta'))
}

/** Ruta con el home abreviado como `~`, para que las sugerencias no repitan `/Users/ana/…` en cada fila. */
function tilde(path: string, home: string | null): string {
  if (!home) return path
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
