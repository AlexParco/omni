import type { JSX } from 'react'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'
import { ICON, X } from '@/ui/icons'
import { sessionTitle, useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'

/** Confirmación antes de matar procesos que están trabajando (como `kill-pane? (y/n)` en tmux). */
export function ConfirmKill(): JSX.Element | null {
  const ids = useUi((s) => s.pendingKill)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const sessions = useSessions((s) => s.sessions)
  const titles = useSessions((s) => s.titles)
  const agents = useSessions((s) => s.agents)
  const kill = useSessions((s) => s.kill)
  const victims = sessions.filter((x) => ids.includes(x.id))
  if (victims.length === 0) return null

  const names = victims.map((v) => sessionTitle({ titles, agents }, v)).join(', ')
  const items: PickerItem[] = [
    { id: 'kill', label: victims.length === 1 ? `Matar ${names}` : `Matar ${victims.length} procesos`, hint: 'está trabajando', icon: <X {...ICON} />, danger: true },
    { id: 'cancel', label: 'Cancelar', kbd: 'Esc' }
  ]

  return (
    <ListPicker
      items={items}
      placeholder={victims.length === 1 ? names : `${victims.length} procesos en curso`}
      filter={false}
      onClose={closeOverlay}
      onPick={(item) => {
        closeOverlay()
        if (item.id === 'kill') victims.forEach((v) => kill(v.id))
      }}
    />
  )
}
