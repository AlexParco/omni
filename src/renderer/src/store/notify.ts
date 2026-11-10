import type { AgentId, NotificationsSetting, NotifyKind, NotifyTestResult, Project, Workspace } from '@shared/types'
import { detectPermission } from '@/core/permission-patterns'
import { agentMessage, clip, lastMeaningfulLine, stripAnsi, tailLines } from '@/core/terminal-text'
import { omni } from '@/lib/omni'
import { getTerminal, screenLines } from '@/panes/terminal/terminal-host'
import { isBlank, liveBrowserId, useBrowser } from './browser'
import { activeTabOf, leaves, useLayout, type Tab } from './layout'
import { HIDDEN_PLACE, agentOf, inHiddenProject, placeLabel, sessionTitle, useSessions } from './sessions'
import { useSettings } from './settings'
import { useUi, type View } from './ui'

/**
 * Notificaciones nativas (ARCHITECTURE §3.14). Mira las transiciones del store de sesiones: una sesión
 * que entra en `pregunta` (BEL) o en `sin leer` pide `notify:show`; cuando la pregunta se atiende, el
 * "sin leer" se limpia o el pane vuelve a verse, `notify:dismiss`. Main decide si la ventana tiene el
 * foco y agrupa por sesión y tipo; aquí además no se repite una notificación mientras siga pendiente.
 * El clic en la notificación llega como `notify:activate(id)`: se entra al pane de esa sesión.
 */

type Flags = Record<string, true>

interface Snapshot {
  attention: Flags
  unread: Flags
}

export interface NotifyPlan {
  show: Array<{ id: string; kind: NotifyKind }>
  dismiss: string[]
}

/** Notificaciones pendientes por sesión y tipo (`id:kind`): una sola hasta que se resuelva. */
const pending = new Set<string>()
const key = (id: string, kind: NotifyKind): string => `${id}:${kind}`

/** Qué tipos de aviso admite el ajuste del usuario. */
export function allowedKinds(setting: NotificationsSetting): NotifyKind[] {
  if (setting === 'off') return []
  if (setting === 'questions') return ['question']
  if (setting === 'done') return ['done']
  return ['question', 'done']
}

/** Los dos interruptores de Ajustes (pregunta, termina) a partir del ajuste. */
export function notifyFlags(setting: NotificationsSetting): { question: boolean; done: boolean } {
  const kinds = allowedKinds(setting)
  return { question: kinds.includes('question'), done: kinds.includes('done') }
}

/** El ajuste que corresponde a los dos interruptores. */
export function notifySetting(flags: { question: boolean; done: boolean }): NotificationsSetting {
  if (flags.question && flags.done) return 'all'
  if (flags.question) return 'questions'
  return flags.done ? 'done' : 'off'
}

/**
 * Lógica pura: dado el estado anterior y el nuevo, qué notificaciones mostrar y cuáles retirar.
 * Entra en `pregunta` → `question`; entra en `sin leer` → `done`. Se retira (`dismiss`, por sesión)
 * cuando se atiende la pregunta o se limpia el sin leer (`markSeen`, entrar al pane) y a esa sesión no
 * le queda nada pendiente. `shown` son las pendientes (`id:kind`); se muta aquí para reflejar lo decidido.
 */
export function planNotify(prev: Snapshot, next: Snapshot, setting: NotificationsSetting, shown: Set<string>): NotifyPlan {
  const kinds = allowedKinds(setting)
  const show: NotifyPlan['show'] = []
  const dismiss: string[] = []
  const ids = new Set([...Object.keys(prev.attention), ...Object.keys(next.attention), ...Object.keys(prev.unread), ...Object.keys(next.unread)])
  ids.forEach((id) => {
    const q = key(id, 'question')
    const d = key(id, 'done')
    const had = shown.has(q) || shown.has(d)
    if (prev.attention[id] === true && next.attention[id] !== true) shown.delete(q)
    if (prev.unread[id] === true && next.unread[id] !== true) shown.delete(d)
    if (had && !shown.has(q) && !shown.has(d)) dismiss.push(id)
    if (next.attention[id] === true && prev.attention[id] !== true && kinds.includes('question') && !shown.has(q)) {
      shown.add(q)
      show.push({ id, kind: 'question' })
    }
    if (next.unread[id] === true && prev.unread[id] !== true && kinds.includes('done') && !shown.has(d)) {
      shown.add(d)
      show.push({ id, kind: 'done' })
    }
  })
  return { show, dismiss }
}

/* ---------- texto de la cola de la terminal ---------- */

/** Última línea con contenido de la cola de una terminal, sin ANSI ni espacios sobrantes. */
export function lastLine(text: string): string {
  return tailLines(stripAnsi(text), 1)[0]?.trim() ?? ''
}

/** Cuántas líneas de la cola mira el detector de permisos (§3.13). */
const TAIL_LINES = 40
/** Líneas de pantalla renderizada donde buscar el último mensaje del agente. */
const SCREEN_LINES = 80

/**
 * Cuerpo del aviso (§3.14). Pregunta: el resumen del patrón de permiso (el comando, el archivo). Si no,
 * lo último que dijo el agente en su pantalla renderizada (`screen`, de `screenLines`): el mensaje con
 * `⏺`/`●`, nunca la barra de estado de la TUI (`-- INSERT --`, `auto mode on…`). Sin pantalla, la última
 * línea útil del historial crudo.
 */
export function notifyBody(agent: AgentId, raw: string, screen: readonly string[] | null = null): string {
  const tail = tailLines(stripAnsi(raw), TAIL_LINES)
  const permission = (screen && detectPermission(agent, screen)) ?? detectPermission(agent, tail)
  if (permission) return clip(permission.summary)
  return (screen && (agentMessage(screen) ?? lastMeaningfulLine(screen))) ?? lastMeaningfulLine(tail) ?? ''
}

/** De dónde viene la sesión, para el subtítulo: el proyecto, y en un worktree también su nombre (`shop · cc-51`). */
export function notifyPlace(s: { workspaces: Workspace[]; projects: Project[] }, workspaceId: string): string {
  return placeLabel(s, workspaceId)
}

/** La sesión está en un pane visible: tab activo del workspace actual, no tapado por el zoom de otro pane, en Flota. */
export function isOnScreen(lay: { tabs: Tab[]; activeTab: Record<string, string> }, workspaceId: string | null, view: View, id: string): boolean {
  if (view !== 'fleet' || workspaceId === null) return false
  const tab = activeTabOf(lay, workspaceId)
  if (!tab) return false
  const shown = tab.zoomedPaneId ? leaves(tab.root).filter((l) => l.id === tab.zoomedPaneId) : leaves(tab.root)
  return shown.some((l) => l.sessionId === id)
}

/* ---------- efectos ---------- */

const TITLE: Record<NotifyKind, string> = { question: 'pregunta', done: 'terminó' }

async function show(id: string, kind: NotifyKind): Promise<void> {
  const s = useSessions.getState()
  const session = s.sessions.find((x) => x.id === id)
  if (!session) return
  const history = await omni.invoke('session:history', id).catch(() => '')
  // Mientras llegaba la cola pudo resolverse (respondida o vista): no se avisa de algo que ya no pasa.
  if (!pending.has(key(id, kind))) return
  const onScreen = isOnScreen(useLayout.getState(), useSessions.getState().currentWorkspaceId, useUi.getState().view, id)
  // Proyecto oculto (§3.5c): el banner de macOS se ve fuera de omni (pantalla compartida), así que no
  // lleva el título OSC (suele ser la tarea), ni lo que dijo el agente, ni el nombre del proyecto.
  if (inHiddenProject(s, session.workspaceId)) {
    const name = agentOf(s, session.agent)?.name ?? session.agent
    return void (await omni.invoke('notify:show', id, `${name} ${TITLE[kind]}`, '', kind, onScreen, HIDDEN_PLACE))
  }
  const body = notifyBody(session.agent, history, screenLines(id, SCREEN_LINES))
  await omni.invoke('notify:show', id, `${sessionTitle(s, session)} ${TITLE[kind]}`, body, kind, onScreen, notifyPlace(s, session.workspaceId))
}

/** Aviso de ejemplo (Ajustes → Probar): main lo manda sin filtros y dice si macOS lo mostró. */
export function sendTestNotification(): Promise<NotifyTestResult> {
  return omni.invoke('notify:test').catch(() => ({ ok: false, error: 'omni no respondió' }))
}

/** Entra al pane de la sesión: tab activo, foco del layout y teclado en la terminal (o la página). */
export function enterSession(id: string): void {
  const sessions = useSessions.getState()
  const tab = useLayout.getState().tabs.find((t) => leaves(t.root).some((l) => l.sessionId === id))
  const leaf = tab && leaves(tab.root).find((l) => l.sessionId === id)
  if (!tab || !leaf) return
  const ui = useUi.getState()
  // Otra vista (Worktrees, revisión, broadcast) tapa los panes: se vuelve a Flota.
  ui.setView('fleet')
  const live = liveBrowserId(useBrowser.getState())
  if (live && live !== id) useBrowser.getState().blur(live)
  sessions.activatePane(tab.id, leaf.id)
  ui.setFocus('terminal')
  const session = sessions.sessions.find((x) => x.id === id)
  if (session?.agent === 'browser') {
    const b = useBrowser.getState()
    if (isBlank(b.states[id])) b.focusUrl(id)
    else b.focusView(id)
  } else getTerminal(id)?.focus()
}

/** Arranca la suscripción; devuelve la función para pararla. Se llama una vez desde `App.tsx`. */
export function initNotify(): () => void {
  pending.clear()
  const offStore = useSessions.subscribe((s, prev) => {
    if (s.attention === prev.attention && s.unread === prev.unread) return
    const plan = planNotify(prev, s, useSettings.getState().settings.notifications, pending)
    plan.dismiss.forEach((id) => void omni.invoke('notify:dismiss', id))
    plan.show.forEach(({ id, kind }) => void show(id, kind))
  })
  const offActivate = omni.on('notify:activate', (id) => enterSession(id))
  return () => {
    offStore()
    offActivate()
    pending.clear()
  }
}
