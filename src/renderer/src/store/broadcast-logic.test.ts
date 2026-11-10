import { describe, expect, it } from 'vitest'
import type { Broadcast, BroadcastCandidate } from '@shared/types'
import {
  aggregateState,
  candidateAfterMove,
  clampCandidate,
  depsLabel,
  depsOf,
  diffLabel,
  diffPair,
  headerLine,
  liveCandidates,
  newRound,
  pruneRounds,
  roundMeta,
  roundName,
  roundsOf,
  sortRounds,
  summaryOf,
  unlinkDeadSessions,
  visibleFiles,
  worktreeNamesFor
} from './broadcast-logic'

const NOW = 1_700_000_000_000
const cand = (workspaceId: string, sessionId: string | null = `s-${workspaceId}`, agent: BroadcastCandidate['agent'] = 'claude'): BroadcastCandidate => ({ workspaceId, sessionId, agent })
const round = (id: string, extra: Partial<Broadcast> = {}): Broadcast => ({ id, projectId: 'p1', prompt: 'Agrega rate limit por IP al endpoint de login', createdAt: NOW, candidates: [cand('w1'), cand('w2', 's-w2', 'codex')], chosen: null, state: 'running', ...extra })
const file = (path: string, additions = 1, deletions = 0) => ({ path, status: 'M' as const, additions, deletions })

describe('roundName', () => {
  it('toma las primeras seis palabras y colapsa el blanco', () => {
    expect(roundName('  Agrega   rate limit\npor IP al endpoint de login ')).toBe('Agrega rate limit por IP al')
    expect(roundName('corto')).toBe('corto')
    expect(roundName('   ')).toBe('Ronda')
  })
})

describe('depsOf / depsLabel', () => {
  it('detecta los archivos de dependencias por nombre, sin repetir y en orden', () => {
    const files = [file('src/a.ts'), file('package.json'), file('apps/web/package.json'), file('go.mod'), file('Cargo.lock'), file('Gemfile'), file('requirements.txt'), file('pnpm-lock.yaml'), file('Cargo.toml')]
    expect(depsOf(files)).toEqual(['package.json', 'go.mod', 'Gemfile', 'requirements.txt', 'pnpm-lock.yaml', 'Cargo.toml'])
    expect(depsOf([file('src/a.ts')])).toEqual([])
    expect(depsLabel([])).toBe('ninguna')
    expect(depsLabel(['package.json', 'go.mod'])).toBe('package.json, go.mod')
  })
})

describe('visibleFiles / diffLabel / summaryOf', () => {
  it('muestra seis archivos y cuenta el resto', () => {
    const files = Array.from({ length: 9 }, (_, i) => file(`f${i}.ts`))
    const { shown, more } = visibleFiles(files)
    expect(shown.map((f) => f.path)).toEqual(['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts'])
    expect(more).toBe(3)
    expect(visibleFiles(files.slice(0, 2)).more).toBe(0)
  })
  it('diffLabel suma los archivos; sin diff, vacío; sin archivos, sin cambios', () => {
    expect(diffLabel(undefined)).toBe('')
    expect(diffLabel({ files: [], truncated: false })).toBe('sin cambios')
    expect(diffLabel({ files: [file('a', 3, 1)], truncated: false })).toBe('+3 −1 · 1 archivo')
    expect(diffLabel({ files: [file('a', 3, 1), file('b', 2, 2)], truncated: false })).toBe('+5 −3 · 2 archivos')
  })
  it('summaryOf es la última línea no vacía sin ANSI', () => {
    expect(summaryOf('\x1b[1mHola\x1b[0m\r\n\r\n  ✔ 12 tests ok  \r\n\r\n')).toBe('  ✔ 12 tests ok')
    expect(summaryOf('')).toBe('')
  })
})

describe('orden y filtro de rondas', () => {
  it('sortRounds pone la más nueva arriba y roundsOf filtra por proyecto', () => {
    const a = round('a', { createdAt: NOW - 1000 })
    const b = round('b', { createdAt: NOW })
    const c = round('c', { createdAt: NOW + 1, projectId: 'p2' })
    expect(sortRounds([a, c, b]).map((r) => r.id)).toEqual(['c', 'b', 'a'])
    expect(roundsOf([a, c, b], 'p1').map((r) => r.id)).toEqual(['b', 'a'])
    expect(roundsOf([a, c, b], null).map((r) => r.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('aggregateState', () => {
  it('running mientras alguno trabaja o pregunta; done cuando todos están en reposo o murieron', () => {
    expect(aggregateState('running', ['idle', 'working'])).toBe('running')
    expect(aggregateState('done', ['question', null])).toBe('running')
    expect(aggregateState('running', ['idle', null])).toBe('done')
    expect(aggregateState('running', [])).toBe('done')
    expect(aggregateState('merged', ['working'])).toBe('merged')
    expect(aggregateState('discarded', ['working'])).toBe('discarded')
    // Lanzando (crear worktrees y agentes): en marcha aunque aún no haya nadie.
    expect(aggregateState('running', [], true)).toBe('running')
    expect(aggregateState('done', ['idle'], true)).toBe('running')
    expect(aggregateState('merged', [], true)).toBe('merged')
  })
})

describe('pruneRounds / unlinkDeadSessions', () => {
  it('quita los candidatos sin worktree, suelta el elegido si se fue y descarta la ronda vacía', () => {
    const r = round('a', { chosen: 'w2' })
    const out = pruneRounds([r], new Set(['w1']))
    expect(out[0].candidates.map((c) => c.workspaceId)).toEqual(['w1'])
    expect(out[0].chosen).toBeNull()
    expect(out[0].state).toBe('running')
    expect(pruneRounds([r], new Set())[0].state).toBe('discarded')
  })
  it('no toca las rondas cerradas ni devuelve otro array si nada cambió', () => {
    const merged = round('m', { state: 'merged' })
    const list = [merged, round('a')]
    expect(pruneRounds(list, new Set(['w1', 'w2']))).toBe(list)
    expect(pruneRounds([merged], new Set())[0]).toBe(merged)
  })
  it('una sesión muerta deja al candidato sin agente', () => {
    const list = [round('a')]
    expect(unlinkDeadSessions(list, new Set(['s-w1', 's-w2']))).toBe(list)
    const out = unlinkDeadSessions(list, new Set(['s-w1']))
    expect(out[0].candidates.map((c) => c.sessionId)).toEqual(['s-w1', null])
  })
})

describe('navegación entre candidatos', () => {
  it('liveCandidates deja solo los que tienen worktree', () => {
    const r = round('a', { candidates: [cand('w1'), cand('gone'), cand('w2')] })
    expect(liveCandidates(r, [{ id: 'w1' }, { id: 'w2' }]).map((c) => c.workspaceId)).toEqual(['w1', 'w2'])
    expect(liveCandidates(undefined, [{ id: 'w1' }])).toEqual([])
  })
  it('clampCandidate y candidateAfterMove con wrap-around', () => {
    const list = round('a').candidates
    expect(clampCandidate(list, 5)).toBe(1)
    expect(clampCandidate(list, -1)).toBe(0)
    expect(clampCandidate([], 3)).toBe(0)
    expect(candidateAfterMove(list, 0, 1)).toBe(1)
    expect(candidateAfterMove(list, 1, 1)).toBe(0)
    expect(candidateAfterMove(list, 0, -1)).toBe(1)
    expect(candidateAfterMove([], 0, 1)).toBe(0)
  })
  it('diffPair: elegido contra el actual, o los dos primeros', () => {
    const list = [cand('w1'), cand('w2'), cand('w3')]
    expect(diffPair(list, null, 2)?.map((c) => c.workspaceId)).toEqual(['w1', 'w2'])
    expect(diffPair(list, 'w3', 0)?.map((c) => c.workspaceId)).toEqual(['w3', 'w1'])
    // Cursor sobre el elegido: no se compara consigo mismo.
    expect(diffPair(list, 'w3', 2)?.map((c) => c.workspaceId)).toEqual(['w1', 'w2'])
    expect(diffPair([cand('w1')], null, 0)).toBeNull()
  })
})

describe('worktreeNamesFor / etiquetas', () => {
  it('numera por badge sin chocar entre agentes repetidos ni con los que existen', () => {
    const badge = (a: string): string => (a === 'claude' ? 'CC' : 'CX')
    expect(worktreeNamesFor(['claude', 'claude', 'codex'], badge, ['cc-1'])).toEqual(['cc-2', 'cc-3', 'cx-1'])
  })
  it('headerLine y roundMeta', () => {
    const r = round('a')
    expect(headerLine(r, 'main', 'pnpm test')).toBe('2 worktrees desde main · pnpm test al terminar')
    expect(headerLine({ candidates: [cand('w1')] }, null, null)).toBe('1 worktree · sin tests al terminar')
    expect(roundMeta(r, 'hace 14m')).toBe('2 agentes · hace 14m')
  })
  it('newRound nace en marcha, sin candidatos y con el prompt limpio', () => {
    const r = newRound('p1', '  hola  ', NOW, 'id')
    expect(r).toEqual({ id: 'id', projectId: 'p1', prompt: 'hola', createdAt: NOW, candidates: [], chosen: null, state: 'running' })
  })
})

describe('agentSaid', () => {
  it('toma el último mensaje del agente, no la sugerencia del prompt', async () => {
    const { agentSaid } = await import('./broadcast-logic')
    const screen = ['⏺ Update(sum.js)', '⏺ Listo: agregué mul y npm test pasa.', '──────', '❯ haz commit de los cambios', '──────']
    expect(agentSaid(screen)).toBe('Listo: agregué mul y npm test pasa.')
    expect(agentSaid(['λ ~/repo/ ls'])).toBeNull()
  })
})
