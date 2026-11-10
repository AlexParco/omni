import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Todo, TodoWhen } from '@shared/types'

const DEFAULT_FILE = join(homedir(), '.config', 'omni', 'todos.json')

/**
 * `~/.config/omni/todos.json`: las tareas del widget To-do (ARCHITECTURE §3.12). El renderer es el
 * dueño del estado; main solo persiste (atómico: tmp + rename, como `StateStore`). Un archivo
 * corrupto se ignora: arrancar sin tareas es siempre válido.
 */
export class TodoStore {
  constructor(private readonly file = DEFAULT_FILE) {}

  load(): Todo[] {
    if (!existsSync(this.file)) return []
    try {
      return sanitizeTodos(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (err) {
      console.warn(`[omni] se ignora ${this.file}:`, err)
      return []
    }
  }

  save(todos: Todo[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(todos, null, 2) + '\n')
    renameSync(tmp, this.file)
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function sanitizeWhen(x: unknown): TodoWhen {
  return x === 'tomorrow' ? 'tomorrow' : 'today'
}

function sanitizeTodo(x: unknown): Todo | null {
  if (!isRecord(x) || typeof x.id !== 'string' || x.id === '' || typeof x.text !== 'string') return null
  return {
    id: x.id,
    text: x.text,
    done: x.done === true,
    when: sanitizeWhen(x.when),
    projectId: typeof x.projectId === 'string' ? x.projectId : null,
    sessionId: typeof x.sessionId === 'string' ? x.sessionId : null,
    createdAt: typeof x.createdAt === 'number' && Number.isFinite(x.createdAt) ? x.createdAt : 0,
    doneAt: typeof x.doneAt === 'number' && Number.isFinite(x.doneAt) ? x.doneAt : null
  }
}

/**
 * Deja solo las tareas con forma válida (id y texto); `when` desconocido → `today`; con ids
 * repetidos se queda la primera. Lo que no es un array → `[]`. Exportado para tests.
 */
export function sanitizeTodos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const todos: Todo[] = []
  for (const item of raw) {
    const todo = sanitizeTodo(item)
    if (!todo || seen.has(todo.id)) continue
    seen.add(todo.id)
    todos.push(todo)
  }
  return todos
}
