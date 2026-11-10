import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectLocation } from '@shared/types'
import { SshHost } from '../hosts/ssh-host'
import { BranchCache, GitService, relativeInsidePosix } from './git'
import { commitFile, git, initRepo } from './git-fixture'

const FAKE_SSH = resolve(__dirname, '../../../e2e/fake-ssh/ssh')

let root: string
let repo: string
let host: SshHost
const env = { ...process.env }

beforeAll(() => {
  root = realpathSync(mkdtempSync('/tmp/omni-rgit-'))
  process.env.FAKE_SSH_HOME = root
  process.env.FAKE_SSH_REMOTE_SHELL = '/bin/sh'
  repo = realpathSync(initRepo())
  mkdirSync(join(repo, 'pkg'))
  commitFile(repo, 'pkg/a.ts', 'base\n', 'pkg')
  git(repo, 'checkout', '-q', '-b', 'feature/x')
  writeFileSync(join(repo, 'pkg', 'a.ts'), 'cambiado\n')
  writeFileSync(join(repo, 'pkg', 'nuevo.ts'), 'nuevo\n')
  host = new SshHost({ id: 'h1', name: 'vps', target: 'alex@vps' }, { sshBin: FAKE_SSH, controlDir: join(root, '.ctl') })
})
afterAll(() => {
  process.env = env
  rmSync(root, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

/** Registro con una ubicación remota en `path` (el repo temporal, que el ssh falso ve "en el host"). */
function service(path: string, withHosts = true): GitService {
  const location: ProjectLocation = { id: 'loc1', name: 'vps', path, host: 'h1' }
  return new GitService({
    registry: { project: () => undefined, location: (id) => (id === 'loc1' ? location : undefined), worktree: () => undefined },
    removeWorktree: async () => undefined,
    // El exec local NUNCA debe usarse para un workspace remoto.
    exec: async () => {
      throw new Error('exec local usado para un remoto')
    },
    hosts: withHosts ? { ensure: async () => host } : undefined
  })
}

describe('git en un workspace remoto (ssh falso)', { timeout: 30_000 }, () => {
  it('fileAtBase: HEAD por el exec del host; null si es nuevo; fuera → error', async () => {
    const git = service(repo)
    expect(await git.fileAtBase('loc1', join(repo, 'pkg', 'a.ts'))).toBe('base\n')
    expect(await git.fileAtBase('loc1', join(repo, 'pkg', 'nuevo.ts'))).toBeNull()
    await expect(git.fileAtBase('loc1', join(root, 'x.ts'))).rejects.toThrow(/fuera del workspace/)
    await expect(git.fileAtBase('loc1', `${repo}/../x.ts`)).rejects.toThrow(/fuera del workspace/)
  })

  it('fileAtBase en una subcarpeta del repo', async () => {
    expect(await service(join(repo, 'pkg')).fileAtBase('loc1', join(repo, 'pkg', 'a.ts'))).toBe('base\n')
  })

  it('fileAtBase: no es repo → error humano; sin hosts → error, nunca git local', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    writeFileSync(join(plain, 'f.ts'), 'x')
    await expect(service(plain).fileAtBase('loc1', join(plain, 'f.ts'))).rejects.toThrow(/no es un repo git/)
    await expect(service(repo, false).fileAtBase('loc1', join(repo, 'pkg', 'a.ts'))).rejects.toThrow(/host remoto/)
  })

  it('BranchCache remoto: rama por el host, cache aparte del local con la misma ruta', async () => {
    let localCalls = 0
    const cache = new BranchCache(async () => {
      localCalls++
      return 'local-branch\n'
    })
    expect(await cache.branch(repo, { hostId: 'h1', exec: host.exec })).toBe('feature/x')
    expect(await cache.branch(repo)).toBe('local-branch')
    expect(localCalls).toBe(1)
    expect(await cache.branch(join(root, 'nada'), { hostId: 'h1', exec: host.exec })).toBeNull()
  })
})

describe('relativeInsidePosix', () => {
  it('léxica: dentro, fuera, raíz', () => {
    expect(relativeInsidePosix('/srv/app', '/srv/app/src/a.ts')).toBe('src/a.ts')
    expect(relativeInsidePosix('/srv/app/', '/srv/app/./a.ts')).toBe('a.ts')
    expect(relativeInsidePosix('/srv/app', '/srv/app')).toBeNull()
    expect(relativeInsidePosix('/srv/app', '/srv/app/../b.ts')).toBeNull()
    expect(relativeInsidePosix('/srv/app', '/srv/apple/b.ts')).toBeNull()
    expect(relativeInsidePosix('/srv/app', 'src/a.ts')).toBeNull()
  })
})
