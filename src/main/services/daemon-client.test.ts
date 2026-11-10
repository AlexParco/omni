import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { DAEMON_PROTOCOL } from '@shared/daemon'
import { daemonPaths } from '../../daemon/paths'
import { decodeLine, encodeLine, LineSplitter } from '../../daemon/protocol'
import { DaemonClient } from './daemon-client'

describe('daemonEnv', () => {
  it('quita el marcador de sesión de Claude Code y deja el resto', async () => {
    const { daemonEnv } = await import('./daemon-client')
    expect(daemonEnv({ PATH: '/bin', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/x' })).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/x' })
  })
})

const LIVE = [{ id: 's1', agent: 'shell', workspaceId: 'w', cwd: '/', createdAt: 0 }]

/**
 * Daemon falso por NDJSON: contesta `info` con el build dado, `list` con `sessions` y lo mínimo para
 * conectar. `requests` anota los tipos de pedido que recibió.
 */
function fakeDaemon(sock: string, build: string, sessions: unknown[] = LIVE, requests: string[] = []): Promise<{ close: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const splitter = new LineSplitter()
    socket.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) {
        const req = decodeLine(line)
        if (!req || typeof req.id !== 'number') continue
        requests.push(String(req.type))
        const result = req.type === 'info' ? { pid: 1, protocol: DAEMON_PROTOCOL, build, startedAt: 0 } : req.type === 'list' ? sessions : null
        socket.write(encodeLine({ id: req.id, ok: true, result }))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(sock, () =>
      resolve({
        close: () =>
          new Promise<void>((done) => {
            sockets.forEach((s) => s.destroy())
            server.close(() => done())
          })
      })
    )
  })
}

describe('DaemonClient.remoteReady', { timeout: 15_000 }, () => {
  it('se recalcula al reconectar: de un daemon de otro build a uno del mismo build y vuelta', async () => {
    const dir = mkdtempSync('/tmp/omni-dc-')
    const paths = daemonPaths(dir)
    // `execPath` inocuo: el cliente "relanza" el daemon al perderlo, pero aquí lo levanta el test.
    const client = new DaemonClient({ build: 'nuevo', restartOnBuildMismatch: false, script: '', execPath: '/usr/bin/true', paths, log: () => undefined })
    const until = async (cond: () => boolean): Promise<void> => {
      const end = Date.now() + 8_000
      while (!cond()) {
        if (Date.now() > end) throw new Error('tiempo agotado')
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    let daemon = await fakeDaemon(paths.sock, 'viejo')
    try {
      await client.start()
      expect(client.remoteReady()).toBe(false)
      await daemon.close()
      daemon = await fakeDaemon(paths.sock, 'nuevo')
      await until(() => client.remoteReady())
      await daemon.close()
      daemon = await fakeDaemon(paths.sock, 'viejo')
      await until(() => !client.remoteReady())
    } finally {
      await client.shutdown()
      await daemon.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('DaemonClient con un daemon de otro build (§3.10c)', { timeout: 15_000 }, () => {
  const setup = async (sessions: unknown[]) => {
    const dir = mkdtempSync('/tmp/omni-dc-')
    const paths = daemonPaths(dir)
    const requests: string[] = []
    const daemon = await fakeDaemon(paths.sock, 'viejo', sessions, requests)
    const client = new DaemonClient({ build: 'nuevo', restartOnBuildMismatch: false, script: '', execPath: '/usr/bin/true', paths, log: () => undefined })
    const done = async (): Promise<void> => {
      await client.shutdown()
      await daemon.close()
      rmSync(dir, { recursive: true, force: true })
    }
    return { client, requests, done }
  }

  it('con sesiones vivas lo conserva y queda desactualizado', async () => {
    const { client, requests, done } = await setup(LIVE)
    try {
      await client.start()
      expect(client.outdated()).toBe(true)
      expect(requests).not.toContain('shutdown')
    } finally {
      await done()
    }
  })

  it('sin sesiones vivas lo relanza sin preguntar: no hay paso en curso que perder', async () => {
    const { client, requests, done } = await setup([])
    try {
      await client.start()
      expect(requests).toContain('shutdown')
    } finally {
      await done()
    }
  })

  it('upgrade lo apaga sin olvidar el registro, para revivir las sesiones', async () => {
    const { client, requests, done } = await setup(LIVE)
    try {
      await client.start()
      await client.upgrade()
      expect(requests).toContain('shutdown')
    } finally {
      await done()
    }
  })
})
