import { describe, expect, it } from 'vitest'
import { agentMessage, clip, isTuiChrome, lastMeaningfulLine, stripAnsi, tailLines } from './terminal-text'

describe('stripAnsi', () => {
  it('quita CSI de color, cursor y modos privados', () => {
    expect(stripAnsi('\x1b[31mrojo\x1b[0m \x1b[1;32mverde\x1b[m')).toBe('rojo verde')
    expect(stripAnsi('\x1b[2J\x1b[H\x1b[?25l\x1b[?2004hprompt')).toBe('prompt')
    expect(stripAnsi('a\x1b[3;1Hb\x1b[K')).toBe('ab')
    expect(stripAnsi('\x9b1mocho bits\x9bm')).toBe('ocho bits')
  })

  it('quita OSC (título, hyperlinks) cerrados con BEL o ST', () => {
    expect(stripAnsi('\x1b]0;✳ Claude Code\x07hola')).toBe('hola')
    expect(stripAnsi('\x1b]8;;https://x.y\x1b\\link\x1b]8;;\x1b\\')).toBe('link')
  })

  it('quita DCS y escapes cortos', () => {
    expect(stripAnsi('\x1bPq#0;1;0\x1b\\x')).toBe('x')
    expect(stripAnsi('\x1b(B\x1b=\x1b>\x1b7y\x1b8')).toBe('y')
  })

  it('quita controles salvo \\n, \\r y \\t', () => {
    expect(stripAnsi('a\x07b\x08c\x00d\x7fe')).toBe('abcde')
    expect(stripAnsi('uno\ndos\r\ntres\tcuatro')).toBe('uno\ndos\r\ntres\tcuatro')
  })

  it('deja el texto plano tal cual', () => {
    expect(stripAnsi('│ Bash command │')).toBe('│ Bash command │')
  })
})

describe('tailLines', () => {
  it('devuelve las últimas n líneas no vacías', () => {
    expect(tailLines('a\nb\n\n   \nc\nd\n', 2)).toEqual(['c', 'd'])
    expect(tailLines('a\nb\nc', 10)).toEqual(['a', 'b', 'c'])
    expect(tailLines('', 5)).toEqual([])
    expect(tailLines('a\nb', 0)).toEqual([])
  })

  it('trata \\r como salto de línea y \\r\\n como uno solo', () => {
    expect(tailLines('Cargando.\rCargando..\rListo', 3)).toEqual(['Cargando.', 'Cargando..', 'Listo'])
    expect(tailLines('uno\r\ndos', 5)).toEqual(['uno', 'dos'])
  })

  it('conserva la sangría, quita espacios finales y expande tabuladores', () => {
    expect(tailLines('  ls -la   \n\tx', 5)).toEqual(['  ls -la', '    x'])
  })

  it('encadenado con stripAnsi da la cola legible de una TUI', () => {
    const raw = '\x1b[?25l\x1b[1mDo you want to proceed?\x1b[0m\r\n\x1b[36m❯\x1b[0m 1. Yes\r\n  2. No\r\n'
    expect(tailLines(stripAnsi(raw), 40)).toEqual(['Do you want to proceed?', '❯ 1. Yes', '  2. No'])
  })
})

describe('stripAnsi con TUI de Ink (Claude Code)', () => {
  it('los saltos de cursor entre palabras (`ESC[<col>G`, `ESC[<n>C`) se vuelven espacios', () => {
    const ink = '\x1b[3G\x1b[1mNew\x1b[7GMCP\x1b[11Gserver\x1b[22m \x1b[2Cfound'
    expect(stripAnsi(ink).replace(/\s+/g, ' ').trim()).toBe('New MCP server found')
  })
})

describe('agentMessage', () => {
  it('toma el último mensaje del agente con su continuación y salta herramientas', () => {
    const screen = ['⏺ Primero miré el repo.', '⏺ Read 3 files', '⏺ Cambié el puerto a 4000', '  y reinicié el server.', '  ⎿  detalle']
    expect(agentMessage(screen)).toBe('Cambié el puerto a 4000 y reinicié el server.')
  })
  it('Codex usa •', () => {
    expect(agentMessage(['• Ya quedó, corrí pnpm test.', '› Escribe un mensaje'])).toBe('Ya quedó, corrí pnpm test.')
  })
  it('sin mensajes devuelve null', () => {
    expect(agentMessage(['λ ~/repo/ ls', 'README.md'])).toBeNull()
  })
})

describe('chrome de la TUI', () => {
  it('reconoce bordes, prompt y barras de estado', () => {
    expect(isTuiChrome('  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)')).toBe(true)
    expect(isTuiChrome('╰────────╯')).toBe(true)
    expect(isTuiChrome('│ > ')).toBe(true)
    expect(isTuiChrome('  ? for shortcuts')).toBe(true)
    expect(isTuiChrome('build ok')).toBe(false)
    expect(isTuiChrome('λ ~/private/courier/')).toBe(true)
    expect(isTuiChrome('➜  omni git:(main) ')).toBe(true)
    expect(isTuiChrome('yo@mac:~/repo$ ')).toBe(true)
    expect(isTuiChrome('¿Borro también la carpeta dist/? (s/n)')).toBe(false)
  })
  it('lastMeaningfulLine salta el chrome', () => {
    expect(lastMeaningfulLine(['listo', '╰──╯', '  -- INSERT --'])).toBe('listo')
    expect(lastMeaningfulLine(['╰──╯'])).toBeNull()
  })
  it('clip corta por palabra con …', () => {
    expect(clip('a'.repeat(10))).toBe('aaaaaaaaaa')
    expect(clip('uno dos tres cuatro cinco', 14)).toBe('uno dos tres…')
  })
})
