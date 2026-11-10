import type { JSX } from 'react'
import { saveDoc } from '@/panes/editor/editor-host'
import { docLabel, useDocs } from '@/store/docs'
import { useSessions, workspaceOf } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'
import { ICON, Trash2 } from '@/ui/icons'

/**
 * Confirmación al cerrar uno o varios editores con cambios sin guardar (ARCHITECTURE §3.19): al
 * cerrar un pane es uno; al cerrar un tab pueden ser varios. Mismo molde que `ConfirmKill`:
 * descartar (destructivo), guardar y cerrar, o cancelar.
 */
export function ConfirmDiscardDoc(): JSX.Element | null {
  const ids = useDocs((s) => s.pendingClose)
  const sessions = useSessions((s) => s.sessions)
  const workspaces = useSessions((s) => s.workspaces)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const victims = sessions.filter((x) => ids.includes(x.id))
  if (victims.length === 0) return null
  const labels = victims.map((v) => docLabel(v, workspaceOf({ workspaces }, v.workspaceId)?.path))
  const subject = victims.length === 1 ? labels[0] : `${labels[0]} y ${victims.length - 1} más`

  const items: PickerItem[] = [
    { id: 'discard', label: victims.length === 1 ? 'Descartar los cambios' : `Descartar los cambios de ${victims.length} archivos`, hint: 'se pierde lo no guardado', icon: <Trash2 {...ICON} />, danger: true },
    { id: 'save', label: victims.length === 1 ? 'Guardar y cerrar' : 'Guardar todo y cerrar' },
    { id: 'cancel', label: 'Cancelar', kbd: 'Esc' }
  ]

  const close = (): void => {
    closeOverlay()
    useDocs.getState().cancelDiscard()
  }

  return (
    <ListPicker
      items={items}
      placeholder={`${subject} tiene cambios sin guardar`}
      filter={false}
      onClose={close}
      onPick={(item) => {
        closeOverlay()
        if (item.id === 'discard') useDocs.getState().confirmDiscard()
        else if (item.id === 'save') {
          // Si alguno no se pudo guardar (o pidió confirmación por cambios en disco), no se cierra ninguno.
          void Promise.all(victims.map((v) => saveDoc(v.id))).then((oks) => {
            if (oks.every(Boolean)) useDocs.getState().confirmDiscard()
            else useDocs.getState().cancelDiscard()
          })
        } else useDocs.getState().cancelDiscard()
      }}
    />
  )
}
