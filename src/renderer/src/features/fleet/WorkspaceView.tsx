import { useHosts } from '@/store/hosts'
import type { JSX } from 'react'
import type { Workspace } from '@shared/types'
import { WindowHead } from '@/app/TitleBar'
import { commands } from '@/core/commands/registry'
import { Layout } from '@/panes/Layout'
import { Badge } from '@/ui/Badge'
import { Button } from '@/ui/Button'
import { Empty } from '@/ui/Empty'
import { AgentIcon, FolderPlus, ICON, OmniMark, Plus } from '@/ui/icons'
import { Kbd } from '@/ui/Kbd'
import { Tab, TabAction, TabLabel, Tabs, TabsEnd } from '@/ui/Tabs'
import { activeTabOf, leaves, tabsOf, useLayout } from '@/store/layout'
import { usePrefixLabel } from '@/store/settings'
import { useUi } from '@/store/ui'
import { currentProjectOf, liveAgent, projectOf, sessionTitle, shortPath, skipsPermissions, useSessions, workspaceOf } from '@/store/sessions'

/**
 * Vista del workspace actual: barra de tabs (windows de tmux) y el layout del tab activo. `hidden`
 * (otra vista en pantalla: Worktrees, revisión, broadcast) la esconde sin desmontarla: xterm y los panes siguen vivos.
 */
export function WorkspaceView({ hidden }: { hidden?: boolean } = {}): JSX.Element {
  const currentWorkspaceId = useSessions((s) => s.currentWorkspaceId)
  const workspace = useSessions((s) => workspaceOf(s, currentWorkspaceId ?? ''))
  // Los nombres de servidor llegan después de arrancar: suscribirse repinta la ruta con el host.
  useHosts((s) => s.hosts)
  // Sin workspace puede haber un proyecto vacío bajo el cursor (§3.5c): se nombra y se ofrece su primera carpeta.
  const project = useSessions((s) => (workspace ? projectOf(s, workspace.projectId) : currentProjectOf(s)))
  const tabs = useLayout((s) => s.tabs)
  const activeTab = useLayout((s) => s.activeTab)
  const activateTab = useSessions((s) => s.activateTab)
  const sidebarHidden = useUi((s) => s.sidebarCollapsed)
  const wsTabs = workspace ? tabsOf({ tabs }, workspace.id) : []
  const active = workspace ? activeTabOf({ tabs, activeTab }, workspace.id) : undefined

  if (!workspace || !active) {
    return (
      <main className="main" hidden={hidden}>
        {sidebarHidden && (
          <div className="empty-head">
            <WindowHead sidebarVisible={false} />
          </div>
        )}
        <Empty title={project?.name ?? 'omni'} icon={<OmniMark size={56} />}>
          {workspace && <div className="empty__meta">{whereOf(workspace)}</div>}
          {!workspace && project && <div className="empty__meta">Sin carpetas todavía</div>}
          <div>
            <Kbd>⌘T</Kbd> nueva terminal o agente · <Kbd>⌘O</Kbd> abrir proyecto · <Kbd>⌘K</Kbd> buscar
          </div>
          {workspace && (
            <Button variant="primary" kbd="⌘T" onClick={() => void commands.run('launcher.open')}>
              <Plus size={14} strokeWidth={ICON.strokeWidth} aria-hidden="true" />
              <span>Nuevo agente</span>
            </Button>
          )}
          {!workspace && project && (
            <Button variant="primary" onClick={() => void commands.run('project.addLocation')}>
              <FolderPlus size={14} strokeWidth={ICON.strokeWidth} aria-hidden="true" />
              <span>Agregar carpeta</span>
            </Button>
          )}
        </Empty>
      </main>
    )
  }

  return (
    <main className="main" hidden={hidden}>
      <Tabs>
        {sidebarHidden && <WindowHead sidebarVisible={false} />}
        {wsTabs.map((t, i) => (
          <WorkspaceTab key={t.id} index={i} tabId={t.id} active={t.id === active.id} onSelect={() => activateTab(t.id)} />
        ))}
        <TabAction label="Nuevo tab" title="Nuevo tab (⌘T)" onClick={() => void commands.run('launcher.open')}>
          <Plus size={14} strokeWidth={ICON.strokeWidth} aria-hidden="true" />
        </TabAction>
        <TabsEnd title={workspace.host ? `${hostName(workspace.host)}:${workspace.path}` : workspace.path}>{whereOf(workspace)}</TabsEnd>
      </Tabs>
      <div className="panes">
        <Layout tab={active} />
      </div>
    </main>
  )
}

function WorkspaceTab({ index, tabId, active, onSelect }: { index: number; tabId: string; active: boolean; onSelect(): void }): JSX.Element {
  const tab = useLayout((s) => s.tabs.find((t) => t.id === tabId))
  const panes = tab ? leaves(tab.root) : []
  const lead = panes.find((l) => l.id === tab?.focusedPaneId) ?? panes[0]
  const session = useSessions((s) => s.sessions.find((x) => x.id === lead?.sessionId))
  const title = useSessions((s) => (session ? sessionTitle(s, session) : 'tab'))
  const agent = useSessions((s) => (session ? liveAgent(s, session) : null))
  const prefix = usePrefixLabel()
  return (
    <Tab active={active} title={`Tab ${index + 1}${session && skipsPermissions(session) ? ' · sin permisos' : ''}`} onSelect={onSelect} onClose={() => void commands.run('tab.close')} closeLabel={`Cerrar tab (${prefix} &)`}>
      {agent && <AgentIcon agent={agent} size={13} />}
      <TabLabel>{title}</TabLabel>
      {panes.length > 1 && <Badge>{panes.length}</Badge>}
      {tab?.zoomedPaneId && <Badge tone="mark">Z</Badge>}
    </Tab>
  )
}

/** Nombre del servidor de un workspace remoto (§3.26). */
function hostName(hostId: string): string {
  return useHosts.getState().nameOf(hostId)
}

/** Dónde corre lo del workspace: la ruta corta y, si es remoto, el servidor delante (`mi-vps:~/api`). */
function whereOf(workspace: Workspace): string {
  if (!workspace.host) return shortPath(workspace.path)
  return `${hostName(workspace.host)}:${workspace.path.replace(/^\/home\/[^/]+|^\/root(?=\/|$)/, '~')}`
}
