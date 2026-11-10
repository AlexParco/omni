import { omni } from '@/lib/omni'

/**
 * Registro DOM de los panes de navegador, fuera de React (como `terminal-host` para xterm): el
 * store y los comandos necesitan enfocar la raíz del pane o su barra de URL sin pasar por props.
 * La vista nativa vive en main; aquí solo hay los elementos del renderer que la rodean.
 */
interface PaneElements {
  /** Raíz enfocable del pane (`tabindex=-1`): donde cae el foco DOM cuando la página tiene el teclado. */
  root: HTMLElement
  url: HTMLInputElement | null
}

const panes = new Map<string, PaneElements>()

export function registerBrowserPane(sessionId: string, els: PaneElements): void {
  panes.set(sessionId, els)
  reportMounted()
}

export function unregisterBrowserPane(sessionId: string, root: HTMLElement): void {
  if (panes.get(sessionId)?.root === root) panes.delete(sessionId)
  reportMounted()
}

let mountedQueued = false
/** Le dice a main qué navegadores tienen pane (una vez por tanda de montajes): esconde las vistas del resto. */
function reportMounted(): void {
  if (mountedQueued) return
  mountedQueued = true
  queueMicrotask(() => {
    mountedQueued = false
    omni.send('browser:mounted', [...panes.keys()])
  })
}

/** Lleva el foco DOM a la raíz del pane (sin seleccionar nada). `false` si el pane no está montado. */
export function focusBrowserRoot(sessionId: string): boolean {
  const root = panes.get(sessionId)?.root
  if (!root) return false
  root.focus()
  return true
}

/** Texto que hay ahora mismo en la barra de URL (el borrador del usuario); `null` si el pane no está montado. */
export function browserUrlDraft(sessionId: string): string | null {
  return panes.get(sessionId)?.url?.value ?? null
}

/** Id de la sesión del pane de navegador que contiene al elemento, si está dentro de uno. */
export function browserIdAt(el: EventTarget | null): string | null {
  if (!(el instanceof HTMLElement)) return null
  return el.closest<HTMLElement>('.browser')?.dataset.sessionId ?? null
}

/** Enfoca la barra de URL con todo el texto seleccionado. `false` si el pane no está montado. */
export function focusBrowserUrl(sessionId: string): boolean {
  const url = panes.get(sessionId)?.url
  if (!url) return false
  url.focus()
  url.select()
  return true
}

/* ---------- teclas de los modos con lienzo (área y markup) ---------- */

type ModeKeyHandler = (chord: string) => boolean

let modeKeyHandler: ModeKeyHandler | null = null

/**
 * El lienzo activo (recorte de área o markup) registra cómo atiende sus teclas (H J K L, letras de
 * herramienta, ⏎, Esc); main las reenvía si la página aún tenía el teclado (`browser:keyGrab`).
 */
export function setModeKeyHandler(handler: ModeKeyHandler | null): void {
  modeKeyHandler = handler
}

/** Tecla reenviada por main mientras un modo con lienzo está activo. `false` si no hay lienzo montado. */
export function forwardModeKey(chord: string): boolean {
  return modeKeyHandler?.(chord) ?? false
}
