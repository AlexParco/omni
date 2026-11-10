import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, Workspace } from '@shared/types'
import { useLayout } from './layout'
import { usePreview } from './preview'
import { useSessions } from './sessions'
import { useUi } from './ui'

const invoke = vi.fn()
const send = vi.fn()
const writeText = vi.fn(async (_text: string) => undefined)
const openDoc = vi.fn(async (..._args: unknown[]) => null)
let listeners: Record<string, (...args: unknown[]) => void> = {}

vi.mock('@/lib/omni', () => ({
  omni: {
    invoke: (...args: unknown[]) => invoke(...args),
    send: (...args: unknown[]) => send(...args),
    on: (channel: string, cb: (...args: unknown[]) => void) => {
      listeners[channel] = cb
      return () => delete listeners[channel]
    }
  }
}))
vi.mock('@/panes/terminal/terminal-host', () => ({
  screenLines: () => null, disposeTerminal: vi.fn(), getTerminal: () => undefined, blurTerminals: vi.fn() }))
vi.mock('./docs', () => ({ useDocs: { getState: () => ({ open: (...args: unknown[]) => openDoc(...args) }) } }))

const WS: Workspace = { id: 'w1', projectId: 'p1', name: 'omni', path: '/repo', kind: 'local' }
const session = (id: string, agent: SessionInfo['agent'], args?: string[]): SessionInfo => ({ id, agent, workspaceId: WS.id, cwd: '/repo', createdAt: 1, args })

/** Respuestas de main por canal; `file:read` devuelve el texto registrado por ruta. */
const files: Record<string, string> = { '/repo/docs/guide.md': '# Guía', '/repo/README.md': '# Readme' }

beforeEach(() => {
  invoke.mockReset()
  send.mockReset()
  writeText.mockClear()
  openDoc.mockClear()
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'file:read') {
      const text = files[args[1] as string]
      if (text === undefined) throw new Error("Error invoking remote method 'file:read': Error: Fuera del workspace")
      return { text, mtime: 1 }
    }
    return undefined
  })
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText } }, configurable: true })
  useSessions.setState({ workspaces: [WS], sessions: [session('pv1', 'preview', ['docs/guide.md'])], titles: {}, currentWorkspaceId: WS.id })
  useLayout.setState({ tabs: [], activeTab: {} })
  useLayout.getState().openTab(WS.id, 'pv1')
  // `listeners` no se resetea: la suscripción a `file:changed` es única por módulo y vive mientras haya docs.
  usePreview.setState({ docs: {} })
  useUi.setState({ focus: 'list', overlay: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('open / reload / close', () => {
  it('resuelve la ruta relativa al workspace, lee el Markdown, vigila el archivo y titula la sesión', async () => {
    await usePreview.getState().open('pv1')
    const doc = usePreview.getState().docs['pv1']
    expect(doc.path).toBe('/repo/docs/guide.md')
    expect(doc.kind).toBe('md')
    expect(doc.text).toBe('# Guía')
    expect(doc.error).toBeNull()
    expect(invoke).toHaveBeenCalledWith('file:watch', WS.id, '/repo/docs/guide.md')
    expect(useSessions.getState().titles['pv1']).toBe('guide.md')
  })

  it('una imagen no se lee por IPC: la sirve el protocolo', async () => {
    useSessions.setState({ sessions: [session('pv1', 'preview', ['/repo/shot.png'])] })
    await usePreview.getState().open('pv1')
    expect(usePreview.getState().docs['pv1'].kind).toBe('image')
    expect(invoke).not.toHaveBeenCalledWith('file:read', expect.anything())
  })

  it('el error de lectura llega limpio a la franja', async () => {
    useSessions.setState({ sessions: [session('pv1', 'preview', ['/etc/passwd.md'])] })
    await usePreview.getState().open('pv1')
    expect(usePreview.getState().docs['pv1'].error).toBe('Fuera del workspace')
  })

  it('file:changed (suscripción única del store) recarga solo los panes con esa ruta y sube la versión', async () => {
    await usePreview.getState().open('pv1')
    expect(listeners['file:changed']).toBeDefined()
    files['/repo/docs/guide.md'] = '# Guía v2'
    listeners['file:changed'](WS.id, '/repo/docs/other.md', 2)
    await Promise.resolve()
    expect(usePreview.getState().docs['pv1'].text).toBe('# Guía')
    listeners['file:changed'](WS.id, '/repo/docs/guide.md', 3)
    await vi.waitFor(() => expect(usePreview.getState().docs['pv1'].text).toBe('# Guía v2'))
    expect(usePreview.getState().docs['pv1'].version).toBe(1)
    files['/repo/docs/guide.md'] = '# Guía'
  })

  it('close deja de vigilar; olvida el doc solo si la sesión murió', async () => {
    await usePreview.getState().open('pv1')
    usePreview.getState().close('pv1')
    expect(invoke).toHaveBeenCalledWith('file:unwatch', WS.id, '/repo/docs/guide.md')
    expect(usePreview.getState().docs['pv1']).toBeDefined()
    useSessions.setState({ sessions: [] })
    usePreview.getState().close('pv1')
    expect(usePreview.getState().docs['pv1']).toBeUndefined()
    // Sin docs, la suscripción a `file:changed` se suelta.
    expect(listeners['file:changed']).toBeUndefined()
  })
})

describe('navegación', () => {
  it('navigate apila el historial, cambia la vigilancia y lee el nuevo archivo; back deshace', async () => {
    await usePreview.getState().open('pv1')
    await usePreview.getState().navigate('pv1', '/repo/README.md')
    let doc = usePreview.getState().docs['pv1']
    expect(doc.path).toBe('/repo/README.md')
    expect(doc.history).toEqual(['/repo/docs/guide.md'])
    expect(doc.text).toBe('# Readme')
    expect(invoke).toHaveBeenCalledWith('file:unwatch', WS.id, '/repo/docs/guide.md')
    expect(invoke).toHaveBeenCalledWith('file:watch', WS.id, '/repo/README.md')
    expect(useSessions.getState().titles['pv1']).toBe('README.md')
    await usePreview.getState().back('pv1')
    doc = usePreview.getState().docs['pv1']
    expect(doc.path).toBe('/repo/docs/guide.md')
    expect(doc.history).toEqual([])
    expect(doc.text).toBe('# Guía')
  })

  it('fuera del workspace no navega: avisa en la franja', async () => {
    await usePreview.getState().open('pv1')
    await usePreview.getState().navigate('pv1', '/repo/../etc/x.md')
    const doc = usePreview.getState().docs['pv1']
    expect(doc.path).toBe('/repo/docs/guide.md')
    expect(doc.notice).toBe('Fuera del workspace')
  })

  it('un archivo que no se sabe pintar se abre con la app del sistema', async () => {
    await usePreview.getState().open('pv1')
    await usePreview.getState().navigate('pv1', '/repo/src/main.ts')
    expect(invoke).toHaveBeenCalledWith('file:open', '/repo/src/main.ts')
    expect(usePreview.getState().docs['pv1'].path).toBe('/repo/docs/guide.md')
  })

  it('followLink: relativo al documento, con / a la raíz del workspace, #ancla en el mismo doc', async () => {
    await usePreview.getState().open('pv1')
    await usePreview.getState().followLink('pv1', '../README.md#intro')
    let doc = usePreview.getState().docs['pv1']
    expect(doc.path).toBe('/repo/README.md')
    expect(doc.pendingHash).toBe('intro')
    usePreview.getState().clearHash('pv1')
    await usePreview.getState().followLink('pv1', '/docs/guide.md')
    expect(usePreview.getState().docs['pv1'].path).toBe('/repo/docs/guide.md')
    await usePreview.getState().followLink('pv1', '#top')
    doc = usePreview.getState().docs['pv1']
    expect(doc.pendingHash).toBe('top')
    expect(doc.history).toEqual(['/repo/docs/guide.md', '/repo/README.md'])
  })

  it('un enlace externo lo abre main con el navegador del sistema y la franja lo dice', async () => {
    vi.useFakeTimers()
    await usePreview.getState().open('pv1')
    await usePreview.getState().followLink('pv1', 'https://github.com/x/y')
    expect(invoke).toHaveBeenCalledWith('shell:openExternal', 'https://github.com/x/y')
    expect(writeText).not.toHaveBeenCalled()
    expect(usePreview.getState().docs['pv1'].notice).toBe('Abierto en el navegador · github.com')
    vi.advanceTimersByTime(3000)
    expect(usePreview.getState().docs['pv1'].notice).toBeNull()
  })

  it('un esquema que no es http(s) no viaja por IPC: cae al portapapeles', async () => {
    await usePreview.getState().open('pv1')
    await usePreview.getState().followLink('pv1', 'mailto:a@b.c')
    expect(invoke).not.toHaveBeenCalledWith('shell:openExternal', expect.anything())
    expect(writeText).toHaveBeenCalledWith('mailto:a@b.c')
    expect(usePreview.getState().docs['pv1'].notice).toBe('Enlace copiado · mailto:a@b.c')
  })

  it('si main rechaza el enlace, también cae al portapapeles', async () => {
    await usePreview.getState().open('pv1')
    invoke.mockImplementationOnce(async () => {
      throw new Error('No se pudo abrir')
    })
    await usePreview.getState().followLink('pv1', 'https://x.y/z')
    expect(invoke).toHaveBeenCalledWith('shell:openExternal', 'https://x.y/z')
    expect(writeText).toHaveBeenCalledWith('https://x.y/z')
    expect(usePreview.getState().docs['pv1'].notice).toBe('Enlace copiado · x.y')
  })

})

describe('zoom', () => {
  it('parte del zoom efectivo ajustado, escala por 1.25 y 0 vuelve a ajustar', async () => {
    useSessions.setState({ sessions: [session('pv1', 'preview', ['/repo/shot.png'])] })
    await usePreview.getState().open('pv1')
    usePreview.getState().setFitScale('pv1', 0.5)
    usePreview.getState().zoomIn('pv1')
    expect(usePreview.getState().docs['pv1'].zoom).toBe(0.625)
    usePreview.getState().zoomOut('pv1')
    expect(usePreview.getState().docs['pv1'].zoom).toBe(0.5)
    usePreview.getState().zoomReset('pv1')
    expect(usePreview.getState().docs['pv1'].zoom).toBeNull()
  })
})

describe('toggle (⌘⇧V)', () => {
  it('desde un preview abre con docs.open el editor del archivo que se muestra ahora, en split a la derecha', async () => {
    await usePreview.getState().open('pv1')
    await usePreview.getState().navigate('pv1', '/repo/README.md')
    await usePreview.getState().toggle('pv1')
    expect(openDoc).toHaveBeenCalledWith(WS.id, '/repo/README.md', 'editor', 'split-right')
  })

  it('desde un editor abre la vista previa de su archivo', async () => {
    useSessions.setState({ sessions: [session('ed1', 'editor', ['/repo/a.md'])] })
    await usePreview.getState().toggle('ed1')
    expect(openDoc).toHaveBeenCalledWith(WS.id, '/repo/a.md', 'preview', 'split-right')
  })

  it('si docs.open falla, la franja del preview lo dice', async () => {
    openDoc.mockRejectedValueOnce(new Error("Error invoking remote method 'doc:open': Error: No existe"))
    await usePreview.getState().open('pv1')
    await usePreview.getState().toggle('pv1')
    expect(usePreview.getState().docs['pv1'].notice).toBe('No existe')
  })
})
