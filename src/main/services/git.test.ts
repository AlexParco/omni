import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BranchCache, GitService, isMissingInRef, parseHunkHeader, parseUnifiedDiff, truncateDiff, untrackedAsDiff, type Runner } from './git'
import { commitFile, git, initRepo } from './git-fixture'
import { ProjectStore } from './projects'
import { WorktreeService } from './worktrees'

describe('BranchCache', () => {
  it('pide la rama con git -C y la cachea 10 s por ruta', async () => {
    let now = 0
    const run = vi.fn<Runner>(async () => 'main\n')
    const cache = new BranchCache(run, () => now)
    expect(await cache.branch('/w/a')).toBe('main')
    expect(run).toHaveBeenCalledWith('git', ['-C', '/w/a', 'rev-parse', '--abbrev-ref', 'HEAD'], 2_000)
    now += 9_000
    expect(await cache.branch('/w/a')).toBe('main')
    expect(run).toHaveBeenCalledTimes(1)
    now += 2_000
    expect(await cache.branch('/w/a')).toBe('main')
    expect(run).toHaveBeenCalledTimes(2)
    await cache.branch('/w/b')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('HEAD suelto (git responde "HEAD") → null', async () => {
    const run = vi.fn<Runner>(async () => 'HEAD\n')
    expect(await new BranchCache(run).branch('/w/a')).toBeNull()
  })

  it('si git falla o no responde nada → null, y también se cachea', async () => {
    let now = 0
    const run = vi.fn<Runner>(async () => {
      throw new Error('not a git repository')
    })
    const cache = new BranchCache(run, () => now)
    expect(await cache.branch('/w/a')).toBeNull()
    expect(await cache.branch('/w/a')).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
    now += 11_000
    run.mockResolvedValueOnce('')
    expect(await cache.branch('/w/a')).toBeNull()
  })
})

describe('parseUnifiedDiff', () => {
  it('modificado con dos hunks: numeración, contexto, signos y totales', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' one',
      '-two',
      '+dos',
      '+dos y medio',
      ' three',
      '@@ -10,2 +11,2 @@ function foo() {',
      '-old',
      '+new',
      ' end',
      '\\ No newline at end of file',
      ''
    ].join('\n')
    const [file] = parseUnifiedDiff(text)
    expect(file).toMatchObject({ path: 'src/a.ts', status: 'M', additions: 3, deletions: 2, binary: false })
    expect(file?.hunks.map((h) => h.header)).toEqual(['@@ -1,3 +1,4 @@', '@@ -10,2 +11,2 @@ function foo() {'])
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: 'ctx', old: 1, new: 1, text: 'one' },
      { kind: 'del', old: 2, new: null, text: 'two' },
      { kind: 'add', old: null, new: 2, text: 'dos' },
      { kind: 'add', old: null, new: 3, text: 'dos y medio' },
      { kind: 'ctx', old: 3, new: 4, text: 'three' }
    ])
    expect(file?.hunks[1]?.lines).toEqual([
      { kind: 'del', old: 10, new: null, text: 'old' },
      { kind: 'add', old: null, new: 11, text: 'new' },
      { kind: 'ctx', old: 11, new: 12, text: 'end' }
    ])
  })

  it('añadido, borrado, renombrado y binario; `---` dentro de un hunk no es cabecera', () => {
    const text = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+---',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
      'diff --git a/old name.ts b/new name.ts',
      'similarity index 90%',
      'rename from old name.ts',
      'rename to new name.ts',
      '--- a/old name.ts',
      '+++ b/new name.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/img.png b/img.png',
      'index 1111111..2222222 100644',
      'Binary files a/img.png and b/img.png differ',
      ''
    ].join('\n')
    const files = parseUnifiedDiff(text)
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary, f.hunks.length])).toEqual([
      ['new.txt', 'A', 1, 0, false, 1],
      ['gone.txt', 'D', 0, 2, false, 1],
      ['new name.ts', 'R', 1, 1, false, 1],
      ['img.png', 'M', 0, 0, true, 0]
    ])
    expect(files[0]?.hunks[0]?.lines).toEqual([{ kind: 'add', old: null, new: 1, text: '---' }])
  })

  it('parseHunkHeader y truncateDiff', () => {
    expect(parseHunkHeader('@@ -3 +4,0 @@')).toEqual({ oldStart: 3, oldCount: 1, newStart: 4, newCount: 0 })
    expect(parseHunkHeader('@@ nope')).toBeNull()
    const two = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-x\n+y\n'
    expect(truncateDiff(two)).toEqual({ text: two, truncated: false })
    const cut = truncateDiff(two, 60)
    expect(cut.truncated).toBe(true)
    expect(parseUnifiedDiff(cut.text).map((f) => f.path)).toEqual(['a'])
    expect(parseUnifiedDiff('')).toEqual([])
  })

  it('truncateDiff cuenta bytes, no caracteres: con acentos el corte llega antes', () => {
    const first = 'diff --git a/ñ b/ñ\n--- a/ñ\n+++ b/ñ\n@@ -1 +1 @@\n-áé\n+íó\n'
    const second = 'diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-x\n+y\n'
    const two = first + second
    const max = two.length
    expect(Buffer.byteLength(two)).toBeGreaterThan(max)
    const cut = truncateDiff(two, max)
    expect(cut.truncated).toBe(true)
    expect(cut.text).toBe(first)
    expect(parseUnifiedDiff(cut.text).map((f) => f.path)).toEqual(['ñ'])
    expect(truncateDiff(two, Buffer.byteLength(two))).toEqual({ text: two, truncated: false })
  })

  it('untrackedAsDiff: texto como un hunk de añadidos, binario sin hunks', () => {
    expect(untrackedAsDiff('n.txt', Buffer.from('a\nb\n'))).toEqual({
      path: 'n.txt',
      status: 'A',
      additions: 2,
      deletions: 0,
      binary: false,
      hunks: [{ header: '@@ -0,0 +1,2 @@', lines: [{ kind: 'add', old: null, new: 1, text: 'a' }, { kind: 'add', old: null, new: 2, text: 'b' }] }]
    })
    expect(untrackedAsDiff('b.bin', Buffer.from([0, 1, 2]))).toMatchObject({ binary: true, hunks: [], additions: 0 })
  })
})

// Repos git reales: con la máquina cargada, 5 s se quedan cortos.
describe('GitService', { timeout: 30_000 }, () => {
  let tmp: string
  let repo: string
  let store: ProjectStore
  let projectId: string
  let worktrees: WorktreeService
  let service: GitService

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'omni-git-'))
    repo = initRepo()
    store = new ProjectStore(join(tmp, 'projects.json'))
    projectId = store.add(repo).id
    worktrees = new WorktreeService({ registry: store, root: join(tmp, 'worktrees') })
    service = new GitService({ registry: store, removeWorktree: (id) => worktrees.remove(id) })
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('diff: commits, árbol sucio y untracked (texto y binario) contra el merge-base', async () => {
    const ws = await worktrees.create(projectId, { name: 'feat' })
    commitFile(ws.path, 'a.ts', 'one\ntwo\n', 'add a')
    writeFileSync(join(ws.path, 'README.md'), '# demo\nmore\n')
    writeFileSync(join(ws.path, 'new.txt'), 'x\ny\n')
    writeFileSync(join(ws.path, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    // El local avanza: el diff del worktree no debe incluir eso.
    commitFile(repo, 'local.txt', 'l\n', 'local work')
    const diff = await service.diff(ws.id)
    expect(diff).toMatchObject({ base: 'main', branch: 'omni/feat', truncated: false })
    expect(diff.files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary])).toEqual([
      ['README.md', 'M', 1, 0, false],
      ['a.ts', 'A', 2, 0, false],
      ['blob.bin', 'A', 0, 0, true],
      ['new.txt', 'A', 2, 0, false]
    ])
    expect(diff.files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'ctx', old: 1, new: 1, text: '# demo' },
      { kind: 'add', old: null, new: 2, text: 'more' }
    ])
    await expect(service.diff(projectId)).rejects.toThrow(/no es un worktree/)
  })

  it('diff con base explícita: directo contra la rama de otro worktree (no merge-base); ref inexistente → error humano', async () => {
    const a = await worktrees.create(projectId, { name: 'cc-1' })
    const b = await worktrees.create(projectId, { name: 'cx-1' })
    commitFile(a.path, 'shared.ts', 'a\n', 'a work')
    commitFile(a.path, 'only-a.ts', 'a\n', 'a only')
    commitFile(b.path, 'shared.ts', 'b\n', 'b work')
    writeFileSync(join(b.path, 'only-b.ts'), 'x\n')
    const diff = await service.diff(b.id, 'omni/cc-1')
    expect(diff).toMatchObject({ base: 'omni/cc-1', branch: 'omni/cx-1', truncated: false })
    // Lo que b tiene distinto de a: shared.ts cambia de 'a' a 'b' (M 1/1), only-a.ts no está en b (D) y only-b.ts es untracked (A).
    expect(diff.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['only-a.ts', 'D', 0, 1],
      ['shared.ts', 'M', 1, 1],
      ['only-b.ts', 'A', 1, 0]
    ])
    expect(diff.files[1]?.hunks[0]?.lines).toEqual([
      { kind: 'del', old: 1, new: null, text: 'a' },
      { kind: 'add', old: null, new: 1, text: 'b' }
    ])
    // Sin `base` (o vacía) sigue siendo contra la base del worktree.
    expect((await service.diff(b.id, '  ')).base).toBe('main')
    await expect(service.diff(b.id, 'omni/nope')).rejects.toThrow('no existe la rama omni/nope')
    // Una ref que empieza por `-` sería una opción para git: ni se consulta.
    await expect(service.diff(b.id, '--output=/tmp/x')).rejects.toThrow('rama inválida: --output=/tmp/x')
  })

  it('merge limpio: commitea el wip, squash en el local y deja el worktree para que lo borre quien llama', async () => {
    const ws = await worktrees.create(projectId, { name: 'feat' })
    commitFile(ws.path, 'a.ts', 'one\n', 'add a')
    writeFileSync(join(ws.path, 'b.ts'), 'two\n')
    // Un untracked en el local no bloquea el merge.
    writeFileSync(join(repo, 'notas.txt'), 'x')
    const { commit } = await service.merge(ws.id)
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(commit)
    expect(git(repo, 'log', '--format=%s', '-n', '2').trim().split('\n')).toEqual(['feat (omni)', 'init'])
    expect(existsSync(join(repo, 'a.ts'))).toBe(true)
    expect(existsSync(join(repo, 'b.ts'))).toBe(true)
    expect(git(repo, 'status', '--porcelain').trim()).toBe('?? notas.txt')
    expect(store.worktree(ws.id)).toBeDefined()
    expect(existsSync(ws.path)).toBe(true)
    await worktrees.remove(ws.id)
    expect(git(repo, 'branch', '--list', 'omni/feat').trim()).toBe('')
  })

  it('merge con el local sucio (lista los archivos), sin cambios o en otra rama: error humano y nada se toca', async () => {
    const ws = await worktrees.create(projectId, { name: 'feat' })
    await expect(service.merge(ws.id)).rejects.toThrow('el worktree no tiene cambios respecto a main')
    commitFile(ws.path, 'a.ts', 'one\n', 'add a')
    writeFileSync(join(repo, 'README.md'), 'dirty\n')
    await expect(service.merge(ws.id)).rejects.toThrow('el repo tiene cambios sin commit: README.md')
    expect(store.worktree(ws.id)).toBeDefined()
    git(repo, 'checkout', '-q', '--', 'README.md')
    git(repo, 'checkout', '-q', '-b', 'other')
    await expect(service.merge(ws.id)).rejects.toThrow('el repo está en other, no en main')
    git(repo, 'checkout', '-q', '--detach')
    await expect(service.merge(ws.id)).rejects.toThrow('el repo está en HEAD suelto')
  })

  it('merge con base feature/x: solo desde esa rama', async () => {
    git(repo, 'checkout', '-q', '-b', 'feature/x')
    const ws = await worktrees.create(projectId, { name: 'feat' })
    expect(store.worktree(ws.id)?.base).toBe('feature/x')
    commitFile(ws.path, 'a.ts', 'one\n', 'add a')
    git(repo, 'checkout', '-q', 'main')
    await expect(service.merge(ws.id)).rejects.toThrow('el repo está en main, no en feature/x')
    git(repo, 'checkout', '-q', 'feature/x')
    await service.merge(ws.id)
    expect(git(repo, 'log', '--format=%s', '-n', '1').trim()).toBe('feat (omni)')
    expect(git(repo, 'rev-parse', 'main').trim()).not.toBe(git(repo, 'rev-parse', 'feature/x').trim())
  })

  it('merge con base remota (origin/main): HEAD tiene que seguir a esa rama', async () => {
    const origin = mkdtempSync(join(tmpdir(), 'omni-origin-'))
    try {
      git(origin, 'init', '-q', '--bare', '-b', 'main')
      git(repo, 'remote', 'add', 'origin', origin)
      git(repo, 'push', '-q', '-u', 'origin', 'main')
      git(repo, 'remote', 'set-head', 'origin', 'main')
      git(repo, 'checkout', '-q', '--detach')
      const ws = await worktrees.create(projectId, { name: 'feat' })
      expect(store.worktree(ws.id)?.base).toBe('origin/main')
      commitFile(ws.path, 'a.ts', 'one\n', 'add a')
      await expect(service.merge(ws.id)).rejects.toThrow('el repo está en HEAD suelto')
      git(repo, 'checkout', '-q', '-b', 'suelta')
      await expect(service.merge(ws.id)).rejects.toThrow('el repo está en suelta, que no sigue a origin/main')
      git(repo, 'checkout', '-q', 'main')
      await service.merge(ws.id)
      expect(git(repo, 'log', '--format=%s', '-n', '1').trim()).toBe('feat (omni)')
    } finally {
      rmSync(origin, { recursive: true, force: true })
    }
  })

  it('si el commit del squash falla (hook), se deshace y el error lo explica', async () => {
    const ws = await worktrees.create(projectId, { name: 'feat' })
    commitFile(ws.path, 'a.ts', 'one\n', 'add a')
    const hook = join(git(repo, 'config', 'core.hooksPath').trim(), 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "nada de commits" >&2\nexit 1\n', { mode: 0o755 })
    await expect(service.merge(ws.id)).rejects.toThrow('commit falló: nada de commits')
    expect(git(repo, 'status', '--porcelain', '--untracked-files=no').trim()).toBe('')
    expect(existsSync(join(repo, 'a.ts'))).toBe(false)
    expect(git(repo, 'log', '--format=%s', '-n', '1').trim()).toBe('init')
    expect(store.worktree(ws.id)).toBeDefined()
  })

  it('merge con conflicto: se aborta, el local queda limpio y el error lista los archivos', async () => {
    const ws = await worktrees.create(projectId, { name: 'feat' })
    commitFile(ws.path, 'README.md', '# worktree\n', 'wt change')
    commitFile(repo, 'README.md', '# local\n', 'local change')
    await expect(service.merge(ws.id)).rejects.toThrow('conflicto en README.md')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('')
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# local\n')
    expect(store.worktree(ws.id)).toBeDefined()
    expect(existsSync(ws.path)).toBe(true)
  })

  it('discard borra el worktree con sus cambios', async () => {
    const ws = await worktrees.create(projectId, { name: 'feat' })
    writeFileSync(join(ws.path, 'wip.txt'), 'x')
    await service.discard(ws.id)
    expect(existsSync(ws.path)).toBe(false)
    expect(store.worktree(ws.id)).toBeUndefined()
    expect(git(repo, 'branch', '--list', 'omni/feat').trim()).toBe('')
    await expect(service.discard(ws.id)).rejects.toThrow(/no es un worktree/)
  })
})

describe('isMissingInRef', () => {
  it('reconoce los dos mensajes de git para "no está en esa ref"', () => {
    expect(isMissingInRef("fatal: path 'a.ts' exists on disk, but not in 'HEAD'")).toBe(true)
    expect(isMissingInRef("fatal: path 'a.ts' does not exist in 'HEAD'")).toBe(true)
    expect(isMissingInRef('fatal: not a git repository')).toBe(false)
  })
})

// Cada caso crea repos y worktrees reales: con la máquina cargada, 5 s no alcanzan.
describe('GitService.fileAtBase', { timeout: 30_000 }, () => {
  let tmp: string
  let repo: string
  let store: ProjectStore
  let projectId: string
  let worktrees: WorktreeService
  let service: GitService

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'omni-git-base-'))
    repo = initRepo()
    store = new ProjectStore(join(tmp, 'projects.json'))
    projectId = store.add(repo).id
    worktrees = new WorktreeService({ registry: store, root: join(tmp, 'worktrees') })
    service = new GitService({ registry: store, removeWorktree: (id) => worktrees.remove(id) })
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('local: HEAD aunque el árbol esté sucio; null si el archivo es nuevo; error fuera del workspace', async () => {
    mkdirSync(join(repo, 'src'))
    commitFile(repo, 'src/a.ts', 'base\n', 'add a')
    writeFileSync(join(repo, 'src', 'a.ts'), 'dirty\n')
    expect(await service.fileAtBase(projectId, join(repo, 'src', 'a.ts'))).toBe('base\n')
    writeFileSync(join(repo, 'new.ts'), 'x\n')
    expect(await service.fileAtBase(projectId, join(repo, 'new.ts'))).toBeNull()
    await expect(service.fileAtBase(projectId, join(tmp, 'projects.json'))).rejects.toThrow(/fuera del workspace/)
    await expect(service.fileAtBase('nope', join(repo, 'src', 'a.ts'))).rejects.toThrow(/workspace desconocido/)
  })

  it('worktree: el merge-base con la base, no el HEAD del worktree ni el de la base avanzada', async () => {
    commitFile(repo, 'a.ts', 'base\n', 'add a')
    const ws = await worktrees.create(projectId, { name: 'feat' })
    commitFile(ws.path, 'a.ts', 'feat\n', 'change a in feat')
    commitFile(repo, 'a.ts', 'main moved\n', 'change a in main')
    expect(await service.fileAtBase(ws.id, join(ws.path, 'a.ts'))).toBe('base\n')
    commitFile(ws.path, 'only-feat.ts', 'x\n', 'add only-feat')
    expect(await service.fileAtBase(ws.id, join(ws.path, 'only-feat.ts'))).toBeNull()
  })

  it('una ubicación que no es la principal (subcarpeta del repo) también: HEAD relativo a su carpeta', async () => {
    mkdirSync(join(repo, 'web'))
    commitFile(repo, 'web/a.ts', 'base\n', 'add web')
    writeFileSync(join(repo, 'web', 'a.ts'), 'dirty\n')
    // Home = tmpdir: el repo temporal tiene que pasar la validación de ubicación local.
    const store2 = new ProjectStore(join(tmp, 'projects2.json'), join(tmp, 'worktrees'), tmpdir())
    const id = store2.add(repo).id
    const web = store2.addFolder(id, 'web')
    expect(web.kind).toBe('folder')
    const svc = new GitService({ registry: store2, removeWorktree: async () => undefined })
    expect(await svc.fileAtBase(web.id, join(repo, 'web', 'a.ts'))).toBe('base\n')
    await expect(svc.fileAtBase(web.id, join(repo, 'README.md'))).rejects.toThrow(/fuera del workspace/)
  })

  it('una carpeta que no es repo da error humano', async () => {
    const plain = join(tmp, 'plain')
    mkdirSync(plain)
    writeFileSync(join(plain, 'a.ts'), 'x')
    const id = store.add(plain).id
    await expect(service.fileAtBase(id, join(plain, 'a.ts'))).rejects.toThrow(/no es un repo git/)
  })
})
