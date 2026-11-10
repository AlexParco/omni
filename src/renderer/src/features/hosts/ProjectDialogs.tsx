import { useState, type JSX } from 'react'
import { useControl } from '@/store/control'
import { useHosts } from '@/store/hosts'
import { humanError } from '@/store/control-logic'
import { currentProjectOf, useSessions, workspaceOf } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { Button } from '@/ui/Button'
import { Dialog } from '@/ui/Dialog'
import { Hint } from '@/ui/Hint'
import { Folder, FolderOpen, ICON, Plus, Server } from '@/ui/icons'
import { commands } from '@/core/commands/registry'
import { prettyChord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'
import { TextInput } from '@/ui/TextInput'
import './hosts.css'

/**
 * `+` de Proyectos (`project.add`): elegir entre crear un proyecto vacío, abrir una carpeta de este Mac o
 * una de un servidor. Cada opción es un comando; aquí solo se elige.
 */
export function ProjectAddPicker(): JSX.Element {
  const closeOverlay = useUi((s) => s.closeOverlay)
  const key = (id: string): string | undefined => {
    const chord = keymap.chordsFor(id).find((c) => c.layer === 'global')?.chord
    return chord ? prettyChord(chord) : undefined
  }
  const items: PickerItem[] = [
    { id: 'project.new', label: 'Nuevo proyecto', hint: 'sin carpetas', icon: <Plus {...ICON} />, kbd: key('project.new') },
    { id: 'project.open', label: 'Abrir carpeta', icon: <FolderOpen {...ICON} />, kbd: key('project.open') },
    { id: 'project.openRemote', label: 'Abrir carpeta remota', icon: <Server {...ICON} />, kbd: key('project.openRemote') }
  ]
  return (
    <ListPicker
      items={items}
      placeholder="Agregar proyecto"
      filter={false}
      onClose={closeOverlay}
      onPick={(item) => {
        closeOverlay()
        void commands.run(item.id)
      }}
    />
  )
}

/**
 * "Nuevo proyecto" (`project.new`, §3.5c): un proyecto es solo un nombre. Se crea vacío, bajo el cursor;
 * sus carpetas se agregan cuando haga falta (⏎ sobre él o "Agregar carpeta" del menú).
 */
export function ProjectNewDialog(): JSX.Element {
  const closeOverlay = useUi((s) => s.closeOverlay)
  const [name, setName] = useState('')
  const save = (): void => {
    if (name.trim() === '') return
    closeOverlay()
    useSessions
      .getState()
      .createProject(name)
      .catch((e: unknown) => useControl.getState().announce(humanError(e, 'No se pudo crear el proyecto')))
  }
  return (
    <Dialog
      title="Nuevo proyecto"
      subtitle="Se crea vacío: le agregas carpetas cuando quieras, en este Mac o en un servidor"
      onClose={closeOverlay}
      footer={
        <>
          <Hint kbd="⏎">crear</Hint>
          <Hint kbd="Esc">cancelar</Hint>
          <span className="hosts-dialog__actions">
            <Button onClick={closeOverlay}>Cancelar</Button>
            <Button variant="primary" disabled={name.trim() === ''} onClick={save}>
              Crear
            </Button>
          </span>
        </>
      }
    >
      <div className="hosts-dialog">
        <TextInput label="Nombre del proyecto" value={name} placeholder="Billing API" autoFocus onChange={setName} onSubmit={save} />
      </div>
    </Dialog>
  )
}

/** "Renombrar proyecto": el nombre es del grupo, no de una carpeta ("Billing API"). */
export function ProjectRenameDialog(): JSX.Element | null {
  const closeOverlay = useUi((s) => s.closeOverlay)
  const project = useSessions((s) => currentProjectOf(s))
  const [name, setName] = useState(project?.name ?? '')
  if (!project) return null
  const save = (): void => {
    if (name.trim() === '') return
    closeOverlay()
    useSessions
      .getState()
      .renameProject(project.id, name)
      .catch((e: unknown) => useControl.getState().announce(humanError(e, 'No se pudo renombrar')))
  }
  return (
    <Dialog
      title="Renombrar proyecto"
      subtitle={`${project.locations.length} ${project.locations.length === 1 ? 'carpeta' : 'carpetas'}`}
      onClose={closeOverlay}
      footer={
        <>
          <Hint kbd="⏎">guardar</Hint>
          <Hint kbd="Esc">cancelar</Hint>
          <span className="hosts-dialog__actions">
            <Button onClick={closeOverlay}>Cancelar</Button>
            <Button variant="primary" disabled={name.trim() === ''} onClick={save}>
              Guardar
            </Button>
          </span>
        </>
      }
    >
      <div className="hosts-dialog">
        <TextInput label="Nombre del proyecto" value={name} autoFocus selectOnFocus onChange={setName} onSubmit={save} />
      </div>
    </Dialog>
  )
}

/**
 * "Renombrar carpeta" (§3.5c): el nombre de la fila de una carpeta del proyecto. La ruta no cambia.
 */
export function LocationRenameDialog(): JSX.Element | null {
  const closeOverlay = useUi((s) => s.closeOverlay)
  const location = useSessions((s) => workspaceOf(s, s.currentWorkspaceId ?? ''))
  const [name, setName] = useState(location?.name ?? '')
  if (!location || location.kind === 'worktree') return null
  const save = (): void => {
    if (name.trim() === '') return
    closeOverlay()
    useSessions
      .getState()
      .renameLocation(location.id, name)
      .catch((e: unknown) => useControl.getState().announce(humanError(e, 'No se pudo renombrar la carpeta')))
  }
  return (
    <Dialog
      title="Renombrar carpeta"
      subtitle={location.path}
      onClose={closeOverlay}
      footer={
        <>
          <Hint kbd="⏎">guardar</Hint>
          <Hint kbd="Esc">cancelar</Hint>
          <span className="hosts-dialog__actions">
            <Button onClick={closeOverlay}>Cancelar</Button>
            <Button variant="primary" disabled={name.trim() === ''} onClick={save}>
              Guardar
            </Button>
          </span>
        </>
      }
    >
      <div className="hosts-dialog">
        <TextInput label="Nombre de la carpeta" value={name} autoFocus selectOnFocus onChange={setName} onSubmit={save} />
      </div>
    </Dialog>
  )
}

/**
 * "Unir con otro proyecto": el elegido se mete en el actual (sus ubicaciones y worktrees pasan aquí
 * y él desaparece). Las sesiones siguen vivas donde estaban.
 */
export function ProjectMergePicker(): JSX.Element | null {
  const closeOverlay = useUi((s) => s.closeOverlay)
  const projects = useSessions((s) => s.projects)
  const currentId = useSessions((s) => currentProjectOf(s)?.id ?? null)
  const current = projects.find((p) => p.id === currentId)
  if (!current) return null
  const items: PickerItem[] = projects
    .filter((p) => p.id !== current.id)
    .map((p) => ({ id: p.id, label: p.name, icon: <Folder {...ICON} />, hint: `${p.locations.length} ${p.locations.length === 1 ? 'carpeta' : 'carpetas'}` }))
  return (
    <ListPicker
      items={items.length > 0 ? items : [{ id: 'none', label: 'No hay otros proyectos', disabled: true }]}
      placeholder={`Combinar con ${current.name}`}
      onClose={closeOverlay}
      onPick={(item) => {
        closeOverlay()
        useSessions
          .getState()
          .mergeProjects(current.id, item.id)
          .then(() => useControl.getState().announce(`${item.label} se combinó con ${current.name}`))
          .catch((e: unknown) => useControl.getState().announce(humanError(e, 'No se pudieron combinar los proyectos')))
      }}
    />
  )
}
