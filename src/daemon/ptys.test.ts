import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PtyHost } from './ptys'

/** Espera hasta que `cond` se cumpla (o falla a los `ms`). */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('tiempo agotado esperando la condición')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// PTYs reales (node-pty) con `/bin/sh -c`: cada arranque cuenta una línea en `count`.
describe('PtyHost: reconexión de terminales remotas', { timeout: 15_000 }, () => {
  let dir: string
  let count: string
  let host: PtyHost
  let output: string
  let exits: [string, number, number, boolean][]
  let screens: Array<string | null>

  const spawns = (): number => {
    try {
      return readFileSync(count, 'utf8').split('\n').filter((l) => l !== '').length
    } catch {
      return 0
    }
  }

  /** Sesión "remota" que corre `body` en `/bin/sh`, contando cada arranque. */
  const start = (body: string, reconnect: boolean): string =>
    host.create({ agent: 'shell', workspaceId: 'w1', cwd: '/srv', command: null, spawn: { file: '/bin/sh', args: ['-c', `echo x >> '${count}'; ${body}`], reconnect } }).id

  const make = (backoffMs: number[], stableMs = 60_000): void => {
    host = new PtyHost(undefined, { backoffMs, stableMs })
    host.onData((_id, data) => {
      output += data
    })
    host.onExit((id, code, signal, lost, screen) => {
      exits.push([id, code, signal, lost === true])
      screens.push(screen ?? null)
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-ptys-'))
    count = join(dir, 'count')
    output = ''
    exits = []
    screens = []
  })
  afterEach(() => {
    host.killAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('código 255 con reconnect: avisa "reconectando", relanza y al agotar las esperas termina con 255', async () => {
    make([20, 20])
    const id = start('echo uno; exit 255', true)
    expect(host.list()[0]).toMatchObject({ id, remote: true, cwd: '/srv' })
    await until(() => exits.length > 0)
    expect(spawns()).toBe(3)
    expect(output.match(/conexión perdida, reconectando/g)).toHaveLength(2)
    // La salida de cada intento ("uno", como el error de ssh) no reinicia el backoff.
    expect(output.match(/uno/g)).toHaveLength(3)
    // Agotó las esperas: `lost` para que el registro la guarde como huérfana (el dtach sigue en el host).
    expect(exits).toEqual([[id, 255, 0, true]])
    expect(host.has(id)).toBe(false)
  })

  it('kill durante la espera: la sesión termina ahí, con exit, y no se relanza', async () => {
    make([2_000])
    const id = start('exit 255', true)
    await until(() => output.includes('reconectando'))
    expect(exits).toEqual([])
    expect(host.has(id)).toBe(true)
    host.kill(id)
    expect(exits).toEqual([[id, 255, 0, false]])
    expect(host.has(id)).toBe(false)
    await delay(100)
    expect(spawns()).toBe(1)
  })

  it('código 0 (no 255) termina normal aunque reconecte', async () => {
    make([20])
    const id = start('exit 0', true)
    await until(() => exits.length > 0)
    expect(exits).toEqual([[id, 0, 0, false]])
    expect(spawns()).toBe(1)
    expect(output).not.toContain('reconectando')
  })

  it('sin reconnect (host sin dtach), un 255 nunca relanza pero queda `lost` con su última pantalla', async () => {
    make([20])
    const id = start('echo ULTIMA-LINEA; sleep 0.3; exit 255', false)
    await until(() => exits.length > 0)
    await delay(100)
    expect(exits).toEqual([[id, 255, 0, true]])
    expect(screens[0]).toContain('ULTIMA-LINEA')
    expect(spawns()).toBe(1)
    expect(output).not.toContain('reconectando')
  })

  it('el relanzado usa el último tamaño pedido con resize', async () => {
    make([300])
    // Primer arranque: se cae; el segundo imprime su tamaño y sale bien.
    const id = start(`if [ "$(wc -l < '${count}')" -gt 1 ]; then stty size; exit 0; fi; exit 255`, true)
    await until(() => output.includes('reconectando'))
    host.resize(id, 100, 40)
    await until(() => exits.length > 0)
    expect(output).toContain('40 100')
    expect(exits).toEqual([[id, 0, 0, false]])
    expect(spawns()).toBe(2)
  })

  it('un proceso que aguantó stableMs reinicia el backoff: se sigue reconectando pasado el tope', async () => {
    make([20], 0)
    const id = start('exit 255', true)
    await until(() => spawns() >= 4)
    expect(exits).toEqual([])
    host.kill(id)
    await until(() => exits.length > 0)
    expect(host.has(id)).toBe(false)
  })

  it('el comando del agente sobrevive a un primer ssh que se cae antes del prompt: lo escribe el relanzado', async () => {
    make([50])
    // Primer arranque: muere con 255 sin imprimir nada. Segundo: pinta un prompt y lee una línea.
    const body = `if [ "$(wc -l < '${count}')" -gt 1 ]; then printf 'prompt$ '; read line; echo "got:$line"; exit 0; fi; exit 255`
    const id = host.create({ agent: 'claude', workspaceId: 'w1', cwd: '/srv', command: 'claude', args: ['--resume', 'abc'], spawn: { file: '/bin/sh', args: ['-c', `echo x >> '${count}'; ${body}`], reconnect: true } }).id
    await until(() => exits.length > 0, 8_000)
    expect(output).toContain('got:claude --resume abc')
    expect(exits).toEqual([[id, 0, 0, false]])
    expect(spawns()).toBe(2)
  })

  it('el comando se escribe una sola vez: un relanzado tras uno que ya lo recibió no lo repite', async () => {
    make([50])
    // Primer arranque: prompt, recibe la línea y se cae con 255. Segundo: prompt y un rato abierto (la
    // tty haría eco de cualquier cosa que se le escriba).
    const body = `if [ "$(wc -l < '${count}')" -gt 1 ]; then printf 'prompt$ '; sleep 1; exit 0; fi; printf 'prompt$ '; read line; echo "got:$line"; exit 255`
    host.create({ agent: 'claude', workspaceId: 'w1', cwd: '/srv', command: 'claude', spawn: { file: '/bin/sh', args: ['-c', `echo x >> '${count}'; ${body}`], reconnect: true } })
    await until(() => exits.length > 0, 8_000)
    expect(output).toContain('got:claude')
    // Eco de la tty + "got:" del primero; nada del segundo.
    expect(output.match(/claude/g)).toHaveLength(2)
    expect(spawns()).toBe(2)
  })

  it('revivir (restored) o enganchar (spawn) con un id vivo se rechaza; uno normal recibe otro id', () => {
    make([20])
    const id = start('sleep 5', true)
    expect(() => host.create({ id, agent: 'shell', workspaceId: 'w1', cwd: '/srv', command: null, spawn: { file: '/bin/sh', args: ['-c', 'sleep 5'], reconnect: true } })).toThrow(/ya existe/)
    expect(() => host.create({ id, agent: 'shell', workspaceId: 'w1', cwd: '/tmp', command: null, restored: true })).toThrow(/ya existe/)
    expect(host.list()).toHaveLength(1)
    const other = host.create({ id, agent: 'shell', workspaceId: 'w1', cwd: '/tmp', command: null })
    expect(other.id).not.toBe(id)
    expect(host.list()).toHaveLength(2)
  })
})
