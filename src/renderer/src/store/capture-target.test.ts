import { describe, expect, it } from 'vitest'
import type { AgentId, SessionInfo } from '@shared/types'
import { captureTarget, rankTargets } from './capture-target'
import type { Tab } from './layout'
import type { SessionStatus } from './sessions'

const session = (id: string, agent: AgentId, workspaceId = 'ws1', createdAt = 0): SessionInfo => ({ id, agent, workspaceId, cwd: '/x', createdAt })

/** Tab con una hoja por sesión, en un split row. */
function tab(id: string, workspaceId: string, sessionIds: string[]): Tab {
  const children = sessionIds.map((sessionId) => ({ id: `${id}-${sessionId}`, kind: 'leaf' as const, sessionId }))
  return {
    id,
    workspaceId,
    root: children.length === 1 ? children[0] : { id: `${id}-split`, kind: 'split', dir: 'row', children, sizes: children.map(() => 1 / children.length) },
    focusedPaneId: children[0].id,
    zoomedPaneId: null
  }
}

describe('captureTarget', () => {
  it('prefiere el pane del mismo tab con foco más reciente, aunque sea shell', () => {
    const sessions = [session('web', 'browser'), session('sh', 'shell'), session('cc', 'claude'), session('cx', 'codex', 'ws1', 9)]
    const tabs = [tab('t1', 'ws1', ['web', 'sh', 'cc']), tab('t2', 'ws1', ['cx'])]
    expect(captureTarget('web', sessions, tabs, ['web', 'sh', 'cc'])).toBe('sh')
    expect(captureTarget('web', sessions, tabs, ['cc', 'web'])).toBe('cc')
  })

  it('sin historial toma el primer vecino del tab en orden de árbol', () => {
    const sessions = [session('web', 'browser'), session('a', 'claude'), session('b', 'codex')]
    expect(captureTarget('web', sessions, [tab('t1', 'ws1', ['a', 'web', 'b'])], [])).toBe('a')
  })

  it('ignora otros navegadores del tab', () => {
    const sessions = [session('web', 'browser'), session('web2', 'browser'), session('cc', 'claude')]
    expect(captureTarget('web', sessions, [tab('t1', 'ws1', ['web', 'web2'])], ['web2'])).toBe('cc')
  })

  it('si el navegador está solo en su tab, va al último agente (no shell) del workspace', () => {
    const sessions = [session('web', 'browser'), session('sh', 'shell', 'ws1', 5), session('cc', 'claude', 'ws1', 1), session('cx', 'codex', 'ws1', 2), session('otro', 'claude', 'ws2', 9)]
    const tabs = [tab('t1', 'ws1', ['web']), tab('t2', 'ws1', ['sh']), tab('t3', 'ws1', ['cc', 'cx'])]
    // Con historial manda el foco más reciente; sin él, el creado más tarde.
    expect(captureTarget('web', sessions, tabs, ['sh', 'cc', 'cx'])).toBe('cc')
    expect(captureTarget('web', sessions, tabs, [])).toBe('cx')
  })

  it('sin agentes cae a la última terminal del workspace; sin nada devuelve null', () => {
    const sessions = [session('web', 'browser'), session('sh1', 'shell', 'ws1', 1), session('sh2', 'shell', 'ws1', 2)]
    const tabs = [tab('t1', 'ws1', ['web']), tab('t2', 'ws1', ['sh1']), tab('t3', 'ws1', ['sh2'])]
    expect(captureTarget('web', sessions, tabs, [])).toBe('sh2')
    expect(captureTarget('web', sessions, tabs, ['sh1'])).toBe('sh1')
    expect(captureTarget('web', [session('web', 'browser')], [tab('t1', 'ws1', ['web'])], [])).toBeNull()
    expect(captureTarget('nope', sessions, tabs, [])).toBeNull()
  })
})

describe('rankTargets', () => {
  const sessions = [
    session('web', 'browser'),
    session('sh', 'shell', 'ws1', 9),
    session('cc', 'claude', 'ws1', 1),
    session('cx', 'codex', 'ws1', 2),
    session('oc', 'opencode', 'ws1', 3),
    session('otro', 'claude', 'ws2', 9)
  ]
  const status = (map: Record<string, SessionStatus>) => (id: string): SessionStatus => map[id] ?? 'idle'

  it('pregunta abierta primero, luego trabajando, luego listo; solo el workspace del navegador y sin navegadores', () => {
    const ranked = rankTargets(sessions, 'ws1', status({ cx: 'question', oc: 'working', sh: 'working' }))
    expect(ranked.map((s) => s.id)).toEqual(['cx', 'oc', 'sh', 'cc'])
  })

  it('dentro del mismo estado, los agentes antes que el shell y el preferido primero', () => {
    expect(rankTargets(sessions, 'ws1', status({}), 'cc').map((s) => s.id)).toEqual(['cc', 'oc', 'cx', 'sh'])
    expect(rankTargets(sessions, 'ws1', status({})).map((s) => s.id)).toEqual(['oc', 'cx', 'cc', 'sh'])
  })

  it('sin terminales en el workspace devuelve vacío', () => {
    expect(rankTargets(sessions, 'ws3', status({}))).toEqual([])
  })
})
