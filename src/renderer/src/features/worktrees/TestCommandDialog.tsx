import { useState, type JSX } from 'react'
import { projectOf, useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { useWorktrees } from '@/store/worktrees'
import { Button } from '@/ui/Button'
import { Dialog } from '@/ui/Dialog'
import { Hint } from '@/ui/Hint'
import { TextInput } from '@/ui/TextInput'
import './worktrees.css'

/**
 * Diálogo "Comando de tests" (`project.setTestCommand`, ARCHITECTURE §3.15): lo que main corre en el
 * worktree cuando su agente pasa de `working` a `idle` y hay cambios. Vacío lo quita. Sobre una carpeta
 * (`targetLocationId`, §3.5c) es el de esa carpeta: manda sobre el del proyecto, y vacío vuelve a ese.
 */
export function TestCommandDialog(): JSX.Element | null {
  const projectId = useWorktrees((s) => s.targetProjectId)
  const locationId = useWorktrees((s) => s.targetLocationId)
  const projects = useSessions((s) => s.projects)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const project = projectId !== null ? projectOf({ projects }, projectId) : undefined
  const location = locationId !== null ? project?.locations.find((l) => l.id === locationId) : undefined
  const [command, setCommand] = useState((location ? location.testCommand : project?.testCommand) ?? '')
  if (!project) return null

  const save = (): void => {
    closeOverlay()
    void useWorktrees.getState().setTestCommand(project.id, command, location?.id ?? null)
  }

  return (
    <Dialog
      title={location ? `Comando de tests de ${location.name}` : 'Comando de tests'}
      subtitle={location ? `${project.name} / ${location.name} · manda sobre el del proyecto en sus worktrees` : `${project.name} · corre en cada worktree cuando su agente termina`}
      onClose={closeOverlay}
      footer={
        <>
          <Hint kbd="⏎">guardar</Hint>
          <Hint kbd="Esc">cancelar</Hint>
          <span className="worktrees-dialog__actions">
            <Button onClick={closeOverlay}>Cancelar</Button>
            <Button variant="primary" onClick={save}>
              {command.trim() === '' ? 'Quitar' : 'Guardar'}
            </Button>
          </span>
        </>
      }
    >
      <div className="worktrees-dialog">
        <TextInput label="Comando de tests" value={command} placeholder={location ? (project.testCommand ?? 'pnpm test') : 'pnpm test'} autoFocus onChange={setCommand} onSubmit={save} />
        <p className="worktrees-dialog__note">
          {location
            ? `Se ejecuta con sh -lc en la carpeta ${location.name} del worktree, con un límite de 10 minutos. Déjalo vacío para usar el del proyecto${project.testCommand ? ` (${project.testCommand})` : ''}.`
            : 'Se ejecuta con sh -lc en el worktree (en su subcarpeta si salió de una), con un límite de 10 minutos. La última línea de la salida se muestra como resumen. Déjalo vacío para no correr tests.'}
        </p>
      </div>
    </Dialog>
  )
}
