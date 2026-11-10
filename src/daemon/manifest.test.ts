import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedSession } from '@shared/daemon'
import type { SessionInfo } from '@shared/types'
import { SessionManifest, restorePreamble, sanitizeSessions } from './manifest'
import { ScreenMirror } from './screen'

const info = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, agent: 'shell', workspaceId: 'w1', cwd: '/tmp', createdAt: 100, ...extra })

const saved = (id: string, createdAt: number, extra: Partial<SavedSession> = {}): SavedSession => ({ id, agent: 'shell', workspaceId: 'w1', cwd: '/tmp', createdAt, ...extra })

describe('SessionManifest', () => {
  let dir: string
  const file = (): string => join(dir, 'sessions.json')
  const onDisk = (): SavedSession[] => JSON.parse(readFileSync(file(), 'utf8')) as SavedSession[]
  const ids = (list: readonly { id: string }[]): string[] => list.map((s) => s.id)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-manifest-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('load: lo del daemon anterior pasa a huérfanas, ordenadas por createdAt', () => {
    writeFileSync(file(), JSON.stringify([saved('b', 300), saved('a', 100), saved('c', 200)]))
    const m = new SessionManifest(dir)
    m.load()
    expect(ids(m.getOrphans())).toEqual(['a', 'c', 'b'])
    expect(m.getOrphan('c')?.createdAt).toBe(200)
  })

  it('load: sin archivo o con JSON roto no hay huérfanas', () => {
    const m = new SessionManifest(dir)
    m.load()
    expect(m.getOrphans()).toEqual([])
    writeFileSync(file(), '{ roto')
    const m2 = new SessionManifest(dir)
    m2.load()
    expect(m2.getOrphans()).toEqual([])
  })

  it('track de un id huérfano lo saca de huérfanas y conserva el createdAt original', () => {
    writeFileSync(file(), JSON.stringify([saved('a', 100), saved('b', 200)]))
    const m = new SessionManifest(dir)
    m.load()
    m.track(info('a', { createdAt: 999, args: ['--x'], resumeId: 'r1' }), 100)
    m.flush()
    expect(ids(m.getOrphans())).toEqual(['b'])
    expect(onDisk()).toEqual([
      { id: 'a', agent: 'shell', workspaceId: 'w1', cwd: '/tmp', createdAt: 100, args: ['--x'], resumeId: 'r1' },
      saved('b', 200)
    ])
  })

  it('setResumeId: la conversación nueva (tras /resume) queda en disco y es la que se revive', () => {
    const m = new SessionManifest(dir)
    m.track(info('c', { agent: 'claude', resumeId: 'vieja' }))
    m.setResumeId('c', 'nueva')
    m.setResumeId('fantasma', 'x')
    m.flush()
    expect(onDisk()).toEqual([{ id: 'c', agent: 'claude', workspaceId: 'w1', cwd: '/tmp', createdAt: 100, resumeId: 'nueva' }])
    const next = new SessionManifest(dir)
    next.load()
    expect(next.getOrphan('c')?.resumeId).toBe('nueva')
  })

  it('lost: una remota que agotó las reconexiones pasa a huérfana (con su createdAt y pantalla) en vez de olvidarse', () => {
    vi.useFakeTimers()
    const m = new SessionManifest(dir, { exitGraceMs: 10 })
    m.track(info('r', { createdAt: 500, resumeId: 'conv' }), 400)
    m.saveScreen('r', 'pantalla')
    m.lost('r')
    vi.advanceTimersByTime(1000)
    m.flush()
    expect(m.getOrphan('r')).toEqual({ id: 'r', agent: 'shell', workspaceId: 'w1', cwd: '/tmp', createdAt: 400, resumeId: 'conv' })
    expect(onDisk().map((x) => x.id)).toEqual(['r'])
    expect(m.readScreen('r')).toBe('pantalla')
    // Una salida normal sí se olvida tras la gracia.
    m.track(info('n'))
    m.exited('n')
    vi.advanceTimersByTime(1000)
    m.flush()
    expect(onDisk().map((x) => x.id)).toEqual(['r'])
  })

  it('agrupa escrituras: varias sesiones seguidas escriben una vez tras la espera', () => {
    vi.useFakeTimers()
    const m = new SessionManifest(dir, { writeDelayMs: 50 })
    m.track(info('a'))
    m.track(info('b'))
    expect(existsSync(file())).toBe(false)
    vi.advanceTimersByTime(50)
    expect(ids(onDisk())).toEqual(['a', 'b'])
  })

  it('exited sin apagado: la sesión se olvida tras la gracia (con su pantalla)', () => {
    vi.useFakeTimers()
    const m = new SessionManifest(dir, { exitGraceMs: 100, writeDelayMs: 10 })
    m.track(info('a'))
    m.saveScreen('a', 'hola')
    m.flush()
    m.exited('a')
    vi.advanceTimersByTime(99)
    m.flush()
    expect(ids(onDisk())).toEqual(['a'])
    vi.advanceTimersByTime(1)
    m.flush()
    expect(onDisk()).toEqual([])
    expect(m.readScreen('a')).toBeNull()
  })

  it('exited y luego freeze antes de la gracia: la entrada queda en disco (apagado del sistema)', () => {
    vi.useFakeTimers()
    const m = new SessionManifest(dir, { exitGraceMs: 100, writeDelayMs: 10 })
    m.track(info('a'))
    m.track(info('b'))
    m.saveScreen('a', 'pantalla')
    // Los shells mueren en cascada antes de que el SIGTERM llegue al daemon.
    m.exited('a')
    m.exited('b')
    m.freeze()
    vi.advanceTimersByTime(1000)
    expect(ids(onDisk())).toEqual(['a', 'b'])
    expect(m.readScreen('a')).toBe('pantalla')
    // Congelado: nada más lo toca.
    m.forget('a')
    m.track(info('c'))
    m.dismiss(['b'])
    m.flush()
    expect(ids(onDisk())).toEqual(['a', 'b'])
    expect(m.readScreen('a')).toBe('pantalla')
  })

  it('forget borra la entrada y su archivo de pantalla', () => {
    const m = new SessionManifest(dir)
    m.track(info('a'))
    m.saveScreen('a', 'algo')
    expect(existsSync(join(dir, 'screens', 'a.ans'))).toBe(true)
    m.forget('a')
    m.flush()
    expect(onDisk()).toEqual([])
    expect(existsSync(join(dir, 'screens', 'a.ans'))).toBe(false)
  })

  it('dismiss descarta huérfanas con su pantalla y deja el resto', () => {
    writeFileSync(file(), JSON.stringify([saved('a', 1), saved('b', 2)]))
    mkdirSync(join(dir, 'screens'))
    writeFileSync(join(dir, 'screens', 'a.ans'), 'vieja')
    const m = new SessionManifest(dir)
    m.load()
    expect(m.readScreen('a')).toBe('vieja')
    m.dismiss(['a', 'desconocida'])
    m.flush()
    expect(ids(m.getOrphans())).toEqual(['b'])
    expect(ids(onDisk())).toEqual(['b'])
    expect(m.readScreen('a')).toBeNull()
  })

  it('clear vacía registro y pantallas; las llamadas posteriores no hacen nada', () => {
    writeFileSync(file(), JSON.stringify([saved('o', 1)]))
    const m = new SessionManifest(dir)
    m.load()
    m.track(info('a'))
    m.saveScreen('a', 'x')
    m.clear()
    expect(onDisk()).toEqual([])
    expect(m.getOrphans()).toEqual([])
    expect(m.readScreen('a')).toBeNull()
    m.track(info('b'))
    m.saveScreen('b', 'y')
    m.flush()
    expect(onDisk()).toEqual([])
    expect(m.readScreen('b')).toBeNull()
  })

  it('saveScreen ignora ids que no están vivos o no son seguros', () => {
    writeFileSync(file(), JSON.stringify([saved('o', 1)]))
    const m = new SessionManifest(dir)
    m.load()
    m.saveScreen('o', 'huérfana')
    m.saveScreen('nadie', 'x')
    m.saveScreen('../x', 'x')
    expect(m.readScreen('o')).toBeNull()
    expect(m.readScreen('nadie')).toBeNull()
    expect(m.readScreen('../x')).toBeNull()
    expect(existsSync(join(dir, 'x.ans'))).toBe(false)
  })
})

describe('sanitizeSessions', () => {
  it('descarta entradas inválidas, agentes sin PTY, ids inseguros y duplicados', () => {
    const raw = [
      { id: 'ok', agent: 'claude', workspaceId: 'w', cwd: '/a', createdAt: 5, args: ['--x', '', 3], resumeId: 'r' },
      { id: 'br', agent: 'browser', workspaceId: 'w', cwd: '/a', createdAt: 1 },
      { id: '../x', agent: 'shell', workspaceId: 'w', cwd: '/a', createdAt: 1 },
      { id: 'sin-cwd', agent: 'shell', workspaceId: 'w', cwd: '', createdAt: 1 },
      { id: 'sin-ws', agent: 'shell', cwd: '/a', createdAt: 1 },
      { id: 'ok', agent: 'shell', workspaceId: 'w', cwd: '/b', createdAt: 1 },
      { id: 'sin-fecha', agent: 'codex', workspaceId: 'w', cwd: '/a', args: [], resumeId: '' },
      'basura',
      null
    ]
    expect(sanitizeSessions(raw)).toEqual([
      { id: 'ok', agent: 'claude', workspaceId: 'w', cwd: '/a', createdAt: 5, args: ['--x'], resumeId: 'r' },
      { id: 'sin-fecha', agent: 'codex', workspaceId: 'w', cwd: '/a', createdAt: 0 }
    ])
  })

  it('lo que no es un arreglo es vacío', () => {
    expect(sanitizeSessions({ id: 'a' })).toEqual([])
    expect(sanitizeSessions(null)).toEqual([])
  })
})

describe('restorePreamble', () => {
  const COLS = 40
  const ROWS = 10

  async function render(data: string): Promise<string[]> {
    const t = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
    await new Promise<void>((r) => t.write(data, r))
    const b = t.buffer.active
    const out: string[] = []
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
    t.dispose()
    return out
  }

  it('pinta la foto, luego el separador y el prompt debajo sin pisar nada', async () => {
    const mirror = new ScreenMirror(COLS, ROWS)
    mirror.write('$ ls\r\nuno dos\r\n$ echo fin\r\nfin\r\n$ ')
    await mirror.flush()
    const screen = mirror.snapshot()
    mirror.dispose()
    const at = new Date(2026, 9, 22, 9, 5)
    const lines = await render(restorePreamble(screen, at) + 'PROMPT$ ')
    const idx = (re: RegExp): number => lines.findIndex((l) => re.test(l))
    const sep = idx(/sesión restaurada 09:05/)
    expect(idx(/^\$ ls$/)).toBeGreaterThanOrEqual(0)
    expect(idx(/^uno dos$/)).toBeGreaterThan(idx(/^\$ ls$/))
    expect(idx(/^fin$/)).toBeGreaterThan(idx(/^uno dos$/))
    expect(sep).toBeGreaterThan(idx(/^fin$/))
    expect(idx(/^PROMPT\$/)).toBeGreaterThan(sep)
  })

  it('pantalla vacía: solo el separador', async () => {
    const out = restorePreamble('', new Date(2026, 0, 1, 23, 59))
    expect(out).toBe('\x1b[2m── sesión restaurada 23:59 ──\x1b[0m\r\n')
    const lines = await render(restorePreamble('  \r\n', new Date(2026, 0, 1, 23, 59)) + 'PROMPT$ ')
    expect(lines[0]).toBe('── sesión restaurada 23:59 ──')
    expect(lines[1].trimEnd()).toBe('PROMPT$')
  })
})
