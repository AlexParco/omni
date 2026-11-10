import { describe, expect, it } from 'vitest'
import type { Todo } from '@shared/types'
import { DONE_KEEP_MS, cursorAfterMove, groupTodos, isSameDay, newTodo, pendingTodoCount, pruneDone, settleCursor, toggledDone, unlinkMissing, unlinkSession, visibleIds } from './todos-logic'

/** Mediodía local de hoy: las comparaciones por día no dependen de la hora del test. */
const NOON = new Date(2026, 9, 15, 12, 0, 0).getTime()
const YESTERDAY = NOON - 24 * 60 * 60 * 1000
const todo = (id: string, patch: Partial<Todo> = {}): Todo => ({ ...newTodo(`Tarea ${id}`, 'p1', NOON, id), ...patch })

describe('newTodo', () => {
  it('crea una tarea pendiente, sin agente y con el texto recortado', () => {
    const t = newTodo('  revisar PR  ', 'p1', NOON, 'a')
    expect(t).toEqual({ id: 'a', text: 'revisar PR', done: false, when: 'today', projectId: 'p1', sessionId: null, createdAt: NOON, doneAt: null })
  })

  it('genera ids únicos con crypto.randomUUID si no se inyecta uno', () => {
    expect(newTodo('a', null).id).not.toBe(newTodo('a', null).id)
  })
})

describe('isSameDay', () => {
  it('compara por día del calendario local', () => {
    expect(isSameDay(NOON, NOON + 3600_000)).toBe(true)
    expect(isSameDay(NOON, YESTERDAY)).toBe(false)
  })
})

describe('groupTodos', () => {
  it('todas las pendientes juntas (también las viejas de Mañana) y Hecho solo con las de hoy, por orden de creación', () => {
    const todos = [
      todo('b', { createdAt: NOON + 2 }),
      todo('a', { createdAt: NOON + 1 }),
      todo('m', { when: 'tomorrow', createdAt: NOON + 3 }),
      todo('d', { done: true, doneAt: NOON - 60_000 }),
      todo('old', { done: true, doneAt: YESTERDAY }),
      todo('mdone', { when: 'tomorrow', done: true, doneAt: NOON })
    ]
    const g = groupTodos(todos, NOON)
    expect(g.pending.map((t) => t.id)).toEqual(['a', 'b', 'm'])
    expect(g.done.map((t) => t.id)).toEqual(['d', 'mdone'])
  })
})

describe('visibleIds', () => {
  const g = groupTodos([todo('a'), todo('m', { when: 'tomorrow' }), todo('d', { done: true, doneAt: NOON })], NOON)
  it('esconde Hecho mientras está plegado', () => {
    expect(visibleIds(g, false)).toEqual(['a', 'm'])
    expect(visibleIds(g, true)).toEqual(['a', 'm', 'd'])
  })
})

describe('pendingTodoCount', () => {
  it('cuenta todas las pendientes', () => {
    expect(pendingTodoCount([todo('a'), todo('m', { when: 'tomorrow' }), todo('d', { done: true, doneAt: NOON })])).toBe(2)
  })
})

describe('toggledDone', () => {
  it('marca hecha con la hora y al deshacer vuelve a pendiente', () => {
    const done = toggledDone(todo('a'), NOON)
    expect(done).toMatchObject({ done: true, doneAt: NOON })
    expect(toggledDone(done, NOON + 1)).toMatchObject({ done: false, doneAt: null })
  })
})

describe('cursorAfterMove', () => {
  const ids = ['a', 'b', 'c']
  it('recorre con wrap-around', () => {
    expect(cursorAfterMove(ids, 'a', 1)).toBe('b')
    expect(cursorAfterMove(ids, 'c', 1)).toBe('a')
    expect(cursorAfterMove(ids, 'a', -1)).toBe('c')
  })
  it('sin cursor válido J va a la primera y K a la última; lista vacía da null', () => {
    expect(cursorAfterMove(ids, null, 1)).toBe('a')
    expect(cursorAfterMove(ids, 'zz', -1)).toBe('c')
    expect(cursorAfterMove([], 'a', 1)).toBeNull()
  })
})

describe('settleCursor', () => {
  it('se queda si sigue en la lista', () => {
    expect(settleCursor(['a', 'b'], 'b')).toBe('b')
  })
  it('al desaparecer baja a la que ocupaba su posición, o a la última', () => {
    expect(settleCursor(['a', 'c'], 'b', ['a', 'b', 'c'])).toBe('c')
    expect(settleCursor(['a', 'b'], 'c', ['a', 'b', 'c'])).toBe('b')
    expect(settleCursor(['a'], null, [])).toBe('a')
    expect(settleCursor([], 'a', ['a'])).toBeNull()
  })
})

describe('unlinkSession y unlinkMissing', () => {
  it('suelta el vínculo sin marcar hecha', () => {
    const out = unlinkSession([todo('a', { sessionId: 's1' }), todo('b', { sessionId: 's2' })], 's1')
    expect(out.map((t) => t.sessionId)).toEqual([null, 's2'])
    expect(out[0].done).toBe(false)
  })
  it('suelta las sesiones que ya no existen', () => {
    const out = unlinkMissing([todo('a', { sessionId: 's1' }), todo('b', { sessionId: 's2' }), todo('c')], new Set(['s2']))
    expect(out.map((t) => t.sessionId)).toEqual([null, 's2', null])
  })
  it('sin vínculos muertos devuelve el mismo array (nada que guardar)', () => {
    const todos = [todo('a', { sessionId: 's1' }), todo('c')]
    expect(unlinkMissing(todos, new Set(['s1']))).toBe(todos)
  })
})

describe('pruneDone', () => {
  it('quita las hechas con más de 7 días y conserva pendientes y hechas recientes', () => {
    const todos = [todo('old', { done: true, doneAt: NOON - DONE_KEEP_MS - 1 }), todo('recent', { done: true, doneAt: NOON - DONE_KEEP_MS }), todo('pending', { createdAt: NOON - 30 * DONE_KEEP_MS })]
    expect(pruneDone(todos, NOON).map((t) => t.id)).toEqual(['recent', 'pending'])
  })
  it('sin nada que podar devuelve el mismo array', () => {
    const todos = [todo('a'), todo('d', { done: true, doneAt: NOON })]
    expect(pruneDone(todos, NOON)).toBe(todos)
  })
})
