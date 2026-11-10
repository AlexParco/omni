import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Todo } from '@shared/types'
import { sanitizeTodos, TodoStore } from './todos'

const good: Todo[] = [
  { id: 'a', text: 'Revisar PR', done: false, when: 'today', projectId: 'p1', sessionId: null, createdAt: 1, doneAt: null },
  { id: 'b', text: 'Deploy', done: true, when: 'tomorrow', projectId: null, sessionId: 's1', createdAt: 2, doneAt: 3 }
]

describe('sanitizeTodos', () => {
  it('conserva una lista válida tal cual', () => {
    expect(sanitizeTodos(good)).toEqual(good)
  })

  it('descarta lo que no tiene forma, normaliza when y rellena lo opcional', () => {
    const raw = [
      { id: 'a', text: 'x', when: 'next-week', done: 'yes', projectId: 7, sessionId: 9, createdAt: 'ayer', doneAt: Infinity },
      { id: '', text: 'sin id' },
      { text: 'sin id' },
      { id: 'c' },
      'basura',
      null,
      { id: 'd', text: 'ok', when: 'tomorrow' }
    ]
    expect(sanitizeTodos(raw)).toEqual([
      { id: 'a', text: 'x', done: false, when: 'today', projectId: null, sessionId: null, createdAt: 0, doneAt: null },
      { id: 'd', text: 'ok', done: false, when: 'tomorrow', projectId: null, sessionId: null, createdAt: 0, doneAt: null }
    ])
  })

  it('con ids repetidos se queda la primera', () => {
    const dup = [good[0], { ...good[1], id: 'a' }, good[1]]
    expect(sanitizeTodos(dup).map((t) => t.text)).toEqual(['Revisar PR', 'Deploy'])
  })

  it('lo que no es un array es []', () => {
    expect(sanitizeTodos({ todos: good })).toEqual([])
    expect(sanitizeTodos('x')).toEqual([])
    expect(sanitizeTodos(null)).toEqual([])
  })
})

describe('TodoStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-todos-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sin archivo devuelve []; guarda y relee; escribe atómico (sin tmp residual)', () => {
    const file = join(dir, 'nested', 'todos.json')
    const store = new TodoStore(file)
    expect(store.load()).toEqual([])
    store.save(good)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(good)
    expect(store.load()).toEqual(good)
    expect(() => readFileSync(`${file}.tmp`)).toThrow()
  })

  it('archivo corrupto → [] sin tirar', () => {
    const file = join(dir, 'todos.json')
    writeFileSync(file, '[ roto')
    expect(new TodoStore(file).load()).toEqual([])
  })
})
