import type { JSX } from 'react'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'
import { ICON, Trash2 } from '@/ui/icons'
import { plural, useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { useWorktrees } from '@/store/worktrees'
import { branchOf, statLabel } from '@/store/worktrees-logic'

/**
 * Confirmación antes de descartar un worktree (`worktree.discard`, ARCHITECTURE §3.15): dice qué se
 * pierde (cambios respecto a la base y agentes que se matan). Mismo molde que `ConfirmKill`.
 */
export function ConfirmDiscard(): JSX.Element | null {
  const id = useWorktrees((s) => s.discardId)
  const status = useWorktrees((s) => (id !== null ? s.statuses[id] : undefined))
  const closeOverlay = useUi((s) => s.closeOverlay)
  const workspaces = useSessions((s) => s.workspaces)
  const sessions = useSessions((s) => s.sessions)
  const workspace = workspaces.find((w) => w.id === id)
  if (!id || !workspace) return null

  const agents = sessions.filter((x) => x.workspaceId === id).length
  const lost = [statLabel(status) || 'estado pendiente', status?.dirty ? 'sin commit' : '', agents > 0 ? `${plural(agents, 'agente', 'agentes')} se ${agents === 1 ? 'mata' : 'matan'}` : ''].filter((x) => x !== '').join(' · ')
  const items: PickerItem[] = [
    { id: 'discard', label: `Descartar ${workspace.name}`, hint: lost, icon: <Trash2 {...ICON} />, danger: true },
    { id: 'cancel', label: 'Cancelar', kbd: 'Esc' }
  ]

  return (
    <ListPicker
      items={items}
      placeholder={`${workspace.name} · ${branchOf(workspace, status)} se borra con su rama`}
      filter={false}
      onClose={closeOverlay}
      onPick={(item) => {
        closeOverlay()
        if (item.id === 'discard') void useWorktrees.getState().confirmDiscard(id)
      }}
    />
  )
}
