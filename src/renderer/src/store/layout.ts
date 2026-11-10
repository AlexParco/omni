import { create } from 'zustand'

/**
 * Layout tipo tmux: workspace → tabs (windows) → árbol de splits → panes (leaf = sesión).
 * Este store es puro: no sabe de sesiones ni de IPC. Los comandos lo orquestan.
 */
export type Dir = 'row' | 'col'
export interface Leaf {
  id: string
  kind: 'leaf'
  sessionId: string
}
export interface Split {
  id: string
  kind: 'split'
  dir: Dir
  children: LayoutNode[]
  /** Fracciones que suman 1, una por hijo. */
  sizes: number[]
}
export type LayoutNode = Leaf | Split

export interface Tab {
  id: string
  workspaceId: string
  root: LayoutNode
  focusedPaneId: string
  zoomedPaneId: string | null
}

interface LayoutState {
  tabs: Tab[]
  /** Tab activo por workspace. */
  activeTab: Record<string, string>

  openTab(workspaceId: string, sessionId: string): Tab
  split(workspaceId: string, dir: Dir, sessionId: string): void
  /** Quita la hoja de la sesión; colapsa splits y cierra tabs vacíos. */
  closeSession(sessionId: string): void
  focusPane(tabId: string, paneId: string): void
  /** Enfoca la hoja de la sesión, cambiando de tab si hace falta. */
  focusSession(sessionId: string): boolean
  focusOffset(workspaceId: string, delta: number): void
  setActiveTab(workspaceId: string, tabId: string): void
  cycleTab(workspaceId: string, delta: number): void
  selectTab(workspaceId: string, index: number): void
  toggleZoom(workspaceId: string): void
  /** Intercambia el pane con foco con el siguiente/anterior en orden de árbol (tmux `swap-pane`). */
  swapFocused(workspaceId: string, delta: number): void
  /**
   * Mueve el pane `paneId` al lado `side` del pane `targetId` (arrastre de la franja). Con `targetId`
   * `null` va a ese borde del tab entero, ocupando todo el ancho o alto. El foco sigue al pane movido;
   * no hace nada si el pane o el destino no están en el tab, o si son el mismo.
   */
  movePane(tabId: string, paneId: string, targetId: string | null, side: Side): void
  /**
   * Mueve el pane con foco hacia `side` con el teclado: si hay un vecino en esa dirección (`neighbourId`,
   * calculado con la geometría en pantalla) se intercambian; si no, pasa a ese borde del tab (así un
   * pane de arriba se puede llevar a la derecha y viceversa).
   */
  moveFocused(workspaceId: string, side: Side, neighbourId: string | null): void
  /** Saca el pane con foco a un tab nuevo (tmux `break-pane`). */
  breakFocused(workspaceId: string): void
  /** Mueve el divisor del pane con foco en `dir`: `delta` > 0 a la derecha o abajo, < 0 a la izquierda o arriba (fracción). */
  resizeFocused(workspaceId: string, dir: Dir, delta: number): void
  setSizes(tabId: string, splitId: string, sizes: number[]): void
}

const uid = (): string => Math.random().toString(36).slice(2, 10)

/** Fracción mínima de un hijo en un split, tanto por teclado como por arrastre. */
export const MIN_SIZE = 0.1

/** Lado de un pane (o del tab entero) donde se suelta otro al moverlo. */
export type Side = 'left' | 'right' | 'top' | 'bottom'

/**
 * Lado del rectángulo más cercano al punto (coordenadas de pantalla): al arrastrar un pane encima de
 * otro, cae en la mitad hacia ese borde. Se compara en fracciones para que un pane ancho no favorezca
 * arriba/abajo.
 */
export function sideAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): Side {
  const fx = rect.width > 0 ? (x - rect.left) / rect.width : 0.5
  const fy = rect.height > 0 ? (y - rect.top) / rect.height : 0.5
  const dists: Array<[Side, number]> = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy]
  ]
  return dists.reduce((best, d) => (d[1] < best[1] ? d : best))[0]
}

export const useLayout = create<LayoutState>((set, get) => ({
  tabs: [],
  activeTab: {},

  openTab(workspaceId, sessionId) {
    const leaf: Leaf = { id: uid(), kind: 'leaf', sessionId }
    const tab: Tab = { id: uid(), workspaceId, root: leaf, focusedPaneId: leaf.id, zoomedPaneId: null }
    set((s) => ({ tabs: [...s.tabs, tab], activeTab: { ...s.activeTab, [workspaceId]: tab.id } }))
    return tab
  },

  split(workspaceId, dir, sessionId) {
    const tab = activeTabOf(get(), workspaceId)
    if (!tab) {
      get().openTab(workspaceId, sessionId)
      return
    }
    const leaf: Leaf = { id: uid(), kind: 'leaf', sessionId }
    const root = splitAt(tab.root, tab.focusedPaneId, dir, leaf)
    patchTab(set, tab.id, { root, focusedPaneId: leaf.id, zoomedPaneId: null })
  },

  closeSession(sessionId) {
    const tab = get().tabs.find((t) => leaves(t.root).some((l) => l.sessionId === sessionId))
    if (!tab) return
    const victim = leaves(tab.root).find((l) => l.sessionId === sessionId)
    if (!victim) return
    const root = removeLeaf(tab.root, victim.id)
    if (!root) {
      set((s) => {
        const siblings = tabsOf(s, tab.workspaceId)
        const index = siblings.findIndex((t) => t.id === tab.id)
        const tabs = s.tabs.filter((t) => t.id !== tab.id)
        const activeTab = { ...s.activeTab }
        if (activeTab[tab.workspaceId] === tab.id) {
          // Como en tmux: el activo pasa al que ocupaba la posición siguiente, o al anterior si era el último.
          const remaining = tabsOf({ tabs }, tab.workspaceId)
          const next = remaining[Math.min(index, remaining.length - 1)]
          if (next) activeTab[tab.workspaceId] = next.id
          else delete activeTab[tab.workspaceId]
        }
        return { tabs, activeTab }
      })
      return
    }
    const focusedPaneId = tab.focusedPaneId === victim.id ? neighbourOf(tab.root, victim.id) : tab.focusedPaneId
    patchTab(set, tab.id, { root, focusedPaneId, zoomedPaneId: tab.zoomedPaneId === victim.id ? null : tab.zoomedPaneId })
  },

  focusPane(tabId, paneId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    patchTab(set, tabId, { focusedPaneId: paneId })
    set((s) => ({ activeTab: { ...s.activeTab, [tab.workspaceId]: tabId } }))
  },

  focusSession(sessionId) {
    const tab = get().tabs.find((t) => leaves(t.root).some((l) => l.sessionId === sessionId))
    const leaf = tab && leaves(tab.root).find((l) => l.sessionId === sessionId)
    if (!tab || !leaf) return false
    get().focusPane(tab.id, leaf.id)
    return true
  },

  focusOffset(workspaceId, delta) {
    const tab = activeTabOf(get(), workspaceId)
    if (!tab) return
    const all = leaves(tab.root)
    const i = all.findIndex((l) => l.id === tab.focusedPaneId)
    const next = all[(i + delta + all.length) % all.length]
    patchTab(set, tab.id, { focusedPaneId: next.id, zoomedPaneId: tab.zoomedPaneId ? next.id : null })
  },

  setActiveTab(workspaceId, tabId) {
    set((s) => ({ activeTab: { ...s.activeTab, [workspaceId]: tabId } }))
  },

  cycleTab(workspaceId, delta) {
    const tabs = tabsOf(get(), workspaceId)
    if (tabs.length === 0) return
    const i = tabs.findIndex((t) => t.id === get().activeTab[workspaceId])
    get().setActiveTab(workspaceId, tabs[(i + delta + tabs.length) % tabs.length].id)
  },

  selectTab(workspaceId, index) {
    const tab = tabsOf(get(), workspaceId)[index]
    if (tab) get().setActiveTab(workspaceId, tab.id)
  },

  toggleZoom(workspaceId) {
    const tab = activeTabOf(get(), workspaceId)
    if (!tab || leaves(tab.root).length < 2) return
    patchTab(set, tab.id, { zoomedPaneId: tab.zoomedPaneId ? null : tab.focusedPaneId })
  },

  swapFocused(workspaceId, delta) {
    const tab = activeTabOf(get(), workspaceId)
    if (!tab) return
    const all = leaves(tab.root)
    if (all.length < 2) return
    const i = all.findIndex((l) => l.id === tab.focusedPaneId)
    const other = all[(i + delta + all.length) % all.length]
    const me = all[i]
    const root = mapNode(tab.root, (n) => {
      if (n.kind !== 'leaf') return n
      if (n.id === me.id) return { ...n, sessionId: other.sessionId }
      if (n.id === other.id) return { ...n, sessionId: me.sessionId }
      return n
    })
    // El foco (y el zoom) siguen a la sesión, no a la posición: así `C-a }` se siente como mover el pane.
    patchTab(set, tab.id, { root, focusedPaneId: other.id, zoomedPaneId: tab.zoomedPaneId ? other.id : null })
  },

  movePane(tabId, paneId, targetId, side) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || paneId === targetId) return
    const moving = leaves(tab.root).find((l) => l.id === paneId)
    if (!moving || (targetId && !containsPane(tab.root, targetId))) return
    const rest = removeLeaf(tab.root, paneId)
    if (!rest) return
    const root = targetId ? placeBeside(rest, targetId, side, moving) : placeAtEdge(rest, side, moving)
    patchTab(set, tab.id, { root, focusedPaneId: moving.id, zoomedPaneId: null })
  },

  moveFocused(workspaceId, side, neighbourId) {
    const tab = activeTabOf(get(), workspaceId)
    if (!tab || leaves(tab.root).length < 2) return
    if (!neighbourId) {
      get().movePane(tab.id, tab.focusedPaneId, null, side)
      return
    }
    const all = leaves(tab.root)
    const me = all.find((l) => l.id === tab.focusedPaneId)
    const other = all.find((l) => l.id === neighbourId)
    if (!me || !other || me.id === other.id) return
    const root = mapNode(tab.root, (n) => {
      if (n.kind !== 'leaf') return n
      if (n.id === me.id) return { ...n, sessionId: other.sessionId }
      if (n.id === other.id) return { ...n, sessionId: me.sessionId }
      return n
    })
    // Como `swapFocused`: el foco sigue a la sesión, que ahora vive en la hoja del vecino.
    patchTab(set, tab.id, { root, focusedPaneId: other.id, zoomedPaneId: null })
  },

  breakFocused(workspaceId) {
    const tab = activeTabOf(get(), workspaceId)
    if (!tab || leaves(tab.root).length < 2) return
    const victim = leaves(tab.root).find((l) => l.id === tab.focusedPaneId)
    const root = victim && removeLeaf(tab.root, victim.id)
    if (!victim || !root) return
    patchTab(set, tab.id, { root, focusedPaneId: neighbourOf(tab.root, victim.id), zoomedPaneId: null })
    get().openTab(workspaceId, victim.sessionId)
  },

  resizeFocused(workspaceId, dir, delta) {
    const tab = activeTabOf(get(), workspaceId)
    if (!tab) return
    const parent = parentWithDir(tab.root, tab.focusedPaneId, dir)
    if (!parent) return
    const i = parent.split.children.findIndex((c) => containsPane(c, tab.focusedPaneId))
    const j = i + 1 < parent.split.children.length ? i + 1 : i - 1
    if (j < 0) return
    // Se mueve el divisor entre el pane y su vecino, como `resize-pane` de tmux: `delta` > 0 lo lleva a la
    // derecha (o abajo) sea cual sea el lado del pane. Crece el de antes del divisor, achica el de después.
    const [a, b] = i < j ? [i, j] : [j, i]
    const sizes = [...parent.split.sizes]
    const d = Math.max(-sizes[a] + MIN_SIZE, Math.min(sizes[b] - MIN_SIZE, delta))
    sizes[a] += d
    sizes[b] -= d
    get().setSizes(tab.id, parent.split.id, sizes)
  },

  setSizes(tabId, splitId, sizes) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    patchTab(set, tabId, { root: mapNode(tab.root, (n) => (n.kind === 'split' && n.id === splitId ? { ...n, sizes } : n)) })
  }
}))

/* ---------- selectores ---------- */

export function tabsOf(s: Pick<LayoutState, 'tabs'>, workspaceId: string): Tab[] {
  return s.tabs.filter((t) => t.workspaceId === workspaceId)
}

export function activeTabOf(s: Pick<LayoutState, 'tabs' | 'activeTab'>, workspaceId: string): Tab | undefined {
  const id = s.activeTab[workspaceId]
  return s.tabs.find((t) => t.id === id) ?? tabsOf(s, workspaceId)[0]
}

export function leaves(node: LayoutNode): Leaf[] {
  return node.kind === 'leaf' ? [node] : node.children.flatMap(leaves)
}

export function focusedSessionId(s: Pick<LayoutState, 'tabs' | 'activeTab'>, workspaceId: string): string | null {
  const tab = activeTabOf(s, workspaceId)
  if (!tab) return null
  return leaves(tab.root).find((l) => l.id === tab.focusedPaneId)?.sessionId ?? null
}

/** Índice (base 1) del tab que contiene la sesión, para el sidebar. */
export function tabIndexOfSession(s: Pick<LayoutState, 'tabs'>, sessionId: string): number | null {
  const tab = s.tabs.find((t) => leaves(t.root).some((l) => l.sessionId === sessionId))
  if (!tab) return null
  return tabsOf(s, tab.workspaceId).findIndex((t) => t.id === tab.id) + 1
}

/* ---------- helpers de árbol (puros) ---------- */

function patchTab(set: (fn: (s: LayoutState) => Partial<LayoutState>) => void, tabId: string, patch: Partial<Tab>): void {
  set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) }))
}

function mapNode(node: LayoutNode, fn: (n: LayoutNode) => LayoutNode): LayoutNode {
  const mapped = fn(node)
  if (mapped.kind === 'split') return { ...mapped, children: mapped.children.map((c) => mapNode(c, fn)) }
  return mapped
}

function containsPane(node: LayoutNode, paneId: string): boolean {
  return leaves(node).some((l) => l.id === paneId)
}

/** Divide la hoja `paneId` en dos: si el padre ya va en `dir`, inserta al lado; si no, crea un split. */
function splitAt(node: LayoutNode, paneId: string, dir: Dir, leaf: Leaf): LayoutNode {
  if (node.kind === 'leaf') {
    if (node.id !== paneId) return node
    return { id: uid(), kind: 'split', dir, children: [node, leaf], sizes: [0.5, 0.5] }
  }
  const i = node.children.findIndex((c) => c.kind === 'leaf' && c.id === paneId)
  if (i >= 0 && node.dir === dir) {
    const children = [...node.children]
    const sizes = [...node.sizes]
    const half = sizes[i] / 2
    sizes[i] = half
    children.splice(i + 1, 0, leaf)
    sizes.splice(i + 1, 0, half)
    return { ...node, children, sizes }
  }
  return { ...node, children: node.children.map((c) => splitAt(c, paneId, dir, leaf)) }
}

const sideDir = (side: Side): Dir => (side === 'left' || side === 'right' ? 'row' : 'col')
const sideFirst = (side: Side): boolean => side === 'left' || side === 'top'

/**
 * Inserta `leaf` al lado `side` de la hoja `targetId`. Si el padre ya va en esa dirección, entra como
 * hermano y se reparte la fracción del destino; si no, el destino se vuelve un split de dos mitades.
 */
function placeBeside(node: LayoutNode, targetId: string, side: Side, leaf: Leaf): LayoutNode {
  const dir = sideDir(side)
  const first = sideFirst(side)
  if (node.kind === 'leaf') {
    if (node.id !== targetId) return node
    return { id: uid(), kind: 'split', dir, children: first ? [leaf, node] : [node, leaf], sizes: [0.5, 0.5] }
  }
  const i = node.children.findIndex((c) => c.kind === 'leaf' && c.id === targetId)
  if (i >= 0 && node.dir === dir) {
    const children = [...node.children]
    const sizes = [...node.sizes]
    const half = sizes[i] / 2
    sizes[i] = half
    const at = first ? i : i + 1
    children.splice(at, 0, leaf)
    sizes.splice(at, 0, half)
    return { ...node, children, sizes }
  }
  return { ...node, children: node.children.map((c) => placeBeside(c, targetId, side, leaf)) }
}

/** Pone `leaf` en el borde `side` del tab: ocupa todo el alto (izquierda/derecha) o todo el ancho (arriba/abajo). */
function placeAtEdge(root: LayoutNode, side: Side, leaf: Leaf): LayoutNode {
  const first = sideFirst(side)
  const dir = sideDir(side)
  // Ya hay un split en esa dirección: entra como un hermano más (sin anidar row dentro de row).
  if (root.kind === 'split' && root.dir === dir) {
    const share = 1 / (root.children.length + 1)
    const sizes = root.sizes.map((x) => x * (1 - share))
    return { ...root, children: first ? [leaf, ...root.children] : [...root.children, leaf], sizes: first ? [share, ...sizes] : [...sizes, share] }
  }
  return { id: uid(), kind: 'split', dir, children: first ? [leaf, root] : [root, leaf], sizes: [0.5, 0.5] }
}

/** Devuelve el árbol sin la hoja; `null` si quedó vacío. Un split con un solo hijo se colapsa. */
function removeLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === 'leaf') return node.id === paneId ? null : node
  const children: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const kept = removeLeaf(c, paneId)
    if (kept) {
      children.push(kept)
      sizes.push(node.sizes[i])
    }
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  const total = sizes.reduce((a, b) => a + b, 0)
  return { ...node, children, sizes: sizes.map((x) => x / total) }
}

function neighbourOf(root: LayoutNode, paneId: string): string {
  const all = leaves(root)
  const i = all.findIndex((l) => l.id === paneId)
  return (all[i + 1] ?? all[i - 1] ?? all[0]).id
}

function parentWithDir(node: LayoutNode, paneId: string, dir: Dir): { split: Split } | null {
  if (node.kind === 'leaf') return null
  const child = node.children.find((c) => containsPane(c, paneId))
  if (!child) return null
  const deeper = parentWithDir(child, paneId, dir)
  if (deeper) return deeper
  return node.dir === dir ? { split: node } : null
}
