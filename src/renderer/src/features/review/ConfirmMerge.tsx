import type { JSX } from 'react'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'
import { GitMerge, ICON } from '@/ui/icons'
import { useReview, worktreeSessions } from '@/store/review'
import { sessionTitle, useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'

/**
 * Confirmación antes de mergear un worktree con sesiones vivas (ARCHITECTURE §3.16): el merge borra
 * el worktree, así que sus agentes y terminales se matan. Mismo patrón que `ConfirmKill`.
 */
export function ConfirmMerge(): JSX.Element | null {
  const closeOverlay = useUi((s) => s.closeOverlay)
  const workspaceId = useReview((s) => s.workspaceId)
  const confirmMerge = useReview((s) => s.confirmMerge)
  const sessions = useSessions((s) => s.sessions)
  const workspaces = useSessions((s) => s.workspaces)
  const titles = useSessions((s) => s.titles)
  const agents = useSessions((s) => s.agents)
  const victims = worktreeSessions({ sessions }, workspaceId)
  const ws = workspaces.find((w) => w.id === workspaceId)
  if (!ws) return null

  const names = victims.map((v) => sessionTitle({ titles, agents }, v)).join(', ')
  const items: PickerItem[] = [
    { id: 'merge', label: `Merge de ${ws.name}`, hint: victims.length === 1 ? `mata ${names}` : `mata ${victims.length} procesos`, icon: <GitMerge {...ICON} />, danger: true },
    { id: 'cancel', label: 'Cancelar', kbd: 'Esc' }
  ]

  return (
    <ListPicker
      items={items}
      placeholder={victims.length === 1 ? `${names} sigue vivo en el worktree` : `${victims.length} procesos siguen vivos en el worktree`}
      filter={false}
      onClose={closeOverlay}
      onPick={(item) => {
        closeOverlay()
        if (item.id === 'merge') void confirmMerge()
      }}
    />
  )
}
