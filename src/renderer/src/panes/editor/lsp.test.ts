import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/omni', () => ({ omni: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(() => () => undefined) } }))

import { ChangeSet, EditorState, type Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { LSPClient } from '@codemirror/lsp-client'
import type { CodeDiagnostic } from '@shared/types'
import { OmniWorkspace, setLspHost } from './lsp'

/** Plugin LSP falso: lo justo que usan `OmniWorkspace` y `applyDiagnostics`. */
interface FakePlugin {
  view: FakeView
  syncedDoc: Text
  unsyncedChanges: ChangeSet
  clear(): void
  fromPosition(p: { line: number; character: number }, doc: Text): number
}
interface FakeView {
  state: EditorState
  plugin(): FakePlugin
  type(text: string): void
}

/** Vista falsa: `LSPPlugin.get(view)` es `view.plugin(lspPlugin)`. */
function fakeView(doc: string): EditorView {
  const view = {} as FakeView
  const plugin: FakePlugin = {
    view,
    syncedDoc: null as unknown as Text,
    unsyncedChanges: null as unknown as ChangeSet,
    clear() {
      plugin.syncedDoc = view.state.doc
      plugin.unsyncedChanges = ChangeSet.empty(view.state.doc.length)
    },
    fromPosition: (p, d) => d.line(p.line + 1).from + p.character
  }
  view.state = EditorState.create({ doc })
  view.plugin = () => plugin
  view.type = (text) => {
    const tr = view.state.update({ changes: { from: view.state.doc.length, insert: text } })
    view.state = tr.state
    plugin.unsyncedChanges = plugin.unsyncedChanges.compose(tr.changes)
  }
  plugin.clear()
  return view as unknown as EditorView
}
const typeIn = (view: EditorView, text: string): void => (view as unknown as FakeView).type(text)

interface Pending {
  method: string
  params: { textDocument: { uri: string } }
  resolve: (r: unknown) => void
  reject: (e: Error) => void
}

/** Cliente falso con modelo pull: guarda cada pedido para responderlo a mano. */
function fakeClient() {
  const pending: Pending[] = []
  const client = {
    serverCapabilities: { diagnosticProvider: {} },
    didOpen: vi.fn(),
    didClose: vi.fn(),
    sync: vi.fn(() => void client.workspace.syncFiles()),
    cancelRequest: vi.fn(),
    request: vi.fn(
      (method: string, params: Pending['params']) =>
        new Promise((resolve, reject) => {
          pending.push({ method, params, resolve, reject })
        })
    ),
    workspace: null as unknown as OmniWorkspace
  }
  client.workspace = new OmniWorkspace(client as unknown as LSPClient, 'w1')
  return { client, ws: client.workspace, pending }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await tick()
}
const diag = (message: string) => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message })

const painted: Array<[EditorView, CodeDiagnostic[]]> = []
beforeEach(() => {
  painted.length = 0
  setLspHost({ diagnostics: (view, d) => void painted.push([view, d]), display: async () => null })
})

describe('OmniWorkspace: varios editores del mismo archivo', () => {
  it('un didOpen por archivo; cerrar uno de dos no manda didClose y el que queda se sincroniza', () => {
    const { client, ws } = fakeClient()
    const a = fakeView('hola')
    const b = fakeView('hola')
    ws.openFile('file:///w/a.ts', 'typescript', a)
    ws.openFile('file:///w/a.ts', 'typescript', b)
    expect(client.didOpen).toHaveBeenCalledTimes(1)
    expect(ws.getFile('file:///w/a.ts')?.getView()).toBe(a)

    ws.closeFile('file:///w/a.ts', a)
    expect(client.didClose).not.toHaveBeenCalled()
    const file = ws.getFile('file:///w/a.ts')
    expect(file?.getView()).toBe(b)

    // Lo que se teclea en el que queda llega al servidor.
    typeIn(b, ' mundo')
    const updates = ws.syncFiles()
    expect(updates).toHaveLength(1)
    expect(updates[0].prevDoc.toString()).toBe('hola')
    expect(file?.doc.toString()).toBe('hola mundo')

    ws.closeFile('file:///w/a.ts', b)
    expect(client.didClose).toHaveBeenCalledTimes(1)
    expect(client.didClose).toHaveBeenCalledWith('file:///w/a.ts')
    expect(ws.getFile('file:///w/a.ts')).toBeNull()
  })

  it('al heredar el archivo, un texto distinto se manda entero aunque el que queda no haya tecleado', () => {
    const { ws } = fakeClient()
    const a = fakeView('uno')
    const b = fakeView('uno')
    ws.openFile('file:///w/a.ts', 'typescript', a)
    ws.openFile('file:///w/a.ts', 'typescript', b)
    typeIn(a, ' dos')
    ws.syncFiles()
    typeIn(a, ' tres') // sin sincronizar: se pierde con el editor
    ws.closeFile('file:///w/a.ts', a)
    const [u] = ws.syncFiles()
    expect(u.prevDoc.toString()).toBe('uno dos')
    expect(u.changes.apply(u.prevDoc).toString()).toBe('uno')
    expect(ws.syncFiles()).toHaveLength(0)
  })

  it('cerrar el segundo editor deja al primero intacto', () => {
    const { client, ws } = fakeClient()
    const a = fakeView('x')
    const b = fakeView('x')
    ws.openFile('file:///w/a.ts', 'typescript', a)
    ws.openFile('file:///w/a.ts', 'typescript', b)
    ws.closeFile('file:///w/a.ts', b)
    expect(ws.getFile('file:///w/a.ts')?.getView()).toBe(a)
    expect(ws.syncFiles()).toHaveLength(0)
    expect(client.didClose).not.toHaveBeenCalled()
  })
})

describe('DiagnosticPuller', () => {
  const open = (ws: OmniWorkspace, names: string[]): EditorView[] =>
    names.map((n) => {
      const v = fakeView('abc')
      ws.openFile(`file:///w/${n}`, 'typescript', v)
      return v
    })

  it('N editores que conectan a la vez piden una sola vez cada archivo; repetir no vuelve a pedir', async () => {
    const { client, ws, pending } = fakeClient()
    open(ws, ['a.ts', 'b.ts', 'c.ts'])
    for (let i = 0; i < 3; i++) ws.puller.schedule('new')
    await flush()
    expect(pending.map((p) => p.params.textDocument.uri)).toEqual(['file:///w/a.ts', 'file:///w/b.ts', 'file:///w/c.ts'])
    pending.forEach((p) => p.resolve({ kind: 'full', items: [] }))
    await flush()
    // Reconfigurar el compartimento: otro `'new'` no repite el barrido.
    for (let i = 0; i < 3; i++) ws.puller.schedule('new')
    await flush()
    expect(client.request).toHaveBeenCalledTimes(3)
  })

  it("'all' tras teclear pide todos, juntado con los 'new' del mismo turno", async () => {
    const { client, ws, pending } = fakeClient()
    open(ws, ['a.ts', 'b.ts'])
    ws.puller.schedule('new')
    await flush()
    pending.splice(0).forEach((p) => p.resolve({ kind: 'full', items: [] }))
    await flush()
    ws.puller.schedule('all')
    ws.puller.schedule('new')
    ws.puller.schedule('all')
    await flush()
    expect(client.request).toHaveBeenCalledTimes(4)
    expect(client.sync).toHaveBeenCalledTimes(2)
  })

  it('un pedido nuevo cancela el que vuela, espera a que termine y solo aplica la respuesta del último', async () => {
    const { client, ws, pending } = fakeClient()
    const [a] = open(ws, ['a.ts'])
    ws.puller.schedule('all')
    await flush()
    expect(pending).toHaveLength(1)
    const first = pending[0]
    ws.puller.schedule('all')
    await flush()
    expect(client.cancelRequest).toHaveBeenCalledWith(first.params)
    expect(pending).toHaveLength(1) // a lo sumo uno en vuelo por archivo
    first.resolve({ kind: 'full', items: [diag('viejo')] })
    await flush()
    expect(painted).toHaveLength(0)
    expect(pending).toHaveLength(2)
    pending[1].resolve({ kind: 'full', items: [diag('nuevo')] })
    await flush()
    expect(painted).toHaveLength(1)
    expect(painted[0][0]).toBe(a)
    expect(painted[0][1].map((d) => d.message)).toEqual(['nuevo'])
  })

  it('una respuesta de una versión vieja del archivo se descarta', async () => {
    const { ws, pending } = fakeClient()
    const [a] = open(ws, ['a.ts'])
    ws.puller.schedule('all')
    await flush()
    typeIn(a, 'd')
    ws.syncFiles()
    pending[0].resolve({ kind: 'full', items: [diag('viejo')] })
    await flush()
    expect(painted).toHaveLength(0)
  })

  it('el editor que hereda el archivo recibe sus errores', async () => {
    const { ws, pending } = fakeClient()
    const a = fakeView('abc')
    const b = fakeView('abc')
    ws.openFile('file:///w/a.ts', 'typescript', a)
    ws.puller.schedule('new')
    await flush()
    pending.splice(0).forEach((p) => p.resolve({ kind: 'full', items: [] }))
    await flush()
    ws.openFile('file:///w/a.ts', 'typescript', b)
    ws.closeFile('file:///w/a.ts', a)
    await flush()
    expect(pending).toHaveLength(1)
    painted.length = 0
    pending[0].resolve({ kind: 'full', items: [diag('e')] })
    await flush()
    expect(painted.map(([v]) => v)).toEqual([b])
  })
})
