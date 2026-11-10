import type { AppState, SavedNode, SavedTab } from '@shared/types'
import { omni } from '@/lib/omni'
import { leaves, tabsOf, useLayout, type LayoutNode, type Tab } from './layout'
import { useSessions } from './sessions'

/**
 * Estado que sobrevive a cerrar la app (ARCHITECTURE §3.10): el layout (tabs, árbol de splits, tab
 * activo por workspace) y el workspace actual. El renderer lo manda con `state:save` tras cada cambio,
 * con debounce; main lo escribe en `~/.config/omni/state.json` y rellena `browsers` por su cuenta.
 * Al arrancar, `sessions.initOnce` pide `state:load` y lo poda contra las sesiones vivas (`pruneState`).
 */

/** Espera tras el último cambio antes de mandar el estado a main. */
export const SAVE_DEBOUNCE_MS = 500

/* ---------- serialización (ida y vuelta) ---------- */

function toSavedNode(node: LayoutNode): SavedNode {
  if (node.kind === 'leaf') return { kind: 'leaf', id: node.id, sessionId: node.sessionId }
  return { kind: 'split', id: node.id, dir: node.dir, sizes: [...node.sizes], children: node.children.map(toSavedNode) }
}

function fromSavedNode(node: SavedNode): LayoutNode {
  if (node.kind === 'leaf') return { id: node.id, kind: 'leaf', sessionId: node.sessionId }
  return { id: node.id, kind: 'split', dir: node.dir, children: node.children.map(fromSavedNode), sizes: [...node.sizes] }
}

/** Copia serializable de los tabs: solo los campos del contrato, sin referencias al store. */
export function toSavedTabs(tabs: Tab[]): SavedTab[] {
  return tabs.map((t) => ({ id: t.id, workspaceId: t.workspaceId, root: toSavedNode(t.root), focusedPaneId: t.focusedPaneId, zoomedPaneId: t.zoomedPaneId }))
}

export function fromSavedTabs(saved: SavedTab[]): Tab[] {
  return saved.map((t) => ({ id: t.id, workspaceId: t.workspaceId, root: fromSavedNode(t.root), focusedPaneId: t.focusedPaneId, zoomedPaneId: t.zoomedPaneId }))
}

/**
 * Lo que el renderer manda a main; `browsers` lo rellena main. `titles` solo lleva los de las terminales
 * vivas (`sessionIds`) y no vacíos: editores, vistas previas y navegadores recalculan el suyo al abrirse.
 */
export function snapshot(lay: { tabs: Tab[]; activeTab: Record<string, string> }, currentWorkspaceId: string | null, titles: Record<string, string> = {}, sessionIds: Iterable<string> = []): AppState {
  const state: AppState = { tabs: toSavedTabs(lay.tabs), activeTab: { ...lay.activeTab }, currentWorkspaceId, browsers: [], savedAt: Date.now() }
  const kept = Object.fromEntries([...sessionIds].filter((id) => titles[id]).map((id) => [id, titles[id]]))
  if (Object.keys(kept).length > 0) state.titles = kept
  return state
}

/* ---------- poda contra lo que sigue vivo ---------- */

export interface RestoredState {
  tabs: Tab[]
  activeTab: Record<string, string>
  currentWorkspaceId: string | null
  /** Títulos guardados de las sesiones que siguen vivas. */
  titles: Record<string, string>
}

function leavesOf(node: SavedNode): Array<SavedNode & { kind: 'leaf' }> {
  return node.kind === 'leaf' ? [node] : node.children.flatMap(leavesOf)
}

/** Quita las hojas muertas; un split con un solo hijo se colapsa, uno vacío desaparece (`null`). */
function pruneNode(node: SavedNode, alive: Set<string>): LayoutNode | null {
  if (node.kind === 'leaf') return alive.has(node.sessionId) ? fromSavedNode(node) : null
  const children: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const kept = pruneNode(c, alive)
    if (!kept) return
    children.push(kept)
    sizes.push(node.sizes[i] ?? 0)
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  const total = sizes.reduce((a, b) => a + b, 0)
  // Tamaños corruptos (todo cero) → reparto parejo; si no, se renormalizan a 1.
  return { id: node.id, kind: 'split', dir: node.dir, children, sizes: total > 0 ? sizes.map((x) => x / total) : children.map(() => 1 / children.length) }
}

/**
 * Pura: el estado guardado contra las sesiones (y workspaces, si se dan) que main dice que existen.
 * Hojas sin sesión viva se quitan; splits con un hijo se colapsan; tabs vacíos (o de un workspace que
 * ya no existe) desaparecen; foco y zoom caen a una hoja viva; `activeTab` inválido cae al primer tab
 * del workspace; `currentWorkspaceId` se conserva solo si sigue existiendo.
 */
export function pruneState(state: AppState, sessionIds: Iterable<string>, workspaceIds?: Iterable<string>): RestoredState {
  const alive = new Set(sessionIds)
  const workspaces = workspaceIds ? new Set(workspaceIds) : null
  // Una sesión solo puede estar en una hoja: la primera gana, las repetidas (archivo corrupto) se descartan.
  const placed = new Set<string>()
  const tabs: Tab[] = []
  state.tabs.forEach((saved) => {
    if (workspaces && !workspaces.has(saved.workspaceId)) return
    const mine = new Set(leavesOf(saved.root).map((l) => l.sessionId).filter((id) => alive.has(id) && !placed.has(id)))
    const root = pruneNode(saved.root, mine)
    if (!root) return
    mine.forEach((id) => placed.add(id))
    const all = leaves(root)
    const focusedPaneId = all.some((l) => l.id === saved.focusedPaneId) ? saved.focusedPaneId : all[0].id
    const zoomedPaneId = saved.zoomedPaneId !== null && all.length > 1 && all.some((l) => l.id === saved.zoomedPaneId) ? saved.zoomedPaneId : null
    tabs.push({ id: saved.id, workspaceId: saved.workspaceId, root, focusedPaneId, zoomedPaneId })
  })

  const activeTab: Record<string, string> = {}
  new Set(tabs.map((t) => t.workspaceId)).forEach((ws) => {
    const mine = tabsOf({ tabs }, ws)
    const wanted = state.activeTab[ws]
    activeTab[ws] = mine.some((t) => t.id === wanted) ? wanted : mine[0].id
  })

  const current = state.currentWorkspaceId
  const currentWorkspaceId = current !== null && (!workspaces || workspaces.has(current)) ? current : null
  const titles = Object.fromEntries(Object.entries(state.titles ?? {}).filter(([id]) => alive.has(id)))
  return { tabs, activeTab, currentWorkspaceId, titles }
}

/* ---------- guardado con debounce ---------- */

let timer = 0
let dirty = false

function flush(): void {
  clearTimeout(timer)
  timer = 0
  if (!dirty) return
  dirty = false
  const { currentWorkspaceId, titles, sessions } = useSessions.getState()
  omni.send('state:save', snapshot(useLayout.getState(), currentWorkspaceId, titles, sessions.map((s) => s.id)))
}

/**
 * Anota un cambio y programa el guardado. No guarda nada hasta que `sessions.ready` sea `true`
 * (`initOnce` terminó): si no, el estado vacío del arranque pisaría el archivo antes de restaurarlo.
 */
export function schedulePersist(): void {
  if (!useSessions.getState().ready) return
  dirty = true
  clearTimeout(timer)
  timer = setTimeout(flush, SAVE_DEBOUNCE_MS) as unknown as number
}

/**
 * Suscribe el guardado a los cambios de layout, de workspace actual y de títulos. Al ocultarse la página
 * (cerrar la ventana, recargar) manda lo pendiente sin esperar el debounce. Devuelve la función
 * para desuscribirse.
 */
export function startPersist(): () => void {
  const offs: Array<() => void> = []
  offs.push(useLayout.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs || s.activeTab !== prev.activeTab) schedulePersist()
  }))
  offs.push(useSessions.subscribe((s, prev) => {
    if (s.currentWorkspaceId !== prev.currentWorkspaceId || s.titles !== prev.titles) schedulePersist()
  }))
  // En tests (Node) no hay `window`: el guardado por debounce funciona igual, solo falta el pagehide.
  if (typeof window !== 'undefined') {
    const onHide = (): void => flush()
    window.addEventListener('pagehide', onHide)
    offs.push(() => window.removeEventListener('pagehide', onHide))
  }
  return () => {
    offs.forEach((off) => off())
    clearTimeout(timer)
    timer = 0
  }
}
