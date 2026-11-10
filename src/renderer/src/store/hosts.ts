import { create } from 'zustand'
import type { HostStatus, RemoteHost, SshConfigHost, Workspace } from '@shared/types'
import { omni } from '@/lib/omni'
import { cursorOf, useSessions } from './sessions'
import { useUi } from './ui'
import { useLayout } from './layout'

/**
 * Hosts remotos y ubicaciones de proyecto (ARCHITECTURE §3.5c, §3.26). Main es dueño de la conexión;
 * aquí se reflejan los hosts con su estado y vive el flujo de "Agregar ubicación": elegir dónde
 * (este Mac o un servidor) y después la carpeta, para un proyecto existente o uno nuevo.
 */

/** Para qué se está eligiendo una carpeta: un proyecto nuevo o una ubicación más de uno existente. */
export type LocationTarget = { mode: 'newProject' } | { mode: 'addTo'; projectId: string }

/** Dónde se elige la carpeta: `null` = este Mac. */
export type LocationPlace = { host: string | null }

interface HostsState {
  hosts: RemoteHost[]
  status: Record<string, HostStatus>
  /** Flujo de ubicación en curso (diálogos `locationPicker` → `locationPath`). */
  target: LocationTarget | null
  place: LocationPlace | null
  load(): Promise<void>
  nameOf(hostId: string): string
  connect(hostId: string): Promise<HostStatus>
  /**
   * "Instalar dtach" (§3.26): abre una terminal en una carpeta de ese servidor con el comando de su gestor
   * de paquetes escrito, sin ⏎ (sudo pide contraseña y el usuario revisa antes de correrlo). Al terminar,
   * la marca `── dtach instalado ──` hace que omni vuelva a mirar el host.
   */
  installDtach(hostId: string): Promise<void>
  /** Repite el preflight del host (herramientas recién instaladas). */
  rescan(hostId: string): Promise<void>
  add(name: string, target: string): Promise<{ host: RemoteHost; status: HostStatus }>
  remove(hostId: string): Promise<void>
  sshConfig(): Promise<SshConfigHost[]>
  suggest(place: LocationPlace, input: string): Promise<string[]>
  /** Abre el flujo: primero "dónde". */
  startLocation(target: LocationTarget): void
  /** Eligió dónde: sigue con la ruta (conecta al host si hace falta). */
  choosePlace(place: LocationPlace): void
  /** Eligió la carpeta: crea el proyecto o suma la ubicación y deja el cursor en ella. */
  finishLocation(path: string): Promise<Workspace>
}

let wired = false

export const useHosts = create<HostsState>((set, get) => ({
  hosts: [],
  status: {},
  target: null,
  place: null,

  async load() {
    const { hosts, statuses } = await omni.invoke('host:list')
    set({ hosts, status: Object.fromEntries(statuses.map((s) => [s.hostId, s])) })
    if (wired) return
    wired = true
    omni.on('host:status', (status) => set((s) => ({ status: { ...s.status, [status.hostId]: status } })))
  },

  nameOf(hostId) {
    return get().hosts.find((h) => h.id === hostId)?.name ?? 'servidor'
  },

  async connect(hostId) {
    const status = await omni.invoke('host:connect', hostId)
    set((s) => ({ status: { ...s.status, [hostId]: status } }))
    return status
  },

  async installDtach(hostId) {
    const command = get().status[hostId]?.tools?.dtachInstall
    const sessions = useSessions.getState()
    const ws = sessions.workspaces.find((w) => w.host === hostId)
    const announce = (text: string): void => void import('./control').then((m) => m.useControl.getState().announce(text))
    if (!command) return announce(`No se encontró un gestor de paquetes en ${get().nameOf(hostId)}: instala dtach a mano`)
    if (!ws) return announce(`Agrega una carpeta de ${get().nameOf(hostId)} para abrir una terminal ahí`)
    useUi.getState().closeOverlay()
    useUi.getState().setView('fleet')
    sessions.setWorkspace(ws.id)
    const info = await sessions.create('shell')
    if (!info) return
    useLayout.getState().openTab(info.workspaceId, info.id)
    sessions.activateTab(useLayout.getState().activeTab[info.workspaceId] ?? '')
    // La marca se arma con `%s` para que el eco de la línea tecleada no la contenga.
    const line = `${command} && printf '\\n── %s ──\\n' 'dtach instalado'`
    // Se escribe cuando la terminal ya tiene prompt; sin ⏎.
    setTimeout(() => omni.send('session:write', info.id, line), 1200)
    announce('Revisa el comando y pulsa ⏎ para instalar dtach')
  },

  async rescan(hostId) {
    const status = await omni.invoke('host:rescan', hostId)
    set((s) => ({ status: { ...s.status, [hostId]: status } }))
  },

  async add(name, target) {
    const result = await omni.invoke('host:add', name, target)
    set((s) => ({ hosts: s.hosts.some((h) => h.id === result.host.id) ? s.hosts : [...s.hosts, result.host], status: { ...s.status, [result.host.id]: result.status } }))
    return result
  },

  async remove(hostId) {
    await omni.invoke('host:remove', hostId)
    set((s) => {
      const { [hostId]: _gone, ...status } = s.status
      return { hosts: s.hosts.filter((h) => h.id !== hostId), status }
    })
  },

  sshConfig: () => omni.invoke('host:sshConfig'),

  suggest(place, input) {
    return place.host ? omni.invoke('host:suggestPaths', place.host, input) : omni.invoke('project:suggestPaths', input)
  },

  startLocation(target) {
    set({ target, place: null })
    useUi.getState().openOverlay('locationPicker')
  },

  choosePlace(place) {
    set({ place })
    useUi.getState().openOverlay('locationPath')
    if (place.host && get().status[place.host]?.state !== 'connected') void get().connect(place.host)
  },

  async finishLocation(path) {
    const { target, place } = get()
    if (!target || !place) throw new Error('no hay una ubicación en curso')
    const sessions = useSessions.getState()
    let workspace: Workspace
    if (target.mode === 'addTo') {
      workspace = await omni.invoke('project:addLocation', target.projectId, place.host ? { path, host: place.host } : { path })
    } else if (place.host) {
      workspace = (await omni.invoke('project:addRemote', place.host, path)).workspace
    } else {
      workspace = (await omni.invoke('project:addPath', path)).workspace
    }
    await sessions.reloadProjects()
    useUi.getState().setCollapsed(workspace.projectId, false)
    useSessions.getState().setCursor(cursorOf(workspace))
    useSessions.getState().setWorkspace(workspace.id)
    set({ target: null, place: null })
    return workspace
  }
}))

/** Texto del estado de un host para el sidebar y Ajustes. */
export function hostStateLabel(status: HostStatus | undefined): string {
  if (!status || status.state === 'disconnected') return 'sin conectar'
  if (status.state === 'connecting') return 'conectando'
  if (status.state === 'error') return 'sin conexión'
  return 'conectado'
}
