import { useState, type JSX } from 'react'
import { projectOf, useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { useWorktrees } from '@/store/worktrees'
import { normalizeWorktreeName } from '@/store/worktrees-logic'
import { Button } from '@/ui/Button'
import { Dialog } from '@/ui/Dialog'
import { Hint } from '@/ui/Hint'
import { TextInput } from '@/ui/TextInput'
import './worktrees.css'

/**
 * Diálogo "Nuevo worktree" (`worktree.new`, ARCHITECTURE §3.15): pide el nombre, crea la rama
 * `omni/<name>` en el proyecto elegido y abre el launcher para que un agente nazca ahí. Un error de
 * main (no es repo git, nombre repetido) se queda en el diálogo.
 */
export function WorktreeNameDialog(): JSX.Element | null {
  const projectId = useWorktrees((s) => s.targetProjectId)
  const error = useWorktrees((s) => s.error)
  const projects = useSessions((s) => s.projects)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const project = projectId !== null ? projectOf({ projects }, projectId) : undefined
  if (!project) return null
  const clean = normalizeWorktreeName(name)
  const valid = clean.length > 0 && !busy

  const create = (): void => {
    if (!valid) return
    setBusy(true)
    void useWorktrees
      .getState()
      .create(project.id, clean)
      .then((ws) => {
        setBusy(false)
        if (ws) useWorktrees.getState().launchIn(ws.id)
      })
  }

  return (
    <Dialog
      title="Nuevo worktree"
      subtitle={`${project.name} · rama omni/${clean || '<nombre>'}`}
      onClose={closeOverlay}
      footer={
        <>
          <Hint kbd="⏎">crear y lanzar un agente</Hint>
          <Hint kbd="Esc">cancelar</Hint>
          <span className="worktrees-dialog__actions">
            <Button onClick={closeOverlay}>Cancelar</Button>
            <Button variant="primary" disabled={!valid} onClick={create}>
              {busy ? 'Creando' : 'Crear'}
            </Button>
          </span>
        </>
      }
    >
      <div className="worktrees-dialog">
        <TextInput label="Nombre del worktree" value={name} placeholder="rate-limit-por-ip" autoFocus onChange={setName} onSubmit={create} />
        {error && <p className="worktrees-dialog__error">{error}</p>}
        <p className="worktrees-dialog__note">Se crea fuera del repo, sobre la rama actual del proyecto. Al terminar se abre el launcher para elegir el agente.</p>
      </div>
    </Dialog>
  )
}
