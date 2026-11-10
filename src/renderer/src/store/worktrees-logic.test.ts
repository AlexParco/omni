import { describe, expect, it } from 'vitest'
import type { Project, SessionInfo, Workspace, WorktreeStatus } from '@shared/types'
import { ageLabel, agentSessionOf, branchOf, detailLine, hasChanges, issuePrompt, launcherWorktreeName, normalizeWorktreeName, parseIssueNumber, statLabel, testsLabel, worktreeRows } from './worktrees-logic'

const NOW = 1_700_000_000_000
const MIN = 60_000

const project = (id: string): Project => ({ id, name: id, locations: [{ id, name: 'Local', path: `/x/${id}` }] })
const wt = (id: string, projectId: string): Workspace => ({ id, projectId, name: id, path: `/wt/${id}`, kind: 'worktree' })
const local = (id: string, projectId: string): Workspace => ({ id, projectId, name: projectId, path: `/x/${projectId}`, kind: 'local' })
const session = (id: string, workspaceId: string, createdAt = NOW, agent: SessionInfo['agent'] = 'claude'): SessionInfo => ({ id, agent, workspaceId, cwd: '/x', createdAt })
const status = (files: number, additions = files, deletions = 0, dirty = false, tests: WorktreeStatus['tests'] = null): WorktreeStatus => ({ branch: 'omni/x', base: 'main', dirty, stat: { files, additions, deletions }, tests })

describe('worktreeRows', () => {
  it('solo lista worktrees con proyecto conocido, en el orden de los proyectos', () => {
    const rows = worktreeRows([local('l1', 'b'), wt('w1', 'b'), wt('w2', 'a'), wt('w3', 'zzz')], [project('a'), project('b')], [], {}, {})
    expect(rows.map((r) => r.workspace.id)).toEqual(['w2', 'w1'])
  })

  it('dentro de un proyecto van primero los que tienen agente y luego los más nuevos', () => {
    const sessions = [session('s1', 'w2', NOW - 5 * MIN), session('s2', 'w4', NOW - 50 * MIN)]
    const firstSeen = { w1: NOW - 10 * MIN, w3: NOW - 2 * MIN }
    const rows = worktreeRows([wt('w1', 'a'), wt('w2', 'a'), wt('w3', 'a'), wt('w4', 'a')], [project('a')], sessions, {}, firstSeen)
    expect(rows.map((r) => r.workspace.id)).toEqual(['w2', 'w4', 'w3', 'w1'])
    expect(rows[0].since).toBe(NOW - 5 * MIN)
    expect(rows[2].since).toBe(NOW - 2 * MIN)
  })

  it('la antigüedad es la sesión más vieja del worktree, aunque sea un navegador', () => {
    const sessions = [session('s1', 'w1', NOW - 5 * MIN), session('b', 'w1', NOW - 30 * MIN, 'browser')]
    const [row] = worktreeRows([wt('w1', 'a')], [project('a')], sessions, { w1: status(2) }, {})
    expect(row.since).toBe(NOW - 30 * MIN)
    expect(row.session?.id).toBe('s1')
    expect(row.status?.stat.files).toBe(2)
  })
})

describe('agentSessionOf', () => {
  it('prefiere una sesión que no sea navegador; sin ninguna, el navegador', () => {
    expect(agentSessionOf([session('b', 'w', NOW, 'browser'), session('c', 'w')], 'w')?.id).toBe('c')
    expect(agentSessionOf([session('b', 'w', NOW, 'browser')], 'w')?.id).toBe('b')
    expect(agentSessionOf([session('c', 'otro')], 'w')).toBeUndefined()
  })
})

describe('etiquetas', () => {
  it('ageLabel: ahora, minutos, horas y días', () => {
    expect(ageLabel(NOW, NOW)).toBe('ahora')
    expect(ageLabel(NOW - 14 * MIN, NOW)).toBe('hace 14m')
    expect(ageLabel(NOW - 3 * 60 * MIN, NOW)).toBe('hace 3h')
    expect(ageLabel(NOW - 72 * 60 * MIN, NOW)).toBe('hace 3d')
    expect(ageLabel(NOW + MIN, NOW)).toBe('ahora')
  })

  it('statLabel: +a −d · n archivos, singular y sin cambios', () => {
    expect(statLabel(undefined)).toBe('')
    expect(statLabel(status(0))).toBe('sin cambios')
    expect(statLabel(status(1, 12, 3))).toBe('+12 −3 · 1 archivo')
    expect(statLabel(status(4, 120, 33))).toBe('+120 −33 · 4 archivos')
  })

  it('testsLabel y detailLine', () => {
    expect(testsLabel(undefined)).toBe('')
    expect(testsLabel(status(1))).toBe('')
    expect(testsLabel(status(1, 1, 0, false, { status: 'pass', summary: 'ok', at: NOW }))).toBe('tests ok')
    expect(testsLabel(status(1, 1, 0, false, { status: 'fail', summary: '', at: NOW }))).toBe('tests fallaron')
    expect(detailLine(status(2, 10, 2, false, { status: 'running', summary: '', at: NOW }), NOW - 14 * MIN, NOW)).toBe('+10 −2 · 2 archivos · tests corriendo · hace 14m')
    expect(detailLine(undefined, NOW - 14 * MIN, NOW)).toBe('hace 14m')
  })

  it('hasChanges: dirty o archivos tocados', () => {
    expect(hasChanges(undefined)).toBe(false)
    expect(hasChanges(status(0))).toBe(false)
    expect(hasChanges(status(0, 0, 0, true))).toBe(true)
    expect(hasChanges(status(3))).toBe(true)
  })

  it('branchOf usa el estado si llegó y si no omni/<name>', () => {
    expect(branchOf({ name: 'cc-1' }, undefined)).toBe('omni/cc-1')
    expect(branchOf({ name: 'cc-1' }, { branch: 'omni/otra' })).toBe('omni/otra')
  })
})

describe('nombres', () => {
  it('launcherWorktreeName: badge en minúscula y primer número libre', () => {
    expect(launcherWorktreeName('CC', [])).toBe('cc-1')
    expect(launcherWorktreeName('CC', ['cc-1', 'cc-2', 'cx-1'])).toBe('cc-3')
    expect(launcherWorktreeName('CC', ['cc-2'])).toBe('cc-1')
    expect(launcherWorktreeName('$', [])).toBe('wt-1')
  })

  it('normalizeWorktreeName: minúsculas, guiones y 40 chars', () => {
    expect(normalizeWorktreeName('  Rate Limit por IP ')).toBe('rate-limit-por-ip')
    expect(normalizeWorktreeName('--x--')).toBe('x')
    expect(normalizeWorktreeName('a'.repeat(60))).toHaveLength(40)
    expect(normalizeWorktreeName('   ')).toBe('')
  })

  it('issuePrompt y parseIssueNumber', () => {
    expect(issuePrompt({ number: 41, title: 'Rate limit', url: 'https://github.com/o/r/issues/41' })).toBe('Issue #41: Rate limit\nhttps://github.com/o/r/issues/41')
    expect(parseIssueNumber('41')).toBe(41)
    expect(parseIssueNumber(' #41 ')).toBe(41)
    expect(parseIssueNumber('https://github.com/o/r/issues/41')).toBe(41)
    expect(parseIssueNumber('https://github.com/o/r/issues/41/')).toBe(41)
    expect(parseIssueNumber('0')).toBeNull()
    expect(parseIssueNumber('abc')).toBeNull()
    expect(parseIssueNumber('')).toBeNull()
  })
})
