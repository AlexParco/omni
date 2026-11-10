import { create } from 'zustand'
import type { ListeningProcess } from '@shared/types'
import { omni } from '@/lib/omni'
import { useBrowser } from './browser'
import { humanError } from './control-logic'
import { useLayout } from './layout'
import { enterSession } from './notify'
import { advertisedUrl, groupPorts, inWorkspace, portRowId, portUrl, samePortOrigin, visiblePortIds, workspaceOfPort } from './ports-logic'
import { useSessions } from './sessions'
import { settleCursor } from './todos-logic'
import { useUi } from './ui'

/** Con el widget abierto se repide cada 2 s; cerrado, cada 10 s y solo con la ventana enfocada (para el conteo del sidebar). */
export const PORTS_OPEN_REFRESH_MS = 2000
export const PORTS_IDLE_REFRESH_MS = 10_000
/** Cuánto espera la segunda `X` para confirmar que se detiene un servicio. */
export const STOP_ARM_MS = 3000
/** Cuánto se ve un aviso al pie del widget. */
const NOTICE_MS = 3000

interface PortsState {
  list: ListeningProcess[]
  loaded: boolean
  /** Fila bajo el cursor (`portRowId`). */
  cursor: string | null
  /** Filtro escrito en el campo de arriba. */
  query: string
  /** Apps del sistema desplegadas (plegadas por defecto). */
  systemOpen: boolean
  /** Fila con la primera `X` pulsada: la segunda (antes de `STOP_ARM_MS`) la detiene. */
  armed: string | null
  /** Filas deteniéndose ahora. */
  stopping: Record<string, true>
  /** Aviso al pie (copiado, detenido, error). */
  notice: string | null
  /** `ports.filter` pidió el foco en el filtro; el widget lo consume. */
  filtering: boolean
  /** Pide `ports:list` y repite (2 s abierto, 10 s cerrado con foco). Devuelve la función para deshacerlo. */
  init(): () => void
  refresh(): Promise<void>
  setCursor(id: string): void
  moveCursor(delta: number): void
  setQuery(query: string): void
  setSystemOpen(open: boolean): void
  setFiltering(on: boolean): void
  /** Abre el servicio en un navegador de omni (o entra al que ya lo muestra) y cierra el widget. */
  open(id: string): Promise<void>
  /** Abre el servicio en el navegador del sistema. */
  openExternal(id: string): void
  copyUrl(id: string): Promise<void>
  /** Entra a la terminal (o agente) que lo levantó. */
  goTo(id: string): void
  /** Primera llamada arma; la segunda dentro de `STOP_ARM_MS` lo detiene. */
  stop(id: string): Promise<void>
}

const sessions = useSessions.getState
const ui = useUi.getState

/** Predicado "corre en el workspace actual" con el estado de sesiones de ahora (§3.24). */
/** Servidor de desarrollo que levantó esa sesión (el de menor puerto si hay varios), o `undefined`. */
export function devServerOf(list: readonly ListeningProcess[], sessionId: string): ListeningProcess | undefined {
  return list.find((p) => p.kind === 'dev' && p.sessionId === sessionId)
}

export function hereNow(): (p: ListeningProcess) => boolean {
  const s = sessions()
  return inWorkspace(s.currentWorkspaceId, s.workspaces, s.sessions)
}

/** URL para abrir o copiar: la que anunció el servidor en su terminal de omni, si no `http://localhost:<puerto>`. */
async function urlOf(p: ListeningProcess): Promise<string> {
  if (!p.sessionId) return portUrl(p)
  const output = await omni.invoke('session:history', p.sessionId).catch(() => '')
  return advertisedUrl(output, p.ports[0]) ?? portUrl(p)
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined
let armTimer: ReturnType<typeof setTimeout> | undefined

export const usePorts = create<PortsState>((set, get) => {
  const find = (id: string): ListeningProcess | undefined => get().list.find((p) => portRowId(p) === id)
  const ids = (list = get().list, systemOpen = get().systemOpen, query = get().query): string[] => {
    // Filtrando, Sistema se ve desplegado: lo que coincide no se esconde tras el pliegue.
    const groups = groupPorts(list, query, hereNow())
    return visiblePortIds(groups, systemOpen || query.trim() !== '')
  }
  const say = (notice: string): void => {
    clearTimeout(noticeTimer)
    set({ notice })
    noticeTimer = setTimeout(() => set({ notice: null }), NOTICE_MS)
  }
  const apply = (list: ListeningProcess[]): void => {
    const before = ids()
    set({ list, loaded: true, cursor: settleCursor(ids(list), get().cursor, before) })
  }

  return {
    list: [],
    loaded: false,
    cursor: null,
    query: '',
    systemOpen: false,
    armed: null,
    stopping: {},
    notice: null,
    filtering: false,

    init() {
      void get().refresh()
      let ticks = 0
      // `setInterval` pelado y `document` opcional: el store también corre en los tests de Node.
      const timer = setInterval(() => {
        ticks++
        const open = ui().overlay === 'ports'
        const focused = typeof document !== 'undefined' && document.hasFocus()
        if (open || (focused && ticks % (PORTS_IDLE_REFRESH_MS / PORTS_OPEN_REFRESH_MS) === 0)) void get().refresh()
      }, PORTS_OPEN_REFRESH_MS)
      return () => clearInterval(timer)
    },

    async refresh() {
      try {
        apply(await omni.invoke('ports:list'))
      } catch {
        // main ocupado o cerrándose: se queda la última lista.
      }
    },

    setCursor(id) {
      set({ cursor: id })
    },

    moveCursor(delta) {
      const list = ids()
      if (list.length === 0) return
      const at = get().cursor === null ? -1 : list.indexOf(get().cursor ?? '')
      const next = at === -1 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, at + delta))
      set({ cursor: list[next], armed: null })
    },

    setQuery(query) {
      const before = ids()
      set({ query, cursor: settleCursor(ids(get().list, get().systemOpen, query), get().cursor, before) })
    },

    setSystemOpen(systemOpen) {
      const before = ids()
      set({ systemOpen, cursor: settleCursor(ids(get().list, systemOpen), get().cursor, before) })
    },

    setFiltering(filtering) {
      set({ filtering })
    },

    async open(id) {
      const p = find(id)
      if (!p) return
      const port = p.ports[0]
      ui().closeOverlay()
      // Un navegador que ya muestra ese servicio gana a abrir otro.
      const states = useBrowser.getState().states
      const already = sessions().sessions.find((s) => s.agent === 'browser' && states[s.id] && samePortOrigin(states[s.id].url, port))
      if (already) return enterSession(already.id)
      const owner = p.sessionId ? sessions().sessions.find((s) => s.id === p.sessionId) : undefined
      const ws = workspaceOfPort(p, sessions().workspaces, owner?.workspaceId ?? null)
      if (ws) sessions().setWorkspace(ws.id)
      try {
        const info = await sessions().create('browser')
        if (!info) return say('No hay ningún proyecto abierto donde abrir el navegador')
        useLayout.getState().openTab(info.workspaceId, info.id)
        await useBrowser.getState().navigate(info.id, await urlOf(p))
        enterSession(info.id)
      } catch (e) {
        say(humanError(e, `No se pudo abrir :${port}`))
      }
    },

    openExternal(id) {
      const p = find(id)
      if (p) void urlOf(p).then((url) => omni.invoke('shell:openExternal', url)).catch(() => say('No se pudo abrir el navegador del sistema'))
    },

    async copyUrl(id) {
      const p = find(id)
      if (!p) return
      try {
        const url = await urlOf(p)
        await navigator.clipboard.writeText(url)
        say(`Copiado ${url}`)
      } catch {
        say('No se pudo copiar la URL')
      }
    },

    goTo(id) {
      const p = find(id)
      if (!p?.sessionId) return say(p?.inOmni ? 'Salió de una terminal de omni, pero no se sabe de cuál (reinicia omni para saberlo)' : 'No lo levantó ninguna terminal de omni')
      ui().closeOverlay()
      enterSession(p.sessionId)
    },

    async stop(id) {
      const p = find(id)
      if (!p || get().stopping[id]) return
      if (p.self) return say('Ese puerto es de omni mismo')
      if (get().armed !== id) {
        clearTimeout(armTimer)
        set({ armed: id })
        armTimer = setTimeout(() => get().armed === id && set({ armed: null }), STOP_ARM_MS)
        return
      }
      clearTimeout(armTimer)
      set((s) => ({ armed: null, stopping: { ...s.stopping, [id]: true } }))
      try {
        const r = await omni.invoke('ports:stop', p.pid, p.ports[0])
        say(r.ok ? `Detenido :${p.ports[0]} ${p.name}${r.forced ? ' (forzado)' : ''}` : (r.error ?? `No se pudo detener :${p.ports[0]}`))
      } catch (e) {
        say(humanError(e, `No se pudo detener :${p.ports[0]}`))
      } finally {
        set((s) => {
          const { [id]: _done, ...rest } = s.stopping
          return { stopping: rest }
        })
        await get().refresh()
      }
    }
  }
})
