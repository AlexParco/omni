import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, Workspace } from '@shared/types'
import { leaves, useLayout } from './layout'
import { useSessions } from './sessions'
import { useUi } from './ui'
import { findDoc, homeOf, normalizePath, resolveInput, useDocs } from './docs'

const invoke = vi.fn()
const kill = vi.fn()
const focus = vi.fn()

vi.mock('@/lib/omni', () => ({
  omni: { invoke: (...args: unknown[]) => invoke(...args), send: vi.fn(), on: vi.fn(() => () => {}) }
}))
vi.mock('@/panes/terminal/terminal-host', () => ({
  screenLines: () => null, disposeTerminal: vi.fn() }))
vi.mock('@/panes/editor/editor-host', () => ({ getEditor: () => ({ focus }) }))

const ws: Workspace = { id: 'w1', projectId: 'p', name: 'local', path: '/repo', kind: 'local' }
const doc = (id: string, path: string, agent: SessionInfo['agent'] = 'editor'): SessionInfo => ({ id, agent, workspaceId: 'w1', cwd: '/repo', createdAt: 0, args: [path] })
const claude: SessionInfo = { id: 'c1', agent: 'claude', workspaceId: 'w1', cwd: '/repo', createdAt: 0 }

beforeEach(() => {
  invoke.mockReset()
  kill.mockReset()
  focus.mockReset()
  useLayout.setState({ tabs: [], activeTab: {} })
  useUi.setState({ focus: 'list', overlay: null })
  useSessions.setState({ workspaces: [ws], sessions: [claude], currentWorkspaceId: 'w1', cursor: 'p:p', kill })
  useDocs.setState({ dirty: {}, pendingClose: [], pendingSave: null, pathDialog: null })
})

describe('normalizePath / resolveInput / findDoc', () => {
  it('normalizePath resuelve . y .., barras repetidas y la final', () => {
    expect(normalizePath('/repo//src/./a.ts')).toBe('/repo/src/a.ts')
    expect(normalizePath('/repo/src/../lib/a.ts/')).toBe('/repo/lib/a.ts')
    expect(normalizePath('/repo/../../a.ts')).toBe('/a.ts')
    expect(normalizePath('src/../a.ts')).toBe('a.ts')
    expect(normalizePath('')).toBe('.')
  })
  it('expande ~ con la home deducida del workspace', () => {
    expect(homeOf('/Users/ana/repo')).toBe('/Users/ana')
    expect(homeOf('/home/ana/repo')).toBe('/home/ana')
    expect(homeOf('/srv/repo')).toBeNull()
    expect(normalizePath('~/x/a.ts', '/Users/ana/repo')).toBe('/Users/ana/x/a.ts')
    expect(normalizePath('~/x/a.ts', '/srv/repo')).toBe('~/x/a.ts')
  })
  it('resolveInput resuelve relativas contra el workspace y canoniza absolutas', () => {
    expect(resolveInput('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(resolveInput('/repo/', './src/a.ts')).toBe('/repo/src/a.ts')
    expect(resolveInput('/repo', '/otro//a.ts')).toBe('/otro/a.ts')
    expect(resolveInput('/Users/ana/repo', '~/b.ts')).toBe('/Users/ana/b.ts')
  })
  it('findDoc busca por tipo, workspace y ruta canónica', () => {
    const sessions = [claude, doc('e1', '/repo/a.ts'), doc('p1', '/repo/a.md', 'preview')]
    expect(findDoc(sessions, 'w1', '/repo/a.ts', 'editor')?.id).toBe('e1')
    expect(findDoc(sessions, 'w1', '/repo/src/../a.ts', 'editor')?.id).toBe('e1')
    expect(findDoc(sessions, 'w1', '/repo/a.ts', 'preview')).toBeUndefined()
    expect(findDoc(sessions, 'w1', '/repo/a.md', 'preview')?.id).toBe('p1')
  })
})

describe('open', () => {
  it('pide doc:open, agrega la sesión, abre un tab y entrega el teclado', async () => {
    invoke.mockResolvedValueOnce(doc('e1', '/repo/a.ts'))
    const info = await useDocs.getState().open('w1', '/repo/a.ts', 'editor', 'tab')
    expect(invoke).toHaveBeenCalledWith('doc:open', 'w1', '/repo/a.ts', 'editor')
    expect(info?.id).toBe('e1')
    expect(useSessions.getState().sessions.map((s) => s.id)).toEqual(['c1', 'e1'])
    const tabs = useLayout.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(leaves(tabs[0].root).map((l) => l.sessionId)).toEqual(['e1'])
    expect(useUi.getState().focus).toBe('terminal')
    expect(focus).toHaveBeenCalled()
  })

  it('split-right coloca el editor al lado del pane con foco', async () => {
    useLayout.getState().openTab('w1', 'c1')
    invoke.mockResolvedValueOnce(doc('e1', '/repo/a.ts'))
    await useDocs.getState().open('w1', '/repo/a.ts', 'editor', 'split-right')
    const tab = useLayout.getState().tabs[0]
    expect(tab.root.kind).toBe('split')
    expect(leaves(tab.root).map((l) => l.sessionId)).toEqual(['c1', 'e1'])
    expect(leaves(tab.root).find((l) => l.id === tab.focusedPaneId)?.sessionId).toBe('e1')
  })

  it('con el archivo ya abierto (aunque la ruta venga sin canonizar) no pide nada a main: solo enfoca ese pane', async () => {
    useSessions.setState((s) => ({ sessions: [...s.sessions, doc('e1', '/repo/a.ts')] }))
    useLayout.getState().openTab('w1', 'c1')
    useLayout.getState().openTab('w1', 'e1')
    useLayout.getState().setActiveTab('w1', useLayout.getState().tabs[0].id)
    const info = await useDocs.getState().open('w1', '/repo/./src/../a.ts', 'editor', 'tab')
    expect(invoke).not.toHaveBeenCalled()
    expect(info?.id).toBe('e1')
    expect(useLayout.getState().activeTab.w1).toBe(useLayout.getState().tabs[1].id)
    expect(useLayout.getState().tabs).toHaveLength(2)
  })

  it('openEditorBeside elige el workspace que contiene la ruta', async () => {
    invoke.mockResolvedValueOnce(doc('e1', '/repo/src/a.ts'))
    await useDocs.getState().openEditorBeside('/repo/src/a.ts')
    expect(invoke).toHaveBeenCalledWith('doc:open', 'w1', '/repo/src/a.ts', 'editor')
    invoke.mockClear()
    await useDocs.getState().openEditorBeside('/fuera/a.ts')
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('closeIfClean', () => {
  it('limpio: mata la sesión al toque', () => {
    expect(useDocs.getState().closeIfClean('e1')).toBe(true)
    expect(kill).toHaveBeenCalledWith('e1')
    expect(useUi.getState().overlay).toBeNull()
  })

  it('sucio: abre la confirmación y espera; confirmar mata, cancelar no', () => {
    useDocs.getState().setDirty('e1', true)
    expect(useDocs.getState().closeIfClean('e1')).toBe(false)
    expect(kill).not.toHaveBeenCalled()
    expect(useUi.getState().overlay).toBe('confirmDiscardDoc')
    expect(useDocs.getState().pendingClose).toEqual(['e1'])
    useDocs.getState().cancelDiscard()
    expect(useDocs.getState().pendingClose).toEqual([])
    expect(kill).not.toHaveBeenCalled()
    useDocs.getState().closeIfClean('e1')
    useDocs.getState().confirmDiscard()
    expect(kill).toHaveBeenCalledWith('e1')
    // Guardar limpia el flag y el cierre vuelve a ser directo.
    useDocs.getState().setDirty('e1', false)
    expect(useDocs.getState().closeIfClean('e1')).toBe(true)
  })
})

describe('closeManyIfClean (cerrar un tab)', () => {
  it('los sucios van juntos a la confirmación; los documentos limpios se matan; terminales se devuelven', () => {
    useSessions.setState((s) => ({ sessions: [...s.sessions, doc('e1', '/repo/a.ts'), doc('e2', '/repo/b.ts'), doc('e3', '/repo/c.ts')] }))
    useDocs.getState().setDirty('e1', true)
    useDocs.getState().setDirty('e2', true)
    const rest = useDocs.getState().closeManyIfClean(['c1', 'e1', 'e2', 'e3'])
    expect(rest).toEqual(['c1', 'e3'])
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith('e3')
    expect(useDocs.getState().pendingClose).toEqual(['e1', 'e2'])
    expect(useUi.getState().overlay).toBe('confirmDiscardDoc')
    useDocs.getState().confirmDiscard()
    expect(kill).toHaveBeenCalledWith('e1')
    expect(kill).toHaveBeenCalledWith('e2')
    expect(kill).not.toHaveBeenCalledWith('c1')
  })
  it('askOverwrite abre confirmOverwriteDoc para ese editor', () => {
    useDocs.getState().askOverwrite('e1')
    expect(useDocs.getState().pendingSave).toBe('e1')
    expect(useUi.getState().overlay).toBe('confirmOverwriteDoc')
    useDocs.getState().clearPendingSave()
    expect(useDocs.getState().pendingSave).toBeNull()
  })
})

describe('diálogo de ruta', () => {
  it('abre el overlay con tipo y destino; ⏎ abre el documento y cierra; el error se queda en el diálogo', async () => {
    useDocs.getState().openPathDialog('editor', 'split-right')
    expect(useUi.getState().overlay).toBe('editorPath')
    expect(useDocs.getState().pathDialog).toEqual({ kind: 'editor', target: 'split-right', error: null })
    invoke.mockRejectedValueOnce(new Error("Error invoking remote method 'doc:open': Error: No existe src/x.ts"))
    await useDocs.getState().openFromDialog('src/x.ts')
    expect(useDocs.getState().pathDialog?.error).toBe('No existe src/x.ts')
    expect(useUi.getState().overlay).toBe('editorPath')
    useLayout.getState().openTab('w1', 'c1')
    invoke.mockResolvedValueOnce(doc('e1', '/repo/src/a.ts'))
    await useDocs.getState().openFromDialog('src/a.ts')
    expect(invoke).toHaveBeenLastCalledWith('doc:open', 'w1', '/repo/src/a.ts', 'editor')
    expect(useDocs.getState().pathDialog).toBeNull()
    expect(useUi.getState().overlay).toBeNull()
    expect(useLayout.getState().tabs[0].root.kind).toBe('split')
  })
})
