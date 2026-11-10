/**
 * Raíces de los panes de vista previa montados, por id de sesión: el store enfoca la raíz al entrar
 * al pane (espejo de `focusBrowserRoot` en el navegador). Sin React ni stores: lo usan ambos.
 */
const roots = new Map<string, HTMLElement>()

export function registerPreviewPane(id: string, root: HTMLElement): void {
  roots.set(id, root)
}

export function unregisterPreviewPane(id: string, root: HTMLElement): void {
  if (roots.get(id) === root) roots.delete(id)
}

/** Enfoca la raíz del pane si está montado; `false` si no (el pane enfocará al montar). */
export function focusPreviewRoot(id: string): boolean {
  const root = roots.get(id)
  if (!root) return false
  root.focus()
  return true
}
