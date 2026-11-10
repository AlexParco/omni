import { Notification } from 'electron'
import type { NotificationsSetting, NotifyKind, NotifyTestResult } from '@shared/types'
import { NotificationGate, type NotificationRequest } from './notification-gate'

export interface NotifierDeps {
  getSetting: () => NotificationsSetting
  isFocused: () => boolean
  /** Trae la ventana al frente tras el clic (`win.show()` + `win.focus()`). */
  focusWindow: () => void
}

/**
 * Notificaciones nativas (ARCHITECTURE §3.14): la agrupación y el filtro viven en
 * `NotificationGate`; aquí solo se habla con `Notification` de Electron y con la ventana.
 */
export class Notifier {
  private readonly gate: NotificationGate

  constructor(deps: NotifierDeps) {
    this.gate = new NotificationGate({ getSetting: deps.getSetting, isFocused: deps.isFocused, spawn: spawnNative })
    this.gate.onActivate(() => deps.focusWindow())
  }

  show(sessionId: string, title: string, body: string, kind: NotifyKind, onScreen: boolean, subtitle?: string): void {
    this.gate.show(sessionId, title, body, kind, onScreen, subtitle)
  }

  dismiss(sessionId: string): void {
    this.gate.dismiss(sessionId)
  }

  onActivate(listener: (sessionId: string) => void): () => void {
    return this.gate.onActivate(listener)
  }

  /**
   * Aviso de ejemplo (Ajustes → Probar): salta el ajuste y la agrupación. Resuelve con `show` o con el
   * error de macOS (`failed`), o a los `TEST_TIMEOUT_MS` sin respuesta, que suele ser Electron de desarrollo.
   */
  test(): Promise<NotifyTestResult> {
    if (!Notification.isSupported()) return Promise.resolve({ ok: false, error: 'Este sistema no admite notificaciones' })
    return new Promise((resolve) => {
      const n = new Notification({ title: 'omni', subtitle: 'Prueba', body: 'Así te llega un aviso cuando un agente pregunta o termina.' })
      const done = (r: NotifyTestResult): void => {
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => done({ ok: false, error: 'macOS no respondió' }), TEST_TIMEOUT_MS)
      n.on('show', () => done({ ok: true }))
      n.on('failed', (_e, error) => done({ ok: false, error: /UNErrorDomain error 1/.test(error) ? 'macOS no deja notificar a omni' : error }))
      n.show()
      testNotification = n
    })
  }
}

/** Cuánto se espera a que macOS confirme el aviso de prueba. */
const TEST_TIMEOUT_MS = 4000
/** El aviso de prueba vive hasta el siguiente: sin referencia, el recolector lo retiraría del Centro de Notificaciones. */
let testNotification: Notification | null = null

function spawnNative(req: NotificationRequest): { close(): void } | null {
  // Traza: macOS puede aceptar la notificación y no pintar el banner (Focus, permisos del binario).
  console.log(`[omni] notificación nativa: "${req.title}" soportada=${Notification.isSupported()}`)
  if (!Notification.isSupported()) return null
  // macOS pinta el subtítulo bajo el título (de dónde viene: proyecto o worktree).
  const n = new Notification({ title: req.title, body: req.body, ...(req.subtitle ? { subtitle: req.subtitle } : {}) })
  n.on('click', req.onClick)
  n.on('close', req.onClose)
  // `failed` no está garantizado, pero si llega no hay nada que agrupar: se libera el hueco.
  n.on('failed', req.onClose)
  n.show()
  return { close: () => n.close() }
}
