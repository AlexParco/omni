import type { JSX } from 'react'
import { omni } from '@/lib/omni'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'
import { ICON, Power } from '@/ui/icons'
import { plural, useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'

/**
 * Confirmación de "Apagar todo" (`app.shutdown`): mata todas las sesiones, apaga el daemon y cierra
 * omni. Cerrar la ventana no hace nada de eso (ARCHITECTURE §3.10), así que aquí sí se pregunta.
 */
export function ConfirmShutdown(): JSX.Element {
  const closeOverlay = useUi((s) => s.closeOverlay)
  const count = useSessions((s) => s.sessions.length)

  const items: PickerItem[] = [
    { id: 'shutdown', label: 'Apagar todo', hint: count > 0 ? `cierra ${plural(count, 'sesión', 'sesiones')} y omni` : 'cierra omni', icon: <Power {...ICON} />, danger: true },
    { id: 'cancel', label: 'Cancelar', kbd: 'Esc' }
  ]

  return (
    <ListPicker
      items={items}
      placeholder="Cierra agentes, terminales y omni"
      filter={false}
      onClose={closeOverlay}
      onPick={(item) => {
        closeOverlay()
        if (item.id === 'shutdown') void omni.invoke('app:shutdown')
      }}
    />
  )
}
