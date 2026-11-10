import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '@shared/types'
import { sanitizeState, StateStore } from './state'

const good: AppState = {
  tabs: [
    { id: 't1', workspaceId: 'w1', root: { kind: 'split', id: 's1', dir: 'row', sizes: [0.5, 0.5], children: [{ kind: 'leaf', id: 'l1', sessionId: 'a' }, { kind: 'leaf', id: 'l2', sessionId: 'b' }] }, focusedPaneId: 'l1', zoomedPaneId: null }
  ],
  activeTab: { w1: 't1' },
  currentWorkspaceId: 'w1',
  browsers: [{ id: 'b1', workspaceId: 'w1', url: 'https://example.com' }],
  savedAt: 1
}

describe('sanitizeState', () => {
  it('conserva un estado válido tal cual', () => {
    expect(sanitizeState(good)).toEqual(good)
  })

  it('conserva el profileId del navegador solo si es un string no vacío', () => {
    const browsers = [
      { id: 'b1', workspaceId: 'w1', url: 'x', profileId: 'p1' },
      { id: 'b2', workspaceId: 'w1', url: 'x', profileId: '' },
      { id: 'b3', workspaceId: 'w1', url: 'x', profileId: 7 }
    ]
    expect(sanitizeState({ ...good, browsers })?.browsers).toEqual([
      { id: 'b1', workspaceId: 'w1', url: 'x', profileId: 'p1' },
      { id: 'b2', workspaceId: 'w1', url: 'x' },
      { id: 'b3', workspaceId: 'w1', url: 'x' }
    ])
  })

  it('conserva docs con forma válida y descarta el resto; sin docs no añade la clave', () => {
    const docs = [
      { id: 'd1', workspaceId: 'w1', path: '/w/a.ts', kind: 'editor' },
      { id: 'd2', workspaceId: 'w1', path: '/w/a.md', kind: 'preview' },
      { id: 'd3', workspaceId: 'w1', path: '/w/a.md', kind: 'otro' },
      { id: 'd4', workspaceId: 'w1', path: '', kind: 'editor' },
      { id: 'd5', workspaceId: 'w1', kind: 'editor' },
      { id: 7, workspaceId: 'w1', path: '/w/a.ts', kind: 'editor' },
      'basura'
    ]
    expect(sanitizeState({ ...good, docs })?.docs).toEqual([
      { id: 'd1', workspaceId: 'w1', path: '/w/a.ts', kind: 'editor' },
      { id: 'd2', workspaceId: 'w1', path: '/w/a.md', kind: 'preview' }
    ])
    expect(sanitizeState({ ...good, docs: ['basura'] })).not.toHaveProperty('docs')
    expect(sanitizeState({ ...good, docs: 'x' })).not.toHaveProperty('docs')
  })

  it('descarta hojas y tabs sin forma, y rellena tamaños que no cuadran', () => {
    const raw = {
      tabs: [
        { id: 't1', workspaceId: 'w1', root: { kind: 'split', id: 's', dir: 'col', sizes: [1], children: [{ kind: 'leaf', id: 'l1', sessionId: 'a' }, { kind: 'leaf', id: 'l2' }, { kind: 'leaf', id: 'l3', sessionId: 'c' }] }, focusedPaneId: 7 },
        { id: 't2' },
        'basura'
      ],
      activeTab: { w1: 't1', w2: 5 },
      browsers: [{ id: 'b1', workspaceId: 'w1', url: 'x' }, { id: 'b2' }],
      currentWorkspaceId: 3
    }
    const s = sanitizeState(raw)
    expect(s?.tabs).toHaveLength(1)
    const root = s?.tabs[0].root
    expect(root?.kind === 'split' && root.children.map((c) => c.id)).toEqual(['l1', 'l3'])
    expect(root?.kind === 'split' && root.sizes).toEqual([0.5, 0.5])
    expect(s?.tabs[0].focusedPaneId).toBe('')
    expect(s?.activeTab).toEqual({ w1: 't1' })
    expect(s?.browsers).toEqual([{ id: 'b1', workspaceId: 'w1', url: 'x' }])
    expect(s?.currentWorkspaceId).toBeNull()
  })

  it('un split que se queda sin hijos válidos desaparece con su tab', () => {
    expect(sanitizeState({ tabs: [{ id: 't', workspaceId: 'w', root: { kind: 'split', id: 's', dir: 'row', children: [{}] } }] })?.tabs).toEqual([])
  })

  it('lo que no es un objeto es null', () => {
    expect(sanitizeState('x')).toBeNull()
    expect(sanitizeState(null)).toBeNull()
  })
})

describe('StateStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-state-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sin archivo devuelve null; guarda y relee; escribe atómico (sin tmp residual)', () => {
    const file = join(dir, 'nested', 'state.json')
    const store = new StateStore(file)
    expect(store.load()).toBeNull()
    store.save(good)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(good)
    expect(store.load()).toEqual(good)
    expect(() => readFileSync(`${file}.tmp`)).toThrow()
  })

  it('archivo corrupto → null sin tirar', () => {
    const file = join(dir, 'state.json')
    writeFileSync(file, '{ roto')
    expect(new StateStore(file).load()).toBeNull()
  })
})

describe('sanitizeState · títulos', () => {
  it('conserva los títulos de texto y descarta los vacíos o de otro tipo', () => {
    const raw = { tabs: [], activeTab: {}, currentWorkspaceId: null, browsers: [], savedAt: 1, titles: { a: 'bug-prd', b: '', c: 3 } }
    expect(sanitizeState(raw)?.titles).toEqual({ a: 'bug-prd' })
    expect(sanitizeState({ ...raw, titles: 'x' })?.titles).toBeUndefined()
  })
})
