import { useEffect, useState, type JSX } from 'react'
import type { SshConfigHost } from '@shared/types'
import { useControl } from '@/store/control'
import { humanError } from '@/store/control-logic'
import { useHosts } from '@/store/hosts'
import { useUi } from '@/store/ui'
import { Button } from '@/ui/Button'
import { Dialog, DialogSection } from '@/ui/Dialog'
import { Hint } from '@/ui/Hint'
import { ICON_SM, Server } from '@/ui/icons'
import { Row, RowLabel, RowMeta } from '@/ui/Row'
import { TextInput } from '@/ui/TextInput'
import './hosts.css'

/**
 * "Agregar servidor SSH" (§3.26): un alias de `~/.ssh/config` (lista para elegir con un clic) o
 * `usuario@host`. omni no guarda llaves ni contraseñas: conecta con tu `ssh` y tu ssh-agent. Si venía
 * del flujo de ubicación, al conectar sigue con la carpeta en ese servidor.
 */
export function HostAddDialog(): JSX.Element {
  const closeOverlay = useUi((s) => s.closeOverlay)
  const known = useHosts((s) => s.hosts)
  const [target, setTarget] = useState('')
  const [config, setConfig] = useState<SshConfigHost[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    useHosts
      .getState()
      .sshConfig()
      .then((list) => setConfig(list.filter((h) => !known.some((k) => k.target === h.alias))))
      .catch(() => setConfig([]))
  }, [known])

  const submit = async (value: string): Promise<void> => {
    const t = value.trim()
    if (t === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const { host, status } = await useHosts.getState().add(t.includes('@') ? t.split('@')[1] : t, t)
      if (status.state !== 'connected') {
        setError(status.error ?? 'No se pudo conectar')
        return
      }
      if (useHosts.getState().target) useHosts.getState().choosePlace({ host: host.id })
      else {
        closeOverlay()
        useControl.getState().announce(`${host.name} conectado`)
      }
    } catch (e) {
      setError(humanError(e, 'No se pudo agregar el servidor'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Agregar servidor SSH"
      subtitle="Usa tu ssh y tus llaves (ssh-agent): omni no guarda contraseñas"
      onClose={closeOverlay}
      footer={
        <>
          <Hint kbd="⏎">conectar</Hint>
          <Hint kbd="Esc">cancelar</Hint>
          <span className="hosts-dialog__actions">
            <Button onClick={closeOverlay}>Cancelar</Button>
            <Button variant="primary" disabled={busy || target.trim() === ''} onClick={() => void submit(target)}>
              {busy ? 'Conectando' : 'Conectar'}
            </Button>
          </span>
        </>
      }
    >
      <div className="hosts-dialog">
        <TextInput label="Servidor" value={target} placeholder="alias de ~/.ssh/config o usuario@host" autoFocus onChange={setTarget} onSubmit={(v) => void submit(v)} />
        {error && <p className="hosts-dialog__error">{error}</p>}
        <p className="hosts-dialog__note">La primera vez conéctate una vez desde una terminal con ssh {target.trim() || '<servidor>'} para aceptar su huella: omni no acepta huellas nuevas por su cuenta.</p>
      </div>
      {config.length > 0 && (
        <>
          <DialogSection title="De tu ~/.ssh/config" />
          <div className="hosts-dialog__list" role="listbox" aria-label="Hosts de ~/.ssh/config">
            {config.map((h, i) => (
              <Row key={h.alias} id={`sshcfg-${i}`} onClick={() => void submit(h.alias)} title={`Conectar a ${h.alias}`}>
                <Server {...ICON_SM} aria-hidden="true" className="hosts-dialog__icon" />
                <RowLabel>{h.alias}</RowLabel>
                <RowMeta>{h.resolved}</RowMeta>
              </Row>
            ))}
          </div>
        </>
      )}
    </Dialog>
  )
}
