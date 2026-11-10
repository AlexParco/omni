import { join } from 'node:path'
import { app, BrowserWindow, powerMonitor, protocol } from 'electron'
import type { ReviveSummary, Workspace } from '@shared/types'
import { BUILD_STAMP } from '../daemon/build'
import { registerIpc } from './ipc'
import { nodeExecPath } from './node-exec'
import { findAgent } from './services/agents'
import { BroadcastStore } from './services/broadcasts'
import { BrowserService } from './services/browser'
import { CONTROL_SOCK, ControlServer } from './services/control'
import { CostTracker } from './services/cost'
import { DaemonClient } from './services/daemon-client'
import { DocService } from './services/docs'
import { createFileProtocolHandler, FILE_SCHEME } from './services/file-protocol'
import { FileIndex, FileWatcher } from './services/files'
import { applyLoginItem } from './services/login-item'
import { Notifier } from './services/notifications'
import { BranchCache, GitService } from './services/git'
import { ProfileStore } from './services/profiles'
import { ProjectStore } from './services/projects'
import { HostRegistry } from './services/host-registry'
import { HostStore } from './services/hosts'
import { PtyManager } from './services/pty'
import { currentClaudeChats, remoteRecovery, reviveRemote, reviveSessions } from './services/revive'
import type { SessionBackend } from './services/session-backend'
import { SettingsStore } from './services/settings'
import { StateStore } from './services/state'
import { TodoStore } from './services/todos'
import { WhisperService } from './services/whisper'
import { DiagnosticsService } from './services/diagnostics'
import { LspService, resolveRemoteServer } from './services/lsp'
import { WorktreeService } from './services/worktrees'
import { buildMenu, createWindow, getMainWindow } from './window'

// OMNI_CDP_PORT expone Chrome DevTools Protocol para pruebas automatizadas del renderer (teclas,
// DOM) sin tocar el escritorio. Solo si la variable viene puesta a mano (dev o la app empaquetada
// lanzada desde una terminal para probarla); nunca por defecto.
if (process.env.OMNI_CDP_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.OMNI_CDP_PORT)
}

// En dev Electron avisa por consola que el renderer no tiene CSP y el aviso inunda la consola embebida.
// Solo se silencia fuera del build empaquetado; el CSP del renderer sigue pendiente (ARCHITECTURE §6).
if (!app.isPackaged) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

// `omni-file://<workspaceId>/<ruta>` (ARCHITECTURE §3.20): los privilegios solo se declaran antes de `ready`.
// Sin `supportFetchAPI` ni service workers: el pane solo lo usa en `<img>` y en el visor PDF, y así una
// página servida por el protocolo no puede leer el workspace con `fetch()`.
protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: { standard: true, secure: true, stream: true } }])

// Bootstrap: aquí solo se cablean servicios. Nada de lógica.
// Los PTY viven en `omni-daemon` y sobreviven a la app (ARCHITECTURE §3.10); `OMNI_DAEMON=0` los deja en proceso.
const ptys: SessionBackend =
  process.env.OMNI_DAEMON === '0'
    ? new PtyManager()
    : new DaemonClient({
        build: BUILD_STAMP,
        // `OMNI_KEEP_DAEMON=1` emula la app empaquetada en dev (e2e de "Actualizar terminales", §3.10c).
        restartOnBuildMismatch: !app.isPackaged && process.env.OMNI_KEEP_DAEMON !== '1',
        script: join(__dirname, 'daemon.js'),
        // El Helper del bundle: con el ejecutable principal macOS tomaba al daemon por la app abierta.
        execPath: nodeExecPath()
      })
const projects = new ProjectStore()
// Hosts remotos por SSH (ARCHITECTURE §3.26): este Mac y los servidores de hosts.json.
const hosts = new HostRegistry({
  store: new HostStore(),
  // CLI `omni` en cada servidor (§3.26): el socket de control se reenvía allá y `bin/` se copia.
  cli: { controlSock: process.env.OMNI_SOCK || CONTROL_SOCK, binDir: app.isPackaged ? join(process.resourcesPath, 'bin') : join(app.getAppPath(), 'bin') }
})
const settings = new SettingsStore()
const state = new StateStore()
const profiles = new ProfileStore()
const todos = new TodoStore()
const broadcasts = new BroadcastStore()
// Socket de control (ARCHITECTURE §3.21): el puente lo cablea `registerIpc`; aquí solo vive y muere.
// `OMNI_SOCK` cambia la ruta del socket (pruebas con otro omni abierto); el cliente lee la misma variable.
const control = new ControlServer({ sockPath: process.env.OMNI_SOCK || undefined })
// El índice no importa ProjectStore: recibe los workspaces vivos por función (ARCHITECTURE §4).
// Una ubicación que cuelga de otra del mismo proyecto y host ya cae en su índice: indexarla aparte
// duplicaría cada archivo. Las que están en otro lado (`shop/` y `sales/…`) se indexan cada una (§3.5c).
const files = new FileIndex({ workspaces: () => withoutNested(projects.workspaces()), hosts })
// Documentos (ARCHITECTURE §3.19): sesiones sin proceso como los navegadores, y el vigilante de archivos del editor.
const docs = new DocService()
const watcher = new FileWatcher()
const branches = new BranchCache()
// Worktrees y revisión (ARCHITECTURE §3.15–3.16): el catálogo se inyecta; el merge borra el worktree por función, no por import.
const worktrees = new WorktreeService({ registry: projects, hosts })
const git = new GitService({ registry: projects, removeWorktree: (id) => worktrees.remove(id), hosts })
// Las vistas se montan sobre la ventana principal, que se crea después: se resuelve perezosamente.
const browsers = new BrowserService({ getWindow: getMainWindow, getPrefix: () => settings.get().prefix, profiles })
// Notificaciones nativas (ARCHITECTURE §3.14): el ajuste se lee en cada aviso y la ventana se resuelve perezosamente.
const notifier = new Notifier({
  getSetting: () => settings.get().notifications,
  isFocused: () => getMainWindow()?.isFocused() ?? false,
  focusWindow: () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})
// Costo como piso (ARCHITECTURE §3.17): lee los logs de los CLIs para las sesiones vivas del daemon y solo sondea con la ventana enfocada.
const cost = new CostTracker({
  // Cada sesión con su host: un cwd del VPS solo se compara con los logs de ese VPS (§3.26).
  sessions: async () => (await ptys.list()).map((s) => {
    const host = projects.workspace(s.workspaceId)?.host
    return host ? { ...s, host } : s
  }),
  // Hosts conectados con sesiones vivas: sus logs de Claude Code y Codex también cuentan.
  remotes: async () => {
    const live = new Set((await ptys.list()).map((s) => projects.workspace(s.workspaceId)?.host).filter((h): h is string => h !== undefined))
    const connected = [...live].filter((id) => hosts.statusOf(id).state === 'connected')
    return Promise.all(connected.map((id) => hosts.costLogs(id)))
  },
  isFocused: () => getMainWindow()?.isFocused() ?? false
})
// Dictado local (ARCHITECTURE §3.22): whisper-cli + modelo en ~/.config/omni/models.
// `OMNI_FAKE_WHISPER` (texto fijo sin binario) solo vale en dev: la app empaquetada nunca lo lee.
const diagnostics = new DiagnosticsService()
// Servidores de lenguaje del editor (§3.19b): procesos hijos de main que mueren con la app, no con el renderer.
const lsp = new LspService({
  // Workspaces en un servidor (§3.26): el servidor de lenguaje se resuelve y corre allá, por ssh.
  remote: async (workspace, path) => (workspace.host ? resolveRemoteServer(await hosts.lspHost(workspace.host), workspace.path, path) : null)
})
const whisper = new WhisperService({ fakeText: app.isPackaged ? undefined : process.env.OMNI_FAKE_WHISPER })

/** Workspaces a indexar: sin las ubicaciones anidadas dentro de otra del mismo proyecto y host. */
function withoutNested(all: Workspace[]): Workspace[] {
  const roots = all.filter((w) => w.kind !== 'worktree')
  return all.filter((w) => w.kind !== 'folder' || !roots.some((r) => r.id !== w.id && r.projectId === w.projectId && r.host === w.host && w.path.startsWith(`${r.path}/`)))
}

/** Cuánto espera el arranque a revivir sesiones remotas antes de abrir la ventana. */
const REMOTE_REVIVE_WAIT_MS = 6000

/** Lo revivido en este arranque; se entrega una sola vez al renderer (una recarga no repite el aviso). */
let revivedSummary: ReviveSummary | null = null
function takeRevived(): ReviveSummary | null {
  const r = revivedSummary
  revivedSummary = null
  return r
}

/**
 * "Actualizar terminales" (§3.10c): daemon nuevo, las sesiones locales y remotas vuelven con su mismo
 * id (los agentes retoman su conversación) y la ventana se recarga para leerlas como al arrancar.
 */
async function upgradeDaemon(): Promise<void> {
  // El daemon viejo no sigue los `/resume` de Claude Code: se leen los chats en curso antes de apagarlo.
  const resumeOverrides = await currentClaudeChats(await ptys.list(), (await ptys.pids()).sessions).catch(() => ({}))
  await ptys.upgrade()
  const local = await reviveSessions({ backend: ptys, workspace: (id) => projects.workspace(id), findAgent, enabled: true, resumeOverrides })
  const remote = await reviveRemote({ backend: ptys, workspace: (id) => projects.workspace(id), findAgent, hosts, enabled: true })
  const total = local.sessions.length + remote.sessions.length
  revivedSummary = { sessions: total, resumed: local.resumed + remote.resumed, reason: 'upgrade' }
  getMainWindow()?.webContents.reload()
}

app.whenReady().then(async () => {
  // Primer arranque sin proyectos: se registra la carpeta desde la que se lanzó.
  if (projects.list().length === 0) projects.add(process.env.OMNI_CWD || process.cwd())

  // El daemon tiene que responder antes de que el renderer pida `session:list`.
  try {
    await ptys.start()
  } catch (err) {
    console.error('[omni] sin daemon de terminales:', err)
  }
  // Tras un reinicio de la Mac (o una caída del daemon) vuelven las terminales de antes, con sus
  // mismos ids, antes de que el renderer pida `session:list` (ARCHITECTURE §3.10b).
  try {
    const result = await reviveSessions({ backend: ptys, workspace: (id) => projects.workspace(id), findAgent, enabled: settings.get().reviveSessions })
    if (result.sessions.length) revivedSummary = { sessions: result.sessions.length, resumed: result.resumed }
  } catch (err) {
    console.warn('[omni] no se pudieron revivir las sesiones:', err)
  }
  applyLoginItem(settings.get().openAtLogin)
  // Remotas (§3.26): se conecta a sus hosts con un tope; lo que no llega a tiempo sigue en segundo plano
  // y aparece por `session:added`. Así un VPS caído no frena el arranque.
  const remoteRevive = reviveRemote({ backend: ptys, workspace: (id) => projects.workspace(id), findAgent, hosts, enabled: settings.get().reviveSessions })
  const early = await Promise.race([remoteRevive.then((r) => ({ r })), new Promise<null>((done) => setTimeout(() => done(null), REMOTE_REVIVE_WAIT_MS))])
  if (early?.r.sessions.length) revivedSummary = { sessions: (revivedSummary?.sessions ?? 0) + early.r.sessions.length, resumed: (revivedSummary?.resumed ?? 0) + early.r.resumed }
  showBrand()
  buildMenu()
  const ipc = registerIpc({ ptys, hosts, revived: { take: () => takeRevived() }, projects, settings, browsers, profiles, state, files, todos, branches, notifier, worktrees, git, cost, broadcasts, docs, watcher, whisper, control, diagnostics, lsp, daemon: { upgrade: upgradeDaemon } })
  // El handler del protocolo solo se puede registrar con la app lista; va antes de la ventana para que el primer preview ya lo encuentre.
  protocol.handle(FILE_SCHEME, createFileProtocolHandler(() => projects.workspaces(), async (id) => (await hosts.ensure(id)).fs))
  createWindow()
  if (!early) void remoteRevive.then((r) => ipc.sessionsAdded(r.sessions))
  // Un host que se conecta (a mano o al reconectar) revive lo que quedó pendiente de él.
  hosts.onStatus((status) => {
    if (status.state !== 'connected') return
    void reviveRemote({ backend: ptys, workspace: (id) => projects.workspace(id), findAgent, hosts, enabled: settings.get().reviveSessions, hostId: status.hostId }).then((r) => ipc.sessionsAdded(r.sessions))
  })
  // Ssh caído con la app abierta (tapa cerrada, cambio de red): la terminal queda huérfana en el daemon
  // y se reintenta revivirla hasta que el host vuelva (§3.26). También al despertar la Mac.
  const recovery = remoteRecovery({
    pendingHosts: async () => [...new Set((await ptys.orphans()).map((o) => projects.workspace(o.workspaceId)?.host).filter((h): h is string => !!h))],
    revive: async (hostId) => {
      // Comprueba el ControlMaster (tras dormir suele estar muerto) y lo rehace antes de enganchar.
      await hosts.connect(hostId)
      return (await reviveRemote({ backend: ptys, workspace: (id) => projects.workspace(id), findAgent, hosts, enabled: settings.get().reviveSessions, hostId })).sessions
    },
    added: (list) => ipc.sessionsAdded(list)
  })
  ptys.onExit((_id, code) => {
    if (code === 255) recovery.kick()
  })
  powerMonitor.on('resume', () => recovery.kick())
  app.on('will-quit', () => recovery.stop())
  // Hosts con carpetas de algún proyecto: se conectan solos al abrir (sin esperar).
  for (const id of new Set(projects.list().flatMap((p) => p.locations.map((l) => l.host).filter((h): h is string => !!h)))) void hosts.connect(id)
  cost.start()
  control.start().catch((err: unknown) => console.warn('[omni] sin socket de control:', err))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Cerrar omni no cierra nada: las terminales y agentes siguen en el daemon. Solo los navegadores
// (vistas de esta ventana) se cierran; se recrean al abrir desde state.json.
app.on('will-quit', () => {
  void control.close()
  // Al salir no se espera la gracia de SIGTERM: SIGKILL al grupo de cada servidor (también sus hijos).
  lsp.killAll()
})

app.on('window-all-closed', () => {
  browsers.killAll()
  lsp.stopAll()
  app.quit()
})

/**
 * Logo de omni fuera de la ventana (design/brand): panel "Acerca de omni" del menú de la app y, en
 * desarrollo, el icono del Dock. La app empaquetada ya trae `build/icon.icns` en el bundle; el Electron
 * de desarrollo mostraría el suyo.
 */
function showBrand(): void {
  const devIcon = app.isPackaged ? undefined : join(app.getAppPath(), 'build/icon.png')
  if (devIcon && process.platform === 'darwin') app.dock?.setIcon(devIcon)
  app.setAboutPanelOptions({
    applicationName: 'omni',
    applicationVersion: app.getVersion(),
    credits: 'Todos tus agentes en una sola ventana',
    ...(devIcon ? { iconPath: devIcon } : {})
  })
}
