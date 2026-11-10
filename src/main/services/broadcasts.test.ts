import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Broadcast } from '@shared/types'
import { BroadcastStore, sanitizeBroadcasts } from './broadcasts'

const good: Broadcast[] = [
  {
    id: 'r1',
    projectId: 'p1',
    prompt: 'Rate limit por IP',
    createdAt: 10,
    candidates: [
      { workspaceId: 'w1', sessionId: 's1', agent: 'claude' },
      { workspaceId: 'w2', sessionId: null, agent: 'codex' }
    ],
    chosen: 'w2',
    state: 'running'
  },
  { id: 'r2', projectId: 'p1', prompt: 'x', createdAt: 20, candidates: [], chosen: null, state: 'merged' }
]

describe('sanitizeBroadcasts', () => {
  it('conserva una lista válida tal cual', () => {
    expect(sanitizeBroadcasts(good)).toEqual(good)
  })

  it('descarta rondas y candidatos rotos; chosen sin candidato pasa a null; createdAt raro a 0', () => {
    const raw = [
      { id: 'a', projectId: 'p', prompt: 'ok', state: 'done', createdAt: 'ayer', chosen: 'nope', candidates: [{ workspaceId: 'w', sessionId: 7, agent: 'claude' }, { workspaceId: '', agent: 'codex' }, { sessionId: 's' }, 'x'] },
      { id: 'b', projectId: 'p', prompt: 'estado inválido', state: 'paused', candidates: [] },
      { id: '', projectId: 'p', prompt: 'sin id', state: 'done' },
      { id: 'c', projectId: 'p', state: 'done' },
      null,
      { id: 'd', projectId: 'p', prompt: 'sin candidatos', state: 'discarded', chosen: null }
    ]
    expect(sanitizeBroadcasts(raw)).toEqual([
      { id: 'a', projectId: 'p', prompt: 'ok', createdAt: 0, candidates: [{ workspaceId: 'w', sessionId: null, agent: 'claude' }], chosen: null, state: 'done' },
      { id: 'd', projectId: 'p', prompt: 'sin candidatos', createdAt: 0, candidates: [], chosen: null, state: 'discarded' }
    ])
  })

  it('con ids repetidos se queda la primera; lo que no es un array es []', () => {
    expect(sanitizeBroadcasts([good[0], { ...good[1], id: 'r1' }]).map((r) => r.prompt)).toEqual(['Rate limit por IP'])
    expect(sanitizeBroadcasts({ rounds: good })).toEqual([])
    expect(sanitizeBroadcasts(null)).toEqual([])
  })
})

describe('BroadcastStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-broadcasts-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sin archivo devuelve []; guarda y relee; escribe atómico; un archivo corrupto se ignora', () => {
    const file = join(dir, 'nested', 'broadcasts.json')
    const store = new BroadcastStore(file)
    expect(store.load()).toEqual([])
    store.save(good)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(good)
    expect(store.load()).toEqual(good)
    expect(() => readFileSync(`${file}.tmp`)).toThrow()
    writeFileSync(file, '{ roto')
    expect(store.load()).toEqual([])
  })
})
