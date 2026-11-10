import { useEffect, type JSX } from 'react'
import { commands } from '@/core/commands/registry'
import { ArrowDown, ArrowUp, CheckMark, Combine, Copy, Eye, EyeOff, Folder, FolderClosed, FolderMinus, FolderPlus, GitCompare, ICON, Pencil, Plus, RefreshCw, X } from '@/ui/icons'
import { prettyChord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { useHosts } from '@/store/hosts'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'
import { useQuickOpen } from '@/store/quickopen'
import { currentProjectOf, plural, useSessions, workspaceOf } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { projectIsRepo, useWorktrees } from '@/store/worktrees'

/**
 * Menú `…` del proyecto bajo el cursor. Cada opción es un comando. Las opciones de una ubicación
 * (quitarla, moverla, subcarpeta, Finder, ruta) solo salen con el cursor sobre una ubicación concreta:
 * la fila de la ubicación, o la del proyecto si es su única carpeta. En la cabecera de un proyecto de
 * varias ubicaciones y en uno vacío quedan las del proyecto (§3.5c).
 */
export function ProjectMenu(): JSX.Element | null {
  const state = useSessions()
  const hostStatuses = useHosts((s) => s.status)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const branches = useQuickOpen((s) => s.branches)
  const project = currentProjectOf(state)
  const projectId = project?.id ?? null
  // Al abrir se pide la rama de la ubicación: un proyecto que no es repo git no puede tener worktrees (§3.15).
  useEffect(() => {
    if (projectId !== null) useWorktrees.getState().probeRepo(projectId)
  }, [projectId])
  if (!project) return null
  const current = workspaceOf(state, state.currentWorkspaceId ?? '')
  const workspace = current?.projectId === project.id ? current : undefined
  // Ubicación concreta bajo el cursor (no un worktree, no la cabecera de un grupo).
  const onHeader = state.cursor?.startsWith('p:') ?? false
  const location = workspace && workspace.kind !== 'worktree' && !(onHeader && workspace.kind !== 'local') ? workspace : undefined
  const index = location ? project.locations.findIndex((l) => l.id === location.id) : -1
  const count = project.locations.length
  // Carpeta concreta de las opciones de ruta (Finder, copiar, reconectar): la ubicación o el worktree.
  const target = location ?? (workspace?.kind === 'worktree' ? workspace : undefined)
  const hostState = target?.host ? (hostStatuses[target.host]?.state ?? 'disconnected') : null
  const notRepo = projectIsRepo(state, project.id, branches) === false
  const empty = count === 0

  const open = location ? state.sessions.filter((s) => s.workspaceId === location.id).length : 0
  const onFolder = location?.kind === 'folder'
  const folderTests = location ? project.locations.find((l) => l.id === location.id)?.testCommand : undefined
  const launchKey = keymap.chordsFor('launcher.open').find((c) => c.layer === 'global')?.chord
  // Tres bloques separados por una línea, como un menú contextual de macOS: lanzar, la carpeta de la
  // fila y el proyecto. Las notas solo dicen lo que la etiqueta no (por qué está apagada, qué se cierra,
  // el comando vigente). El título nombra la carpeta cuando el proyecto tiene varias.
  const folderGroup = 'folder'
  const title = target && target.kind !== 'local' ? `${project.name} / ${target.name}` : project.name
  const items: PickerItem[] = [
    ...(empty ? [] : [{ id: 'launcher.open', label: 'Nuevo agente', icon: <Plus {...ICON} />, kbd: launchKey ? prettyChord(launchKey) : undefined }]),
    ...(empty ? [] : [{ id: 'worktree.new', label: 'Nuevo worktree', icon: <GitCompare {...ICON} />, disabled: notRepo, hint: notRepo ? 'requiere git' : undefined }]),
    // Carpeta de la fila (§3.5c): la ubicación o el worktree bajo el cursor.
    ...(location && !location.host ? [{ id: 'project.addFolder', label: 'Agregar subcarpeta', icon: <Folder {...ICON} />, group: folderGroup }] : []),
    ...(onFolder ? [{ id: 'project.renameFolder', label: 'Renombrar carpeta', icon: <Pencil {...ICON} />, group: folderGroup }] : []),
    // Solo se ve el comando propio de la carpeta: sin él usa el del proyecto, que está más abajo.
    ...(onFolder ? [{ id: 'project.setFolderTestCommand', label: 'Tests de la carpeta', icon: <CheckMark {...ICON} />, hint: folderTests ?? (project.testCommand ? `los del proyecto` : 'sin configurar'), group: folderGroup }] : []),
    ...(location && index > 0 ? [{ id: 'project.moveLocationUp', label: 'Mover arriba', icon: <ArrowUp {...ICON} />, group: folderGroup }] : []),
    ...(location && index >= 0 && index < count - 1 ? [{ id: 'project.moveLocationDown', label: 'Mover abajo', icon: <ArrowDown {...ICON} />, group: folderGroup }] : []),
    ...(target && !target.host ? [{ id: 'project.reveal', label: 'Mostrar en Finder', icon: <FolderClosed {...ICON} />, group: folderGroup }] : []),
    ...(target ? [{ id: 'project.copyPath', label: 'Copiar ruta', icon: <Copy {...ICON} />, group: folderGroup }] : []),
    ...(target?.host && hostState !== 'connected' ? [{ id: 'host.reconnect', label: 'Reconectar servidor', icon: <RefreshCw {...ICON} />, hint: hostState === 'error' ? 'sin conexión' : 'desconectado', group: folderGroup }] : []),
    ...(location ? [{ id: 'project.removeFolder', label: 'Quitar del proyecto', icon: <FolderMinus {...ICON} />, hint: open > 0 ? `cierra ${plural(open, 'sesión', 'sesiones')}` : undefined, group: folderGroup }] : []),
    // Proyecto.
    { id: 'project.addLocation', label: 'Agregar carpeta', icon: <FolderPlus {...ICON} />, group: 'project' },
    // Sobre una carpeta, "Renombrar" y "Tests" son los de la carpeta (arriba); los del proyecto quedan en su
    // cabecera y en la paleta. Así el menú entra entero sin scroll.
    ...(onFolder ? [] : [{ id: 'project.rename', label: 'Renombrar', icon: <Pencil {...ICON} />, group: 'project' }]),
    ...(state.projects.length > 1 ? [{ id: 'project.merge', label: 'Combinar con otro proyecto', icon: <Combine {...ICON} />, group: 'project' }] : []),
    // El comando vigente se ve a la derecha; sin comando, los tests no corren solos al terminar un agente (§3.15).
    ...(onFolder ? [] : [{ id: 'project.setTestCommand', label: project.testCommand ? 'Comando de tests' : 'Configurar tests', icon: <CheckMark {...ICON} />, ...(project.testCommand ? { hint: project.testCommand } : {}), group: 'project' }]),
    project.hidden
      ? { id: 'project.unhide', label: 'Mostrar en el sidebar', icon: <Eye {...ICON} />, group: 'project' }
      : { id: 'project.hide', label: 'Ocultar', icon: <EyeOff {...ICON} />, group: 'project' },
    { id: 'project.remove', label: 'Quitar proyecto', icon: <X {...ICON} />, danger: true, group: 'project' }
  ]

  return (
    <ListPicker
      items={items}
      placeholder={title}
      filter={false}
      groupLabels={false}
      onClose={closeOverlay}
      onPick={(item) => {
        closeOverlay()
        void commands.run(item.id)
      }}
    />
  )
}

