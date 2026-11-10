import type { Todo } from '@shared/types'

/** Grupos del widget, en el orden en que se pintan: pendientes y, plegado, Hecho (solo las de hoy). */
export interface TodoGroups {
  pending: Todo[]
  done: Todo[]
}

/** Dos timestamps caen en el mismo día del calendario local. */
export function isSameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/** Tarea nueva: pendiente, en Hoy, sin agente. El id lo pone `crypto.randomUUID` salvo que se inyecte (tests). */
export function newTodo(text: string, projectId: string | null, now = Date.now(), id: string = crypto.randomUUID()): Todo {
  return { id, text: text.trim(), done: false, when: 'today', projectId, sessionId: null, createdAt: now, doneAt: null }
}

/**
 * Reparte las tareas en sus grupos: todas las pendientes juntas (ya no hay Hoy/Mañana; el `when` de
 * tareas viejas se ignora) y las hechas solo si se terminaron hoy. Dentro de cada grupo manda el
 * orden de creación.
 */
export function groupTodos(todos: readonly Todo[], now = Date.now()): TodoGroups {
  const byCreated = (a: Todo, b: Todo): number => a.createdAt - b.createdAt
  return {
    pending: todos.filter((t) => !t.done).sort(byCreated),
    done: todos.filter((t) => t.done && t.doneAt !== null && isSameDay(t.doneAt, now)).sort(byCreated)
  }
}

/** Ids en el orden en que el cursor los recorre (J/K): pendientes y, si está desplegado, Hecho. */
export function visibleIds(groups: TodoGroups, doneOpen: boolean): string[] {
  return [...groups.pending, ...(doneOpen ? groups.done : [])].map((t) => t.id)
}

/** Pendientes: el `N` de la cabecera y del ítem `Tareas` del sidebar. */
export function pendingTodoCount(todos: readonly Todo[]): number {
  return todos.filter((t) => !t.done).length
}

/** Alterna hecha/pendiente. */
export function toggledDone(todo: Todo, now = Date.now()): Todo {
  return todo.done ? { ...todo, done: false, doneAt: null, when: 'today' } : { ...todo, done: true, doneAt: now }
}

/** Cursor tras mover `delta` con wrap-around; sin cursor válido, J va a la primera y K a la última. */
export function cursorAfterMove(ids: readonly string[], cursor: string | null, delta: number): string | null {
  if (ids.length === 0) return null
  const i = cursor === null ? -1 : ids.indexOf(cursor)
  if (i === -1) return delta > 0 ? ids[0] : ids[ids.length - 1]
  return ids[(i + delta + ids.length) % ids.length]
}

/**
 * Cursor válido para una lista nueva: si sigue en ella se queda; si desapareció (borrada, hecha con
 * Hecho plegado) baja a la que ocupaba su posición en la lista anterior, o a la última.
 */
export function settleCursor(ids: readonly string[], cursor: string | null, previousIds: readonly string[] = ids): string | null {
  if (ids.length === 0) return null
  if (cursor !== null && ids.includes(cursor)) return cursor
  const was = cursor === null ? -1 : previousIds.indexOf(cursor)
  if (was === -1) return ids[0]
  return ids[Math.min(was, ids.length - 1)]
}

/** Suelta el vínculo con un agente que murió: la tarea sigue pendiente, no se marca hecha sola. */
export function unlinkSession(todos: readonly Todo[], sessionId: string): Todo[] {
  return todos.map((t) => (t.sessionId === sessionId ? { ...t, sessionId: null } : t))
}

/** Suelta los vínculos con sesiones que ya no existen (tras un arranque en frío sin daemon, por ejemplo). Sin cambios devuelve el mismo array. */
export function unlinkMissing(todos: Todo[], alive: ReadonlySet<string>): Todo[] {
  const dead = (t: Todo): boolean => t.sessionId !== null && !alive.has(t.sessionId)
  return todos.some(dead) ? todos.map((t) => (dead(t) ? { ...t, sessionId: null } : t)) : todos
}

/** Las hechas se guardan una semana; después se podan al cargar. */
export const DONE_KEEP_MS = 7 * 24 * 60 * 60 * 1000

/** Quita las hechas con más de `keepMs` (por `doneAt`). Sin cambios devuelve el mismo array. */
export function pruneDone(todos: Todo[], now = Date.now(), keepMs = DONE_KEEP_MS): Todo[] {
  const stale = (t: Todo): boolean => t.done && t.doneAt !== null && now - t.doneAt > keepMs
  return todos.some(stale) ? todos.filter((t) => !stale(t)) : todos
}
