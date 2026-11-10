import { describe, it, expect, beforeEach } from 'vitest'
import { CommandRegistry, type Command } from './registry'

function comando(id: string, extra: Partial<Command> = {}): Command {
  return { id, title: id, run: () => {}, ...extra }
}

describe('CommandRegistry', () => {
  let reg: CommandRegistry

  beforeEach(() => {
    reg = new CommandRegistry()
  })

  describe('register', () => {
    it('registra el comando y devuelve una función para quitarlo', () => {
      const quitar = reg.register(comando('session.next'))
      expect(reg.get('session.next')).toBeDefined()
      quitar()
      expect(reg.get('session.next')).toBeUndefined()
    })

    it('lanza error si el id ya existe', () => {
      reg.register(comando('session.next'))
      expect(() => reg.register(comando('session.next'))).toThrow('comando duplicado: session.next')
    })

    it('registra varios comandos de una vez', () => {
      reg.register(comando('a'), comando('b'))
      expect(reg.get('a')).toBeDefined()
      expect(reg.get('b')).toBeDefined()
    })
  })

  describe('list', () => {
    it('incluye comandos sin when o con when verdadero, en orden de registro', () => {
      reg.register(comando('b'), comando('a', { when: () => true }))
      expect(reg.list().map((c) => c.id)).toEqual(['b', 'a'])
    })

    it('filtra los comandos cuyo when devuelve false', () => {
      reg.register(comando('visible'), comando('oculto', { when: () => false }))
      expect(reg.list().map((c) => c.id)).toEqual(['visible'])
    })
  })

  describe('run', () => {
    it('devuelve false si el comando no existe', async () => {
      expect(await reg.run('no.existe')).toBe(false)
    })

    it('devuelve false y no ejecuta si when devuelve false', async () => {
      let corrio = false
      reg.register(comando('x', { when: () => false, run: () => {
        corrio = true
      } }))
      expect(await reg.run('x')).toBe(false)
      expect(corrio).toBe(false)
    })

    it('devuelve true y ejecuta el comando si está disponible', async () => {
      let corrio = false
      reg.register(comando('x', { run: () => {
        corrio = true
      } }))
      expect(await reg.run('x')).toBe(true)
      expect(corrio).toBe(true)
    })

    it('espera a un run asíncrono antes de devolver true', async () => {
      let terminado = false
      reg.register(
        comando('async', {
          run: async () => {
            await Promise.resolve()
            terminado = true
          }
        })
      )
      expect(await reg.run('async')).toBe(true)
      expect(terminado).toBe(true)
    })

    it('ya no ejecuta un comando después de quitarlo', async () => {
      let corrio = false
      const quitar = reg.register(comando('x', { run: () => {
        corrio = true
      } }))
      quitar()
      expect(await reg.run('x')).toBe(false)
      expect(corrio).toBe(false)
    })
  })

  describe('casos de borde', () => {
    it('un registro que falla por duplicado no deja comandos a medio registrar', () => {
      // Atomicidad: si lanza por duplicado, no queda nada registrado de esa llamada.
      reg.register(comando('dup'))
      expect(() => reg.register(comando('a'), comando('dup'))).toThrow()
      expect(reg.get('a')).toBeUndefined()
    })

    it('quitar un registro viejo no borra un comando nuevo con el mismo id', () => {
      // El unregister compara por identidad, no por id: un cleanup viejo no borra un registro nuevo.
      const quitarViejo = reg.register(comando('x', { title: 'viejo' }))
      quitarViejo()
      reg.register(comando('x', { title: 'nuevo' }))
      quitarViejo()
      expect(reg.get('x')?.title).toBe('nuevo')
    })
  })
})
