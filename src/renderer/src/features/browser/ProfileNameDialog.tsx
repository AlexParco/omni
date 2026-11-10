import { useState, type JSX } from 'react'
import { useBrowser } from '@/store/browser'
import { useUi } from '@/store/ui'
import { Button } from '@/ui/Button'
import { Dialog } from '@/ui/Dialog'
import { Hint } from '@/ui/Hint'
import { TextInput } from '@/ui/TextInput'
import './profile-name.css'

/** Diálogo "Nuevo perfil": pide el nombre, crea el perfil y lo activa en el navegador del menú. */
export function ProfileNameDialog(): JSX.Element | null {
  const id = useBrowser((s) => s.menuId)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const [name, setName] = useState('')
  if (!id) return null
  const valid = name.trim().length > 0

  const create = (): void => {
    if (!valid) return
    closeOverlay()
    void useBrowser.getState().createProfile(id, name)
  }

  return (
    <Dialog
      title="Nuevo perfil"
      subtitle="Con sus propias cookies y datos de sitios, separados de los demás perfiles"
      onClose={closeOverlay}
      footer={
        <>
          <Hint kbd="⏎">crear</Hint>
          <Hint kbd="Esc">cancelar</Hint>
          <span className="profile-name__actions">
            <Button onClick={closeOverlay}>Cancelar</Button>
            <Button variant="primary" disabled={!valid} onClick={create}>
              Crear
            </Button>
          </span>
        </>
      }
    >
      <div className="profile-name">
        <TextInput label="Nombre del perfil" value={name} placeholder="Trabajo, Cliente, Pruebas" autoFocus onChange={setName} onSubmit={create} />
      </div>
    </Dialog>
  )
}
