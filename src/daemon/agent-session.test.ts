import { describe, expect, it } from 'vitest'
import { claudeSessionUnder, descendants, parseProcessTable } from './agent-session'

const PS = `    1     0
  100     1
  101   100
  102   101
  200     1
  201   200
garbage line
`
const OLD = '644b0f7e-27af-4a8a-b491-8fe668d118a2'
const NEW = '27752111-5305-4f95-9eaf-edbd10cefbd3'

describe('agent-session', () => {
  it('parsea la tabla de ps e ignora líneas raras', () => {
    const t = parseProcessTable(PS)
    expect(t.get(102)).toBe(101)
    expect(t.size).toBe(6)
  })

  it('lista los descendientes del shell, no los de otras sesiones', () => {
    expect(descendants(parseProcessTable(PS), 100)).toEqual([101, 102])
  })

  it('devuelve la conversación en curso de Claude Code bajo el shell (tras un /resume)', async () => {
    const files: Record<number, string> = { 102: JSON.stringify({ pid: 102, sessionId: NEW }), 201: JSON.stringify({ sessionId: OLD }) }
    const read = async (pid: number): Promise<string | null> => files[pid] ?? null
    expect(await claudeSessionUnder(parseProcessTable(PS), 100, read)).toBe(NEW)
    expect(await claudeSessionUnder(parseProcessTable(PS), 200, read)).toBe(OLD)
  })

  it('sin archivo, roto o sin uuid válido devuelve null', async () => {
    const t = parseProcessTable(PS)
    expect(await claudeSessionUnder(t, 100, async () => null)).toBeNull()
    expect(await claudeSessionUnder(t, 100, async () => '{roto')).toBeNull()
    expect(await claudeSessionUnder(t, 100, async () => JSON.stringify({ sessionId: '../x' }))).toBeNull()
  })
})
