/**
 * Contrato de pane (DESIGN.md §4.1 llevado a Electron). Un pane es contenido
 * imperativo montado en un elemento: terminal, browser, editor, diff. React solo
 * reserva el hueco y delega; el pane maneja su propio foco y tamaño.
 */
export interface PaneHandle {
  focus(): void
  blur(): void
  /** Reajustar al tamaño del contenedor (p. ej. al volverse visible). */
  fit(): void
  dispose(): void
}

export interface PaneContent<Props> {
  type: string
  mount(el: HTMLElement, props: Props): PaneHandle
}
