import { useMemo, useState, type JSX } from 'react'
import type { AgentDef, AgentId } from '@shared/types'
import { commands } from '@/core/commands/registry'
import { broadcastProjectId, useBroadcast } from '@/store/broadcast'
import { projectOf, useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { Button, IconButton } from '@/ui/Button'
import { Dialog } from '@/ui/Dialog'
import { Hint } from '@/ui/Hint'
import { AgentIcon, ICON_SM, Plus } from '@/ui/icons'
import { TextArea } from '@/ui/TextArea'
import { Toggle } from '@/ui/Toggle'
import './broadcast.css'

/** Agentes que se pueden lanzar en una ronda: los del catálogo con comando (ni shell ni navegador). */
export function launchableAgents(agents: readonly AgentDef[]): AgentDef[] {
  return agents.filter((a) => a.command !== null && a.id !== 'browser')
}

/** Lista de agentes a lanzar a partir de las veces elegidas por chip, en el orden del catálogo. */
export function expandCounts(agents: readonly AgentDef[], counts: Readonly<Partial<Record<AgentId, number>>>): AgentId[] {
  const out: AgentId[] = []
  for (const a of agents) for (let i = 0; i < (counts[a.id] ?? 0); i++) out.push(a.id)
  return out
}

/**
 * Diálogo "Nueva ronda" (`broadcast.new`, ARCHITECTURE §3.18): prompt obligatorio, chips con los agentes
 * del catálogo (varios, mínimo uno; `+` repite uno), la línea de tests del proyecto con atajo para
 * editarla, y `⌘⏎` lanza. El proyecto es el actual. El prompt a medio escribir sobrevive a cerrar el
 * diálogo para ir a editar el comando de tests (`draft` en el store).
 */
export function BroadcastNewDialog(): JSX.Element | null {
  const agents = useSessions((s) => s.agents)
  const projects = useSessions((s) => s.projects)
  const workspaces = useSessions((s) => s.workspaces)
  const currentWorkspaceId = useSessions((s) => s.currentWorkspaceId)
  const draft = useBroadcast((s) => s.draft)
  const setDraft = useBroadcast((s) => s.setDraft)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const launchable = useMemo(() => launchableAgents(agents), [agents])
  const [counts, setCounts] = useState<Partial<Record<AgentId, number>>>(() => {
    const first = launchable.find((a) => a.id === 'claude') ?? launchable[0]
    return first ? { [first.id]: 1 } : {}
  })
  const projectId = broadcastProjectId({ workspaces, currentWorkspaceId })
  const project = projectId !== null ? projectOf({ projects }, projectId) : undefined
  if (!project) return null

  const chosen = expandCounts(launchable, counts)
  const ready = draft.trim() !== '' && chosen.length > 0
  const bump = (id: AgentId, delta: number): void => setCounts((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) + delta) }))
  const toggle = (id: AgentId): void => setCounts((c) => ({ ...c, [id]: (c[id] ?? 0) > 0 ? 0 : 1 }))

  const launch = (): void => {
    if (!ready) return
    closeOverlay()
    void useBroadcast.getState().create({ prompt: draft, agents: chosen })
  }
  const editTests = (): void => {
    // El diálogo del comando de tests reemplaza a este; el prompt queda en `draft` para la vuelta.
    closeOverlay()
    void commands.run('project.setTestCommand')
  }

  return (
    <Dialog
      title="Nueva ronda"
      subtitle={`${project.name} · un worktree por agente, el prompt como primer mensaje`}
      onClose={closeOverlay}
      footer={
        <>
          <Hint kbd="⌘⏎">lanzar</Hint>
          <Hint kbd="Esc">cancelar</Hint>
          <span className="broadcast-dialog__actions">
            <Button onClick={closeOverlay}>Cancelar</Button>
            <Button variant="primary" disabled={!ready} onClick={launch}>
              {chosen.length > 1 ? `Lanzar ${chosen.length} agentes` : 'Lanzar'}
            </Button>
          </span>
        </>
      }
    >
      <div className="broadcast-dialog">
        <div className="broadcast-dialog__section">
          <span className="broadcast-dialog__label">Prompt</span>
          <TextArea label="Prompt de la ronda" value={draft} placeholder="Qué tienen que hacer los agentes" autoFocus rows={4} onChange={setDraft} onSubmit={launch} onCancel={closeOverlay} />
        </div>
        <div className="broadcast-dialog__section">
          <span className="broadcast-dialog__label">Agentes</span>
          <div className="broadcast-dialog__agents" role="group" aria-label="Agentes de la ronda">
            {launchable.map((a) => (
              <span key={a.id} className="broadcast-dialog__agent">
                <Toggle on={(counts[a.id] ?? 0) > 0} count={(counts[a.id] ?? 0) > 1 ? counts[a.id] : undefined} title={`${a.name} · ${a.command ?? ''}`} onClick={() => toggle(a.id)}>
                  <AgentIcon agent={a.id} size={14} />
                  {a.name}
                </Toggle>
                <IconButton label={`Repetir ${a.name}`} title={`Otro ${a.badge} en la ronda`} size="sm" onClick={() => bump(a.id, 1)}>
                  <Plus {...ICON_SM} aria-hidden="true" />
                </IconButton>
              </span>
            ))}
            {launchable.length === 0 && <span className="broadcast-dialog__note">Ningún agente del catálogo tiene comando.</span>}
          </div>
        </div>
        <div className="broadcast-dialog__section">
          <span className="broadcast-dialog__label">Tests al terminar</span>
          <div className="broadcast-dialog__tests">
            <span className="broadcast-dialog__tests-cmd" data-empty={!project.testCommand || undefined}>
              {project.testCommand ?? 'sin comando de tests'}
            </span>
            <Button quiet title="Comando de tests del proyecto" onClick={editTests}>
              editar
            </Button>
          </div>
          <p className="broadcast-dialog__note">Corre en cada worktree cuando su agente se calla, como en Worktrees.</p>
        </div>
      </div>
    </Dialog>
  )
}
