import { describe, expect, it, vi } from 'vitest'
import { allowedKinds, isOnScreen, lastLine, notifyBody, notifyFlags, notifyPlace, notifySetting, planNotify } from './notify'

vi.mock('@/lib/omni', () => ({
  omni: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(() => () => {}) }
}))
vi.mock('@/panes/terminal/terminal-host', () => ({
  screenLines: () => null, disposeTerminal: vi.fn(), getTerminal: vi.fn() }))

/** Banderas `{ id: true }` con el tipo exacto del store. */
const flags = (...ids: string[]): Record<string, true> => Object.fromEntries(ids.map((id) => [id, true as const]))
const snap = (attention: string[] = [], unread: string[] = []) => ({ attention: flags(...attention), unread: flags(...unread) })
const empty = snap()

describe('allowedKinds', () => {
  it('traduce el ajuste a tipos de aviso', () => {
    expect(allowedKinds('all')).toEqual(['question', 'done'])
    expect(allowedKinds('questions')).toEqual(['question'])
    expect(allowedKinds('off')).toEqual([])
  })
})

describe('planNotify', () => {
  it('entrar en pregunta pide una notificación question', () => {
    const shown = new Set<string>()
    const plan = planNotify(empty, snap(['a']), 'all', shown)

    expect(plan).toEqual({ show: [{ id: 'a', kind: 'question' }], dismiss: [] })
    expect(shown.has('a:question')).toBe(true)
  })

  it('entrar en sin leer pide done solo con el ajuste "all"', () => {
    const next = snap([], ['a'])
    expect(planNotify(empty, next, 'all', new Set()).show).toEqual([{ id: 'a', kind: 'done' }])
    expect(planNotify(empty, next, 'questions', new Set()).show).toEqual([])
    expect(planNotify(empty, next, 'off', new Set()).show).toEqual([])
  })

  it('con el ajuste "off" no pide nada', () => {
    expect(planNotify(empty, snap(['a'], ['a']), 'off', new Set()).show).toEqual([])
  })

  it('una por sesión y estado: no repite mientras siga pendiente', () => {
    const shown = new Set(['a:question'])
    const plan = planNotify(empty, snap(['a']), 'all', shown)

    expect(plan.show).toEqual([])
  })

  it('sin transición no pide nada', () => {
    const prev = snap(['a'], ['b'])
    expect(planNotify(prev, prev, 'all', new Set()).show).toEqual([])
  })

  it('atender la pregunta retira la notificación de la sesión', () => {
    const shown = new Set(['a:question'])
    const plan = planNotify(snap(['a']), empty, 'all', shown)

    expect(plan.dismiss).toEqual(['a'])
    expect(shown.size).toBe(0)
  })

  it('limpiar el sin leer (markSeen, entrar al pane) retira la notificación', () => {
    const shown = new Set(['a:done'])
    const plan = planNotify(snap([], ['a']), empty, 'all', shown)

    expect(plan.dismiss).toEqual(['a'])
  })

  it('no retira mientras a la sesión le quede otro aviso pendiente', () => {
    const shown = new Set(['a:question', 'a:done'])
    const plan = planNotify(snap(['a'], ['a']), snap(['a']), 'all', shown)

    expect(plan.dismiss).toEqual([])
    expect([...shown]).toEqual(['a:question'])
  })

  it('no retira si nunca se mostró nada (ajuste off)', () => {
    expect(planNotify(snap(['a']), empty, 'off', new Set()).dismiss).toEqual([])
  })

  it('resuelta y vuelta a pedir, se vuelve a mostrar', () => {
    const shown = new Set<string>()
    planNotify(empty, snap(['a']), 'all', shown)
    planNotify(snap(['a']), empty, 'all', shown)
    const again = planNotify(empty, snap(['a']), 'all', shown)

    expect(again.show).toEqual([{ id: 'a', kind: 'question' }])
  })
})

describe('texto de la cola', () => {
  it('lastLine devuelve la última línea no vacía, sin ANSI ni espacios', () => {
    expect(lastLine('uno\r\n\x1b[1mDo you want to proceed?\x1b[0m  \n\n   \n')).toBe('Do you want to proceed?')
    expect(lastLine('solo\rotra')).toBe('otra')
    expect(lastLine('\x1b]0;título\x07  fin  \x1b[?2004h')).toBe('fin')
    expect(lastLine('\n\n')).toBe('')
  })

  it('notifyBody usa el resumen del patrón de permiso si lo hay, si no la última línea', () => {
    const claude = ['Bash command', 'git status', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'].join('\n')
    expect(notifyBody('claude', claude)).toBe('git status')
    expect(notifyBody('shell', '\x1b[32m$\x1b[0m make\nlisto  \n')).toBe('listo')
    expect(notifyBody('claude', '')).toBe('')
  })

  it('notifyBody con la pantalla de Claude Code: lo que dijo el agente, nunca la barra de estado', () => {
    const screen = [
      '⏺ Update(src/app.ts)',
      '  ⎿  Updated src/app.ts with 3 additions',
      '⏺ Listo: agregué la validación del email y los tests pasan (12/12).',
      '  Falta decidir si el mensaje de error va en español.',
      '╭──────────────────────────────────────────╮',
      '│ >                                        │',
      '╰──────────────────────────────────────────╯',
      '  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)'
    ]
    expect(notifyBody('claude', '', screen)).toBe('Listo: agregué la validación del email y los tests pasan (12/12). Falta decidir si el mensaje de error va en español.')
    // Solo herramientas: la última llamada, no el pie.
    expect(notifyBody('claude', '', ['⏺ Bash(npm test)', '  ⎿  ok', '  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)'])).toBe('Bash(npm test)')
    // Sin mensajes: la última línea útil, saltando el chrome.
    expect(notifyBody('shell', '', ['$ make', 'build ok', '  -- INSERT --'])).toBe('build ok')
    // Pregunta: el permiso gana al mensaje.
    expect(notifyBody('claude', '', ['⏺ Voy a correr los tests.', 'Bash command', 'npm test', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'])).toBe('npm test')
  })

  it('los dos interruptores de Ajustes van y vuelven al ajuste', () => {
    for (const setting of ['all', 'questions', 'done', 'off'] as const) expect(notifySetting(notifyFlags(setting))).toBe(setting)
    expect(notifyFlags('done')).toEqual({ question: false, done: true })
    expect(allowedKinds('done')).toEqual(['done'])
  })

  it('notifyPlace: el proyecto, y en un worktree también su nombre', () => {
    const projects = [{ id: 'p', name: 'shop', path: '/r' }] as never[]
    const workspaces = [
      { id: 'w1', projectId: 'p', kind: 'local', name: 'Local', path: '/r' },
      { id: 'w2', projectId: 'p', kind: 'worktree', name: 'cc-51', path: '/r-wt' }
    ] as never[]
    expect(notifyPlace({ projects, workspaces }, 'w1')).toBe('shop')
    expect(notifyPlace({ projects, workspaces }, 'w2')).toBe('shop · cc-51')
    expect(notifyPlace({ projects, workspaces }, 'nope')).toBe('')
  })

  it('isOnScreen: pane del tab activo del workspace actual, en Flota y no tapado por el zoom', () => {
    const leafA = { id: 'la', kind: 'leaf' as const, sessionId: 'a' }
    const leafB = { id: 'lb', kind: 'leaf' as const, sessionId: 'b' }
    const root = { id: 'sp', kind: 'split' as const, dir: 'row' as const, sizes: [0.5, 0.5], children: [leafA, leafB] }
    const t1 = { id: 't1', workspaceId: 'w1', root, focusedPaneId: 'la', zoomedPaneId: null }
    const t2 = { id: 't2', workspaceId: 'w1', root: { id: 'lc', kind: 'leaf' as const, sessionId: 'c' }, focusedPaneId: 'lc', zoomedPaneId: null }
    const lay = { tabs: [t1, t2], activeTab: { w1: 't1' } }

    expect(isOnScreen(lay, 'w1', 'fleet', 'a')).toBe(true)
    expect(isOnScreen(lay, 'w1', 'fleet', 'b')).toBe(true)
    expect(isOnScreen(lay, 'w1', 'fleet', 'c')).toBe(false)
    expect(isOnScreen(lay, 'w1', 'worktrees', 'a')).toBe(false)
    expect(isOnScreen(lay, null, 'fleet', 'a')).toBe(false)
    expect(isOnScreen(lay, 'w2', 'fleet', 'a')).toBe(false)
    expect(isOnScreen({ tabs: [{ ...t1, zoomedPaneId: 'la' }, t2], activeTab: { w1: 't1' } }, 'w1', 'fleet', 'b')).toBe(false)
  })
})
