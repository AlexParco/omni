import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '@shared/types'

vi.mock('electron', () => ({}))

import { BrowserAgent, cdpModifiers, isPageOp, parseKeys, readScript, validatePageArgs, validateShapes, type AgentHost } from './browser-agent'

describe('parseKeys', () => {
  it('nombres, caracteres y modificadores con key, code y keyCode del DOM', () => {
    expect(parseKeys('Enter')).toEqual({ ok: true, strokes: [{ key: 'Enter', code: 'Enter', keyCode: 13, modifiers: [], text: '\r' }] })
    expect(parseKeys('cmd+a Backspace')).toEqual({
      ok: true,
      strokes: [
        { key: 'a', code: 'KeyA', keyCode: 65, modifiers: ['meta'], commands: ['selectAll'] },
        { key: 'Backspace', code: 'Backspace', keyCode: 8, modifiers: [] }
      ]
    })
    expect(parseKeys('shift+Tab ArrowDown esc')).toMatchObject({ ok: true, strokes: [{ key: 'Tab', modifiers: ['shift'] }, { key: 'ArrowDown', keyCode: 40 }, { key: 'Escape', keyCode: 27 }] })
    expect(parseKeys('shift+a')).toEqual({ ok: true, strokes: [{ key: 'A', code: 'KeyA', keyCode: 65, modifiers: ['shift'], text: 'A' }] })
    expect(parseKeys('7 /')).toMatchObject({ ok: true, strokes: [{ key: '7', code: 'Digit7', keyCode: 55, text: '7' }, { key: '/', code: 'Slash', keyCode: 191, text: '/' }] })
    expect(parseKeys('ctrl++')).toEqual({ ok: true, strokes: [{ key: '+', code: '', keyCode: 0, modifiers: ['control'] }] })
    expect(parseKeys('F5')).toEqual({ ok: true, strokes: [{ key: 'F5', code: 'F5', keyCode: 116, modifiers: [] }] })
    expect(parseKeys('cmd+shift+z')).toMatchObject({ ok: true, strokes: [{ commands: ['redo'] }] })
    expect(cdpModifiers(['meta', 'shift'])).toBe(12)
  })

  it('rechaza teclas y modificadores desconocidos', () => {
    expect(parseKeys('hyper+a').ok).toBe(false)
    expect(parseKeys('Enterr').ok).toBe(false)
    expect(parseKeys(Array(51).fill('a').join(' ')).ok).toBe(false)
  })
})

describe('validatePageArgs', () => {
  it('cada op exige lo suyo', () => {
    expect(validatePageArgs('navigate', {}).ok).toBe(false)
    expect(validatePageArgs('navigate', { url: 'example.com' })).toEqual({ ok: true, args: { url: 'example.com', newTab: false } })
    expect(validatePageArgs('read', { mode: 'raw' }).ok).toBe(false)
    expect(validatePageArgs('read', {})).toEqual({ ok: true, args: { mode: 'interactive', ref: undefined, viewport: false } })
    expect(validatePageArgs('click', {}).ok).toBe(false)
    expect(validatePageArgs('click', { ref: 'div' }).ok).toBe(false)
    expect(validatePageArgs('click', { x: 10, y: 20 })).toMatchObject({ ok: true, args: { x: 10, y: 20, button: 'left', double: false } })
    expect(validatePageArgs('type', { text: '' }).ok).toBe(false)
    expect(validatePageArgs('type', { text: '', clear: true }).ok).toBe(true)
    expect(validatePageArgs('key', { keys: 'nope+x' }).ok).toBe(false)
    expect(validatePageArgs('scroll', { direction: 'sideways' }).ok).toBe(false)
    expect(validatePageArgs('console', { pattern: '(' }).ok).toBe(false)
    expect(validatePageArgs('console', {})).toEqual({ ok: true, args: { pattern: undefined, lines: 50 } })
    expect(validatePageArgs('eval', {}).ok).toBe(false)
    expect(validatePageArgs('wait', {}).ok).toBe(false)
    expect(validatePageArgs('wait', { text: 'Listo', timeout: 999_999 })).toMatchObject({ ok: true, args: { text: 'Listo', timeout: 60_000 } })
    expect(validatePageArgs('draw', {}).ok).toBe(false)
    expect(validatePageArgs('draw', { clear: true })).toEqual({ ok: true, args: { shapes: [], clear: true } })
  })

  it('sessionId pasa solo si viene', () => {
    expect(validatePageArgs('screenshot', { sessionId: 'abcd1234' })).toEqual({ ok: true, args: { sessionId: 'abcd1234' } })
    expect(validatePageArgs('screenshot', {})).toEqual({ ok: true, args: {} })
  })

  it('isPageOp', () => {
    expect(isPageOp('draw')).toBe(true)
    expect(isPageOp('rm')).toBe(false)
  })
})

describe('validateShapes', () => {
  it('formas válidas con color por defecto', () => {
    const r = validateShapes([
      { kind: 'box', ref: 'r3', label: 'Aquí' },
      { kind: 'arrow', x: 10, y: 10, x2: 50, y2: 60, color: 'blue' },
      { kind: 'text', x: 5, y: 5, label: 'Nota' },
      { kind: 'dot', x: 1, y: 2, label: '1' }
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.shapes[0]).toEqual({ kind: 'box', ref: 'r3', label: 'Aquí', color: '#f97316' })
      expect(r.shapes[1]?.color).toBe('#3b82f6')
    }
  })

  it('rechaza formas incompletas, colores libres y demasiadas', () => {
    expect(validateShapes([{ kind: 'box', x: 1, y: 1 }]).ok).toBe(false)
    expect(validateShapes([{ kind: 'arrow', x: 1, y: 1 }]).ok).toBe(false)
    expect(validateShapes([{ kind: 'text', x: 1, y: 1 }]).ok).toBe(false)
    expect(validateShapes([{ kind: 'dot', ref: 'r1', color: '#000' }]).ok).toBe(false)
    expect(validateShapes([{ kind: 'circle' }]).ok).toBe(false)
    expect(validateShapes('box').ok).toBe(false)
    expect(validateShapes(Array(51).fill({ kind: 'dot', x: 1, y: 1 })).ok).toBe(false)
  })
})

describe('readScript', () => {
  it('es JS válido en cada modo', () => {
    for (const mode of ['interactive', 'all', 'text'] as const) expect(() => new Function(`return ${readScript({ mode, viewport: false, ref: 'r1' })}`)).not.toThrow()
  })
})

/** Host falso: dos navegadores, uno en pantalla. */
function fakeHost(over: Partial<AgentHost> = {}): AgentHost {
  const list: SessionInfo[] = [
    { id: 'aaaa1111', agent: 'browser', workspaceId: 'w', cwd: '/', createdAt: 1 },
    { id: 'bbbb2222', agent: 'browser', workspaceId: 'w', cwd: '/', createdAt: 2 }
  ]
  const state = { url: 'https://x.test/', title: 'X', loading: false, canGoBack: false, canGoForward: false, devtools: false, profileId: 'default', viewport: null }
  return {
    list: () => list,
    state: () => state,
    webContents: () => undefined,
    bounds: (id) => (id === 'aaaa1111' ? { x: 0, y: 0, width: 800, height: 600 } : null),
    lastShown: () => null,
    navigate: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    reload: () => undefined,
    consoleTail: () => ['[error] boom', '[log] hola', '[warn] cuidado'],
    captureImage: () => Promise.reject(new Error('sin imagen')),
    withAgentInput: (_id, fn) => fn(),
    keepAwake: () => undefined,
    open: () => Promise.resolve('new'),
    show: () => Promise.resolve(),
    notice: () => undefined,
    ...over
  }
}

describe('BrowserAgent', () => {
  it('tabs marca como destino el que está en pantalla, o el último mostrado', async () => {
    expect(new BrowserAgent(fakeHost()).tabs()).toMatchObject([{ sessionId: 'aaaa1111', onScreen: true, target: true }, { sessionId: 'bbbb2222', onScreen: false, target: false }])
    expect(new BrowserAgent(fakeHost({ lastShown: () => 'bbbb2222' })).tabs()).toMatchObject([{ target: false }, { target: true }])
  })

  it('console filtra por regex y avisa en la franja del navegador elegido', async () => {
    const notice = vi.fn()
    const agent = new BrowserAgent(fakeHost({ notice }))
    expect(await agent.run('console', { sessionId: 'bbbb', pattern: 'error|warn', lines: 50 }, 'mcp:claude')).toBe('[error] boom\n[warn] cuidado')
    expect(notice).toHaveBeenCalledWith('bbbb2222', 'mcp:claude')
  })

  it('sin navegadores: error humano; navigate abre uno', async () => {
    const open = vi.fn(() => Promise.resolve('aaaa1111'))
    const agent = new BrowserAgent(fakeHost({ list: () => [], open }))
    await expect(agent.run('read', { mode: 'interactive' }, 'mcp:claude')).rejects.toThrow(/no hay ningún navegador/)
    await expect(agent.run('navigate', { url: 'example.com', newTab: false }, 'mcp:claude')).resolves.toMatchObject({ sessionId: 'aaaa1111' })
    expect(open).toHaveBeenCalledWith('example.com', 'mcp:claude')
  })

  it('un sessionId que no existe falla con la pista de tabs', async () => {
    await expect(new BrowserAgent(fakeHost()).run('console', { sessionId: 'zzzz', lines: 5 }, 'cli')).rejects.toThrow(/mira tabs/)
  })
})
