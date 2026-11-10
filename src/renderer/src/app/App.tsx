import { HostAddDialog } from '@/features/hosts/HostAddDialog'
import { LocationPathDialog } from '@/features/hosts/LocationPathDialog'
import { LocationPicker } from '@/features/hosts/LocationPicker'
import { LocationRenameDialog, ProjectAddPicker, ProjectMergePicker, ProjectNewDialog, ProjectRenameDialog } from '@/features/hosts/ProjectDialogs'
import type { JSX } from 'react'
import { useEffect } from 'react'
import { BroadcastNewDialog } from '@/features/broadcast/BroadcastNewDialog'
import { BroadcastView } from '@/features/broadcast/BroadcastView'
import { BrowserMenu } from '@/features/browser/BrowserMenu'
import { BrowserSettings } from '@/features/browser/BrowserSettings'
import { ProfileNameDialog } from '@/features/browser/ProfileNameDialog'
import { SendCapture } from '@/features/capture/SendCapture'
import { ConfirmDiscardDoc } from '@/features/editor/ConfirmDiscardDoc'
import { ConfirmOverwriteDoc } from '@/features/editor/ConfirmOverwriteDoc'
import { EditorPathDialog } from '@/features/editor/EditorPathDialog'
import { Launcher } from '@/features/launcher/Launcher'
import { KeySheet } from '@/features/palette/KeySheet'
import { Palette } from '@/features/palette/Palette'
import { QuickOpen } from '@/features/quickopen/QuickOpen'
import { ConfirmKill } from '@/features/fleet/ConfirmKill'
import { ConfirmUpgrade } from '@/features/daemon/ConfirmUpgrade'
import { useDaemon } from '@/store/daemon'
import { ConfirmShutdown } from '@/features/fleet/ConfirmShutdown'
import { ConfirmRemoveLocation } from '@/features/fleet/ConfirmRemoveLocation'
import { ProjectMenu } from '@/features/fleet/ProjectMenu'
import { FolderPicker } from '@/features/fleet/FolderPicker'
import { ConfirmMerge } from '@/features/review/ConfirmMerge'
import { ReviewView } from '@/features/review/ReviewView'
import { Sidebar } from '@/features/fleet/Sidebar'
import { SettingsPanel } from '@/features/settings/SettingsPanel'
import { PortsWidget } from '@/features/ports/PortsWidget'
import { UsageWidget } from '@/features/usage/UsageWidget'
import { TodoWidget } from '@/features/todo/TodoWidget'
import { useHoldKey } from '@/features/voice/useHoldKey'
import { VoiceOverlay } from '@/features/voice/VoiceOverlay'
import { WorkspaceView } from '@/features/fleet/WorkspaceView'
import { ConfirmDiscard } from '@/features/worktrees/ConfirmDiscard'
import { TestCommandDialog } from '@/features/worktrees/TestCommandDialog'
import { WorktreeIssueDialog } from '@/features/worktrees/WorktreeIssueDialog'
import { WorktreeNameDialog } from '@/features/worktrees/WorktreeNameDialog'
import { WorktreesView } from '@/features/worktrees/WorktreesView'
import { applyTerminalSettings } from '@/panes/terminal/terminal-host'
import { useBroadcast } from '@/store/broadcast'
import { useBrowser } from '@/store/browser'
import { useControl } from '@/store/control'
import { useCost } from '@/store/cost'
import { initNotify } from '@/store/notify'
import { startPersist } from '@/store/persist'
import { useReview } from '@/store/review'
import { useSessions } from '@/store/sessions'
import { useSettings } from '@/store/settings'
import { usePorts } from '@/store/ports'
import { useTodos } from '@/store/todos'
import { useUi, watchWindowFocus } from '@/store/ui'
import { useWorktrees } from '@/store/worktrees'
import { registerAppCommands } from './commands'
import { Footer } from './Footer'
import { applyKeybindings } from './keybindings'
import { TitleBar } from './TitleBar'
import { useKeyboard } from './useKeyboard'
import './shell.css'

// Los ajustes mandan sobre el keymap y las terminales vivas; se escucha una sola vez por módulo.
applyKeybindings(useSettings.getState().settings)
useSettings.subscribe((s, prev) => {
  if (s.settings.prefix !== prev.settings.prefix || s.settings.keys !== prev.settings.keys) applyKeybindings(s.settings)
  applyTerminalSettings(s.settings)
})

export function App(): JSX.Element {
  const overlay = useUi((s) => s.overlay)
  const focus = useUi((s) => s.focus)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const view = useUi((s) => s.view)
  // Con el sidebar oculto, la flota lleva la cabecera de la ventana en su fila de tabs; las demás vistas no
  // tienen esa fila y recuperan la barra superior.
  const titleBar = sidebarCollapsed && view !== 'fleet'
  const init = useSessions((s) => s.init)
  const initSettings = useSettings((s) => s.init)
  const initBrowser = useBrowser((s) => s.init)
  useKeyboard()
  // Mantener/soltar ⌥Space (dictado, §3.22): va después de useKeyboard para ver la pulsación inicial ya resuelta.
  useHoldKey()

  useEffect(() => {
    const unregister = registerAppCommands()
    let unsubscribeSettings: (() => void) | undefined
    void initSettings().then((off) => (unsubscribeSettings = off))
    const unsubscribeBrowser = initBrowser()
    // El estado (layout, workspace actual) se guarda tras cada cambio; `init` lo restaura antes de habilitarlo.
    const stopPersist = startPersist()
    // Tareas: `todo:list`, vínculos con sesiones y persistencia con debounce (ARCHITECTURE §3.12).
    const stopTodos = useTodos.getState().init()
    // Puertos: `ports:list` cada 2 s con el widget abierto y cada 10 s con la ventana enfocada, para el conteo del sidebar (ARCHITECTURE §3.24).
    const stopPorts = usePorts.getState().init()
    // Notificaciones nativas: pregunta y sin leer → `notify:show`; clic → entrar al pane (ARCHITECTURE §3.14).
    const stopNotify = initNotify()
    // Revisión: recarga el diff con `worktree:changed` y vuelve a Worktrees si el worktree desaparece (ARCHITECTURE §3.16).
    const stopReview = useReview.getState().init()
    // Costo del día: `cost:summary`, `cost:changed` y repetición cada minuto con foco (ARCHITECTURE §3.17).
    const stopCost = useCost.getState().init()
    // Worktrees: `worktree:changed`, estado git/tests por worktree y tests al terminar un agente (ARCHITECTURE §3.15).
    const stopWorktrees = useWorktrees.getState().init()
    // Broadcast: `broadcast:list`, rondas al día con worktrees y sesiones, y resúmenes de las tarjetas (ARCHITECTURE §3.18).
    const stopBroadcast = useBroadcast.getState().init()
    // Socket de control y bus MCP: `app:command` → stores → `app:commandResult` (ARCHITECTURE §3.21).
    const stopControl = useControl.getState().init()
    // Foco de la ventana para 'sin leer': en segundo plano un pane en pantalla no cuenta como visto (ARCHITECTURE §3.14).
    const stopWindowFocus = watchWindowFocus()
    // Daemon de otro build (app empaquetada): el pie ofrece "Actualizar terminales" (ARCHITECTURE §3.10c).
    void useDaemon.getState().refresh()
    void init()
    return () => {
      unregister()
      unsubscribeSettings?.()
      unsubscribeBrowser()
      stopPersist()
      stopTodos()
      stopPorts()
      stopNotify()
      stopReview()
      stopCost()
      stopWorktrees()
      stopBroadcast()
      stopControl()
      stopWindowFocus()
    }
  }, [init, initSettings, initBrowser])

  return (
    <div className="app" data-focus={focus} data-titlebar={titleBar || undefined}>
      {titleBar && <TitleBar />}
      <div className="body">
        <Sidebar />
        <WorkspaceView hidden={view !== 'fleet'} />
        {view === 'review' && <ReviewView />}
        {view === 'worktrees' && <WorktreesView />}
        {view === 'broadcast' && <BroadcastView />}
      </div>
      <Footer />
      {overlay === 'launcher' && <Launcher />}
      {overlay === 'palette' && <Palette />}
      {overlay === 'quickopen' && <QuickOpen />}
      {overlay === 'projectMenu' && <ProjectMenu />}
      {overlay === 'folderPicker' && <FolderPicker />}
      {overlay === 'locationPicker' && <LocationPicker />}
      {overlay === 'locationPath' && <LocationPathDialog />}
      {overlay === 'hostAdd' && <HostAddDialog />}
      {overlay === 'projectNew' && <ProjectNewDialog />}
      {overlay === 'projectRename' && <ProjectRenameDialog />}
      {overlay === 'projectMerge' && <ProjectMergePicker />}
      {overlay === 'confirmKill' && <ConfirmKill />}
      {overlay === 'confirmShutdown' && <ConfirmShutdown />}
      {overlay === 'confirmUpgrade' && <ConfirmUpgrade />}
      {overlay === 'locationRename' && <LocationRenameDialog />}
      {overlay === 'projectAdd' && <ProjectAddPicker />}
      {overlay === 'confirmRemoveLocation' && <ConfirmRemoveLocation />}
      {overlay === 'keys' && <KeySheet />}
      {overlay === 'settings' && <SettingsPanel />}
      {overlay === 'sendCapture' && <SendCapture />}
      {overlay === 'browserMenu' && <BrowserMenu />}
      {overlay === 'browserSettings' && <BrowserSettings />}
      {overlay === 'browserProfile' && <ProfileNameDialog />}
      {overlay === 'todo' && <TodoWidget />}
      {overlay === 'ports' && <PortsWidget />}
      {overlay === 'usage' && <UsageWidget />}
      {overlay === 'voice' && <VoiceOverlay />}
      {overlay === 'confirmMerge' && <ConfirmMerge />}
      {overlay === 'confirmDiscard' && <ConfirmDiscard />}
      {overlay === 'worktreeName' && <WorktreeNameDialog />}
      {overlay === 'worktreeIssue' && <WorktreeIssueDialog />}
      {overlay === 'testCommand' && <TestCommandDialog />}
      {overlay === 'broadcastNew' && <BroadcastNewDialog />}
      {overlay === 'editorPath' && <EditorPathDialog />}
      {overlay === 'confirmDiscardDoc' && <ConfirmDiscardDoc />}
      {overlay === 'confirmOverwriteDoc' && <ConfirmOverwriteDoc />}
    </div>
  )
}
