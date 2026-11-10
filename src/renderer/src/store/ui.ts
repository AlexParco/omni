import { create } from 'zustand'
import { omni } from '@/lib/omni'

/** Dónde está el foco de teclado. Define qué capas del keymap aplican. */
export type Focus = 'list' | 'terminal'
/** Overlays modales. Mientras hay uno abierto, solo él recibe teclas. */
export type Overlay =
  | null
  | 'launcher'
  | 'palette'
  | 'quickopen'
  | 'projectMenu'
  /* subcarpetas (§3.5c): elegir cuál registrar */
  | 'folderPicker'
  /* ubicaciones y hosts (§3.5c, §3.26): dónde (este Mac o un servidor), qué carpeta, agregar un servidor */
  | 'locationPicker'
  | 'locationPath'
  | 'hostAdd'
  /* proyecto: nuevo (solo nombre), renombrar y unir con otro */
  | 'projectNew'
  | 'projectRename'
  | 'projectMerge'
  /* quitar una ubicación que tiene sesiones abiertas: confirmar que se cierran */
  | 'confirmRemoveLocation'
  | 'confirmKill'
  | 'confirmShutdown'
  | 'confirmUpgrade'
  | 'locationRename'
  | 'projectAdd'
  | 'keys'
  | 'settings'
  | 'sendCapture'
  | 'browserMenu'
  | 'browserSettings'
  | 'browserProfile'
  | 'todo'
  /* puertos (§3.24): servicios en escucha */
  | 'ports'
  /* uso por agente (§3.25): consumo de hoy y topes del plan */
  | 'usage'
  /* worktrees (§3.15): descartar con confirmación, nombre a mano, número de issue y comando de tests del proyecto */
  | 'confirmDiscard'
  | 'worktreeName'
  | 'worktreeIssue'
  | 'testCommand'
  /* revisión (§3.16): merge con sesiones vivas en el worktree */
  | 'confirmMerge'
  /* dictado (§3.22): abierto mientras se mantiene ⌥Space, se transcribe o se revisa el texto */
  | 'voice'
  /* broadcast (§3.18): nueva ronda (prompt y agentes) */
  | 'broadcastNew'
  /* editor (§3.19): ruta a abrir desde el launcher y cierre de un editor con cambios sin guardar */
  | 'editorPath'
  | 'confirmDiscardDoc'
  | 'confirmOverwriteDoc'
/** Dónde cae lo que lance el launcher. */
export type LaunchTarget = 'tab' | 'split-right' | 'split-down'
/** Cómo se lanza el agente: `yolo` = con su flag de "sin pedir permisos" (⌥⏎ en el launcher). */
export type LaunchMode = 'normal' | 'yolo'
/** Vista principal: la flota (panes del workspace) u otra vista (Worktrees, revisión, broadcast) que la reemplaza sin desmontarla. */
export type View = 'fleet' | 'worktrees' | 'review' | 'broadcast'

/** Tiempo que el prefijo espera la siguiente tecla antes de caducar (terminal y navegador por igual). */
export const PREFIX_TIMEOUT_MS = 1500

interface UiState {
  focus: Focus
  overlay: Overlay
  view: View
  launchTarget: LaunchTarget
  launchMode: LaunchMode
  /** Sesiones a matar cuando el usuario confirme en el overlay `confirmKill`. */
  pendingKill: string[]
  /** Ubicación a quitar (con sus sesiones) cuando el usuario confirme en `confirmRemoveLocation`. */
  pendingRemoveLocation: string | null
  /** C-a apretado y esperando la siguiente tecla (equivale a `client_prefix` en tmux). */
  prefixArmed: boolean
  /** Proyectos plegados en el sidebar. Se recuerda entre recargas. */
  collapsed: Record<string, true>
  /** Sidebar oculto (⌘B). Se recuerda entre recargas. */
  sidebarCollapsed: boolean
  /** Ancho del sidebar en px (arrastre de su borde derecho). Se recuerda entre recargas. */
  sidebarWidth: number
  /**
   * Los proyectos ocultos (§3.5c) se ven en el sidebar. A propósito no se recuerda: tras recargar o
   * reabrir omni vuelven a esconderse, así nunca quedan a la vista por olvido.
   */
  showHidden: boolean
  /** Se está arrastrando un divisor del layout: las vistas nativas se esconden para no tragarse el mouse. */
  dragging: boolean
  /**
   * La ventana de omni es la activa del sistema (§3.14). Sin ella, un pane en pantalla no cuenta como visto:
   * si no, con omni en segundo plano cada salida lo marcaba visto y nunca avisaba "terminó".
   */
  windowFocused: boolean
  setWindowFocused(focused: boolean): void
  setCollapsed(projectId: string, collapsed: boolean): void
  setSidebarCollapsed(collapsed: boolean): void
  /** Fija el ancho (recortado a `SIDEBAR_MIN`–`SIDEBAR_MAX`) y lo recuerda. */
  setSidebarWidth(width: number): void
  setShowHidden(show: boolean): void
  setDragging(dragging: boolean): void
  setFocus(focus: Focus): void
  setView(view: View): void
  setPrefixArmed(armed: boolean): void
  openOverlay(overlay: Exclude<Overlay, null>): void
  closeOverlay(): void
  setLaunchTarget(target: LaunchTarget): void
  setLaunchMode(mode: LaunchMode): void
  setPendingKill(ids: string[]): void
  setPendingRemoveLocation(workspaceId: string | null): void
}

const COLLAPSED_KEY = 'omni.sidebar.collapsed'
const SIDEBAR_KEY = 'omni.sidebar.hidden'
const SIDEBAR_WIDTH_KEY = 'omni.sidebar.width'

/** Límites y valor por defecto del ancho del sidebar (el de `--sidebar-w` en tokens.css). */
export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 480
export const SIDEBAR_DEFAULT = 290

/** Ancho dentro de los límites, en px enteros; lo que no es número vuelve al de por defecto. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)))
}

function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    return raw === null ? SIDEBAR_DEFAULT : clampSidebarWidth(Number(raw))
  } catch {
    return SIDEBAR_DEFAULT
  }
}

function writeSidebarWidth(width: number): void {
  try {
    if (width === SIDEBAR_DEFAULT) localStorage.removeItem(SIDEBAR_WIDTH_KEY)
    else localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width))
  } catch {
    /* sin storage no se recuerda; no pasa nada */
  }
}

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(SIDEBAR_KEY, '1')
    else localStorage.removeItem(SIDEBAR_KEY)
  } catch {
    /* sin storage no se recuerda; no pasa nada */
  }
}

function readCollapsed(): Record<string, true> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(ids) ? Object.fromEntries(ids.filter((x): x is string => typeof x === 'string').map((id) => [id, true as const])) : {}
  } catch {
    return {}
  }
}

function writeCollapsed(collapsed: Record<string, true>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Object.keys(collapsed)))
  } catch {
    /* sin storage no se recuerda; no pasa nada */
  }
}

export const useUi = create<UiState>((set) => ({
  focus: 'list',
  overlay: null,
  view: 'fleet',
  launchTarget: 'tab',
  launchMode: 'normal',
  pendingKill: [],
  pendingRemoveLocation: null,
  prefixArmed: false,
  collapsed: readCollapsed(),
  sidebarCollapsed: readSidebarCollapsed(),
  sidebarWidth: readSidebarWidth(),
  showHidden: false,
  dragging: false,
  // `document` opcional: el store también corre en los tests de Node.
  windowFocused: typeof document === 'undefined' ? true : document.hasFocus(),
  setWindowFocused: (windowFocused) => set({ windowFocused }),
  setSidebarCollapsed(sidebarCollapsed) {
    writeSidebarCollapsed(sidebarCollapsed)
    set({ sidebarCollapsed })
  },
  setSidebarWidth(width) {
    const sidebarWidth = clampSidebarWidth(width)
    writeSidebarWidth(sidebarWidth)
    set({ sidebarWidth })
  },
  setShowHidden: (showHidden) => set({ showHidden }),
  setDragging: (dragging) => set({ dragging }),
  setCollapsed(projectId, collapsed) {
    set((s) => {
      const { [projectId]: _was, ...rest } = s.collapsed
      const next = collapsed ? { ...rest, [projectId]: true as const } : rest
      writeCollapsed(next)
      return { collapsed: next }
    })
  },
  setPrefixArmed: (prefixArmed) => set({ prefixArmed }),
  // El teclado en una terminal solo tiene sentido con la flota en pantalla: entrar a una sesión desde
  // Worktrees, una notificación, el quick open o las tareas vuelve a la flota sin que cada sitio lo sepa.
  setFocus: (focus) => set((s) => (focus === 'terminal' && s.view !== 'fleet' ? { focus, view: 'fleet' } : { focus })),
  setView: (view) => set({ view }),
  openOverlay: (overlay) => set({ overlay }),
  // Cerrar un overlay limpia el destino del launcher: un split cancelado no debe contaminar el siguiente ⌘T.
  closeOverlay: () => set({ overlay: null, launchTarget: 'tab', launchMode: 'normal' }),
  setLaunchTarget: (launchTarget) => set({ launchTarget }),
  setLaunchMode: (launchMode) => set({ launchMode }),
  setPendingKill: (pendingKill) => set({ pendingKill }),
  setPendingRemoveLocation: (pendingRemoveLocation) => set({ pendingRemoveLocation })
}))

/** Sigue el foco de la ventana que avisa main (`window:focus`, §3.14). Devuelve la función para dejar de seguirlo. */
export function watchWindowFocus(): () => void {
  return omni.on('window:focus', (focused) => useUi.getState().setWindowFocused(focused))
}
