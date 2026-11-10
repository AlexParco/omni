/**
 * Quién "tiene el teclado dentro de un pane" (ARCHITECTURE §5): el textarea de xterm, la raíz o la
 * barra del navegador, CodeMirror (con su árbol y su compositor) y la vista previa. Los blur de
 * cada host se evalúan un tick después contra esto: si el foco siguió en un pane o fue a un overlay,
 * `ui.focus` se queda en `terminal`; si no, vuelve a la lista. Un host nuevo suma su raíz aquí.
 */
export const PANE_SELECTOR = '.term-root, .browser, .editor, .preview'

/** El elemento está dentro de un pane con teclado propio. */
export function insidePane(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && el.closest(PANE_SELECTOR) !== null
}

/** El elemento está dentro de un overlay (paleta, diálogo): el pane no pierde su intención. */
export function insideOverlay(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && el.closest('.overlay') !== null
}

/** El foco DOM sigue "en la app": en un overlay o en un pane. Es lo que decide no caer a `list`. */
export function focusStays(el: EventTarget | null): boolean {
  return insideOverlay(el) || insidePane(el)
}
