/**
 * Bus de comandos. Toda acción del usuario es un comando con id estable:
 * las teclas, la paleta ⌘K, y más adelante la CLI y el servidor MCP, llaman aquí.
 * Nada de lógica de dominio en handlers de teclado o en onClick: siempre un comando.
 */
export interface Command {
  /** Id estable con namespace por dominio: `session.next`, `launcher.open`. */
  id: string
  /** Título visible en la paleta. */
  title: string
  /** Agrupación en la paleta. */
  group?: string
  /** Disponibilidad. Si devuelve false el comando no corre ni se lista. */
  when?: () => boolean
  run: () => void | Promise<void>
}

export class CommandRegistry {
  private commands = new Map<string, Command>()

  /** Atómico: si hay un id duplicado no registra ninguno. El unregister solo quita lo que registró. */
  register(...cmds: Command[]): () => void {
    const dup = cmds.find((c) => this.commands.has(c.id)) ?? cmds.find((c, i) => cmds.findIndex((x) => x.id === c.id) !== i)
    if (dup) throw new Error(`comando duplicado: ${dup.id}`)
    cmds.forEach((c) => this.commands.set(c.id, c))
    return () => cmds.forEach((c) => {
      if (this.commands.get(c.id) === c) this.commands.delete(c.id)
    })
  }

  get(id: string): Command | undefined {
    return this.commands.get(id)
  }

  /** Comandos disponibles ahora mismo, en orden de registro. */
  list(): Command[] {
    return [...this.commands.values()].filter((c) => c.when?.() !== false)
  }

  /** Devuelve false si el comando no existe o no está disponible. */
  async run(id: string): Promise<boolean> {
    const cmd = this.commands.get(id)
    if (!cmd || cmd.when?.() === false) return false
    await cmd.run()
    return true
  }
}

export const commands = new CommandRegistry()
