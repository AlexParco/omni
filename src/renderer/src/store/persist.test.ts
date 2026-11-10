import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, SavedNode, SavedTab } from '@shared/types'
import { omni } from '@/lib/omni'
import { leaves, useLayout, type Tab } from './layout'
import { SAVE_DEBOUNCE_MS, fromSavedTabs, pruneState, schedulePersist, snapshot, startPersist, toSavedTabs } from './persist'
import { useSessions } from './sessions'

vi.mock('@/lib/omni', () => ({
  omni: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(() => () => {}) }
}))
vi.mock('@/panes/terminal/terminal-host', () => ({
  screenLines: () => null, disposeTerminal: vi.fn() }))

const WS = 'ws-1'
const OTHER = 'ws-2'

const leaf = (id: string, sessionId: string): SavedNode => ({ kind: 'leaf', id, sessionId })
const split = (id: string, dir: 'row' | 'col', children: SavedNode[], sizes?: number[]): SavedNode => ({
  kind: 'split',
  id,
  dir,
  children,
  sizes: sizes ?? children.map(() => 1 / children.length)
})
const tab = (id: string, root: SavedNode, extra: Partial<SavedTab> = {}): SavedTab => ({
  id,
  workspaceId: WS,
  root,
  focusedPaneId: leavesOf(root)[0],
  zoomedPaneId: null,
  ...extra
})
const leavesOf = (node: SavedNode): string[] => (node.kind === 'leaf' ? [node.id] : node.children.flatMap(leavesOf))

const state = (tabs: SavedTab[], extra: Partial<AppState> = {}): AppState => ({
  tabs,
  activeTab: {},
  currentWorkspaceId: WS,
  browsers: [],
  savedAt: 0,
  ...extra
})

describe('pruneState', () => {
  it('quita las hojas cuya sesión ya no existe y colapsa el split que queda con un hijo', () => {
    const saved = state([tab('t1', split('sp', 'row', [leaf('a', 's-a'), leaf('b', 's-b')]), { focusedPaneId: 'b', zoomedPaneId: 'b' })])

    const out = pruneState(saved, ['s-a'])

    expect(out.tabs).toHaveLength(1)
    expect(out.tabs[0].root).toEqual({ id: 'a', kind: 'leaf', sessionId: 's-a' })
    // El foco y el zoom apuntaban a la hoja muerta: caen a la viva y a sin zoom.
    expect(out.tabs[0].focusedPaneId).toBe('a')
    expect(out.tabs[0].zoomedPaneId).toBeNull()
  })

  it('un tab que se queda sin hojas desaparece y su entrada de activeTab también', () => {
    const saved = state([tab('t1', leaf('a', 's-a')), tab('t2', leaf('b', 's-b'))], { activeTab: { [WS]: 't1' } })

    const out = pruneState(saved, ['s-b'])

    expect(out.tabs.map((t) => t.id)).toEqual(['t2'])
    expect(out.activeTab).toEqual({ [WS]: 't2' })
  })

  it('sin ninguna sesión viva no queda nada', () => {
    const out = pruneState(state([tab('t1', leaf('a', 's-a'))], { activeTab: { [WS]: 't1' } }), [])

    expect(out.tabs).toEqual([])
    expect(out.activeTab).toEqual({})
  })

  it('activeTab inválido cae al primer tab del workspace', () => {
    const saved = state([tab('t1', leaf('a', 's-a')), tab('t2', leaf('b', 's-b'))], { activeTab: { [WS]: 'no-existe' } })

    expect(pruneState(saved, ['s-a', 's-b']).activeTab).toEqual({ [WS]: 't1' })
  })

  it('activeTab válido se conserva', () => {
    const saved = state([tab('t1', leaf('a', 's-a')), tab('t2', leaf('b', 's-b'))], { activeTab: { [WS]: 't2' } })

    expect(pruneState(saved, ['s-a', 's-b']).activeTab).toEqual({ [WS]: 't2' })
  })

  it('renormaliza los tamaños del split al quitar un hijo y conserva foco y zoom válidos', () => {
    const root = split('sp', 'col', [leaf('a', 's-a'), leaf('b', 's-b'), leaf('c', 's-c')], [0.5, 0.25, 0.25])
    const saved = state([tab('t1', root, { focusedPaneId: 'c', zoomedPaneId: 'c' })])

    const out = pruneState(saved, ['s-a', 's-c'])
    const kept = out.tabs[0].root
    if (kept.kind !== 'split') throw new Error('se esperaba un split')

    expect(kept.children.map((c) => c.id)).toEqual(['a', 'c'])
    expect(kept.sizes[0]).toBeCloseTo(2 / 3)
    expect(kept.sizes[1]).toBeCloseTo(1 / 3)
    expect(out.tabs[0].focusedPaneId).toBe('c')
    expect(out.tabs[0].zoomedPaneId).toBe('c')
  })

  it('un split anidado que queda con un hijo se colapsa dentro del padre', () => {
    const root = split('outer', 'row', [leaf('a', 's-a'), split('inner', 'col', [leaf('b', 's-b'), leaf('c', 's-c')])])
    const out = pruneState(state([tab('t1', root)]), ['s-a', 's-c'])
    const kept = out.tabs[0].root
    if (kept.kind !== 'split') throw new Error('se esperaba un split')

    expect(kept.id).toBe('outer')
    expect(kept.children).toEqual([
      { id: 'a', kind: 'leaf', sessionId: 's-a' },
      { id: 'c', kind: 'leaf', sessionId: 's-c' }
    ])
  })

  it('con la lista de workspaces, descarta tabs de workspaces que ya no existen y valida currentWorkspaceId', () => {
    const saved = state([tab('t1', leaf('a', 's-a')), tab('t2', leaf('b', 's-b'), { workspaceId: OTHER })], { activeTab: { [WS]: 't1', [OTHER]: 't2' }, currentWorkspaceId: OTHER })

    const out = pruneState(saved, ['s-a', 's-b'], [WS])

    expect(out.tabs.map((t) => t.id)).toEqual(['t1'])
    expect(out.activeTab).toEqual({ [WS]: 't1' })
    expect(out.currentWorkspaceId).toBeNull()
  })

  it('sin lista de workspaces conserva currentWorkspaceId tal cual', () => {
    expect(pruneState(state([], { currentWorkspaceId: OTHER }), []).currentWorkspaceId).toBe(OTHER)
  })

  it('una sesión repetida en dos hojas (archivo corrupto) solo queda en la primera', () => {
    const saved = state([tab('t1', leaf('a', 's-a')), tab('t2', leaf('b', 's-a'))])

    const out = pruneState(saved, ['s-a'])

    expect(out.tabs.map((t) => t.id)).toEqual(['t1'])
  })
})

describe('toSavedTabs / fromSavedTabs', () => {
  it('ida y vuelta conserva árbol, tamaños, foco y zoom', () => {
    const tabs: Tab[] = [
      {
        id: 't1',
        workspaceId: WS,
        root: {
          id: 'outer',
          kind: 'split',
          dir: 'row',
          sizes: [0.3, 0.7],
          children: [
            { id: 'a', kind: 'leaf', sessionId: 's-a' },
            { id: 'inner', kind: 'split', dir: 'col', sizes: [0.5, 0.5], children: [{ id: 'b', kind: 'leaf', sessionId: 's-b' }, { id: 'c', kind: 'leaf', sessionId: 's-c' }] }
          ]
        },
        focusedPaneId: 'b',
        zoomedPaneId: 'b'
      },
      { id: 't2', workspaceId: OTHER, root: { id: 'd', kind: 'leaf', sessionId: 's-d' }, focusedPaneId: 'd', zoomedPaneId: null }
    ]

    const saved = toSavedTabs(tabs)
    const back = fromSavedTabs(saved)

    expect(back).toEqual(tabs)
    // Es una copia, no la misma referencia: serializar no puede dejar el archivo atado al store.
    expect(back[0].root).not.toBe(tabs[0].root)
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved)
  })

  it('snapshot manda browsers vacío (los rellena main) y el workspace actual', () => {
    const lay = { tabs: [{ id: 't1', workspaceId: WS, root: { id: 'a', kind: 'leaf' as const, sessionId: 's-a' }, focusedPaneId: 'a', zoomedPaneId: null }], activeTab: { [WS]: 't1' } }

    const out = snapshot(lay, WS)

    expect(out.browsers).toEqual([])
    expect(out.currentWorkspaceId).toBe(WS)
    expect(out.activeTab).toEqual({ [WS]: 't1' })
    expect(out.activeTab).not.toBe(lay.activeTab)
    expect(out.tabs.flatMap((t) => leaves(fromSavedTabs([t])[0].root).map((l) => l.sessionId))).toEqual(['s-a'])
  })
})

describe('guardado con debounce', () => {
  let stop: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(omni.send).mockClear()
    useLayout.setState({ tabs: [], activeTab: {} })
    useSessions.setState({ ready: false, currentWorkspaceId: WS })
    stop = startPersist()
  })

  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('no manda nada antes de que init termine (ready = false)', () => {
    useLayout.getState().openTab(WS, 's-a')
    schedulePersist()
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 4)

    expect(omni.send).not.toHaveBeenCalled()
  })

  it('con init terminado, varios cambios seguidos se juntan en un solo state:save tras el debounce', () => {
    useSessions.setState({ ready: true })
    useLayout.getState().openTab(WS, 's-a')
    useLayout.getState().openTab(WS, 's-b')
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1)
    expect(omni.send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)

    expect(omni.send).toHaveBeenCalledTimes(1)
    const [channel, saved] = vi.mocked(omni.send).mock.calls[0] as [string, AppState]
    expect(channel).toBe('state:save')
    expect(saved.tabs.map((t) => leavesOf(t.root).length)).toEqual([1, 1])
    expect(saved.currentWorkspaceId).toBe(WS)
    expect(saved.browsers).toEqual([])
  })

  it('cambiar el workspace actual también guarda', () => {
    useSessions.setState({ ready: true })
    useSessions.setState({ currentWorkspaceId: OTHER })
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)

    expect(omni.send).toHaveBeenCalledTimes(1)
    const [, saved] = vi.mocked(omni.send).mock.calls[0] as [string, AppState]
    expect(saved.currentWorkspaceId).toBe(OTHER)
  })

  it('tras desuscribirse no guarda más', () => {
    useSessions.setState({ ready: true })
    stop()
    useLayout.getState().openTab(WS, 's-a')
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)

    expect(omni.send).not.toHaveBeenCalled()
    stop = () => {}
  })
})

describe('títulos guardados', () => {
  it('snapshot guarda solo los títulos no vacíos de las sesiones vivas', () => {
    const state = snapshot({ tabs: [], activeTab: {} }, null, { a: 'bug-prd', b: '', c: 'muerta' }, ['a', 'b'])
    expect(state.titles).toEqual({ a: 'bug-prd' })
  })

  it('snapshot sin títulos no agrega el campo', () => {
    expect(snapshot({ tabs: [], activeTab: {} }, null).titles).toBeUndefined()
  })

  it('pruneState devuelve los títulos de las sesiones que siguen vivas', () => {
    const saved = { tabs: [], activeTab: {}, currentWorkspaceId: null, browsers: [], savedAt: 0, titles: { a: 'bug-prd', z: 'muerta' } }
    expect(pruneState(saved, ['a']).titles).toEqual({ a: 'bug-prd' })
    expect(pruneState({ ...saved, titles: undefined }, ['a']).titles).toEqual({})
  })
})
