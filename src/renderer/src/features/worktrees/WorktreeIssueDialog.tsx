import { useState, type JSX } from 'react'
import { projectOf, useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { useWorktrees } from '@/store/worktrees'
import { parseIssueNumber } from '@/store/worktrees-logic'
import { Button } from '@/ui/Button'
import { Dialog } from '@/ui/Dialog'
import { Hint } from '@/ui/Hint'
import { TextInput } from '@/ui/TextInput'
import './worktrees.css'

/**
 * Diálogo "Worktree desde un issue" (`worktree.fromIssue`, ARCHITECTURE §3.15): pide el número (o la
 * URL) del issue; main lo resuelve con `gh`, nombra el worktree por el título y el agente que se lance
 * ahí recibe `Issue #n: título\nurl` como primer prompt. Si `gh` falla, el motivo se queda en el diálogo.
 */
export function WorktreeIssueDialog(): JSX.Element | null {
  const projectId = useWorktrees((s) => s.targetProjectId)
  const error = useWorktrees((s) => s.error)
  const projects = useSessions((s) => s.projects)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)
  const project = projectId !== null ? projectOf({ projects }, projectId) : undefined
  if (!project) return null
  const issue = parseIssueNumber(raw)
  const valid = issue !== null && !busy

  const create = (): void => {
    if (!valid || issue === null) return
    setBusy(true)
    // `createFromIssue` abre el launcher él mismo cuando todo sale bien; con error el diálogo sigue abierto.
    void useWorktrees
      .getState()
      .createFromIssue(project.id, issue)
      .then(() => setBusy(false))
  }

  return (
    <Dialog
      title="Worktree desde un issue"
      subtitle={`${project.name} · gh issue view ${issue ?? '<n>'}`}
      onClose={closeOverlay}
      footer={
        <>
          <Hint kbd="⏎">crear y lanzar un agente</Hint>
          <Hint kbd="Esc">cancelar</Hint>
          <span className="worktrees-dialog__actions">
            <Button onClick={closeOverlay}>Cancelar</Button>
            <Button variant="primary" disabled={!valid} onClick={create}>
              {busy ? 'Resolviendo' : 'Crear'}
            </Button>
          </span>
        </>
      }
    >
      <div className="worktrees-dialog">
        <TextInput label="Número o URL del issue" value={raw} placeholder="41 o https://github.com/org/repo/issues/41" autoFocus onChange={setRaw} onSubmit={create} />
        {error && <p className="worktrees-dialog__error">{error}</p>}
        <p className="worktrees-dialog__note">El nombre sale del título del issue y el agente arranca con el issue como primer prompt. Requiere `gh` autenticado.</p>
      </div>
    </Dialog>
  )
}
