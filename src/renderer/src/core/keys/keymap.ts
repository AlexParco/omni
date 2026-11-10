import { normalizeChord, type Chord } from './chord'

/**
 * Capas de teclado. Cada capa mapea chord → id de comando. Quién está activa lo
 * decide el foco (ver ARCHITECTURE.md §Teclado):
 *  - `global`:   atajos con ⌘, valen siempre que no haya overlay.
 *  - `list`:     teclas sueltas estilo vim cuando el foco está en una lista.
 *  - `terminal`: teclas DESPUÉS del prefijo C-a, cuando el foco está en una terminal.
 *  - `editorTree`: teclas sueltas con el foco DOM en el árbol lateral de un editor (§3.19).
 */
export type Layer = 'global' | 'list' | 'terminal' | 'worktrees' | 'review' | 'broadcast' | 'editorTree'

export class Keymap {
  private layers: Record<Layer, Map<Chord, string>> = {
    global: new Map(),
    list: new Map(),
    terminal: new Map(),
    worktrees: new Map(),
    review: new Map(),
    broadcast: new Map(),
    editorTree: new Map()
  }

  bind(layer: Layer, chord: Chord, commandId: string): void {
    this.layers[layer].set(normalizeChord(chord), commandId)
  }

  unbind(layer: Layer, chord: Chord): void {
    this.layers[layer].delete(normalizeChord(chord))
  }

  /** Vacía todas las capas (para reconstruir desde los ajustes). */
  clear(): void {
    ;(Object.keys(this.layers) as Layer[]).forEach((layer) => this.layers[layer].clear())
  }

  /** Primera capa que resuelve gana. */
  resolve(layers: Layer[], chord: Chord): string | undefined {
    const key = normalizeChord(chord)
    for (const layer of layers) {
      const id = this.layers[layer].get(key)
      if (id) return id
    }
    return undefined
  }

  /** Todos los atajos de una capa, en orden de registro (para la hoja de atajos). */
  bindings(layer: Layer): Array<{ chord: Chord; commandId: string }> {
    return [...this.layers[layer].entries()].map(([chord, commandId]) => ({ chord, commandId }))
  }

  /** Chords que disparan un comando, para pintar hints. */
  chordsFor(commandId: string): Array<{ layer: Layer; chord: Chord }> {
    const out: Array<{ layer: Layer; chord: Chord }> = []
    ;(Object.keys(this.layers) as Layer[]).forEach((layer) => {
      this.layers[layer].forEach((id, chord) => {
        if (id === commandId) out.push({ layer, chord })
      })
    })
    return out
  }
}

export const keymap = new Keymap()
