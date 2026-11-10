import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffFile, SessionInfo, WorkspaceDiff, Workspace, WorktreeStatus } from '@shared/types'
import { cursorAnchor, cursorFilePath, reviewTargetId, useReview, worktreeAgent } from './review'
import { addReviewTarget } from './review-target'
import { useSessions } from './sessions'
import { useUi } from './ui'

const invoke = vi.fn()
const send = vi.fn()
const blurTerminals = vi.fn(() => useUi.getState().setFocus('list'))
const writeText = vi.fn(async () => undefined)
const discard = vi.fn()
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
  screenLines: () => null,
  disposeTerminal: vi.fn(),
  getTerminal: () => undefined,
  blurTerminals: () => blurTerminals()
}))
vi.mock('./browser', () => ({ liveBrowserId: () => null, useBrowser: { getState: () => ({ blur: vi.fn() }) } }))
vi.mock('./worktrees', () => ({ useWorktrees: { getState: () => ({ discard }) } }))

const NOW = 1_700_000_000_000
const LOCAL: Workspace = { id: 'w1', projectId: 'p1', name: 'omni', path: '/repo', kind: 'local' }
const WT: Workspace = { id: 'wt1', projectId: 'p1', name: 'cc-51', path: '/wt/cc-51', kind: 'worktree' }
const session = (id: string, agent: SessionInfo['agent'], workspaceId = WT.id): SessionInfo => ({ id, agent, workspaceId, cwd: '/x', createdAt: NOW })

const file = (path: string, lines: DiffFile['hunks'][number]['lines'], extra: Partial<DiffFile> = {}): DiffFile => ({ path, status: 'M', additions: 1, deletions: 1, binary: false, hunks: [{ header: '@@ -1 +1 @@', lines }], ...extra })
const DIFF: WorkspaceDiff = {
  base: 'main',
  branch: 'omni/cc-51',
  truncated: false,
  files: [
    file('src/client.ts', [
      { kind: 'ctx', old: 47, new: 47, text: 'a' },
      { kind: 'add', old: null, new: 48, text: 'b' },
      { kind: 'del', old: 48, new: null, text: 'c' }
    ]),
    file('old.ts', [{ kind: 'del', old: 1, new: null, text: 'x' }], { status: 'D' })
  ]
}
const STATUS: WorktreeStatus = { branch: 'omni/cc-51', base: 'main', dirty: true, stat: { files: 2, additions: 2, deletions: 2 }, tests: { status: 'pass', summary: 'ok', at: NOW } }

let stop: () => void = () => {}

beforeEach(() => {
  invoke.mockReset()
  send.mockReset()
  writeText.mockClear()
  discard.mockClear()
  listeners = {}
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'git:diff') return DIFF
    if (channel === 'worktree:status') return STATUS
    if (channel === 'git:merge') return { commit: 'abc1234567' }
    return undefined
  })
  useReview.setState({ workspaceId: null, diff: null, status: null, loading: false, error: null, notice: null, cursor: null, comments: [], composer: null })
  useSessions.setState({ agents: [], projects: [], workspaces: [LOCAL, WT], sessions: [], attention: {}, unread: {}, activity: {}, currentWorkspaceId: 'w1', cursor: null, ready: true })
  useUi.setState({ overlay: null, view: 'fleet', focus: 'list' })
})

afterEach(() => {
  stop()
  vi.unstubAllGlobals()
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function open(): Promise<void> {
  await useReview.getState().open(WT.id)
}

describe('useReview · abrir y navegar', () => {
  it('open pone la vista, saca el teclado de la terminal y pide diff y estado; el cursor cae en la primera línea', async () => {
    await open()
    const s = useReview.getState()
    expect(useUi.getState().view).toBe('review')
    expect(blurTerminals).toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('git:diff', WT.id)
    expect(invoke).toHaveBeenCalledWith('worktree:status', WT.id)
    expect(s.diff).toEqual(DIFF)
    expect(s.status).toEqual(STATUS)
    expect(s.cursor).toEqual({ file: 0, hunk: 0, line: 0 })
  })

  it('J K ] [ } { mueven el cursor y el ancla sigue a la línea (nueva para add/ctx, vieja para del)', async () => {
    await open()
    const r = useReview.getState
    r().nextLine()
    expect(r().cursor).toEqual({ file: 0, hunk: 0, line: 1 })
    expect(cursorAnchor(r())).toEqual({ path: 'src/client.ts', line: 48, side: 'new', lineText: 'b' })
    r().nextLine()
    expect(cursorAnchor(r())).toEqual({ path: 'src/client.ts', line: 48, side: 'old', lineText: 'c' })
    r().nextHunk()
    expect(r().cursor).toEqual({ file: 1, hunk: 0, line: 0 })
    r().prevHunk()
    expect(r().cursor).toEqual({ file: 0, hunk: 0, line: 0 })
    r().nextFile()
    expect(r().cursor).toEqual({ file: 1, hunk: 0, line: 0 })
    r().prevFile()
    r().prevLine()
    expect(r().cursor).toEqual({ file: 0, hunk: 0, line: 0 })
  })

  it('reload re-ancla los comentarios por texto cuando el agente renumera, y marca desfasado el que perdió su línea', async () => {
    await open()
    const r = useReview.getState
    r().nextLine()
    r().startComment()
    r().setComposerText('ojo con b')
    r().saveComment()
    r().nextLine()
    r().startComment()
    r().setComposerText('c se va')
    r().saveComment()
    expect(r().comments.map((c) => [c.line, c.side, c.lineText])).toEqual([[48, 'new', 'b'], [48, 'old', 'c']])
    // Tres líneas nuevas arriba: `b` pasa a la 51; la borrada `c` ya no está en el diff.
    const renumbered = file('src/client.ts', [
      { kind: 'add', old: null, new: 1, text: 'import x' },
      { kind: 'add', old: null, new: 2, text: 'import y' },
      { kind: 'add', old: null, new: 3, text: 'import z' },
      { kind: 'ctx', old: 47, new: 50, text: 'a' },
      { kind: 'add', old: null, new: 51, text: 'b' }
    ])
    invoke.mockImplementation(async (channel: string) => (channel === 'git:diff' ? { ...DIFF, files: [renumbered] } : STATUS))
    await r().reload()
    expect(r().comments.map((c) => [c.line, c.stale])).toEqual([[51, false], [48, true]])
    expect(r().cursor).toEqual({ file: 0, hunk: 0, line: 2 })
    // El desfasado se envía con su línea vieja y la marca.
    useSessions.setState({ sessions: [session('cc', 'claude')] })
    await r().send()
    const [, , text] = send.mock.calls[0] as [string, string, string]
    expect(text).toContain('- src/client.ts:51: ojo con b\n- src/client.ts:48 (desfasado): c se va')
  })

  it('reload: si el diff perdió la línea del cursor, baja a la más cercana', async () => {
    await open()
    const r = useReview.getState
    r().nextLine()
    r().nextLine()
    invoke.mockImplementation(async (channel: string) => (channel === 'git:diff' ? { ...DIFF, files: [file('src/client.ts', [{ kind: 'add', old: null, new: 1, text: 'z' }])] } : STATUS))
    await r().reload()
    expect(r().cursor).toEqual({ file: 0, hunk: 0, line: 0 })
  })

  it('un error de git:diff queda en `error` y la vista sigue en pantalla', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'git:diff') throw new Error('no es un worktree')
      return STATUS
    })
    await open()
    expect(useReview.getState().error).toBe('no es un worktree')
    expect(useReview.getState().diff).toBeNull()
    expect(useUi.getState().view).toBe('review')
  })

  it('back vuelve a Worktrees y cierra el compositor', async () => {
    await open()
    useReview.getState().startComment()
    useReview.getState().back()
    expect(useUi.getState().view).toBe('worktrees')
    expect(useReview.getState().composer).toBeNull()
  })

  it('openInEditor abre el archivo bajo el cursor con su ruta absoluta; un borrado no se abre', async () => {
    await open()
    expect(cursorFilePath(useReview.getState(), useSessions.getState())).toBe('/wt/cc-51/src/client.ts')
    useReview.getState().openInEditor()
    expect(invoke).toHaveBeenCalledWith('file:open', '/wt/cc-51/src/client.ts')
    useReview.getState().nextFile()
    expect(cursorFilePath(useReview.getState(), useSessions.getState())).toBeNull()
  })
})

describe('useReview · comentarios', () => {
  it('C abre el compositor en la línea del cursor, ⌘⏎ guarda y Esc cancela; vacío no crea nada', async () => {
    await open()
    const r = useReview.getState
    r().nextLine()
    r().startComment()
    expect(r().composer).toEqual({ path: 'src/client.ts', line: 48, side: 'new', lineText: 'b', text: '' })
    r().setComposerText('  falta el await  ')
    r().saveComment()
    expect(r().composer).toBeNull()
    expect(r().comments).toMatchObject([{ path: 'src/client.ts', line: 48, side: 'new', lineText: 'b', text: 'falta el await', sent: false, stale: false }])
    r().startComment()
    r().setComposerText('x')
    r().cancelComment()
    expect(r().comments).toHaveLength(1)
    r().startComment()
    r().saveComment()
    expect(r().comments).toHaveLength(1)
    r().removeComment(r().comments[0].id)
    expect(r().comments).toHaveLength(0)
  })

  it('send escribe los pendientes al agente del worktree (no al shell) con ⏎ y los marca enviados', async () => {
    useSessions.setState({ sessions: [session('sh', 'shell'), session('cc', 'claude'), session('other', 'claude', 'w1')] })
    await open()
    const r = useReview.getState
    r().nextLine()
    r().startComment()
    r().setComposerText('falta el await')
    r().saveComment()
    expect(worktreeAgent(useSessions.getState(), WT.id)?.id).toBe('cc')
    await r().send()
    expect(send).toHaveBeenCalledTimes(1)
    const [channel, id, text] = send.mock.calls[0] as [string, string, string]
    expect(channel).toBe('session:write')
    expect(id).toBe('cc')
    expect(text).toBe('\x1b[200~Revisión de omni/cc-51:\n- src/client.ts:48: falta el await\x1b[201~')
    await new Promise((res) => setTimeout(res, 200))
    expect(send).toHaveBeenLastCalledWith('session:write', 'cc', '\r')
    expect(r().comments[0].sent).toBe(true)
    expect(r().notice).toBe('Comentario enviado al agente')
    // Ya no hay pendientes: un segundo envío no escribe nada (los dos writes son texto + ⏎ del primero).
    await r().send()
    // (el ⏎ diferido de un test anterior puede caer aquí: se cuentan solo los writes con texto)
    expect(send.mock.calls.filter((c) => c[2] !== '\r')).toHaveLength(1)
  })

  it('sin agente en el worktree, send copia al portapapeles y lo avisa', async () => {
    useSessions.setState({ sessions: [session('sh', 'shell')] })
    await open()
    const r = useReview.getState
    r().startComment()
    r().setComposerText('revisar')
    r().saveComment()
    await r().send()
    expect(send).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('Revisión de omni/cc-51:\n- src/client.ts:47: revisar')
    expect(r().notice).toMatch(/portapapeles/)
    expect(r().comments[0].sent).toBe(true)
  })
})

describe('useReview · merge y descarte', () => {
  it('merge sin sesiones vivas va al toque: git:merge, vuelve a Worktrees y avisa con el commit corto', async () => {
    await open()
    useReview.getState().merge()
    await flush()
    expect(useUi.getState().overlay).toBeNull()
    expect(invoke).toHaveBeenCalledWith('git:merge', WT.id)
    expect(useUi.getState().view).toBe('worktrees')
    expect(useReview.getState().notice).toBe('Merge hecho: abc1234')
  })

  it('merge con sesiones vivas pide confirmación; confirmar mata las sesiones del worktree y mergea', async () => {
    useSessions.setState({ sessions: [session('cc', 'claude'), session('other', 'claude', 'w1')] })
    await open()
    useReview.getState().merge()
    expect(useUi.getState().overlay).toBe('confirmMerge')
    expect(invoke).not.toHaveBeenCalledWith('git:merge', WT.id)
    useUi.getState().closeOverlay()
    await useReview.getState().confirmMerge()
    expect(invoke).toHaveBeenCalledWith('git:merge', WT.id)
    expect(send).toHaveBeenCalledWith('session:kill', 'cc')
    expect(send).not.toHaveBeenCalledWith('session:kill', 'other')
    expect(useUi.getState().view).toBe('worktrees')
  })

  it('un merge con conflicto deja el error en pantalla y no sale de la revisión', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'git:diff') return DIFF
      if (channel === 'worktree:status') return STATUS
      throw new Error('conflicto en src/client.ts')
    })
    await open()
    await useReview.getState().confirmMerge()
    expect(useReview.getState().error).toBe('conflicto en src/client.ts')
    expect(useUi.getState().view).toBe('review')
  })

  it('discard delega en el overlay confirmDiscard de Worktrees; cuando el worktree desaparece, init vuelve a Worktrees', async () => {
    stop = useReview.getState().init()
    await open()
    useReview.getState().discard()
    expect(discard).toHaveBeenCalledWith(WT.id)
    useSessions.setState({ workspaces: [LOCAL] })
    expect(useUi.getState().view).toBe('worktrees')
    expect(useReview.getState().notice).toBe('Worktree descartado')
  })

  it('init recarga con worktree:changed del mismo worktree (o global) solo con la revisión en pantalla', async () => {
    stop = useReview.getState().init()
    await open()
    invoke.mockClear()
    listeners['worktree:changed']?.('otro')
    await flush()
    expect(invoke).not.toHaveBeenCalledWith('git:diff', WT.id)
    listeners['worktree:changed']?.(WT.id)
    await flush()
    expect(invoke).toHaveBeenCalledWith('git:diff', WT.id)
    invoke.mockClear()
    listeners['worktree:changed']?.(null)
    await flush()
    expect(invoke).toHaveBeenCalledWith('git:diff', WT.id)
    useUi.getState().setView('fleet')
    invoke.mockClear()
    listeners['worktree:changed']?.(WT.id)
    await flush()
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('reviewTargetId', () => {
  it('prefiere el proveedor (vista Worktrees), luego el cursor del sidebar sobre un worktree, luego el workspace actual', () => {
    expect(reviewTargetId()).toBeNull()
    useSessions.setState({ currentWorkspaceId: WT.id })
    expect(reviewTargetId()).toBe(WT.id)
    useSessions.setState({ currentWorkspaceId: 'w1', cursor: 'ws:wt1' })
    expect(reviewTargetId()).toBe(WT.id)
    useSessions.setState({ cursor: 'p:p1' })
    expect(reviewTargetId()).toBeNull()
    const off = addReviewTarget(() => 'wt-from-view')
    expect(reviewTargetId()).toBe('wt-from-view')
    off()
    expect(reviewTargetId()).toBeNull()
  })
})
