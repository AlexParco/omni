import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileHit } from '@shared/types'

const invoke = vi.fn()
vi.mock('@/lib/omni', () => ({ omni: { invoke: (...args: unknown[]) => invoke(...args), send: vi.fn(), on: vi.fn(() => () => {}) } }))

const { FILES_DEBOUNCE_MS, useQuickOpen } = await import('./quickopen')

/** Promesa controlada: así una respuesta "vieja" puede llegar después que la nueva. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const hit = (rel: string): FileHit => ({ workspaceId: 'ws', path: `/p/${rel}`, rel })
/** Deja que las promesas encadenadas (`then`) corran. */
const flush = (): Promise<void> => Promise.resolve().then(() => Promise.resolve())

describe('store/quickopen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    invoke.mockReset()
    useQuickOpen.getState().reset()
    useQuickOpen.setState({ branches: {} })
  })
  afterEach(() => vi.useRealTimers())

  it('searchFiles espera el debounce antes de pedir a main', () => {
    invoke.mockResolvedValue([])
    useQuickOpen.getState().searchFiles('app', 8)
    expect(invoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(FILES_DEBOUNCE_MS - 1)
    expect(invoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(invoke).toHaveBeenCalledWith('files:search', 'app', 8)
  })

  it('teclear seguido solo manda la última consulta', () => {
    invoke.mockResolvedValue([])
    const s = useQuickOpen.getState()
    s.searchFiles('a', 8)
    vi.advanceTimersByTime(30)
    s.searchFiles('ap', 8)
    vi.advanceTimersByTime(30)
    s.searchFiles('app', 8)
    vi.advanceTimersByTime(FILES_DEBOUNCE_MS)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('files:search', 'app', 8)
  })

  it('una respuesta vieja que llega tarde no pisa a la nueva', async () => {
    const first = deferred<FileHit[]>()
    const second = deferred<FileHit[]>()
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const s = useQuickOpen.getState()
    s.searchFiles('a', 8)
    vi.advanceTimersByTime(FILES_DEBOUNCE_MS)
    s.searchFiles('ab', 8)
    vi.advanceTimersByTime(FILES_DEBOUNCE_MS)
    expect(invoke).toHaveBeenCalledTimes(2)
    // La nueva contesta primero; la vieja, después: debe descartarse.
    second.resolve([hit('ab.ts')])
    await flush()
    expect(useQuickOpen.getState().files.map((f) => f.rel)).toEqual(['ab.ts'])
    first.resolve([hit('a.ts')])
    await flush()
    expect(useQuickOpen.getState().files.map((f) => f.rel)).toEqual(['ab.ts'])
  })

  it('sin consulta vacía la lista y no pide nada; setQuery y reset también la vacían', () => {
    useQuickOpen.setState({ files: [hit('x.ts')] })
    useQuickOpen.getState().searchFiles(null, 8)
    expect(useQuickOpen.getState().files).toEqual([])
    expect(invoke).not.toHaveBeenCalled()

    useQuickOpen.setState({ files: [hit('x.ts')], index: 3 })
    useQuickOpen.getState().setQuery('y')
    expect(useQuickOpen.getState()).toMatchObject({ query: 'y', index: 0, files: [] })

    useQuickOpen.setState({ files: [hit('x.ts')] })
    useQuickOpen.getState().reset()
    expect(useQuickOpen.getState()).toMatchObject({ query: '', index: 0, files: [] })
  })

  it('reset descarta una búsqueda pendiente y su respuesta', async () => {
    const pending = deferred<FileHit[]>()
    invoke.mockReturnValueOnce(pending.promise)
    useQuickOpen.getState().searchFiles('a', 8)
    vi.advanceTimersByTime(FILES_DEBOUNCE_MS)
    useQuickOpen.getState().reset()
    pending.resolve([hit('a.ts')])
    await flush()
    expect(useQuickOpen.getState().files).toEqual([])
  })

  it('loadBranch cachea por workspace y vuelve a pedir pasados 30 s', async () => {
    invoke.mockResolvedValue('main')
    const s = useQuickOpen.getState()
    s.loadBranch('ws')
    s.loadBranch('ws')
    await flush()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('workspace:branch', 'ws')
    expect(useQuickOpen.getState().branches.ws.name).toBe('main')
    s.loadBranch('ws')
    expect(invoke).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_001)
    s.loadBranch('ws')
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('loadBranch guarda null si main falla, sin romper', async () => {
    invoke.mockRejectedValue(new Error('sin git'))
    useQuickOpen.getState().loadBranch('ws2')
    await flush()
    await flush()
    expect(useQuickOpen.getState().branches.ws2.name).toBeNull()
  })
})
