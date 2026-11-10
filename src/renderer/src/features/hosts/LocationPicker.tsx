import type { JSX } from 'react'
import { hostStateLabel, useHosts } from '@/store/hosts'
import { projectOf, useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { ICON, Laptop, Plus, Server } from '@/ui/icons'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'

const LOCAL = 'local'
const ADD = 'add-host'

/**
 * Primer paso de "Agregar ubicación" / "Abrir carpeta remota" (§3.5c, §3.26): dónde está la carpeta,
 * en este Mac o en un servidor SSH (con su estado de conexión), o registrar un servidor nuevo.
 */
export function LocationPicker(): JSX.Element {
  const hosts = useHosts((s) => s.hosts)
  const status = useHosts((s) => s.status)
  const target = useHosts((s) => s.target)
  const projects = useSessions((s) => s.projects)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const project = target?.mode === 'addTo' ? projectOf({ projects }, target.projectId) : undefined

  const items: PickerItem[] = [
    ...(target?.mode === 'newProject' ? [] : [{ id: LOCAL, label: 'Este Mac', icon: <Laptop {...ICON} /> }]),
    ...hosts.map((h) => ({ id: h.id, label: h.name, icon: <Server {...ICON} />, hint: `${h.target} · ${hostStateLabel(status[h.id])}` })),
    { id: ADD, label: 'Agregar servidor SSH', icon: <Plus {...ICON} />, hint: 'desde ~/.ssh/config o usuario@host' }
  ]

  return (
    <ListPicker
      items={items}
      placeholder={project ? `Agregar carpeta a ${project.name}` : 'Abrir carpeta remota'}
      onClose={closeOverlay}
      onPick={(item) => {
        if (item.id === ADD) return useUi.getState().openOverlay('hostAdd')
        useHosts.getState().choosePlace({ host: item.id === LOCAL ? null : item.id })
      }}
    />
  )
}
