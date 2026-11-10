import type { JSX } from 'react'
import { useClock } from '@/store/clock'
import { useDaemon } from '@/store/daemon'
import { liveAgent, plural, sessionStatus, useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { ICON, RefreshCw } from '@/ui/icons'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'

/**
 * Confirmación de "Actualizar terminales" (§3.10c): el daemon se reemplaza, cada terminal se reabre con
 * su mismo id y los agentes retoman su conversación. Lo que se pierde es el paso en curso: se avisa
 * cuántos agentes están trabajando ahora mismo.
 */
export function ConfirmUpgrade(): JSX.Element {
  const closeOverlay = useUi((s) => s.closeOverlay)
  const state = useSessions()
  const now = useClock((c) => c.now)
  const terminals = state.sessions.filter((s) => s.agent !== 'browser' && s.agent !== 'editor')
  // Solo los agentes pierden algo: un shell se reabre igual.
  const working = terminals.filter((s) => liveAgent(state, s, now) !== 'shell' && sessionStatus(state, s.id, now) === 'working').length

  const items: PickerItem[] = [
    {
      id: 'upgrade',
      label: terminals.length > 0 ? `Reabrir ${plural(terminals.length, 'terminal', 'terminales')}` : 'Actualizar',
      hint: working > 0 ? `${plural(working, 'agente', 'agentes')} trabajando pierde${working === 1 ? '' : 'n'} el paso en curso` : 'los agentes retoman su conversación',
      icon: <RefreshCw {...ICON} />,
      danger: working > 0
    },
    { id: 'cancel', label: 'Cancelar', kbd: 'Esc' }
  ]

  return (
    <ListPicker
      items={items}
      placeholder="¿Actualizar las terminales?"
      filter={false}
      onClose={closeOverlay}
      onPick={(item) => {
        closeOverlay()
        if (item.id === 'upgrade') void useDaemon.getState().upgrade()
      }}
    />
  )
}
