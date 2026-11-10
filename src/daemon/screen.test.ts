import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { ScreenMirror } from './screen'

/** Escribe `data` en una xterm vacía y devuelve sus líneas visibles (lo que vería el usuario al reconectar). */
async function replay(data: string, cols: number, rows: number): Promise<string[]> {
  const t = new Terminal({ cols, rows, allowProposedApi: true })
  await new Promise<void>((r) => t.write(data, r))
  const b = t.buffer.active
  const out: string[] = []
  for (let i = 0; i < rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
  t.dispose()
  return out
}

describe('ScreenMirror', () => {
  it('serializa la pantalla final, no la historia de bytes (un repintado de TUI queda como una sola pantalla)', async () => {
    const m = new ScreenMirror(30, 4)
    m.write('primera versión\r\n')
    // Una TUI repinta la línea: con bytes crudos se reproduciría todo; el espejo guarda solo el resultado.
    m.write('\x1b[1A\x1b[2Kversión final\r\n')
    await m.flush()
    const lines = await replay(m.serialize(), 30, 4)
    expect(lines[0]).toBe('versión final')
    expect(lines.join('\n')).not.toMatch(/primera/)
    m.dispose()
  })

  it('conserva la pantalla alterna de una TUI a pantalla completa', async () => {
    const m = new ScreenMirror(30, 4)
    m.write('prompt del shell\r\n\x1b[?1049h\x1b[2J\x1b[HClaude Code\r\n❯ ')
    await m.flush()
    const s = m.serialize()
    expect(s).toContain('\x1b[?1049h')
    expect((await replay(s, 30, 4))[0]).toBe('Claude Code')
    m.dispose()
  })

  it('mide emojis con unicode 11 y sigue al resize', async () => {
    const m = new ScreenMirror(20, 3)
    m.resize(10, 3)
    m.write('😀ab')
    await m.flush()
    expect(m.serialize()).toContain('😀ab')
    const lines = await replay(m.serialize(), 10, 3)
    expect(lines[0]).toBe('😀ab')
    m.dispose()
  })
})
