import type { NotificationsSetting, NotifyKind } from '@shared/types'

/** Notificación nativa ya mostrada: lo único que el gate necesita de ella es poder cerrarla. */
export interface LiveNotification {
  close(): void
}

/** Lo que el gate pide al sistema; `onClick`/`onClose` liberan el hueco de esa sesión y tipo. */
export interface NotificationRequest {
  title: string
  /** Segunda línea en negrita (macOS): de qué proyecto o worktree viene. */
  subtitle?: string
  body: string
  onClick(): void
  onClose(): void
}

export interface NotificationGateDeps {
  getSetting: () => NotificationsSetting
  /** La ventana principal tiene el foco. Junto con `onScreen` decide si el usuario ya está viendo la sesión. */
  isFocused: () => boolean
  /** Muestra la notificación nativa; `null` si la plataforma no soporta notificaciones. */
  spawn: (req: NotificationRequest) => LiveNotification | null
}

/** Filtro por ajuste (§3.14): `questions` deja pasar solo preguntas, `done` solo fines, `off` nada. */
export function allowsKind(setting: NotificationsSetting, kind: NotifyKind): boolean {
  if (setting === 'off') return false
  if (setting === 'questions') return kind === 'question'
  if (setting === 'done') return kind === 'done'
  return true
}

/**
 * Lógica de agrupación sin Electron (ARCHITECTURE §3.14): como mucho una notificación viva por
 * sesión y tipo. Mientras siga viva no se repite; se libera al `dismiss`, al cerrarse o al clic.
 * Solo se calla cuando el usuario ya ve la sesión: ventana con foco Y pane en pantalla (`onScreen`).
 * El clic avisa a los listeners de `onActivate` con el id de la sesión.
 */
export class NotificationGate {
  private readonly live = new Map<string, LiveNotification>()
  private readonly listeners = new Set<(sessionId: string) => void>()

  constructor(private readonly deps: NotificationGateDeps) {}

  /** Devuelve `true` si llegó a mostrarse. `onScreen`: el pane de la sesión está visible en el renderer. */
  show(sessionId: string, title: string, body: string, kind: NotifyKind, onScreen: boolean, subtitle?: string): boolean {
    if (!allowsKind(this.deps.getSetting(), kind)) return false
    if (this.deps.isFocused() && onScreen) return false
    const key = keyOf(sessionId, kind)
    if (this.live.has(key)) return false
    let handle: LiveNotification | null = null
    const release = (): void => {
      if (this.live.get(key) === handle) this.live.delete(key)
    }
    handle = this.deps.spawn({
      title,
      ...(subtitle ? { subtitle } : {}),
      body,
      onClose: release,
      onClick: () => {
        release()
        this.listeners.forEach((fn) => fn(sessionId))
      }
    })
    if (!handle) return false
    this.live.set(key, handle)
    return true
  }

  /** Cierra todas las notificaciones vivas de la sesión, de cualquier tipo. */
  dismiss(sessionId: string): void {
    for (const kind of KINDS) {
      const key = keyOf(sessionId, kind)
      const handle = this.live.get(key)
      if (!handle) continue
      this.live.delete(key)
      handle.close()
    }
  }

  onActivate(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Cuántas siguen vivas (para tests). */
  get size(): number {
    return this.live.size
  }
}

const KINDS: readonly NotifyKind[] = ['question', 'done']

function keyOf(sessionId: string, kind: NotifyKind): string {
  return `${sessionId}\u0000${kind}`
}
