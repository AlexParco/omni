import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, posix, resolve, sep } from 'node:path'
import type { FolderCandidate, IssueInfo, Project, ProjectLocation, Workspace, Worktree } from '@shared/types'
import { CONFIG_DIR, WORKTREES_ROOT } from '../paths'

const DEFAULT_FILE = join(CONFIG_DIR, 'projects.json')

/** Ruta real si existe, resuelta si no: para comparar sin que un symlink engañe. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function startsWithDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/**
 * Expande `~` al home (POSIX: sirve para este Mac y para un servidor). El campo de ruta arranca con
 * `~/`, así que una ruta absoluta pegada encima (`~//Users/ana/x`) vale como absoluta. Lo demás queda igual.
 */
export function expandHome(raw: string, home: string): string {
  const trimmed = raw.trim()
  if (trimmed === '~') return home
  if (!trimmed.startsWith('~/')) return trimmed
  const rest = trimmed.slice(2)
  return rest.startsWith('/') ? rest : `${home}/${rest}`
}

/**
 * Ruta de proyecto aceptable: absoluta (`resolve`, con `~` expandido), sin barra final, una carpeta
 * que existe y que cuelga de la carpeta de usuario. Errores humanos para el renderer. Exportado para tests.
 */
export function validateProjectPath(raw: string, home = homedir()): string {
  const trimmed = expandHome(raw, home)
  if (trimmed === '') throw new Error('falta la ruta del proyecto')
  const path = resolve(trimmed)
  let isDir: boolean
  try {
    isDir = statSync(path).isDirectory()
  } catch {
    throw new Error(`no existe la carpeta ${path}`)
  }
  if (!isDir) throw new Error(`${path} no es una carpeta`)
  if (!startsWithDir(realOrResolved(path), realOrResolved(home))) throw new Error(`${path} está fuera de tu carpeta de usuario`)
  return path
}

/** Cuántas carpetas sugiere `suggestProjectPaths`. */
const SUGGEST_MAX = 8

/**
 * Autocompletado de carpetas para abrir un proyecto por ruta (quick open, §3.11): `~/priv` →
 * `/Users/yo/private`; con barra final lista las hijas. Solo carpetas (sin ocultas salvo que lo
 * escrito empiece por `.`) que cuelgan del home, en orden alfabético, como mucho `SUGGEST_MAX`.
 * Lo que no es una ruta (`~` o `/` al inicio) devuelve `[]`. Exportado para tests.
 */
export function suggestProjectPaths(input: string, home = homedir(), max = SUGGEST_MAX): string[] {
  const raw = input.trim()
  if (!raw.startsWith('~') && !raw.startsWith('/')) return []
  if (raw.startsWith('~') && raw !== '~' && !raw.startsWith('~/')) return []
  const expanded = raw.startsWith('~') ? home + raw.slice(1) : raw
  const listing = expanded.endsWith('/') || raw === '~'
  const dir = listing ? resolve(expanded) : dirname(resolve(expanded))
  const prefix = listing ? '' : basename(expanded).toLowerCase()
  if (!startsWithDir(realOrResolved(dir), realOrResolved(home))) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith(prefix) && (!e.name.startsWith('.') || prefix.startsWith('.')))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, max)
    .map((name) => join(dir, name))
}

interface Persisted {
  projects: Project[]
  worktrees: Worktree[]
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/**
 * Ruta relativa de subcarpeta aceptable: normalizada, con `/`, sin `..`, no absoluta, no la raíz.
 * `null` si no lo es. Exportado para tests.
 */
export function normalizeFolderRel(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '' || isAbsolute(trimmed)) return null
  const rel = normalize(trimmed).split(sep).join('/').replace(/\/+$/, '')
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('../') || rel.split('/').includes('..')) return null
  return rel
}

/** Ruta absoluta normalizada, sin barra final: local con `resolve`, remota como POSIX. `null` si no sirve. */
function normalizeLocationPath(raw: string, host: string | undefined): string | null {
  if (raw === '') return null
  if (host) {
    if (!raw.startsWith('/')) return null
    const p = posix.normalize(raw)
    return p.length > 1 ? p.replace(/\/+$/, '') : p
  }
  return isAbsolute(raw) ? resolve(raw) : null
}

/** Nombre por defecto de una ubicación: la carpeta (`app` de `/srv/app`). */
function folderName(path: string): string {
  return posix.basename(path) || path
}

function sanitizeLocation(x: unknown): ProjectLocation | null {
  if (!isRecord(x) || typeof x.id !== 'string' || x.id === '' || typeof x.path !== 'string') return null
  const host = typeof x.host === 'string' && x.host !== '' ? x.host : undefined
  const path = normalizeLocationPath(x.path, host)
  if (!path) return null
  // "Local" era el nombre fijo de la antigua ubicación principal: ahora todas se llaman como su carpeta.
  const named = typeof x.name === 'string' && x.name !== '' && x.name !== 'Local'
  const location: ProjectLocation = { id: x.id, name: named ? (x.name as string) : folderName(path), path }
  if (host) location.host = host
  if (typeof x.testCommand === 'string' && x.testCommand.trim() !== '') location.testCommand = x.testCommand.trim()
  return location
}

/**
 * Proyecto con sus ubicaciones (0..n, todas iguales). Migra el formato de antes de las ubicaciones
 * (`path` + `host` + `folders[].rel`): la carpeta del proyecto pasa a ser su primera ubicación con el
 * id del proyecto y cada subcarpeta una ubicación más con su id de siempre, así ningún workspace
 * cambia de id. Un proyecto sin ubicaciones se conserva si viene en el formato nuevo con nombre.
 */
function sanitizeProject(x: unknown, seen: Set<string>): Project | null {
  if (!isRecord(x) || typeof x.id !== 'string' || x.id === '') return null
  const legacy = !Array.isArray(x.locations)
  const raw: unknown[] = Array.isArray(x.locations) ? x.locations : []
  if (legacy && typeof x.path === 'string') {
    const host = typeof x.host === 'string' && x.host !== '' ? x.host : undefined
    raw.push({ id: x.id, path: x.path, host })
    if (Array.isArray(x.folders)) {
      for (const f of x.folders) {
        if (!isRecord(f) || typeof f.rel !== 'string') continue
        const rel = normalizeFolderRel(f.rel)
        if (rel) raw.push({ id: f.id, name: typeof f.name === 'string' && f.name !== '' ? f.name : basename(rel), path: posix.join(x.path, rel), host })
      }
    }
  }
  const locations: ProjectLocation[] = []
  for (const item of raw) {
    const location = sanitizeLocation(item)
    // Ids únicos entre proyectos, ubicaciones y worktrees: todos son ids de workspace. Una ubicación
    // puede llevar el id de su propio proyecto (la que era la principal antes de esta versión).
    if (!location || (location.id !== x.id && seen.has(location.id)) || locations.some((l) => l.id === location.id || (l.host === location.host && l.path === location.path))) continue
    locations.push(location)
  }
  const named = typeof x.name === 'string' && x.name.trim() !== ''
  if (locations.length === 0 && (legacy || !named)) return null
  locations.filter((l) => l.id !== x.id).forEach((l) => seen.add(l.id))
  const name = named ? (x.name as string) : folderName(locations[0].path)
  const project: Project = { id: x.id, name, locations }
  if (typeof x.testCommand === 'string' && x.testCommand.trim() !== '') project.testCommand = x.testCommand
  if (x.hidden === true) project.hidden = true
  return project
}

function sanitizeIssue(x: unknown): IssueInfo | undefined {
  if (!isRecord(x) || typeof x.number !== 'number' || typeof x.title !== 'string' || typeof x.url !== 'string') return undefined
  return { number: x.number, title: x.title, url: x.url }
}

/** Carpeta de worktrees de omni en un host remoto, relativa a su `$HOME` (§3.26). */
export const REMOTE_WORKTREES_DIR = '.omni/worktrees'

/**
 * Un worktree remoto no se puede resolver en este Mac: basta con que la ruta sea absoluta, normalizada
 * y cuelgue de `…/.omni/worktrees/<algo>` (la guarda de `rm -rf` se repite en el host al borrarlo).
 */
function isRemoteWorktreePath(path: string): boolean {
  if (!path.startsWith('/') || posix.normalize(path) !== path) return false
  const i = path.indexOf(`/${REMOTE_WORKTREES_DIR}/`)
  return i > 0 && path.length > i + REMOTE_WORKTREES_DIR.length + 2
}

function sanitizeWorktree(x: unknown, root: string, remote: boolean, locationId: string): Worktree | null {
  if (!isRecord(x)) return null
  const { id, projectId, name, branch, base, path } = x
  if ([id, projectId, name, branch, base, path].some((v) => typeof v !== 'string' || v === '')) return null
  // Un worktree fuera de la raíz no es nuestro: `remove` haría `rm -rf` sobre lo que diga el JSON.
  if (remote ? !isRemoteWorktreePath(path as string) : !startsWithDir(realOrResolved(path as string), realOrResolved(root)) || realOrResolved(path as string) === realOrResolved(root)) return null
  const worktree: Worktree = {
    id: id as string,
    projectId: projectId as string,
    locationId,
    name: name as string,
    branch: branch as string,
    base: base as string,
    path: path as string,
    createdAt: typeof x.createdAt === 'number' && Number.isFinite(x.createdAt) ? x.createdAt : 0
  }
  const issue = sanitizeIssue(x.issue)
  if (issue) worktree.issue = issue
  // Relativa y sin `..`: con otra cosa el cwd saldría del worktree.
  if (typeof x.subdir === 'string') {
    const subdir = posix.normalize(x.subdir).replace(/\/+$/, '')
    if (subdir !== '.' && subdir !== '' && !subdir.startsWith('/') && !subdir.split('/').includes('..')) worktree.subdir = subdir
  }
  return worktree
}

/**
 * Deja solo lo que tiene forma: proyectos con id y ruta, worktrees con todos sus campos, cuyo
 * proyecto existe y cuya ruta cuelga de `root`. Ids repetidos: se queda el primero. Exportado para tests.
 */
export function sanitizePersisted(raw: unknown, root = WORKTREES_ROOT): Persisted {
  if (!isRecord(raw)) return { projects: [], worktrees: [] }
  const projects: Project[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw.projects)) {
    for (const item of raw.projects) {
      if (isRecord(item) && typeof item.id === 'string' && seen.has(item.id)) continue
      const project = sanitizeProject(item, seen)
      if (!project || seen.has(project.id)) continue
      seen.add(project.id)
      projects.push(project)
    }
  }
  const worktrees: Worktree[] = []
  if (Array.isArray(raw.worktrees)) {
    for (const item of raw.worktrees) {
      const owner = isRecord(item) ? projects.find((p) => p.id === item.projectId) : undefined
      // Antes de las ubicaciones todo worktree salía de la carpeta del proyecto (hoy su primera ubicación).
      const location = owner && isRecord(item) ? (owner.locations.find((l) => l.id === item.locationId) ?? owner.locations[0]) : undefined
      const worktree = owner && location ? sanitizeWorktree(item, root, location.host !== undefined, location.id) : null
      if (!worktree || seen.has(worktree.id)) continue
      seen.add(worktree.id)
      worktrees.push(worktree)
    }
  }
  return { projects, worktrees }
}

/** Carpetas que nunca son subproyectos: dependencias, salidas de build y cachés. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'target', 'vendor', 'coverage', '__pycache__', 'venv'])
/** Manifiestos que delatan un subproyecto (monorepo), en orden de preferencia. */
const MARKERS = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'mix.exs', 'deno.json']
/** Profundidad máxima del recorrido (`apps/web` = 2) y tope de carpetas devueltas. */
const CANDIDATE_DEPTH = 2
const CANDIDATE_MAX = 400

/**
 * Subcarpetas de `root` hasta dos niveles, sin ocultas ni las de `SKIP_DIRS`, para el selector de
 * "Agregar carpeta" (§3.5c). Las que tienen manifiesto (subproyectos) van primero; dentro de cada
 * grupo, orden alfabético. Nunca sigue symlinks. Exportado para tests.
 */
export function listFolderCandidates(root: string, depth = CANDIDATE_DEPTH, max = CANDIDATE_MAX): FolderCandidate[] {
  const out: FolderCandidate[] = []
  const walk = (dir: string, rel: string, level: number): void => {
    if (level > depth || out.length >= max) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const childDir = join(dir, e.name)
      const marker = MARKERS.find((m) => existsSync(join(childDir, m))) ?? null
      out.push({ rel: childRel, marker })
      if (out.length >= max) return
      walk(childDir, childRel, level + 1)
    }
  }
  walk(root, '', 1)
  return out.sort((a, b) => Number(b.marker !== null) - Number(a.marker !== null) || a.rel.localeCompare(b.rel))
}

/**
 * Catálogo de proyectos, sus ubicaciones y sus worktrees (ARCHITECTURE §3.5c, §3.15). Persistencia en
 * JSON (atómica: tmp + rename). Los workspaces se derivan: uno por ubicación y uno por worktree, con el
 * id de cada uno.
 */
export class ProjectStore {
  private projects: Project[] = []
  private worktrees: Worktree[] = []

  constructor(
    private readonly file = DEFAULT_FILE,
    private readonly worktreeRoot = WORKTREES_ROOT,
    // Carpeta de usuario contra la que se valida una ubicación local; inyectable en tests.
    private readonly home = homedir()
  ) {
    this.load()
  }

  list(): Project[] {
    return this.projects
  }

  project(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id)
  }

  workspaces(): Workspace[] {
    // Cada ubicación es un workspace. Con una sola, es `local`: la fila del proyecto la representa. Con
    // dos o más, todas son `folder` (filas propias) y el proyecto queda como cabecera del grupo.
    const locations: Workspace[] = this.projects.flatMap((p) =>
      p.locations.map((l): Workspace => {
        const w: Workspace = { id: l.id, projectId: p.id, name: l.name, path: l.path, kind: p.locations.length === 1 ? 'local' : 'folder' }
        if (l.host) w.host = l.host
        return w
      })
    )
    const worktrees: Workspace[] = this.worktrees.map((t) => {
      const w: Workspace = { id: t.id, projectId: t.projectId, name: t.name, path: t.path, kind: 'worktree', locationId: t.locationId }
      const host = this.location(t.locationId)?.host
      if (host) w.host = host
      if (t.subdir) w.cwd = posix.join(t.path, t.subdir)
      return w
    })
    return [...locations, ...worktrees]
  }

  workspace(id: string): Workspace | undefined {
    return this.workspaces().find((w) => w.id === id)
  }

  /** Ubicación por id. */
  location(id: string): ProjectLocation | undefined {
    return this.ownerOfLocation(id)?.location
  }

  /** Proyecto dueño de una ubicación, con la ubicación. */
  private ownerOfLocation(id: string): { project: Project; location: ProjectLocation } | undefined {
    for (const project of this.projects) {
      const location = project.locations.find((x) => x.id === id)
      if (location) return { project, location }
    }
    return undefined
  }

  /** Proyecto que ya tiene esa carpeta (en ese host) como alguna de sus ubicaciones. */
  ownerOf(host: string | undefined, path: string): { project: Project; location: ProjectLocation } | undefined {
    for (const project of this.projects) {
      const location = project.locations.find((l) => l.host === host && l.path === path)
      if (location) return { project, location }
    }
    return undefined
  }

  /**
   * Proyecto vacío, solo con nombre (§3.5c, "Nuevo proyecto"): sus carpetas se suman después con
   * `addLocation`.
   */
  create(name: string): Project {
    const trimmed = name.trim()
    if (trimmed === '') throw new Error('el proyecto necesita un nombre')
    const project: Project = { id: randomUUID(), name: trimmed, locations: [] }
    this.projects.push(project)
    this.save()
    return project
  }

  /** Proyecto nuevo con una carpeta de este Mac; si ya es ubicación de alguno, devuelve ese. La ruta se normaliza (`resolve`). */
  add(raw: string): Project {
    return this.openFolder(undefined, resolve(raw)).project
  }

  /**
   * Proyecto nuevo con una carpeta de un host remoto (§3.26). La ruta ya viene validada por el host
   * (existe, es carpeta, resuelta); aquí solo se normaliza como POSIX.
   */
  addRemote(host: string, rawPath: string): Project {
    return this.openRemote(host, rawPath).project
  }

  /** `addRemote` con el workspace de la carpeta (que puede no ser la primera si el proyecto ya existía). */
  openRemote(host: string, rawPath: string): { project: Project; workspace: Workspace } {
    const path = normalizeLocationPath(rawPath, host)
    if (!path) throw new Error(`la ruta remota tiene que ser absoluta: ${rawPath}`)
    return this.openFolder(host, path)
  }

  /**
   * "Abrir proyecto" / "Abrir carpeta remota": un proyecto de una ubicación con el nombre de la carpeta.
   * Si la carpeta ya es ubicación de algún proyecto, ese proyecto y esa ubicación.
   */
  openFolder(host: string | undefined, path: string): { project: Project; workspace: Workspace } {
    const found = this.ownerOf(host, path)
    if (found) return { project: found.project, workspace: this.workspace(found.location.id) as Workspace }
    const id = randomUUID()
    const location: ProjectLocation = { id, name: folderName(path), path }
    if (host) location.host = host
    const project: Project = { id, name: folderName(path), locations: [location] }
    this.projects.push(project)
    this.save()
    return { project, workspace: this.workspace(id) as Workspace }
  }

  /**
   * Suma una ubicación (otra carpeta de este Mac o de un host) a un proyecto y devuelve su workspace;
   * si ya era suya, la existente. Una carpeta que es ubicación de otro proyecto se rechaza: para
   * juntarlos está `merge`. Las rutas remotas llegan validadas por el host; las locales se validan aquí.
   */
  addLocation(projectId: string, input: { path: string; host?: string; name?: string }): Workspace {
    const project = this.project(projectId)
    if (!project) throw new Error(`proyecto desconocido: ${projectId}`)
    const path = input.host ? normalizeLocationPath(input.path, input.host) : validateProjectPath(input.path, this.home)
    if (!path) throw new Error(`la ruta remota tiene que ser absoluta: ${input.path}`)
    const found = this.ownerOf(input.host, path)
    if (found && found.project.id !== projectId) throw new Error(`esa carpeta ya es del proyecto ${found.project.name}: usa "Combinar con otro proyecto"`)
    if (!found) {
      const location: ProjectLocation = { id: randomUUID(), name: input.name?.trim() || folderName(path), path }
      if (input.host) location.host = input.host
      project.locations.push(location)
      this.save()
    }
    const id = found?.location.id ?? project.locations[project.locations.length - 1].id
    const workspace = this.workspace(id)
    if (!workspace) throw new Error('no se pudo registrar la ubicación')
    return workspace
  }

  /**
   * Olvida una ubicación cualquiera (el disco no se toca). Una con worktrees no: se borran antes. Quitar
   * la última deja el proyecto vacío. Las sesiones vivas las revisa quien llama (main/ipc).
   */
  removeLocation(id: string): void {
    const owner = this.ownerOfLocation(id)
    if (!owner) return
    if (this.worktrees.some((w) => w.locationId === id)) throw new Error('esta carpeta tiene worktrees: elimínalos antes de quitarla')
    owner.project.locations = owner.project.locations.filter((l) => l.id !== id)
    this.save()
  }

  /** Sube (`-1`) o baja (`1`) una ubicación dentro de su proyecto; en el borde no hace nada. */
  moveLocation(id: string, delta: -1 | 1): void {
    const owner = this.ownerOfLocation(id)
    if (!owner) throw new Error(`ubicación desconocida: ${id}`)
    const list = owner.project.locations
    const from = list.findIndex((l) => l.id === id)
    const to = from + delta
    if (to < 0 || to >= list.length) return
    const next = [...list]
    ;[next[from], next[to]] = [next[to], next[from]]
    owner.project.locations = next
    this.save()
  }

  rename(projectId: string, name: string): void {
    const project = this.project(projectId)
    if (!project) throw new Error(`proyecto desconocido: ${projectId}`)
    const trimmed = name.trim()
    if (trimmed === '') throw new Error('el proyecto necesita un nombre')
    project.name = trimmed
    this.save()
  }

  /**
   * Junta `sourceId` dentro de `targetId`: sus ubicaciones y worktrees pasan al destino y el origen
   * desaparece. Los ids de workspace no cambian, así sus sesiones siguen vivas donde estaban.
   */
  merge(targetId: string, sourceId: string): void {
    if (targetId === sourceId) throw new Error('es el mismo proyecto')
    const target = this.project(targetId)
    const source = this.project(sourceId)
    if (!target || !source) throw new Error('proyecto desconocido')
    // Una ubicación repetida no se duplica: sus worktrees pasan a apuntar a la del destino.
    const remap = new Map<string, string>()
    for (const l of source.locations) {
      const same = target.locations.find((t) => t.host === l.host && t.path === l.path)
      if (same) {
        remap.set(l.id, same.id)
        continue
      }
      target.locations.push(l)
    }
    this.worktrees = this.worktrees.map((w) => (w.projectId === sourceId ? { ...w, projectId: targetId, locationId: remap.get(w.locationId) ?? w.locationId } : w))
    this.projects = this.projects.filter((p) => p.id !== sourceId)
    this.save()
  }

  /** Quita el proyecto y el registro de sus worktrees (el disco lo limpia quien lo llama, si quiere). */
  remove(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id)
    this.worktrees = this.worktrees.filter((w) => w.projectId !== id)
    this.save()
  }

  /**
   * `null` o vacío borra el comando. Con `locationId` es el de esa carpeta (manda sobre el del proyecto
   * en los worktrees que salen de ella, §3.5c); sin él, el del proyecto.
   */
  setTestCommand(projectId: string, command: string | null, locationId?: string): void {
    const project = this.project(projectId)
    if (!project) throw new Error(`proyecto desconocido: ${projectId}`)
    const target = locationId === undefined ? project : project.locations.find((l) => l.id === locationId)
    if (!target) throw new Error(`carpeta desconocida: ${locationId}`)
    const trimmed = command?.trim() ?? ''
    if (trimmed === '') delete target.testCommand
    else target.testCommand = trimmed
    this.save()
  }

  /** Comando de tests de un worktree: el de su carpeta de origen o, si no tiene, el del proyecto. */
  testCommandOf(worktree: Pick<Worktree, 'projectId' | 'locationId'>): string | undefined {
    return this.location(worktree.locationId)?.testCommand ?? this.project(worktree.projectId)?.testCommand ?? undefined
  }

  /** Nombre visible de una carpeta del proyecto (la fila del sidebar); la ruta no cambia. */
  renameLocation(locationId: string, name: string): void {
    const location = this.location(locationId)
    if (!location) throw new Error(`carpeta desconocida: ${locationId}`)
    const trimmed = name.trim()
    if (trimmed === '') throw new Error('la carpeta necesita un nombre')
    location.name = trimmed
    this.save()
  }

  /** Oculta o muestra el proyecto en el sidebar (§3.5c). Solo cambia la vista: sus sesiones siguen vivas. */
  setHidden(projectId: string, hidden: boolean): void {
    const project = this.project(projectId)
    if (!project) throw new Error(`proyecto desconocido: ${projectId}`)
    if (hidden) project.hidden = true
    else delete project.hidden
    this.save()
  }

  /** Ubicación local de la que salen subcarpetas; error humano si es remota o no existe. */
  private folderRoot(locationId: string): { project: Project; location: ProjectLocation } {
    const owner = this.ownerOfLocation(locationId)
    if (!owner) throw new Error(`ubicación desconocida: ${locationId}`)
    if (owner.location.host) throw new Error('en un servidor agrega la carpeta con "Agregar carpeta"')
    return owner
  }

  /** Subcarpetas candidatas de una ubicación de este Mac, sin las ya registradas en su proyecto. */
  folderCandidates(locationId: string): FolderCandidate[] {
    const owner = this.ownerOfLocation(locationId)
    if (!owner) throw new Error(`ubicación desconocida: ${locationId}`)
    if (owner.location.host) return []
    const root = owner.location
    const taken = new Set(owner.project.locations.filter((l) => !l.host).map((l) => l.path))
    return listFolderCandidates(root.path).filter((c) => !taken.has(join(root.path, c.rel)))
  }

  /**
   * "Agregar subcarpeta": una subcarpeta de la ubicación `locationId` como ubicación más de su proyecto
   * (§3.5c). Tiene que existir y, resuelta sin symlinks, seguir dentro de esa ubicación.
   */
  addFolder(locationId: string, raw: string): Workspace {
    const { project, location: root } = this.folderRoot(locationId)
    const rel = normalizeFolderRel(raw)
    if (!rel) throw new Error(`ruta de carpeta no válida: ${raw}`)
    const path = join(root.path, rel)
    const found = project.locations.find((l) => !l.host && l.path === path)
    if (found) return this.workspace(found.id) as Workspace
    let isDir: boolean
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      throw new Error(`no existe la carpeta ${rel}`)
    }
    if (!isDir) throw new Error(`${rel} no es una carpeta`)
    const real = realOrResolved(path)
    const rootReal = realOrResolved(root.path)
    if (real === rootReal || !startsWithDir(real, rootReal)) throw new Error(`${rel} está fuera de ${root.name}`)
    return this.addLocation(project.id, { path, name: basename(rel) })
  }

  /** Olvida una ubicación (alias de `removeLocation` para "Quitar ubicación"). */
  removeFolder(id: string): void {
    this.removeLocation(id)
  }

  worktree(id: string): Worktree | undefined {
    return this.worktrees.find((w) => w.id === id)
  }

  /** Worktrees de un proyecto (de todas sus ubicaciones). */
  worktreesOf(projectId: string): Worktree[] {
    return this.worktrees.filter((w) => w.projectId === projectId)
  }

  addWorktree(worktree: Worktree): void {
    if (!this.project(worktree.projectId)) throw new Error(`proyecto desconocido: ${worktree.projectId}`)
    if (this.worktrees.some((w) => w.id === worktree.id)) throw new Error(`worktree repetido: ${worktree.id}`)
    this.worktrees.push(worktree)
    this.save()
  }

  removeWorktree(id: string): void {
    this.worktrees = this.worktrees.filter((w) => w.id !== id)
    this.save()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const data = sanitizePersisted(JSON.parse(readFileSync(this.file, 'utf8')), this.worktreeRoot)
      this.projects = data.projects
      this.worktrees = data.worktrees
    } catch (err) {
      console.warn(`[omni] se ignora ${this.file}:`, err)
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ projects: this.projects, worktrees: this.worktrees } satisfies Persisted, null, 2) + '\n')
    renameSync(tmp, this.file)
  }
}
