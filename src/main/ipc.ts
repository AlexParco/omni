import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join, posix, resolve } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, net, shell, type WebContents } from 'electron'
import type { IpcEventMap, IpcInvokeMap, IpcSendMap } from '@shared/ipc'
import type { AppState, ReviveSummary, SessionInfo, Workspace } from '@shared/types'
import { externalUrl } from '@shared/url'
import { findAgent, listAgents } from './services/agents'
import { applyLoginItem } from './services/login-item'
import type { HostRegistry } from './services/host-registry'
import { launchCommand } from './services/revive'
import type { BroadcastStore } from './services/broadcasts'
import { sanitizeBroadcasts } from './services/broadcasts'
import type { BrowserService } from './services/browser'
import { BrowserAgent, isPageOp, validatePageArgs } from './services/browser-agent'
import type { ControlServer } from './services/control'
import type { CostTracker } from './services/cost'
import { UsageService } from './services/usage'
import type { DocService } from './services/docs'
import { DiagnosticsService } from './services/diagnostics'
import type { LspService } from './services/lsp'
import type { FileIndex, FileWatcher } from './services/files'
import { isInside, isInsideForWrite, listTree, readTextFile, checkDropSize, dropName, saveDropped, WatchLedger, writeTextFile } from './services/files'
import { isInsidePosix, listRemoteTree, readRemoteText, RemoteWatcher, writeRemoteText } from './services/remote-files'
import type { BranchCache, GitService } from './services/git'
import type { Notifier } from './services/notifications'
import type { ProfileStore } from './services/profiles'
import type { ProjectStore } from './services/projects'
import { suggestProjectPaths, validateProjectPath } from './services/projects'
import type { SessionBackend } from './services/session-backend'
import type { SettingsStore } from './services/settings'
import type { StateStore } from './services/state'
import { PortScanner } from './services/ports'
import type { TodoStore } from './services/todos'
import { sanitizeTodos } from './services/todos'
import type { WhisperService } from './services/whisper'
import type { WorktreeService } from './services/worktrees'

/** Entre comillas simples solo si hace falta (espacios o caracteres raros), para pegar la línea en una terminal. */
export function shellQuote(s: string): string {
  return /^[\w./@:+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** Helpers tipados: el único lugar donde se tocan ipcMain y webContents.send. */
function handle<K extends keyof IpcInvokeMap>(
  channel: K,
  fn: (...args: IpcInvokeMap[K]['req']) => IpcInvokeMap[K]['res'] | Promise<IpcInvokeMap[K]['res']>
): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as IpcInvokeMap[K]['req'])))
}

/** Como `handle`, pero el handler recibe el `webContents` que invoca (para atar recursos a un renderer concreto). */
function handleFrom<K extends keyof IpcInvokeMap>(
  channel: K,
  fn: (sender: WebContents, ...args: IpcInvokeMap[K]['req']) => IpcInvokeMap[K]['res'] | Promise<IpcInvokeMap[K]['res']>
): void {
  ipcMain.handle(channel, (e, ...args) => fn(e.sender, ...(args as IpcInvokeMap[K]['req'])))
}

function on<K extends keyof IpcSendMap>(channel: K, fn: (...args: IpcSendMap[K]) => void): void {
  ipcMain.on(channel, (_e, ...args) => fn(...(args as IpcSendMap[K])))
}

function emit<K extends keyof IpcEventMap>(channel: K, ...args: IpcEventMap[K]): void {
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, ...args))
}

export interface IpcDeps {
  ptys: SessionBackend
  hosts: HostRegistry
  /** Lo revivido al arrancar; el renderer lo pide una vez para avisar. */
  revived: { take: () => ReviveSummary | null }
  projects: ProjectStore
  settings: SettingsStore
  browsers: BrowserService
  profiles: ProfileStore
  state: StateStore
  files: FileIndex
  todos: TodoStore
  branches: BranchCache
  notifier: Notifier
  worktrees: WorktreeService
  git: GitService
  cost: CostTracker
  docs: DocService
  watcher: FileWatcher
  broadcasts: BroadcastStore
  whisper: WhisperService
  control: ControlServer
  diagnostics: DiagnosticsService
  lsp: LspService
  /** Actualización del daemon (§3.10c): main la orquesta porque después hay que revivir y recargar. */
  daemon: { upgrade: () => Promise<void> }
}

/** Lo que main puede avisar al renderer fuera de un pedido suyo. */
export interface IpcHandle {
  /** Sesiones creadas por main (revividas en segundo plano): el renderer las abre en su tab. */
  sessionsAdded(list: SessionInfo[]): void
}

export function registerIpc({ ptys, hosts, revived, projects, settings, browsers, profiles, state, files, todos, branches, notifier, worktrees, git, cost, broadcasts, docs, watcher, whisper, control, diagnostics, lsp, daemon }: IpcDeps): IpcHandle {
  /** Finder y "abrir con" solo sobre rutas de algún workspace (resueltas, sin symlinks que escapen): el renderer no manda rutas arbitrarias al sistema. */
  const insideWorkspace = (path: string): string => {
    if (!isAbsolute(path)) throw new Error(`la ruta tiene que ser absoluta: ${path}`)
    const all = projects.workspaces()
    // Solo workspaces de este Mac: una ruta remota (§3.26) no existe aquí, o peor, es otro archivo con la misma ruta.
    if (isInside(path, all.filter((w) => !w.host).map((w) => w.path))) return path
    const remote = all.find((w) => w.host && isInsidePosix(path, w.path))
    if (remote?.host) throw new Error(`${path} está en ${hosts.nameOf(remote.host)}: no se puede abrir en el Mac`)
    throw new Error(`ruta fuera de los proyectos: ${path}`)
  }
  /** Sesiones de todos los dueños (PTY en el daemon, navegadores y documentos aquí), en orden de creación. */
  const sessions = async (): Promise<SessionInfo[]> => [...(await ptys.list()), ...browsers.list(), ...docs.list()].sort((a, b) => a.createdAt - b.createdAt)
  const kill = (id: string): void => {
    if (browsers.has(id)) return browsers.destroy(id)
    if (docs.has(id)) return docs.destroy(id)
    // Remota: cortar el ssh no basta, dtach mantendría viva la sesión en el host (§3.26).
    const host = projects.workspace(sessionWorkspace.get(id) ?? '')?.host
    if (host) void hosts.killSession(host, id)
    ptys.kill(id)
  }
  /** Lo que se escribe en state.json: el layout del renderer y los navegadores vivos con su URL actual (main manda). */
  const withBrowsers = (incoming: AppState): AppState => ({
    ...incoming,
    docs: docs.saved(),
    browsers: browsers.list().map((b) => {
      const s = browsers.state(b.id)
      return { id: b.id, workspaceId: b.workspaceId, url: s.url, profileId: s.profileId }
    }),
    savedAt: Date.now()
  })

  handle('agents:list', () => listAgents())

  /* navegador manejado por un agente (MCP `omni-browser`, ARCHITECTURE §3.23): main actúa sobre las vistas */
  const agent = new BrowserAgent({
    list: () => browsers.list(),
    state: (id) => browsers.state(id),
    webContents: (id) => browsers.webContents(id),
    bounds: (id) => browsers.bounds(id),
    lastShown: () => browsers.lastShown(),
    navigate: (id, url) => browsers.navigate(id, url),
    back: (id) => browsers.back(id),
    forward: (id) => browsers.forward(id),
    reload: (id) => browsers.reload(id),
    consoleTail: (id, lines) => browsers.consoleTail(id, lines),
    captureImage: (id) => browsers.captureImage(id),
    withAgentInput: (id, fn) => browsers.withAgentInput(id, fn),
    keepAwake: (id) => browsers.keepAwake(id),
    // Abrir y mostrar pasan por el renderer (layout, tabs): los mismos comandos `browser` y `show` del socket.
    open: async (url, from) => {
      const r = await control.handle({ type: 'browser', url, from })
      if (!r.ok) throw new Error(r.error)
      const id = (r.result as { sessionId?: unknown } | undefined)?.sessionId
      if (typeof id !== 'string') throw new Error('omni no devolvió el navegador nuevo')
      return id
    },
    show: async (id, from) => {
      const r = await control.handle({ type: 'show', sessionId: id, from })
      if (!r.ok) throw new Error(r.error)
    },
    notice: (id, from) => emit('control:sent', id, from)
  })

  /* socket de control (ARCHITECTURE §3.21): main resuelve `list` y `send`; el resto va al renderer como `app:command` */
  control.attach({
    page: (op, args, from) => {
      if (!isPageOp(op)) return null
      const v = validatePageArgs(op, args)
      if (!v.ok) return { error: v.error }
      return { run: () => agent.run(op, v.args, from) }
    },
    sessions,
    write: async (id, data) => {
      if (browsers.has(id) || docs.has(id)) throw new Error('la sesión no es una terminal')
      await ptys.write(id, data)
    },
    sent: (id, from) => emit('control:sent', id, from),
    workspace: (id) => projects.workspace(id),
    project: (id) => projects.project(id),
    agents: listAgents,
    emit: (command) => {
      if (BrowserWindow.getAllWindows().length === 0) return false
      emit('app:command', command)
      return true
    }
  })
  handle('app:commandResult', (id, result) => control.resolve(id, result))
  // En dev, el `bin/` del repo; empaquetado, `Resources/bin` (electron-builder `extraResources`).
  // Dos líneas: `omni` (sesiones, tareas, avisos) y `omni-browser` (el navegador manejado por el agente, §3.23).
  handle('mcp:command', () => {
    const bin = (file: string): string => shellQuote(app.isPackaged ? join(process.resourcesPath, 'bin', file) : join(app.getAppPath(), 'bin', file))
    return [`claude mcp add omni -- node ${bin('omni-mcp.mjs')}`, `claude mcp add omni-browser -- node ${bin('omni-browser-mcp.mjs')}`].join('\n')
  })

  handle('project:list', () => ({ projects: projects.list(), workspaces: projects.workspaces() }))
  // Sin diálogo: la ruta viene del renderer, así que se valida (carpeta real, dentro del home) antes de registrarla.
  handle('project:addPath', (raw) => {
    return projects.openFolder(undefined, validateProjectPath(raw))
  })
  handle('project:add', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: 'Abrir proyecto',
      properties: ['openDirectory', 'createDirectory']
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    return projects.openFolder(undefined, resolve(path))
  })
  handle('project:remove', async (id) => {
    ;(await sessions()).filter((s) => projects.workspace(s.workspaceId)?.projectId === id).forEach((s) => kill(s.id))
    // Solo se borran del disco los worktrees sin cambios; los que tienen trabajo se quedan y se le dicen al usuario.
    const keptWorktrees = await worktrees.removeProjectWorktrees(id)
    projects.remove(id)
    return { keptWorktrees }
  })
  handle('project:setTestCommand', (projectId, command, locationId) => projects.setTestCommand(projectId, command, locationId))
  handle('project:renameLocation', (locationId, name) => projects.renameLocation(locationId, name))
  handle('project:suggestPaths', (input) => suggestProjectPaths(input))
  handle('project:setHidden', (projectId, hidden) => projects.setHidden(projectId, hidden))
  handle('project:subfolders', (locationId) => projects.folderCandidates(locationId))
  handle('project:addFolder', (locationId, rel) => projects.addFolder(locationId, rel))
  handle('project:create', (name) => projects.create(name))
  handle('project:moveLocation', (workspaceId, delta) => projects.moveLocation(workspaceId, delta === -1 ? -1 : 1))
  const removeLocation = async (workspaceId: string, closeSessions = false): Promise<void> => {
    const workspace = projects.workspace(workspaceId)
    if (!workspace || workspace.kind === 'worktree') throw new Error(`no es una ubicación que se pueda quitar: ${workspaceId}`)
    if (projects.worktreesOf(workspace.projectId).some((w) => w.locationId === workspaceId)) throw new Error('esta carpeta tiene worktrees: elimínalos antes de quitarla')
    const alive = (await sessions()).filter((s) => s.workspaceId === workspaceId)
    if (alive.length > 0 && !closeSessions) throw new Error(`${workspace.name} tiene ${alive.length} ${alive.length === 1 ? 'sesión abierta' : 'sesiones abiertas'}: ciérralas antes de quitarla`)
    // Se matan antes de olvidar la ubicación: `kill` necesita su host para cerrar la sesión remota (§3.26).
    alive.forEach((s) => kill(s.id))
    projects.removeLocation(workspaceId)
  }
  handle('project:removeFolder', removeLocation)
  handle('project:removeLocation', removeLocation)
  handle('project:addRemote', async (hostId, raw) => {
    return projects.openRemote(hostId, await hosts.resolveDir(hostId, raw))
  })
  handle('project:addLocation', async (projectId, location) => {
    if (!location.host) return projects.addLocation(projectId, { path: location.path })
    const path = await hosts.resolveDir(location.host, location.path)
    return projects.addLocation(projectId, { path, host: location.host })
  })
  handle('project:rename', (projectId, name) => projects.rename(projectId, name))
  handle('project:merge', (targetId, sourceId) => projects.merge(targetId, sourceId))

  handle('host:list', () => ({ hosts: hosts.list(), statuses: hosts.statuses() }))
  handle('host:sshConfig', () => hosts.sshConfigHosts())
  handle('host:add', async (name, target) => {
    const host = hosts.add(name, target)
    return { host, status: await hosts.connect(host.id) }
  })
  handle('host:remove', async (hostId) => {
    const used = projects.list().filter((p) => p.locations.some((l) => l.host === hostId))
    if (used.length > 0) throw new Error(`${hosts.nameOf(hostId)} tiene carpetas en ${used.map((p) => p.name).join(', ')}: quítalas antes`)
    await hosts.remove(hostId)
  })
  handle('host:connect', (hostId) => hosts.connect(hostId))
  handle('host:disconnect', (hostId) => hosts.disconnect(hostId))
  handle('host:rescan', (hostId) => hosts.rescan(hostId))
  handle('host:suggestPaths', (hostId, input) => hosts.suggestPaths(hostId, input))
  handle('host:forwardPort', async (workspaceId, remotePort) => {
    const workspace = projects.workspace(workspaceId)
    if (!workspace?.host) throw new Error('el workspace no está en un servidor')
    return { localPort: await hosts.forwardPort(workspace.host, remotePort) }
  })

  // Al morir una sesión ya no está en `list()`: se recuerda a qué workspace pertenecía para la limpieza
  // automática del worktree (§3.15) cuando era la última.
  const sessionWorkspace = new Map<string, string>()
  const remember = (list: SessionInfo[]): SessionInfo[] => {
    for (const s of list) sessionWorkspace.set(s.id, s.workspaceId)
    return list
  }
  // Las sesiones que el daemon ya tenía al arrancar también cuentan, aunque el renderer tarde en pedir `session:list`.
  ptys.list().then(remember, (err) => console.warn('[omni] no se pudieron listar las sesiones del daemon:', err))
  const cleanupWorktreeOf = async (sessionId: string): Promise<void> => {
    const workspaceId = sessionWorkspace.get(sessionId)
    sessionWorkspace.delete(sessionId)
    if (!workspaceId || projects.workspace(workspaceId)?.kind !== 'worktree') return
    try {
      if ((await sessions()).some((s) => s.workspaceId === workspaceId)) return
      await worktrees.cleanupIfEmpty(workspaceId)
    } catch (err) {
      console.warn(`[omni] limpieza del worktree ${workspaceId}:`, err)
    }
  }

  handle('session:create', async (input) => {
    const agent = findAgent(input.agent)
    if (!agent) throw new Error(`agente desconocido: ${input.agent}`)
    const workspace = projects.workspace(input.workspaceId)
    if (!workspace) throw new Error(`workspace desconocido: ${input.workspaceId}`)
    let info: SessionInfo
    if (agent.id === 'browser') info = browsers.create(workspace, input.url)
    else if (workspace.host) {
      // Terminal remota (§3.26): `ssh -tt` por la conexión compartida, con dtach en el host si lo tiene.
      const id = randomUUID()
      const spawn = await hosts.terminalSpawn(workspace.host, id, workspace.cwd ?? workspace.path)
      info = await ptys.create(agent, workspace, input.args, { ...launchCommand(agent), id, spawn })
    } else info = await ptys.create(agent, workspace, input.args, launchCommand(agent))
    sessionWorkspace.set(info.id, info.workspaceId)
    return info
  })
  handle('session:list', async () => remember(await sessions()))
  handle('session:revived', async () => revived.take())
  handle('session:history', (id) => (browsers.has(id) || docs.has(id) ? Promise.resolve('') : ptys.history(id)))
  handle('session:foreground', () => ptys.foreground())
  // Puertos en escucha (§3.24): `lsof` + `ps`, subiendo por el árbol hasta el shell de cada sesión.
  const ports = new PortScanner({ owners: () => ptys.pids() })
  handle('ports:list', () => ports.list())
  handle('ports:stop', (pid, port) => ports.stop(pid, port))
  handle('state:load', () => {
    const saved = state.load()
    if (!saved) return null
    // Los navegadores no sobreviven a la app: se recrean con su mismo id y URL antes de que el
    // renderer restaure el layout. Si su workspace ya no existe, se descartan.
    for (const b of saved.browsers) {
      const workspace = projects.workspace(b.workspaceId)
      if (!workspace || browsers.has(b.id)) continue
      try {
        browsers.create(workspace, b.url, { id: b.id, profileId: b.profileId })
      } catch (err) {
        console.warn(`[omni] no se pudo recrear el navegador ${b.id}:`, err)
      }
    }
    // Los documentos (§3.19) igual: mismo id; si el archivo o el workspace ya no están, se descartan.
    for (const d of saved.docs ?? []) {
      const workspace = projects.workspace(d.workspaceId)
      if (!workspace || docs.has(d.id)) continue
      try {
        docs.open(workspace, d.path, d.kind, { id: d.id })
      } catch (err) {
        console.warn(`[omni] no se pudo recrear el documento ${d.id}:`, err)
      }
    }
    return saved
  })
  handle('app:shutdown', async () => {
    try {
      // "Apagar todo" es a propósito: nada de revivir estas sesiones en el próximo arranque.
      await ptys.shutdown(true)
    } finally {
      browsers.killAll()
      app.quit()
    }
  })
  handle('daemon:status', () => ({ outdated: ptys.outdated() }))
  handle('daemon:upgrade', () => daemon.upgrade())
  handle('browser:navigate', (id, url) => browsers.navigate(id, url))
  handle('browser:back', (id) => browsers.back(id))
  handle('browser:forward', (id) => browsers.forward(id))
  handle('browser:reload', (id) => browsers.reload(id))
  handle('browser:stop', (id) => browsers.stop(id))
  handle('browser:state', (id) => browsers.state(id))
  handle('browser:devtools', (id, on) => browsers.setDevTools(id, on))
  handle('browser:consoleTail', (id, lines) => browsers.consoleTail(id, lines))
  handle('browser:profiles', () => profiles.list())
  handle('browser:profileCreate', (name) => profiles.create(name))
  handle('browser:profileDelete', (id) => profiles.remove(id))
  handle('browser:profileSet', (id, profileId) => browsers.profileSet(id, profileId))
  handle('browser:importCookies', (id, source, path) => browsers.importCookies(id, source, path))
  handle('browser:pickCookieFile', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: 'Importar cookies',
      properties: ['openFile'],
      filters: [{ name: 'Cookies (cookies.txt o JSON)', extensions: ['txt', 'json'] }]
    })
    const path = result.filePaths[0]
    return result.canceled || !path ? null : path
  })
  handle('browser:viewport', (id, preset) => browsers.setViewport(id, preset))
  handle('browser:clearData', (id) => browsers.clearData(id))
  handle('browser:capture', (id, rect) => browsers.capture(id, rect))
  handle('browser:elements', (id) => browsers.elements(id))
  handle('browser:elementPick', (id, hint) => browsers.elementPick(id, hint))
  handle('browser:elementsClear', (id) => browsers.elementsClear(id))
  handle('browser:snapshot', (id) => browsers.snapshot(id))
  handle('capture:save', (dataUrl) => browsers.saveCapture(dataUrl))
  handle('capture:copyImage', (path) => browsers.copyCapture(path))
  handle('files:search', (query, limit) => files.search(query, limit))
  handle('workspace:branch', async (workspaceId) => {
    const workspace = projects.workspace(workspaceId)
    if (!workspace) return null
    if (!workspace.host) return branches.branch(workspace.path)
    // Remoto: solo con el host ya conectado (la rama es un dato de adorno, no motivo para abrir ssh).
    try {
      return await branches.branch(workspace.path, { hostId: workspace.host, exec: hosts.connected(workspace.host).exec })
    } catch {
      return null
    }
  })
  /* worktrees y revisión (ARCHITECTURE §3.15, §3.16): `worktree:changed` sale del propio servicio */
  const killWorkspace = async (workspaceId: string): Promise<void> => {
    ;(await sessions()).filter((s) => s.workspaceId === workspaceId).forEach((s) => kill(s.id))
  }
  handle('worktree:create', (projectId, opts) => worktrees.create(projectId, opts))
  handle('worktree:remove', async (workspaceId) => {
    await killWorkspace(workspaceId)
    await worktrees.remove(workspaceId)
  })
  handle('worktree:status', (workspaceId, fresh) => worktrees.status(workspaceId, fresh))
  // Tira en el acto si no hay comando; el resultado llega por `worktree:changed`, no por la respuesta.
  handle('worktree:runTests', (workspaceId) => {
    void worktrees.runTests(workspaceId)
  })
  handle('git:issue', (projectId, number) => worktrees.issue(projectId, number))
  handle('git:diff', (workspaceId, base) => git.diff(workspaceId, base))
  /* broadcast (§3.18): el renderer es el dueño de las rondas; main solo persiste, saneando como con los to-do */
  handle('broadcast:list', () => broadcasts.load())
  handle('broadcast:save', (rounds) => broadcasts.save(sanitizeBroadcasts(rounds)))
  handle('git:merge', async (workspaceId) => {
    // Si el merge falla (local sucio, conflicto) las sesiones siguen vivas; al lograrlo se matan y recién entonces desaparece la carpeta.
    const result = await git.merge(workspaceId)
    await killWorkspace(workspaceId)
    await worktrees.remove(workspaceId)
    return result
  })
  handle('git:discard', async (workspaceId) => {
    await killWorkspace(workspaceId)
    await git.discard(workspaceId)
  })
  handle('clipboard:readImage', async () => {
    for (const item of await clipboard.read()) {
      if (!item.types.includes('image/png')) continue
      const blob = await item.getType('image/png')
      return new Uint8Array(await blob.arrayBuffer())
    }
    return null
  })
  handle('file:saveDrop', (name, data) => saveDropped(join(tmpdir(), 'omni-drops'), name, data))
  handle('file:uploadDrop', async (workspaceId, name, data) => {
    const workspace = projects.workspace(workspaceId)
    if (!workspace?.host) throw new Error('el workspace no está en un servidor')
    checkDropSize(data)
    const host = await hosts.ensure(workspace.host)
    const dir = posix.join(await host.home(), '.omni', 'drops')
    await host.fs.mkdirp(dir)
    const path = posix.join(dir, dropName(name))
    await host.fs.writeFile(path, Buffer.from(data))
    return path
  })
  handle('file:reveal', (path) => shell.showItemInFolder(insideWorkspace(path)))
  handle('file:open', async (path) => {
    const err = await shell.openPath(insideWorkspace(path))
    if (err) throw new Error(err)
  })
  handle('todo:list', () => todos.load())
  // Lo que manda el renderer también pasa por el saneado: un bug suyo no deja un todos.json inválido.
  handle('todo:save', (list) => todos.save(sanitizeTodos(list)))
  // Foco de la ventana para "sin leer" (§3.14): el `blur` del documento no sirve, porque también salta cuando
  // la página de un navegador embebido toma el teclado y la ventana sigue al frente.
  app.on('browser-window-focus', () => emit('window:focus', true))
  app.on('browser-window-blur', () => emit('window:focus', false))
  handle('notify:show', (id, title, body, kind, onScreen, subtitle) => notifier.show(id, title, body, kind, onScreen, subtitle))
  handle('notify:dismiss', (id) => notifier.dismiss(id))
  handle('notify:test', () => notifier.test())
  handle('settings:get', () => settings.get())
  handle('settings:set', (patch) => {
    const next = settings.update(patch)
    applyLoginItem(next.openAtLogin)
    emit('settings:changed', next)
    return next
  })
  // Es un `send` (sin respuesta): una ruta fuera de los proyectos se avisa en consola, no se tira.
  on('app:reveal', (path) => {
    try {
      shell.showItemInFolder(insideWorkspace(path))
    } catch (err) {
      console.warn('[omni] app:reveal rechazado:', err)
    }
  })
  // Fire-and-forget desde el renderer: un daemon caído se avisa en consola; el socket de control sí espera la respuesta.
  on('session:write', (id, data) => void ptys.write(id, data).catch((err: unknown) => console.warn('[omni] session:write:', err)))
  on('session:resize', (id, cols, rows) => ptys.resize(id, cols, rows))
  on('session:kill', (id) => kill(id))
  // El renderer guarda cuando cambia el layout; la URL de un navegador cambia sin tocar el layout,
  // así que main vuelve a escribir el último estado (con las URLs vivas) cuando una vista navega.
  let lastState: AppState | null = null
  let resaveTimer: ReturnType<typeof setTimeout> | null = null
  const save = (incoming: AppState): void => {
    lastState = incoming
    try {
      state.save(withBrowsers(incoming))
    } catch (err) {
      console.warn('[omni] no se pudo guardar state.json:', err)
    }
  }
  on('state:save', save)
  browsers.onState(() => {
    if (!lastState) return
    if (resaveTimer) clearTimeout(resaveTimer)
    resaveTimer = setTimeout(() => {
      resaveTimer = null
      if (lastState) save(lastState)
    }, 500)
  })
  on('browser:bounds', (id, rect) => browsers.setBounds(id, rect))
  on('browser:mounted', (ids) => browsers.keepOnly(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []))
  on('browser:blur', (id) => browsers.blur(id))
  on('browser:focusView', (id) => browsers.focusView(id))
  on('browser:keyGrab', (id, on) => browsers.setKeyGrab(id, on))
  on('browser:devtoolsBounds', (id, rect) => browsers.setDevToolsBounds(id, rect))

  ptys.onData((id, data) => emit('session:data', id, data))
  ptys.onExit((id, code) => {
    emit('session:exit', id, code)
    void cleanupWorktreeOf(id)
  })
  browsers.onExit((id, code) => {
    emit('session:exit', id, code)
    void cleanupWorktreeOf(id)
  })
  worktrees.onChanged((workspaceId) => emit('worktree:changed', workspaceId))
  browsers.onState((id, state) => emit('browser:state', id, state))
  browsers.onCrash((id, reason) => emit('browser:crashed', id, reason))
  browsers.onKey((id, key) => emit('browser:key', id, key))
  browsers.onFocus((id, focused) => emit('browser:focus', id, focused))
  notifier.onActivate((id) => emit('notify:activate', id))
  // Costo (§3.17): el resumen va con cache de 30 s; el evento sale solo cuando el tracker ve algo distinto.
  handle('cost:summary', () => cost.summary())
  // Uso por agente (§3.25): hoy de los logs y topes del plan en vivo con el login de cada CLI.
  const usage = new UsageService({ cost: () => cost.summary(), fetch: (url, init) => net.fetch(url, init) })
  handle('usage:get', (force) => usage.report(force === true))
  cost.onChanged((summary) => emit('cost:changed', summary))

  /* documentos: editor y vista previa (ARCHITECTURE §3.19, §3.20). Las rutas pasan por la ruta real: nada fuera de un workspace. */
  const roots = (): string[] => projects.workspaces().map((w) => w.path)
  handle('doc:open', (workspaceId, path, kind) => {
    const workspace = projects.workspace(workspaceId)
    if (!workspace) throw new Error(`workspace desconocido: ${workspaceId}`)
    const info = docs.open(workspace, path, kind)
    sessionWorkspace.set(info.id, info.workspaceId)
    return info
  })
  /** Workspace del pedido y la ruta validada dentro de él (no en cualquier proyecto: dos hosts pueden repetir rutas). */
  const fileOf = (workspaceId: string, path: string): { workspace: Workspace; path: string } => {
    const workspace = projects.workspace(workspaceId)
    if (!workspace) throw new Error(`workspace desconocido: ${workspaceId}`)
    if (!isAbsolute(path)) throw new Error(`la ruta tiene que ser absoluta: ${path}`)
    // Remoto (§3.26): comprobación léxica aquí; la ruta real la valida `remote-files` contra el host.
    if (workspace.host ? !isInsidePosix(path, workspace.path) : !isInside(path, [workspace.path])) throw new Error(`ruta fuera del workspace: ${path}`)
    return { workspace, path }
  }
  handle('file:read', async (workspaceId, path) => {
    const file = fileOf(workspaceId, path)
    if (!file.workspace.host) return readTextFile(file.path)
    return readRemoteText((await hosts.ensure(file.workspace.host)).fs, file.workspace.path, file.path)
  })
  handle('file:write', async (workspaceId, path, text) => {
    const workspace = projects.workspace(workspaceId)
    if (!workspace) throw new Error(`workspace desconocido: ${workspaceId}`)
    if (!isAbsolute(path)) throw new Error(`la ruta tiene que ser absoluta: ${path}`)
    if (workspace.host) return writeRemoteText((await hosts.ensure(workspace.host)).fs, workspace.path, path, text)
    if (!isInsideForWrite(path, [workspace.path])) throw new Error(`ruta fuera del workspace: ${path}`)
    return writeTextFile(path, text)
  })
  // Las referencias de vigilancia se atan al webContents que las pidió: al recargar (navegación del
  // marco principal) o morir el renderer se sueltan todas, y sus contadores no se inflan en cada reload.
  const ledger = new WatchLedger()
  const hookedSenders = new WeakSet<WebContents>()
  /** Quién vigila cada ruta local: un cambio se avisa una vez por workspace que la pidió. */
  const watchers = new Map<string, Set<string>>()
  const watchKey = (workspaceId: string, path: string): string => `${workspaceId}\u0000${path}`
  // Archivos remotos (§3.26): sin `fs.watch` por ssh, se sondea el mtime mientras haya quien mire.
  const remoteWatcher = new RemoteWatcher({
    fsOf: (workspaceId) => {
      const host = projects.workspace(workspaceId)?.host
      if (!host) return null
      try {
        return hosts.connected(host).fs
      } catch {
        return null
      }
    }
  })
  remoteWatcher.onChanged((workspaceId, path, mtime) => emit('file:changed', workspaceId, path, mtime))
  const unwatchKey = (key: string): void => {
    const [workspaceId, path] = key.split('\u0000')
    if (remoteWatcher.unwatch(workspaceId, path)) return
    const set = watchers.get(path)
    set?.delete(workspaceId)
    if (set && set.size === 0) watchers.delete(path)
    watcher.unwatch(path)
  }
  const releaseSender = (sender: WebContents): void => {
    for (const key of ledger.drop(sender.id)) unwatchKey(key)
  }
  const hookSender = (sender: WebContents): void => {
    if (hookedSenders.has(sender)) return
    hookedSenders.add(sender)
    sender.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) releaseSender(sender)
    })
    sender.on('destroyed', () => releaseSender(sender))
  }
  handleFrom('file:watch', (sender, workspaceId, path) => {
    const file = fileOf(workspaceId, path)
    hookSender(sender)
    if (file.workspace.host) {
      remoteWatcher.watch(workspaceId, path)
      ledger.add(sender.id, watchKey(workspaceId, path))
      return
    }
    watcher.watch(path)
    const set = watchers.get(path) ?? new Set<string>()
    set.add(workspaceId)
    watchers.set(path, set)
    ledger.add(sender.id, watchKey(workspaceId, path))
  })
  handleFrom('file:unwatch', (sender, workspaceId, path) => {
    if (ledger.remove(sender.id, watchKey(workspaceId, path))) unwatchKey(watchKey(workspaceId, path))
  })
  handle('shell:openExternal', (url) => shell.openExternal(externalUrl(url)))
  handle('files:tree', async (workspaceId, dir) => {
    const workspace = projects.workspace(workspaceId)
    if (!workspace) throw new Error(`workspace desconocido: ${workspaceId}`)
    if (workspace.host) return listRemoteTree((await hosts.ensure(workspace.host)).fs, workspace.path, dir)
    return listTree(workspace.path, dir)
  })
  handle('git:fileAtBase', (workspaceId, path) => git.fileAtBase(workspaceId, path))
  /** Un `DiagnosticsService` por host remoto, con el `exec` y los archivos de ese host. */
  const remoteDiagnosticsByHost = new Map<string, DiagnosticsService>()
  const remoteDiagnostics = async (hostId: string): Promise<DiagnosticsService> => {
    const known = remoteDiagnosticsByHost.get(hostId)
    if (known) return known
    const host = await hosts.ensure(hostId)
    const service = new DiagnosticsService({
      exec: host.execLogin,
      exists: async (p) => (await host.fs.stat(p).catch(() => null)) !== null,
      readText: async (p) => (await host.fs.readFile(p)).toString('utf8')
    })
    remoteDiagnosticsByHost.set(hostId, service)
    return service
  }
  handle('diagnostics:check', (workspaceId, path, skip) => {
    const workspace = projects.workspace(workspaceId)
    if (!workspace) throw new Error(`workspace desconocido: ${workspaceId}`)
    // Remoto (§3.26): el tsc/eslint del proyecto en el host, por su shell de login (PATH con node).
    if (workspace.host) {
      const root = workspace.path.endsWith('/') ? workspace.path : `${workspace.path}/`
      if (!path.startsWith(root) || path.split('/').includes('..')) throw new Error(`ruta fuera del workspace: ${path}`)
      return remoteDiagnostics(workspace.host).then((d) => d.check(workspace.path, path, skip))
    }
    if (!isAbsolute(path) || !isInside(path, [workspace.path])) throw new Error(`ruta fuera del workspace: ${path}`)
    return diagnostics.check(workspace.path, path, skip)
  })
  // Servidores de lenguaje (§3.19b): main pone y quita el marco Content-Length; el protocolo lo habla el renderer.
  handle('lsp:start', (workspaceId, path, client) => {
    const workspace = projects.workspace(workspaceId)
    if (!workspace) throw new Error(`workspace desconocido: ${workspaceId}`)
    if (!isAbsolute(path)) throw new Error(`la ruta tiene que ser absoluta: ${path}`)
    return lsp.start(workspace, path, client)
  })
  on('lsp:send', (serverId, message) => lsp.send(serverId, message))
  on('lsp:stop', (serverId) => lsp.stop(serverId))
  lsp.onMessage((serverId, message) => emit('lsp:message', serverId, message))
  lsp.onExit((serverId, error) => emit('lsp:exit', serverId, error))
  docs.onExit((id, code) => {
    emit('session:exit', id, code)
    void cleanupWorktreeOf(id)
  })
  hosts.onStatus((status) => emit('host:status', status))
  const ipcHandle: IpcHandle = {
    sessionsAdded(list) {
      remember(list)
      if (list.length) emit('session:added', list)
    }
  }
  watcher.onChanged((path, mtime) => watchers.get(path)?.forEach((workspaceId) => emit('file:changed', workspaceId, path, mtime)))
  // Dictado (§3.22): el PCM llega como ArrayBuffer, Uint8Array o Buffer según el puente; el servicio acepta cualquiera.
  handle('whisper:status', () => whisper.status())
  handle('whisper:downloadModel', () => whisper.downloadModel())
  handle('whisper:transcribe', (pcm) => whisper.transcribe(pcm))
  whisper.onProgress((fraction) => emit('whisper:progress', fraction))
  return ipcHandle
}
