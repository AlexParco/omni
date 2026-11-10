import { create } from 'zustand'
import type { Capture, ControlCommand, ControlResult, SessionInfo, SessionLiveStatus } from '@shared/types'
import { omni } from '@/lib/omni'
import { workspaceOfPath } from '@/panes/editor/editor-logic'
import { useBrowser } from './browser'
import { CONTROL_NOTICE_MS, docKindFor, humanError, noticeText, parseArgs, sameUrl, type ControlArgs } from './control-logic'
import { useDocs } from './docs'
import { focusedSessionId, leaves, useLayout } from './layout'
import { enterSession } from './notify'
import { useReview } from './review'
import { sessionStatus, useSessions, workspaceOf } from './sessions'
import { useTodos } from './todos'
import { useUi } from './ui'

/**
 * Socket de control, CLI y bus MCP (ARCHITECTURE §3.21), lado renderer. Main recibe `{ id, type, ... }` por
 * `app.sock`, resuelve `list` y `send` solo y reenvía el resto como `app:command`; aquí cada tipo se despacha
 * contra los stores y se responde con `app:commandResult(id, { ok, result | error })`. Nunca se deja escapar
 * una excepción: el error vuelve como texto humano a quien lo pidió. Cada comando que toca un pane pinta
 * `MCP · <agente>` o `CLI` en su franja durante 3 s (el mismo aviso que las capturas).
 */

/** Aviso que no tuvo pane donde pintarse (`notify` sin pane con foco): el pie o la barra pueden leerlo. */
export interface Banner {
  title: string
  body: string
  at: number
}

interface ControlState {
  banner: Banner | null
  /** Suscribe `app:command`; devuelve la función para pararlo. Se llama una vez desde `App.tsx`. */
  init(): () => void
  /** Ejecuta un comando y devuelve su resultado; no lanza. Separado de `init` para probarlo sin IPC. */
  dispatch(command: ControlCommand): Promise<ControlResult>
  /**
   * Aviso breve: en la franja del pane dado o del pane con foco; sin pane, queda como `banner` (y se borra
   * solo a los 3 s). Lo usan los comandos del bus y `mcp.copyCommand`.
   */
  announce(text: string, sessionId?: string | null): void
}

/** Cuánto se espera a que la página cargue antes de capturar. */
const LOAD_TIMEOUT_MS = 30_000

const sessions = useSessions.getState
const layout = useLayout.getState
const browser = useBrowser.getState
const ui = useUi.getState

let bannerTimer: ReturnType<typeof setTimeout> | undefined

/** Pane con foco del layout en el workspace actual, si hay. */
function focusedId(): string | null {
  const ws = sessions().currentWorkspaceId
  return ws ? focusedSessionId(layout(), ws) : null
}

/** Pone en pantalla el tab de la sesión (vista Flota, tab activo) sin mover el teclado. */
function showPane(id: string): void {
  const tab = layout().tabs.find((t) => leaves(t.root).some((l) => l.sessionId === id))
  if (!tab) return
  if (ui().view !== 'fleet') ui().setView('fleet')
  sessions().activateTab(tab.id)
}

/** Navegador nuevo en tab propio, como el launcher; `workspaceId` lo cambia antes de crearlo. */
async function newBrowser(workspaceId: string | null): Promise<SessionInfo> {
  if (workspaceId) {
    if (!workspaceOf(sessions(), workspaceId)) throw new Error(`No existe el workspace ${workspaceId}`)
    sessions().setWorkspace(workspaceId)
  }
  const info = await sessions().create('browser')
  if (!info) throw new Error('No hay ningún proyecto abierto donde crear el navegador')
  layout().openTab(info.workspaceId, info.id)
  return info
}

/** Resuelve cuando la página de ese navegador terminó de cargar; rechaza pasado el tiempo. */
function whenLoaded(id: string, timeoutMs: number): Promise<void> {
  const ready = (): boolean => {
    const st = browser().states[id]
    return st !== undefined && !st.loading
  }
  return new Promise((resolve, reject) => {
    if (ready()) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      off()
      reject(new Error(`La página no terminó de cargar en ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    const off = useBrowser.subscribe(() => {
      if (!ready()) return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
}

/**
 * Dos frames después (lo que tarda el pane en reenviar `browser:bounds`), como `whenVisible` del navegador.
 * Con un overlay abierto la vista está tapada: no se espera a que el usuario lo cierre (quien pidió la
 * captura se quedaría colgado), se devuelve error humano.
 */
function whenVisible(): Promise<void> {
  if (ui().overlay !== null) return Promise.reject(new Error('No se puede capturar: hay un diálogo abierto en omni'))
  const frame = (cb: () => void): void => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb)
    else setTimeout(cb, 0)
  }
  return new Promise((resolve) => frame(() => frame(resolve)))
}

/* ---------- un handler por tipo ---------- */

async function openPath(a: Extract<ControlArgs, { type: 'open' }>, from: string): Promise<unknown> {
  if (a.kind === 'file') {
    // Un archivo se abre en el workspace que lo contiene (§3.19): editor, o vista previa si es Markdown, imagen o PDF.
    const ws = workspaceOfPath(sessions().workspaces, a.path, sessions().currentWorkspaceId)
    if (!ws) throw new Error(`El archivo no está dentro de ningún proyecto abierto: ${a.path}`)
    const kind = docKindFor(a.path)
    const info = await useDocs.getState().open(ws.id, a.path, kind, 'tab')
    if (!info) throw new Error(`No se pudo abrir ${a.path}`)
    showPane(info.id)
    browser().notify(info.id, noticeText(from))
    return { sessionId: info.id, workspaceId: ws.id, kind }
  }
  // El workspace recién abierto pasa a ser el actual; si ya tenía un tab, se muestra.
  const { project, workspace } = await sessions().openProjectPath(a.path)
  return { projectId: project.id, workspaceId: workspace.id, path: workspace.path }
}

async function openBrowser(a: Extract<ControlArgs, { type: 'browser' }>, from: string): Promise<{ sessionId: string }> {
  const info = await newBrowser(a.workspaceId)
  await browser().navigate(info.id, a.url)
  browser().notify(info.id, noticeText(from))
  return { sessionId: info.id }
}

async function captureUrl(a: Extract<ControlArgs, { type: 'capture' }>, from: string): Promise<Capture & { sessionId: string }> {
  let id: string
  if (a.sessionId) {
    const s = sessions().sessions.find((x) => x.id === a.sessionId)
    if (!s) throw new Error(`No existe la sesión ${a.sessionId}`)
    if (s.agent !== 'browser') throw new Error(`La sesión ${a.sessionId} no es un navegador`)
    id = s.id
  } else {
    const states = browser().states
    const open = sessions().sessions.find((s) => s.agent === 'browser' && states[s.id] !== undefined && sameUrl(states[s.id].url, a.url))
    id = open ? open.id : (await newBrowser(null)).id
  }
  const current = browser().states[id]?.url ?? ''
  if (!sameUrl(current, a.url)) await browser().navigate(id, a.url)
  showPane(id)
  await whenLoaded(id, LOAD_TIMEOUT_MS)
  await whenVisible()
  const capture = await omni.invoke('browser:capture', id)
  browser().notify(id, noticeText(from, 'captura'))
  return { ...capture, sessionId: id }
}

async function openDiff(a: Extract<ControlArgs, { type: 'diff' }>, from: string): Promise<{ workspaceId: string }> {
  if (!workspaceOf(sessions(), a.workspaceId)) throw new Error(`No existe el workspace ${a.workspaceId}`)
  await useReview.getState().open(a.workspaceId)
  useControl.getState().announce(noticeText(from, 'revisión'))
  return { workspaceId: a.workspaceId }
}

function focusSession(a: Extract<ControlArgs, { type: 'focus' }>, from: string): { sessionId: string } {
  if (!sessions().sessions.some((s) => s.id === a.sessionId)) throw new Error(`No existe la sesión ${a.sessionId}`)
  enterSession(a.sessionId)
  browser().notify(a.sessionId, noticeText(from))
  return { sessionId: a.sessionId }
}

/** Pone el pane en pantalla sin mover el teclado (el agente va a capturarlo) y espera a que pinte. */
async function showSession(a: Extract<ControlArgs, { type: 'show' }>): Promise<{ sessionId: string }> {
  if (!sessions().sessions.some((s) => s.id === a.sessionId)) throw new Error(`No existe la sesión ${a.sessionId}`)
  showPane(a.sessionId)
  await whenVisible()
  return { sessionId: a.sessionId }
}

function addTodo(a: Extract<ControlArgs, { type: 'todo' }>, from: string): { id: string } {
  const ws = sessions().currentWorkspaceId
  const projectId = ws ? (workspaceOf(sessions(), ws)?.projectId ?? null) : null
  const todo = useTodos.getState().add(a.text, projectId)
  if (!todo) throw new Error('No se pudo crear la tarea')
  useControl.getState().announce(noticeText(from, 'tarea nueva'))
  return { id: todo.id }
}

async function notifyUser(a: Extract<ControlArgs, { type: 'notify' }>, from: string): Promise<{ shown: 'pane' | 'banner' }> {
  const target = focusedId()
  const text = a.body ? `${a.title}: ${a.body}` : a.title
  useControl.getState().announce(noticeText(from, text), target)
  // Con la ventana en segundo plano el aviso también sale como notificación nativa (main decide, §3.14).
  await omni.invoke('notify:show', target ?? 'control', a.title, a.body, 'done', target !== null).catch(() => undefined)
  return { shown: target ? 'pane' : 'banner' }
}

/** Estado y título vivo de cada sesión, para `omni list` (main no los sabe: se infieren de la salida). */
function liveStatuses(): Record<string, SessionLiveStatus> {
  const s = sessions()
  const now = Date.now()
  return Object.fromEntries(s.sessions.map((x) => [x.id, { status: sessionStatus(s, x.id, now), title: s.titles[x.id] ?? '' }]))
}

/* ---------- store ---------- */

export const useControl = create<ControlState>((set, get) => ({
  banner: null,

  init() {
    const offCommand = omni.on('app:command', (command) => {
      void get()
        .dispatch(command)
        .then((result) => omni.invoke('app:commandResult', command.id, result))
        .catch(() => undefined)
    })
    // `send` lo resuelve main solo (escribe a la PTY): aquí solo se avisa en la franja de esa sesión.
    const offSent = omni.on('control:sent', (sessionId, from) => {
      if (sessions().sessions.some((s) => s.id === sessionId)) browser().notify(sessionId, noticeText(from))
    })
    return () => {
      offCommand()
      offSent()
    }
  },

  async dispatch(command) {
    const parsed = parseArgs(command.type, command.args ?? {})
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const a = parsed.args
    try {
      switch (a.type) {
        case 'open':
          return { ok: true, result: await openPath(a, command.from) }
        case 'browser':
          return { ok: true, result: await openBrowser(a, command.from) }
        case 'capture':
          return { ok: true, result: await captureUrl(a, command.from) }
        case 'diff':
          return { ok: true, result: await openDiff(a, command.from) }
        case 'focus':
          return { ok: true, result: focusSession(a, command.from) }
        case 'show':
          return { ok: true, result: await showSession(a) }
        case 'todo':
          return { ok: true, result: addTodo(a, command.from) }
        case 'notify':
          return { ok: true, result: await notifyUser(a, command.from) }
        case 'statuses':
          return { ok: true, result: liveStatuses() }
      }
    } catch (e) {
      return { ok: false, error: humanError(e, `${command.type}: no se pudo ejecutar`) }
    }
  },

  announce(text, sessionId) {
    // Fuera de la flota la franja del pane no está en pantalla: el aviso va al pie para que se vea.
    const target = sessionId ?? (ui().view === 'fleet' ? focusedId() : null)
    if (target) {
      browser().notify(target, text)
      return
    }
    clearTimeout(bannerTimer)
    const [title, ...rest] = text.split(': ')
    set({ banner: { title: title ?? text, body: rest.join(': '), at: Date.now() } })
    bannerTimer = setTimeout(() => set({ banner: null }), CONTROL_NOTICE_MS)
  }
}))
