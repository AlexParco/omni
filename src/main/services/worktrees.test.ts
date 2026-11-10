import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IssueInfo } from '@shared/types'
import { commitFile, git, initRepo } from './git-fixture'
import { ProjectStore } from './projects'
import { SshHost } from '../hosts/ssh-host'
import { countLines, isUnderRoot, lastLine, nameFromIssue, parseShortstat, projectFolder, sanitizeName, testsEnv, WorktreeService, type IssueFetcher } from './worktrees'

describe('nombres', () => {
  it('sanea a [a-z0-9-] y recorta a 40 sin guion colgando', () => {
    expect(sanitizeName('Rate Limit por IP!')).toBe('rate-limit-por-ip')
    expect(sanitizeName('  Ñandú/café ')).toBe('nandu-cafe')
    expect(sanitizeName('***')).toBe('')
    expect(sanitizeName('a'.repeat(39) + '-bcdef')).toBe('a'.repeat(39))
  })

  it('desde un issue: issue-<n>-<slug del título>', () => {
    expect(nameFromIssue({ number: 41, title: 'Rate limit por IP', url: 'u' })).toBe('issue-41-rate-limit-por-ip')
    expect(nameFromIssue({ number: 7, title: 'Un título larguísimo que no cabe en cuarenta caracteres ni de broma', url: 'u' })).toHaveLength(40)
  })
})

describe('helpers', () => {
  it('parseShortstat', () => {
    expect(parseShortstat(' 3 files changed, 10 insertions(+), 2 deletions(-)\n')).toEqual({ files: 3, additions: 10, deletions: 2 })
    expect(parseShortstat(' 1 file changed, 1 insertion(+)\n')).toEqual({ files: 1, additions: 1, deletions: 0 })
    expect(parseShortstat('')).toEqual({ files: 0, additions: 0, deletions: 0 })
  })

  it('testsEnv quita lo de Electron, NODE_OPTIONS y npm_config_*; marca TERM_PROGRAM', () => {
    const env = testsEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', NODE_OPTIONS: '--inspect', npm_config_registry: 'x', NPM_CONFIG_USER_AGENT: 'y', HOME: '/h', VACIA: undefined })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', TERM_PROGRAM: 'omni', OMNI_SESSION: '1' })
  })

  it('isUnderRoot: solo lo que cuelga de la raíz, sin confundir prefijos', () => {
    expect(isUnderRoot('/r/a/b', '/r')).toBe(true)
    expect(isUnderRoot('/r/a/../b', '/r')).toBe(true)
    expect(isUnderRoot('/r/../etc', '/r')).toBe(false)
    expect(isUnderRoot('/r', '/r')).toBe(false)
    expect(isUnderRoot('/rx/a', '/r')).toBe(false)
  })

  it('lastLine y countLines', () => {
    expect(lastLine('a\n\n  b  \n\n')).toBe('b')
    expect(lastLine('')).toBe('')
    expect(countLines(Buffer.from('a\nb\n'))).toBe(2)
    expect(countLines(Buffer.from('a\nb'))).toBe(2)
    expect(countLines(Buffer.alloc(0))).toBe(0)
    expect(countLines(Buffer.from([65, 0, 66]))).toBe(0)
  })
})

// Repos git reales: con la máquina cargada, 5 s se quedan cortos.
describe('WorktreeService', { timeout: 30_000 }, () => {
  let tmp: string
  let repo: string
  let store: ProjectStore
  let projectId: string
  let changed: string[]
  let fetchIssue: ReturnType<typeof vi.fn<IssueFetcher>>
  let service: WorktreeService

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'omni-wt-'))
    repo = initRepo()
    // home '/': el repo de prueba vive en el tmp del sistema, fuera de la carpeta de usuario.
    store = new ProjectStore(join(tmp, 'projects.json'), join(tmp, 'worktrees'), '/')
    projectId = store.add(repo).id
    changed = []
    fetchIssue = vi.fn<IssueFetcher>(async (number): Promise<IssueInfo> => ({ number, title: 'Rate limit por IP', url: `https://github.com/x/y/issues/${number}` }))
    service = new WorktreeService({ registry: store, root: join(tmp, 'worktrees'), issue: fetchIssue })
    service.onChanged((id) => changed.push(id))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('desde una subcarpeta del repo: el worktree es del repo entero y agentes y tests arrancan en esa subcarpeta', async () => {
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
    commitFile(repo, 'apps/web/package.json', '{}\n', 'web')
    const web = store.addLocation(projectId, { path: join(repo, 'apps', 'web') })
    store.setTestCommand(projectId, 'pwd', web.id)
    const ws = await service.create(projectId, { name: 'web-fix', locationId: web.id })
    expect(store.worktree(ws.id)?.subdir).toBe('apps/web')
    const workspace = store.workspace(ws.id)
    expect(workspace?.cwd).toBe(join(ws.path, 'apps/web'))
    expect(existsSync(join(ws.path, 'apps', 'web', 'package.json'))).toBe(true)
    await service.runTests(ws.id)
    // `pwd` corrió en la subcarpeta: la última línea de la salida es esa ruta.
    expect(service.testsOf(ws.id)).toMatchObject({ status: 'pass' })
    expect(service.testsOf(ws.id)?.summary.endsWith('apps/web')).toBe(true)
  })

  it('crea omni/<name> desde la rama actual en la raíz, lo registra y avisa', async () => {
    const ws = await service.create(projectId, { name: 'Rate Limit' })
    const project = store.project(projectId)
    if (!project) throw new Error('sin proyecto')
    expect(ws).toMatchObject({ projectId, name: 'rate-limit', kind: 'worktree' })
    expect(projectFolder(project)).toBe(`${sanitizeName(project.name)}-${project.id.slice(0, 8)}`)
    expect(ws.path).toBe(join(tmp, 'worktrees', projectFolder(project), 'rate-limit'))
    expect(existsSync(join(ws.path, 'README.md'))).toBe(true)
    expect(git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('omni/rate-limit')
    expect(store.worktree(ws.id)).toMatchObject({ branch: 'omni/rate-limit', base: 'main', path: ws.path })
    expect(store.workspace(ws.id)?.kind).toBe('worktree')
    expect(changed).toEqual([ws.id])
    await expect(service.create(projectId, { name: 'rate-limit' })).rejects.toThrow('ya existe un worktree rate-limit')
    await expect(service.create(projectId, { name: '!!!' })).rejects.toThrow(/nombre inválido/)
  })

  it('sin nombre ni issue, wt-<n>; un proyecto que no es repo tira con error humano', async () => {
    expect((await service.create(projectId)).name).toBe('wt-1')
    expect((await service.create(projectId)).name).toBe('wt-2')
    const plain = store.add(mkdtempSync(join(tmpdir(), 'omni-plain-')))
    await expect(service.create(plain.id)).rejects.toThrow('el proyecto no es un repo git')
    rmSync(plain.locations[0].path, { recursive: true, force: true })
  })

  it('dos proyectos con el mismo basename no comparten carpeta de worktrees', async () => {
    const twin = initRepo()
    try {
      const other = store.add(twin)
      expect(basename(other.locations[0].path)).not.toBe(basename(repo))
      // Mismo nombre visible a la fuerza: el id los separa igual.
      other.name = store.project(projectId)?.name ?? ''
      const a = await service.create(projectId, { name: 'feat' })
      const b = await service.create(other.id, { name: 'feat' })
      expect(a.path).not.toBe(b.path)
      expect(dirname(a.path)).not.toBe(dirname(b.path))
      expect(existsSync(join(b.path, 'README.md'))).toBe(true)
    } finally {
      rmSync(twin, { recursive: true, force: true })
    }
  })

  it('desde un issue: nombre del título, gh con el cwd del repo y el issue guardado', async () => {
    const ws = await service.create(projectId, { issue: 41 })
    expect(fetchIssue).toHaveBeenCalledWith(41, repo)
    expect(ws.name).toBe('issue-41-rate-limit-por-ip')
    expect(store.worktree(ws.id)?.issue).toEqual({ number: 41, title: 'Rate limit por IP', url: 'https://github.com/x/y/issues/41' })
    expect(await service.issue(projectId, 9)).toMatchObject({ number: 9 })
    await expect(service.issue(projectId, 0)).rejects.toThrow(/inválido/)
  })

  it('status: limpio al crear; luego cuenta commits, cambios sucios y untracked; cachea 5 s', async () => {
    let now = 1_000
    service = new WorktreeService({ registry: store, root: join(tmp, 'worktrees'), issue: fetchIssue, now: () => now })
    const ws = await service.create(projectId, { name: 'feat' })
    expect(await service.status(ws.id)).toEqual({ branch: 'omni/feat', base: 'main', dirty: false, stat: { files: 0, additions: 0, deletions: 0 }, tests: null })

    commitFile(ws.path, 'a.ts', 'one\ntwo\n', 'add a')
    writeFileSync(join(ws.path, 'README.md'), '# demo\nmore\n')
    writeFileSync(join(ws.path, 'new.txt'), 'x\ny\nz\n')
    // Dentro de los 5 s sigue la foto vieja.
    expect((await service.status(ws.id)).stat.files).toBe(0)
    now += 6_000
    const status = await service.status(ws.id)
    expect(status.dirty).toBe(true)
    expect(status.stat).toEqual({ files: 3, additions: 6, deletions: 0 })
    // La base avanza en el local: el merge-base sigue siendo el punto de partida del worktree.
    commitFile(repo, 'local.txt', 'l\n', 'local work')
    expect((await service.status(ws.id, true)).stat.files).toBe(3)
  })

  it('remove borra carpeta, rama y registro; el local no se toca', async () => {
    const ws = await service.create(projectId, { name: 'feat' })
    writeFileSync(join(ws.path, 'dirty.txt'), 'x')
    await service.remove(ws.id)
    expect(existsSync(ws.path)).toBe(false)
    expect(git(repo, 'branch', '--list', 'omni/feat').trim()).toBe('')
    expect(git(repo, 'worktree', 'list').split('\n').filter((l) => l !== '')).toHaveLength(1)
    expect(store.worktree(ws.id)).toBeUndefined()
    expect(changed).toEqual([ws.id, ws.id])
    await expect(service.status(ws.id)).rejects.toThrow(/no es un worktree/)
    await expect(service.remove(projectId)).rejects.toThrow(/no es un worktree/)
  })

  it('remove con un path fuera de la raíz: no toca el disco, olvida el registro y tira', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'omni-outside-'))
    writeFileSync(join(outside, 'valioso.txt'), 'x')
    try {
      store.addWorktree({ id: 'evil', projectId, locationId: projectId, name: 'evil', branch: 'omni/evil', base: 'main', path: outside, createdAt: 0 })
      await expect(service.remove('evil')).rejects.toThrow('ruta fuera de la carpeta de worktrees')
      expect(existsSync(join(outside, 'valioso.txt'))).toBe(true)
      expect(store.worktree('evil')).toBeUndefined()
      expect(changed).toEqual(['evil'])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('con locationId sale del repo de esa ubicación y la guarda; una ubicación remota sin conexión se rechaza', async () => {
    const other = initRepo()
    try {
      commitFile(other, 'other.txt', 'x\n', 'other')
      git(other, 'checkout', '-q', '-b', 'dev')
      const located = new ProjectStore(join(tmp, 'located.json'), undefined, tmpdir())
      const id = located.add(repo).id
      const api = located.addLocation(id, { path: other, name: 'api' })
      const vps = located.addLocation(id, { path: '/srv/app', host: 'vps' })
      const svc = new WorktreeService({ registry: located, root: join(tmp, 'worktrees'), issue: fetchIssue })
      const ws = await svc.create(id, { name: 'feat', locationId: api.id })
      expect(located.worktree(ws.id)).toMatchObject({ locationId: api.id, base: 'dev' })
      expect(existsSync(join(ws.path, 'other.txt'))).toBe(true)
      expect(git(other, 'branch', '--list', 'omni/feat').trim()).toContain('omni/feat')
      expect(git(repo, 'branch', '--list', 'omni/feat').trim()).toBe('')
      await expect(svc.create(id, { name: 'remoto', locationId: vps.id })).rejects.toThrow('los worktrees remotos necesitan la conexión con el servidor')
      await expect(svc.create(id, { name: 'x', locationId: 'nope' })).rejects.toThrow(/ubicación desconocida/)
      // Sin locationId, la primera ubicación (el orden lo decide el usuario).
      expect(located.worktree((await svc.create(id, { name: 'main-wt' })).id)?.locationId).toBe(id)
      located.moveLocation(api.id, -1)
      expect(located.worktree((await svc.create(id, { name: 'first-wt' })).id)?.locationId).toBe(api.id)
      // Un proyecto sin carpetas no tiene de dónde sacar un worktree.
      const empty = located.create('Vacío').id
      await expect(svc.create(empty, { name: 'x' })).rejects.toThrow('Vacío no tiene carpetas: agrega una ubicación')
      await svc.remove(ws.id)
      expect(git(other, 'branch', '--list', 'omni/feat').trim()).toBe('')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('removeProjectWorktrees: borra los limpios, conserva en disco los que tienen cambios y devuelve sus rutas', async () => {
    const clean = await service.create(projectId, { name: 'clean' })
    const dirty = await service.create(projectId, { name: 'dirty' })
    const committed = await service.create(projectId, { name: 'committed' })
    writeFileSync(join(dirty.path, 'wip.txt'), 'x')
    commitFile(committed.path, 'done.txt', 'y\n', 'work')
    const kept = await service.removeProjectWorktrees(projectId)
    expect(kept.sort()).toEqual([committed.path, dirty.path].sort())
    expect(existsSync(clean.path)).toBe(false)
    expect(existsSync(join(dirty.path, 'wip.txt'))).toBe(true)
    expect(existsSync(join(committed.path, 'done.txt'))).toBe(true)
    expect(store.worktreesOf(projectId)).toEqual([])
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'omni/*').trim().split('\n').sort()).toEqual(['omni/committed', 'omni/dirty'])
  })

  it('tests que se pasan del tope: muere todo el grupo (también el nieto) y queda como fail con aviso', async () => {
    service = new WorktreeService({ registry: store, root: join(tmp, 'worktrees'), issue: fetchIssue, testsTimeoutMs: 400 })
    const ws = await service.create(projectId, { name: 'feat' })
    const pidFile = join(tmp, 'grandchild.pid')
    store.setTestCommand(projectId, `sh -c 'sleep 30' & echo $! > '${pidFile}'; echo arrancó; wait`)
    const started = Date.now()
    await service.runTests(ws.id)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(service.testsOf(ws.id)).toMatchObject({ status: 'fail', summary: 'tests cancelados a los 0 s' })
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(pid).toBeGreaterThan(0)
    // El nieto (`sleep`) ya no existe: `kill -0` falla con ESRCH.
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3_000 })
  })

  it('runTests: pass con la última línea como resumen, fail con código; nunca dos a la vez', async () => {
    const ws = await service.create(projectId, { name: 'feat' })
    expect(() => service.runTests(ws.id)).toThrow('el proyecto no tiene comando de tests')
    store.setTestCommand(projectId, "echo 'hola'; echo '  12 passed  '; echo")
    changed.length = 0
    const first = service.runTests(ws.id)
    expect(service.runTests(ws.id)).toBe(first)
    expect(service.testsOf(ws.id)?.status).toBe('running')
    await first
    expect(service.testsOf(ws.id)).toMatchObject({ status: 'pass', summary: '12 passed' })
    expect((await service.status(ws.id)).tests?.status).toBe('pass')
    expect(changed).toEqual([ws.id, ws.id])

    store.setTestCommand(projectId, 'echo boom >&2; exit 3')
    await service.runTests(ws.id)
    expect(service.testsOf(ws.id)).toMatchObject({ status: 'fail', summary: 'boom' })

    store.setTestCommand(projectId, 'exit 1')
    await service.runTests(ws.id)
    expect(service.testsOf(ws.id)).toMatchObject({ status: 'fail', summary: 'código 1' })
  })

  it('cleanupIfEmpty borra solo si no hay cambios respecto a la base', async () => {
    const ws = await service.create(projectId, { name: 'feat' })
    writeFileSync(join(ws.path, 'wip.txt'), 'x')
    expect(await service.cleanupIfEmpty(ws.id)).toBe(false)
    expect(store.worktree(ws.id)).toBeDefined()
    rmSync(join(ws.path, 'wip.txt'))
    commitFile(ws.path, 'done.txt', 'y\n', 'work')
    expect(await service.cleanupIfEmpty(ws.id)).toBe(false)
    git(ws.path, 'reset', '-q', '--hard', 'main')
    expect(await service.cleanupIfEmpty(ws.id)).toBe(true)
    expect(store.worktree(ws.id)).toBeUndefined()
    expect(existsSync(ws.path)).toBe(false)
    expect(await service.cleanupIfEmpty(ws.id)).toBe(false)
  })
})


// El "servidor" es este Mac por el ssh falso: lo remoto corre de verdad por `ssh … -- sh -c`.
describe('WorktreeService en un servidor (§3.26)', { timeout: 60_000 }, () => {
  const FAKE_SSH = resolve(__dirname, '../../../e2e/fake-ssh/ssh')
  const saved = { ...process.env }
  let home: string
  afterEach(() => {
    process.env = { ...saved }
    rmSync(home, { recursive: true, force: true })
  })

  it('crea el worktree en ~/.omni/worktrees del host, mide su estado, corre los tests allá y lo borra', async () => {
    home = realpathSync(mkdtempSync('/tmp/omni-wtr-'))
    process.env.FAKE_SSH_HOME = home
    process.env.FAKE_SSH_REMOTE_SHELL = '/bin/sh'
    const repo = join(home, 'srv', 'app')
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'uno\n')
    git(repo, 'add', '.')
    git(repo, '-c', 'user.email=e2e@omni', '-c', 'user.name=e2e', 'commit', '-qm', 'init')
    const store = new ProjectStore(join(home, 'projects.json'), join(home, 'local-wt'), home)
    const project = store.create('App')
    const location = store.addLocation(project.id, { path: repo, host: 'vps' })
    store.setTestCommand(project.id, 'echo remoto-ok')
    const ssh = new SshHost({ id: 'vps', name: 'vps', target: 'vps' }, { sshBin: FAKE_SSH, controlDir: join(home, '.ctl') })
    const svc = new WorktreeService({ registry: store, hosts: { ensure: async () => ssh } })

    const ws = await svc.create(project.id, { name: 'remota', locationId: location.id })
    expect(ws.path).toBe(join(home, '.omni', 'worktrees', projectFolder(project), 'remota'))
    expect(existsSync(join(ws.path, 'a.txt'))).toBe(true)
    expect(store.workspace(ws.id)?.host).toBe('vps')

    writeFileSync(join(ws.path, 'b.txt'), 'dos\ntres\n')
    const status = await svc.status(ws.id, true)
    expect(status).toMatchObject({ dirty: true, stat: { files: 1, additions: 2 } })

    await svc.runTests(ws.id)
    expect(svc.testsOf(ws.id)).toMatchObject({ status: 'pass', summary: 'remoto-ok' })

    await svc.remove(ws.id)
    expect(existsSync(ws.path)).toBe(false)
    expect(git(repo, 'branch', '--list', 'omni/remota').trim()).toBe('')
    expect(store.worktree(ws.id)).toBeUndefined()
  })
})
