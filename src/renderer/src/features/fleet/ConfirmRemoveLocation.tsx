import type { JSX } from 'react'
import { useControl } from '@/store/control'
import { humanError } from '@/store/control-logic'
import { useDocs } from '@/store/docs'
import { plural, useSessions, workspaceOf } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { FolderMinus, ICON } from '@/ui/icons'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'

/**
 * Confirmación de "Quitar ubicación" cuando la carpeta tiene sesiones abiertas (§3.5c): dice cuántas
 * se cierran (y si algún editor tiene cambios sin guardar) antes de cerrarlas y olvidar la ubicación.
 */
export function ConfirmRemoveLocation(): JSX.Element | null {
  const workspaceId = useUi((s) => s.pendingRemoveLocation)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const state = useSessions()
  const dirty = useDocs((s) => s.dirty)
  const ws = workspaceId ? workspaceOf(state, workspaceId) : undefined
  if (!ws) return null
  const open = state.sessions.filter((s) => s.workspaceId === ws.id)
  const unsaved = open.filter((s) => dirty[s.id] === true).length

  const items: PickerItem[] = [
    {
      id: 'remove',
      label: open.length > 0 ? `Cerrar ${plural(open.length, 'sesión', 'sesiones')} y quitar la carpeta` : 'Quitar la carpeta',
      hint: unsaved > 0 ? `${plural(unsaved, 'editor', 'editores')} sin guardar` : 'no se borra del disco',
      icon: <FolderMinus {...ICON} />,
      danger: true
    },
    { id: 'cancel', label: 'Cancelar', kbd: 'Esc' }
  ]

  return (
    <ListPicker
      items={items}
      placeholder={`¿Quitar ${ws.name} del proyecto?`}
      filter={false}
      onClose={() => {
        useUi.getState().setPendingRemoveLocation(null)
        closeOverlay()
      }}
      onPick={(item) => {
        useUi.getState().setPendingRemoveLocation(null)
        closeOverlay()
        if (item.id !== 'remove') return
        void useSessions
          .getState()
          .removeFolder(ws.id, true)
          .catch((e: unknown) => useControl.getState().announce(humanError(e, 'No se pudo quitar la carpeta')))
      }}
    />
  )
}
