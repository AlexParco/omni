import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Worktree } from '@shared/types'
import { ProjectStore, expandHome, listFolderCandidates, normalizeFolderRel, sanitizePersisted, suggestProjectPaths, validateProjectPath } from './projects'

const ROOT = '/wt'

const wt: Worktree = { id: 'w1', projectId: 'p1', locationId: 'p1', name: 'rate-limit', branch: 'omni/rate-limit', base: 'main', path: '/wt/rate-limit', createdAt: 5 }

describe('sanitizePersisted', () => {
  it('conserva proyectos y worktrees con forma; descarta worktrees huérfanos o rotos', () => {
    const raw = {
      projects: [{ id: 'p1', name: 'demo', path: '/demo', testCommand: 'pnpm test' }, { id: 'p2', path: '/otro' }, { id: '', path: '/x' }, 'basura'],
      worktrees: [wt, { ...wt, id: 'w2', projectId: 'nope' }, { id: 'w3', projectId: 'p1' }, { ...wt, id: 'w4', issue: { number: 4, title: 't', url: 'u' } }]
    }
    expect(sanitizePersisted(raw, ROOT)).toEqual({
      projects: [
        { id: 'p1', name: 'demo', locations: [{ id: 'p1', name: 'demo', path: '/demo' }], testCommand: 'pnpm test' },
        { id: 'p2', name: 'otro', locations: [{ id: 'p2', name: 'otro', path: '/otro' }] }
      ],
      worktrees: [wt, { ...wt, id: 'w4', issue: { number: 4, title: 't', url: 'u' } }]
    })
  })

  it('un worktree fuera de la raíz (o la raíz misma) se descarta: nunca se borra lo que no es nuestro', () => {
    const raw = { projects: [{ id: 'p1', path: '/demo' }], worktrees: [wt, { ...wt, id: 'w2', path: '/Users/yo/proyecto' }, { ...wt, id: 'w3', path: '/wt/../etc' }, { ...wt, id: 'w4', path: '/wt' }, { ...wt, id: 'w5', path: '/wtx/otro' }] }
    expect(sanitizePersisted(raw, ROOT).worktrees.map((w) => w.id)).toEqual(['w1'])
  })

  it('lo que no tiene forma es vacío', () => {
    expect(sanitizePersisted(null)).toEqual({ projects: [], worktrees: [] })
    expect(sanitizePersisted({ projects: 'x' })).toEqual({ projects: [], worktrees: [] })
  })
})

describe('ProjectStore', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-projects-'))
    file = join(dir, 'projects.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('persiste worktrees y testCommand; los workspaces son el local más uno por worktree', () => {
    const store = new ProjectStore(file, ROOT, dir)
    const project = store.add('/demo/')
    expect(project.locations).toEqual([{ id: project.id, name: 'demo', path: '/demo' }])
    expect(store.add('/demo')).toBe(project)
    store.setTestCommand(project.id, '  pnpm test ')
    store.addWorktree({ ...wt, projectId: project.id, locationId: project.id })
    expect(store.workspaces()).toEqual([
      { id: project.id, projectId: project.id, name: 'demo', path: '/demo', kind: 'local' },
      { id: 'w1', projectId: project.id, name: 'rate-limit', path: '/wt/rate-limit', kind: 'worktree', locationId: project.id }
    ])
    expect(store.workspace('w1')?.kind).toBe('worktree')
    expect(store.worktreesOf(project.id)).toHaveLength(1)

    const reloaded = new ProjectStore(file, ROOT)
    expect(reloaded.project(project.id)?.testCommand).toBe('pnpm test')
    expect(reloaded.worktree('w1')).toEqual({ ...wt, projectId: project.id, locationId: project.id })
    expect(() => readFileSync(`${file}.tmp`)).toThrow()

    reloaded.setTestCommand(project.id, '')
    expect(new ProjectStore(file, ROOT).project(project.id)?.testCommand).toBeUndefined()
    reloaded.removeWorktree('w1')
    expect(new ProjectStore(file, ROOT).workspaces()).toHaveLength(1)
    // Con otra raíz, el worktree guardado no se carga.
    const again = new ProjectStore(file, ROOT)
    again.addWorktree({ ...wt, projectId: project.id, locationId: project.id })
    expect(new ProjectStore(file, '/otra').worktree('w1')).toBeUndefined()
  })

  it('quitar el proyecto se lleva sus worktrees; añadir uno a un proyecto desconocido tira', () => {
    const store = new ProjectStore(file, ROOT, dir)
    const project = store.add('/demo')
    store.addWorktree({ ...wt, projectId: project.id, locationId: project.id })
    expect(() => store.addWorktree({ ...wt, id: 'w9', projectId: 'nope' })).toThrow(/proyecto desconocido/)
    expect(() => store.addWorktree({ ...wt, projectId: project.id, locationId: project.id })).toThrow(/repetido/)
    store.remove(project.id)
    expect(store.workspaces()).toEqual([])
    expect(new ProjectStore(file, ROOT).worktree('w1')).toBeUndefined()
  })

  it('validateProjectPath: resuelve y quita la barra final; rechaza lo que no existe, archivos y rutas fuera del home', () => {
    const home = join(dir, 'home')
    const project = join(home, 'proyecto')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(home, 'archivo.txt'), 'x')
    expect(validateProjectPath(`${project}/`, home)).toBe(project)
    expect(validateProjectPath(`${project}/../proyecto`, home)).toBe(project)
    expect(validateProjectPath(home, home)).toBe(resolve(home))
    expect(() => validateProjectPath('', home)).toThrow('falta la ruta del proyecto')
    expect(() => validateProjectPath(join(home, 'nope'), home)).toThrow(/no existe la carpeta/)
    expect(() => validateProjectPath(join(home, 'archivo.txt'), home)).toThrow(/no es una carpeta/)
    expect(() => validateProjectPath(dir, home)).toThrow(/fuera de tu carpeta de usuario/)
    expect(() => validateProjectPath('/', home)).toThrow(/fuera de tu carpeta de usuario/)
    // `~` se expande; una ruta absoluta pegada sobre el `~/` del campo vale como absoluta.
    expect(validateProjectPath('~/proyecto', home)).toBe(project)
    expect(validateProjectPath('~', home)).toBe(resolve(home))
    expect(validateProjectPath(`~/${project}`, home)).toBe(project)
  })

  it('expandHome: ~, ~/x, ~//abs y rutas sin ~', () => {
    expect(expandHome('~', '/home/ana')).toBe('/home/ana')
    expect(expandHome(' ~/api ', '/home/ana')).toBe('/home/ana/api')
    expect(expandHome('~//srv/app', '/home/ana')).toBe('/srv/app')
    expect(expandHome('/srv/app', '/home/ana')).toBe('/srv/app')
    expect(expandHome('~ana/x', '/home/ana')).toBe('~ana/x')
  })

  it('un archivo viejo sin worktrees se lee igual', () => {
    writeFileSync(file, JSON.stringify({ projects: [{ id: 'p1', name: 'demo', path: '/demo' }] }))
    const store = new ProjectStore(file)
    expect(store.list()).toEqual([{ id: 'p1', name: 'demo', locations: [{ id: 'p1', name: 'demo', path: '/demo' }] }])
    expect(store.workspaces()).toHaveLength(1)
  })

  it('carpetas: se registran como workspaces `folder` relativos a la raíz, persisten y se olvidan', () => {
    const root = join(dir, 'mono')
    mkdirSync(join(root, 'apps', 'web'), { recursive: true })
    mkdirSync(join(root, 'api'))
    writeFileSync(join(root, 'README.md'), 'x')
    const store = new ProjectStore(file, ROOT, dir)
    const project = store.add(root)
    const web = store.addFolder(project.id, 'apps/web/')
    expect(web).toEqual({ id: web.id, projectId: project.id, name: 'web', path: join(root, 'apps/web'), kind: 'folder' })
    expect(store.addFolder(project.id, './apps/web')).toEqual(web)
    store.addFolder(project.id, 'api')
    // Con varias ubicaciones todas son `folder`, también la primera.
    expect(store.workspaces().map((w) => [w.kind, w.name])).toEqual([['folder', 'mono'], ['folder', 'web'], ['folder', 'api']])
    expect(() => store.addFolder(project.id, '../fuera')).toThrow(/no válida/)
    expect(() => store.addFolder(project.id, '/etc')).toThrow(/no válida/)
    expect(() => store.addFolder(project.id, 'nope')).toThrow(/no existe la carpeta/)
    expect(() => store.addFolder(project.id, 'README.md')).toThrow(/no es una carpeta/)
    expect(() => store.addFolder('nope', 'api')).toThrow(/ubicación desconocida/)
    // La subcarpeta sale de la ubicación pedida, no de la primera: `apps/web` → `apps/web/src`.
    mkdirSync(join(root, 'apps/web/src'))
    const src = store.addFolder(web.id, 'src')
    expect(src.path).toBe(join(root, 'apps/web/src'))
    expect(store.folderCandidates(web.id).map((c) => c.rel)).not.toContain('src')

    const reloaded = new ProjectStore(file, ROOT)
    expect(reloaded.workspace(web.id)?.path).toBe(join(root, 'apps/web'))
    reloaded.removeFolder(web.id)
    expect(new ProjectStore(file, ROOT).workspaces().filter((w) => w.kind === 'folder').map((w) => w.name)).toEqual(['mono', 'api', 'src'])
  })

  it('ocultar: se persiste como `hidden: true` y mostrar lo quita', () => {
    const store = new ProjectStore(file, ROOT, dir)
    const project = store.add('/demo')
    store.setHidden(project.id, true)
    expect(new ProjectStore(file, ROOT).project(project.id)?.hidden).toBe(true)
    store.setHidden(project.id, false)
    expect(new ProjectStore(file, ROOT).project(project.id)).toEqual({ id: project.id, name: 'demo', locations: [{ id: project.id, name: 'demo', path: '/demo' }] })
    expect(() => store.setHidden('nope', true)).toThrow(/proyecto desconocido/)
  })

  it('candidatas: dos niveles, sin ocultas ni dependencias, subproyectos primero y sin las ya registradas', () => {
    const root = join(dir, 'mono')
    for (const d of ['apps/web/src/deep', 'apps/docs', 'api', '.git/objects', 'node_modules/x', 'dist', 'scripts']) mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, 'apps/web/package.json'), '{}')
    writeFileSync(join(root, 'api/go.mod'), 'module api')
    expect(listFolderCandidates(root)).toEqual([
      { rel: 'api', marker: 'go.mod' },
      { rel: 'apps/web', marker: 'package.json' },
      { rel: 'apps', marker: null },
      { rel: 'apps/docs', marker: null },
      { rel: 'scripts', marker: null }
    ])
    const store = new ProjectStore(file, ROOT, dir)
    const project = store.add(root)
    store.addFolder(project.id, 'api')
    expect(store.folderCandidates(project.id).map((c) => c.rel)).not.toContain('api')
  })
})

describe('normalizeFolderRel', () => {
  it('normaliza y rechaza lo que sale del proyecto o es la raíz', () => {
    expect(normalizeFolderRel(' apps//web/ ')).toBe('apps/web')
    expect(normalizeFolderRel('./api')).toBe('api')
    expect(normalizeFolderRel('apps/../api')).toBe('api')
    for (const bad of ['', '.', '..', '../x', 'a/../../x', '/abs']) expect(normalizeFolderRel(bad)).toBeNull()
  })

  it('sanitizePersisted descarta carpetas rotas, repetidas o con id de otro workspace', () => {
    const raw = {
      projects: [{ id: 'p1', path: '/demo', hidden: true, folders: [{ id: 'f1', rel: 'web' }, { id: 'f2', rel: '../x' }, { id: 'f3', rel: 'web' }, { id: 'p1', rel: 'api' }, { id: 'f4', name: 'API', rel: 'api' }] }],
      worktrees: [{ ...wt, id: 'f1' }]
    }
    const data = sanitizePersisted(raw, ROOT)
    expect(data.projects).toEqual([
      {
        id: 'p1',
        name: 'demo',
        hidden: true,
        locations: [
          { id: 'p1', name: 'demo', path: '/demo' },
          { id: 'f1', name: 'web', path: '/demo/web' },
          { id: 'f4', name: 'API', path: '/demo/api' }
        ]
      }
    ])
    expect(data.worktrees).toEqual([])
  })
})

describe('suggestProjectPaths', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'omni-home-'))
    for (const d of ['private/omni', 'private/omnibus', 'private/zeta', 'Proyectos', '.config']) mkdirSync(join(home, d), { recursive: true })
    writeFileSync(join(home, 'private/omni.txt'), 'x')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('completa por prefijo (sin distinguir mayúsculas), lista con barra final y solo carpetas', () => {
    expect(suggestProjectPaths('~/private/om', home)).toEqual([join(home, 'private/omni'), join(home, 'private/omnibus')])
    expect(suggestProjectPaths('~/private/', home)).toEqual([join(home, 'private/omni'), join(home, 'private/omnibus'), join(home, 'private/zeta')])
    expect(suggestProjectPaths('~/pro', home)).toEqual([join(home, 'Proyectos')])
    expect(suggestProjectPaths(`${home}/private/z`, home)).toEqual([join(home, 'private/zeta')])
  })

  it('ocultas solo si se escriben; nada fuera del home ni lo que no es ruta', () => {
    expect(suggestProjectPaths('~/', home)).not.toContain(join(home, '.config'))
    expect(suggestProjectPaths('~/.co', home)).toEqual([join(home, '.config')])
    expect(suggestProjectPaths('/etc/', home)).toEqual([])
    expect(suggestProjectPaths('~/../', home)).toEqual([])
    expect(suggestProjectPaths('omni', home)).toEqual([])
    expect(suggestProjectPaths('~nadie', home)).toEqual([])
    expect(suggestProjectPaths('~/nope/x', home)).toEqual([])
  })
})

describe('ubicaciones', () => {
  let dir: string
  let file: string
  const mk = (name: string): string => {
    const path = join(dir, name)
    mkdirSync(path, { recursive: true })
    return path
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-locations-'))
    file = join(dir, 'projects.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('migra el formato viejo (path + folders) a ubicaciones con los mismos ids; el host pasa a todas', () => {
    const raw = {
      projects: [
        { id: 'p1', name: 'demo', path: '/demo', folders: [{ id: 'f1', rel: 'web' }, { id: 'f2', name: 'API', rel: 'api' }] },
        { id: 'p2', name: 'vps', path: '/home/yo/app', host: 'vps', folders: [{ id: 'f3', rel: 'web' }] }
      ],
      worktrees: [
        { ...wt, id: 'w1', projectId: 'p1', locationId: undefined },
        { ...wt, id: 'w2', projectId: 'p2', locationId: undefined, path: '/home/yo/.omni/worktrees/app/feat' },
        // Un worktree de un proyecto remoto con ruta local no es un worktree remoto válido.
        { ...wt, id: 'w3', projectId: 'p2', locationId: undefined, path: '/wt/feat' },
        { ...wt, id: 'w4', projectId: 'p2', locationId: undefined, path: '/home/yo/.omni/worktrees/' }
      ]
    }
    const data = sanitizePersisted(raw, ROOT)
    expect(data.projects).toEqual([
      {
        id: 'p1',
        name: 'demo',
        locations: [
          { id: 'p1', name: 'demo', path: '/demo' },
          { id: 'f1', name: 'web', path: '/demo/web' },
          { id: 'f2', name: 'API', path: '/demo/api' }
        ]
      },
      {
        id: 'p2',
        name: 'vps',
        locations: [
          { id: 'p2', name: 'app', path: '/home/yo/app', host: 'vps' },
          { id: 'f3', name: 'web', path: '/home/yo/app/web', host: 'vps' }
        ]
      }
    ])
    expect(data.worktrees.map((w) => [w.id, w.locationId])).toEqual([
      ['w1', 'p1'],
      ['w2', 'p2']
    ])
  })

  it('descarta ubicaciones rotas o repetidas y no deja ids repetidos entre proyectos', () => {
    const raw = {
      projects: [
        {
          id: 'p1',
          name: 'demo',
          locations: [
            { id: 'p1', name: '', path: '/demo/' },
            { id: 'l1', path: 'relativa' },
            { id: 'l2', path: '/demo' },
            { id: 'l3', name: 'remota', path: 'sin-barra', host: 'vps' },
            { id: '', path: '/x' },
            { id: 'l4', path: '/srv//app/', host: 'vps' },
            { id: 'l4', path: '/otra' },
            'basura'
          ]
        },
        { id: 'p2', name: 'otro', locations: [{ id: 'p2', path: '/otro' }, { id: 'l4', path: '/robada' }] },
        { id: 'p3', name: 'rotas', locations: [{ id: 'p3', path: 'rel' }] },
        // Formato nuevo sin nombre ni carpetas: no hay nada que mostrar.
        { id: 'p4', locations: [] },
        { id: 'p5', name: '  ', locations: [] }
      ]
    }
    expect(sanitizePersisted(raw, ROOT).projects).toEqual([
      {
        id: 'p1',
        name: 'demo',
        locations: [
          { id: 'p1', name: 'demo', path: '/demo' },
          { id: 'l4', name: 'app', path: '/srv/app', host: 'vps' }
        ]
      },
      { id: 'p2', name: 'otro', locations: [{ id: 'p2', name: 'otro', path: '/otro' }] },
      // Con nombre en el formato nuevo, un proyecto se conserva aunque se quede sin carpetas.
      { id: 'p3', name: 'rotas', locations: [] }
    ])
  })

  it('sin principal: el orden guardado se respeta, los ids no cambian y un proyecto vacío con nombre sobrevive', () => {
    const raw = {
      projects: [
        { id: 'p1', name: 'a', locations: [{ id: 'l1', name: 'web', path: '/a/web' }, { id: 'p1', name: 'Local', path: '/a' }] },
        { id: 'p2', name: 'b', locations: [{ id: 'l2', name: 'api', path: '/b/api' }, { id: 'l3', name: 'web', path: '/b/web' }] },
        { id: 'p3', name: 'Billing', locations: [] }
      ]
    }
    const [a, b, c] = sanitizePersisted(raw, ROOT).projects
    expect(a.locations.map((l) => [l.id, l.name])).toEqual([
      ['l1', 'web'],
      // El viejo nombre fijo "Local" pasa a ser el de su carpeta.
      ['p1', 'a']
    ])
    expect(b.locations.map((l) => l.id)).toEqual(['l2', 'l3'])
    expect(c).toEqual({ id: 'p3', name: 'Billing', locations: [] })
  })

  it('workspaces: con varias ubicaciones todas son folder (con una sola, local); los worktrees toman el host de su ubicación', () => {
    writeFileSync(
      file,
      JSON.stringify({
        projects: [
          {
            id: 'p1',
            name: 'demo',
            locations: [
              { id: 'p1', name: 'demo', path: '/demo' },
              { id: 'l1', name: 'vps', path: '/home/yo/app', host: 'vps' }
            ]
          }
        ],
        worktrees: [
          { ...wt, id: 'w1', locationId: 'p1' },
          { ...wt, id: 'w2', locationId: 'l1', name: 'remoto', path: '/home/yo/.omni/worktrees/app/remoto' }
        ]
      })
    )
    const store = new ProjectStore(file, ROOT, dir)
    expect(store.workspaces()).toEqual([
      { id: 'p1', projectId: 'p1', name: 'demo', path: '/demo', kind: 'folder' },
      { id: 'l1', projectId: 'p1', name: 'vps', path: '/home/yo/app', kind: 'folder', host: 'vps' },
      { id: 'w1', projectId: 'p1', name: 'rate-limit', path: '/wt/rate-limit', kind: 'worktree', locationId: 'p1' },
      { id: 'w2', projectId: 'p1', name: 'remoto', path: '/home/yo/.omni/worktrees/app/remoto', kind: 'worktree', locationId: 'l1', host: 'vps' }
    ])
    expect(store.location('l1')?.host).toBe('vps')
    expect(store.location('w1')).toBeUndefined()
    expect(store.ownerOf('vps', '/home/yo/app')?.project.id).toBe('p1')
    expect(store.ownerOf(undefined, '/home/yo/app')).toBeUndefined()
  })

  it('add y addRemote: una carpeta que ya es ubicación de algún proyecto devuelve ese proyecto', () => {
    const store = new ProjectStore(file, ROOT, dir)
    const a = store.add(mk('a'))
    const b = mk('b')
    store.addLocation(a.id, { path: b })
    expect(store.add(`${b}/`)).toBe(a)
    expect(store.list()).toHaveLength(1)

    const remote = store.addRemote('vps', '/srv//app/')
    expect(remote.locations).toEqual([{ id: remote.id, name: 'app', path: '/srv/app', host: 'vps' }])
    expect(remote.name).toBe('app')
    expect(store.addRemote('vps', '/srv/app')).toBe(remote)
    expect(store.addRemote('otro', '/srv/app')).not.toBe(remote)
    // La misma ruta en este Mac no es la del host.
    expect(store.ownerOf(undefined, '/srv/app')).toBeUndefined()
    expect(() => store.addRemote('vps', 'relativa')).toThrow(/absoluta/)
    expect(new ProjectStore(file, ROOT, dir).list()).toHaveLength(3)
  })

  it('addLocation: local validada dentro del home, remota normalizada, repetida devuelve la existente y la de otro proyecto pide unir', () => {
    const store = new ProjectStore(file, ROOT, dir)
    const a = store.add(mk('a'))
    const web = mk('web')
    const ws = store.addLocation(a.id, { path: `${web}/`, name: ' Front ' })
    expect(ws).toEqual({ id: ws.id, projectId: a.id, name: 'Front', path: web, kind: 'folder' })
    expect(store.addLocation(a.id, { path: web })).toEqual(ws)

    const remote = store.addLocation(a.id, { path: '/srv//app/', host: 'vps' })
    expect(remote).toEqual({ id: remote.id, projectId: a.id, name: 'app', path: '/srv/app', kind: 'folder', host: 'vps' })
    expect(store.addLocation(a.id, { path: '/srv/app', host: 'vps' }).id).toBe(remote.id)
    expect(() => store.addLocation(a.id, { path: 'srv', host: 'vps' })).toThrow(/absoluta/)

    const outside = mkdtempSync(join(tmpdir(), 'omni-fuera-'))
    try {
      expect(() => store.addLocation(a.id, { path: outside })).toThrow(/fuera de tu carpeta de usuario/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    expect(() => store.addLocation(a.id, { path: join(dir, 'nope') })).toThrow(/no existe la carpeta/)
    expect(() => store.addLocation('nope', { path: web })).toThrow(/proyecto desconocido/)

    const b = store.add(mk('b'))
    expect(() => store.addLocation(b.id, { path: web })).toThrow(/Combinar con otro proyecto/)
    expect(() => store.addLocation(b.id, { path: '/srv/app', host: 'vps' })).toThrow(/ya es del proyecto a/)

    const reloaded = new ProjectStore(file, ROOT, dir)
    expect(reloaded.project(a.id)?.locations.map((l) => l.name)).toEqual(['a', 'Front', 'app'])
  })

  it('removeLocation: cualquiera se quita (también la primera) salvo la que tiene worktrees; la última deja el proyecto vacío', () => {
    const store = new ProjectStore(file, ROOT, dir)
    const a = store.add(mk('a'))
    const web = store.addLocation(a.id, { path: mk('web') })
    const api = store.addLocation(a.id, { path: mk('api') })
    store.addWorktree({ ...wt, projectId: a.id, locationId: api.id })
    expect(() => store.removeLocation(api.id)).toThrow(/tiene worktrees/)
    store.removeLocation(a.id)
    store.removeLocation('nope')
    expect(new ProjectStore(file, ROOT, dir).project(a.id)?.locations.map((l) => l.id)).toEqual([web.id, api.id])
    store.removeWorktree('w1')
    store.removeLocation(web.id)
    // Queda una: vuelve a ser `local` (la fila del proyecto la representa).
    expect(store.workspace(api.id)?.kind).toBe('local')
    store.removeLocation(api.id)
    const reloaded = new ProjectStore(file, ROOT, dir)
    expect(reloaded.project(a.id)).toEqual({ id: a.id, name: 'a', locations: [] })
    expect(reloaded.workspaces()).toEqual([])
  })

  it('create: proyecto vacío con nombre que persiste; luego se le suman ubicaciones', () => {
    const store = new ProjectStore(file, ROOT, dir)
    expect(() => store.create('   ')).toThrow(/necesita un nombre/)
    const p = store.create('  Billing API ')
    expect(p).toEqual({ id: p.id, name: 'Billing API', locations: [] })
    expect(new ProjectStore(file, ROOT, dir).project(p.id)).toEqual(p)
    expect(store.workspaces()).toEqual([])
    const api = store.addLocation(p.id, { path: mk('api') })
    expect(api).toMatchObject({ projectId: p.id, name: 'api', kind: 'local' })
    expect(api.id).not.toBe(p.id)
    const vps = store.addLocation(p.id, { path: '/srv/app', host: 'vps' })
    expect(store.workspaces().map((w) => [w.id, w.kind])).toEqual([
      [api.id, 'folder'],
      [vps.id, 'folder']
    ])
    expect(store.folderCandidates(vps.id)).toEqual([])
    expect(() => store.addFolder(vps.id, 'x')).toThrow(/en un servidor/)
  })

  it('moveLocation: sube y baja dentro del proyecto, persiste y en el borde no hace nada', () => {
    const store = new ProjectStore(file, ROOT, dir)
    const a = store.add(mk('a'))
    const web = store.addLocation(a.id, { path: mk('web') })
    const api = store.addLocation(a.id, { path: mk('api') })
    store.moveLocation(api.id, -1)
    expect(store.project(a.id)?.locations.map((l) => l.id)).toEqual([a.id, api.id, web.id])
    store.moveLocation(a.id, -1)
    store.moveLocation(web.id, 1)
    store.moveLocation(a.id, 1)
    expect(new ProjectStore(file, ROOT, dir).project(a.id)?.locations.map((l) => l.id)).toEqual([api.id, a.id, web.id])
    expect(() => store.moveLocation('nope', 1)).toThrow(/ubicación desconocida/)
  })

  it('openFolder: devuelve el workspace de la carpeta aunque no sea la primera del proyecto', () => {
    const store = new ProjectStore(file, ROOT, dir)
    const p = store.create('grupo')
    const web = store.addLocation(p.id, { path: mk('web') })
    expect(store.openFolder(undefined, join(dir, 'web'))).toEqual({ project: p, workspace: web })
    const fresh = store.openFolder(undefined, mk('nuevo'))
    expect(fresh.workspace).toEqual({ id: fresh.project.id, projectId: fresh.project.id, name: 'nuevo', path: join(dir, 'nuevo'), kind: 'local' })
    expect(store.openRemote('vps', '/srv/x/').workspace).toMatchObject({ path: '/srv/x', host: 'vps', kind: 'local' })
  })

  it('rename: recorta, persiste y rechaza vacío o desconocido', () => {
    const store = new ProjectStore(file, ROOT, dir)
    const a = store.add(mk('a'))
    store.rename(a.id, '  Mi proyecto ')
    expect(new ProjectStore(file, ROOT, dir).project(a.id)?.name).toBe('Mi proyecto')
    expect(() => store.rename(a.id, '   ')).toThrow(/necesita un nombre/)
    expect(() => store.rename('nope', 'x')).toThrow(/proyecto desconocido/)
  })

  it('merge: ubicaciones y worktrees pasan al destino con sus ids y el origen desaparece', () => {
    const store = new ProjectStore(file, ROOT, dir)
    const target = store.add(mk('front'))
    const source = store.add(mk('back'))
    const api = store.addLocation(source.id, { path: mk('back-api'), name: 'api' })
    const shared = store.addLocation(source.id, { path: '/srv/app', host: 'vps' })
    store.addWorktree({ ...wt, projectId: source.id, locationId: source.id })
    expect(() => store.merge(target.id, target.id)).toThrow(/mismo proyecto/)
    expect(() => store.merge(target.id, 'nope')).toThrow(/proyecto desconocido/)

    store.merge(target.id, source.id)
    const check = (s: ProjectStore): void => {
      expect(s.project(source.id)).toBeUndefined()
      expect(s.project(target.id)?.locations).toEqual([
        { id: target.id, name: 'front', path: join(dir, 'front') },
        { id: source.id, name: 'back', path: join(dir, 'back') },
        { id: api.id, name: 'api', path: join(dir, 'back-api') },
        { id: shared.id, name: 'app', path: '/srv/app', host: 'vps' }
      ])
      expect(s.worktree('w1')).toMatchObject({ projectId: target.id, locationId: source.id })
      expect(s.workspace(source.id)).toMatchObject({ projectId: target.id, kind: 'folder', name: 'back' })
    }
    check(store)
    check(new ProjectStore(file, ROOT, dir))
  })

  it('merge: una ubicación con la misma carpeta que una del destino no se duplica', () => {
    // Dos proyectos con la misma carpeta solo llegan de un archivo viejo: sanitize no los junta.
    writeFileSync(
      file,
      JSON.stringify({
        projects: [
          { id: 'p1', name: 'a', locations: [{ id: 'p1', path: '/a' }, { id: 'l1', path: '/shared' }] },
          { id: 'p2', name: 'b', locations: [{ id: 'p2', path: '/b' }, { id: 'l2', path: '/shared' }] }
        ]
      })
    )
    const store = new ProjectStore(file, ROOT, dir)
    store.merge('p1', 'p2')
    expect(store.project('p1')?.locations.map((l) => [l.id, l.path])).toEqual([
      ['p1', '/a'],
      ['l1', '/shared'],
      ['p2', '/b']
    ])
  })
})

describe('subcarpetas, segunda parte (§3.5c)', () => {
  it('worktree de una subcarpeta: cwd en <worktree>/<subdir>; tests y nombre por carpeta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-sub-'))
    try {
      const root = join(dir, 'worktrees')
      const file = join(dir, 'projects.json')
      writeFileSync(
        file,
        JSON.stringify({
          projects: [{ id: 'p1', name: 'app', locations: [{ id: 'l1', path: '/repo' }, { id: 'l2', path: '/repo/apps/web', testCommand: ' pnpm test:web ' }], testCommand: 'pnpm test' }],
          worktrees: [
            { id: 'w1', projectId: 'p1', locationId: 'l2', name: 'x', branch: 'omni/x', base: 'main', path: join(root, 'app', 'x'), subdir: 'apps/web/' },
            { id: 'w2', projectId: 'p1', locationId: 'l1', name: 'y', branch: 'omni/y', base: 'main', path: join(root, 'app', 'y'), subdir: '../fuera' }
          ]
        })
      )
      const store = new ProjectStore(file, root)
      const w1 = store.workspace('w1')
      expect(w1).toMatchObject({ cwd: join(root, 'app', 'x', 'apps/web'), locationId: 'l2' })
      // Un subdir que sale del worktree se descarta: arranca en la raíz.
      expect(store.workspace('w2')?.cwd).toBeUndefined()
      expect(store.testCommandOf({ projectId: 'p1', locationId: 'l2' })).toBe('pnpm test:web')
      expect(store.testCommandOf({ projectId: 'p1', locationId: 'l1' })).toBe('pnpm test')
      store.setTestCommand('p1', null, 'l2')
      expect(store.testCommandOf({ projectId: 'p1', locationId: 'l2' })).toBe('pnpm test')
      store.renameLocation('l2', ' frontend ')
      expect(store.workspace('l2')?.name).toBe('frontend')
      expect(() => store.renameLocation('l2', '  ')).toThrow(/nombre/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
