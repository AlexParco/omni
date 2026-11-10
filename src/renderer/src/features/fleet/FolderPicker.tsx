import { useEffect, useState, type JSX } from 'react'
import type { FolderCandidate } from '@shared/types'
import { useControl } from '@/store/control'
import { humanError } from '@/store/control-logic'
import { projectOf, useSessions, workspaceOf } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { Folder, FolderClosed, ICON } from '@/ui/icons'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'

/**
 * "Agregar subcarpeta" (`project.addFolder`, ARCHITECTURE §3.5c): lista las subcarpetas de la ubicación
 * actual (hasta dos niveles) con los subproyectos primero (su manifiesto a la derecha) y registra la
 * elegida como ubicación más del proyecto. Filtrar escribe sobre la ruta relativa (`apps/web`).
 */
export function FolderPicker(): JSX.Element | null {
  const state = useSessions()
  const closeOverlay = useUi((s) => s.closeOverlay)
  const current = workspaceOf(state, state.currentWorkspaceId ?? '')
  const workspace = current && current.kind !== 'worktree' && !current.host ? current : undefined
  const project = workspace ? projectOf(state, workspace.projectId) : undefined
  const locationId = workspace?.id ?? null
  const [candidates, setCandidates] = useState<FolderCandidate[] | null>(null)

  useEffect(() => {
    if (locationId === null) return
    let alive = true
    useSessions
      .getState()
      .folderCandidates(locationId)
      .then((list) => alive && setCandidates(list))
      .catch(() => alive && setCandidates([]))
    return () => {
      alive = false
    }
  }, [locationId])

  if (!project || !workspace) return null

  const items: PickerItem[] =
    candidates === null
      ? [{ id: 'loading', label: 'Buscando carpetas', disabled: true, icon: <FolderClosed {...ICON} /> }]
      : candidates.length === 0
        ? [{ id: 'empty', label: 'No hay subcarpetas para agregar', disabled: true, icon: <FolderClosed {...ICON} /> }]
        : candidates.map((c) => ({ id: c.rel, label: c.rel, icon: <Folder {...ICON} />, hint: c.marker ?? undefined }))

  return (
    <ListPicker
      items={items}
      placeholder={`Agregar subcarpeta de ${project.locations.length > 1 ? workspace.name : project.name}`}
      onClose={closeOverlay}
      onPick={(item) => {
        closeOverlay()
        useSessions
          .getState()
          .addFolder(workspace.id, item.id)
          .catch((e: unknown) => useControl.getState().announce(humanError(e, 'No se pudo agregar la carpeta')))
      }}
    />
  )
}
