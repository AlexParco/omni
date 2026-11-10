import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/headless'

/** Filas de scrollback que guarda el espejo; las mismas que la xterm del renderer. */
export const MIRROR_SCROLLBACK = 5000
/** Filas de scrollback que se guardan en disco por sesión (§3.10b): suficiente contexto sin archivos enormes. */
export const SNAPSHOT_SCROLLBACK = 1000

/**
 * Espejo sin pantalla de una terminal (`@xterm/headless`): procesa la misma salida que la xterm
 * del renderer y, al reconectar, `serialize` devuelve el estado exacto (pantalla, pantalla
 * alterna, colores, cursor) en vez de reproducir bytes crudos que pueden empezar a medio escape.
 */
export class ScreenMirror {
  private readonly term: Terminal
  private readonly serializer = new SerializeAddon()

  constructor(cols: number, rows: number, scrollback = MIRROR_SCROLLBACK) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
    this.term.loadAddon(this.serializer)
    // Mismo ancho de caracteres que el renderer: sin esto un emoji descuadra las columnas al repintar.
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = '11'
  }

  write(data: string): void {
    this.term.write(data)
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.term.resize(cols, rows)
  }

  /** Secuencia que, escrita en una xterm vacía del mismo tamaño, reconstruye esta pantalla. */
  serialize(): string {
    return this.serializer.serialize({ scrollback: MIRROR_SCROLLBACK })
  }

  /** Filas del buffer normal más el scrollback reciente, sin pantalla alterna ni modos: lo que se guarda en disco para revivir la sesión. */
  snapshot(scrollback = SNAPSHOT_SCROLLBACK): string {
    return this.serializer.serialize({ scrollback, excludeAltBuffer: true, excludeModes: true })
  }

  /** Resuelve cuando todo lo escrito ya se procesó (para tests). */
  flush(): Promise<void> {
    return new Promise((resolve) => this.term.write('', resolve))
  }

  dispose(): void {
    this.term.dispose()
  }
}
