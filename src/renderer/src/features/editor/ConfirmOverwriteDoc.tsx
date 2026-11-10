import type { JSX } from 'react'
import { reloadDoc, saveDoc } from '@/panes/editor/editor-host'
import { docLabel, useDocs } from '@/store/docs'
import { useSessions, workspaceOf } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'
import { ICON, RefreshCw } from '@/ui/icons'

/**
 * `⌘S` sobre un editor cuyo archivo cambió en disco con el buffer sucio (ARCHITECTURE §3.19): o se
 * pisa lo de disco con el buffer, o se recarga lo de disco perdiendo el buffer, o nada. Mismo molde
 * que `ConfirmKill`.
 */
export function ConfirmOverwriteDoc(): JSX.Element | null {
  const id = useDocs((s) => s.pendingSave)
  const session = useSessions((s) => s.sessions.find((x) => x.id === id))
  const workspacePath = useSessions((s) => (session ? workspaceOf(s, session.workspaceId)?.path : undefined))
  const closeOverlay = useUi((s) => s.closeOverlay)
  if (!id || !session) return null
  const label = docLabel(session, workspacePath)

  const items: PickerItem[] = [
    { id: 'overwrite', label: 'Sobrescribir con el buffer', hint: 'se pierde lo que cambió en disco', danger: true },
    { id: 'reload', label: 'Recargar desde disco', hint: 'se pierden los cambios del buffer', icon: <RefreshCw {...ICON} /> },
    { id: 'cancel', label: 'Cancelar', kbd: 'Esc' }
  ]

  const close = (): void => {
    closeOverlay()
    useDocs.getState().clearPendingSave()
  }

  return (
    <ListPicker
      items={items}
      placeholder={`${label} cambió en disco mientras lo editabas`}
      filter={false}
      onClose={close}
      onPick={(item) => {
        close()
        if (item.id === 'overwrite') void saveDoc(id, true)
        else if (item.id === 'reload') void reloadDoc(id)
      }}
    />
  )
}
