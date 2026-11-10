import type { ListeningProcess, SessionInfo, Workspace } from '@shared/types'

/** Id de fila de un proceso (el pid; un proceso es una fila aunque escuche en varios puertos). */
export const portRowId = (p: Pick<ListeningProcess, 'pid'>): string => String(p.pid)

export interface PortGroups {
  /** Servicios del workspace actual (como el "Active Workspace" de Orca): arriba, separados del resto. */
  here: ListeningProcess[]
  /** Los demás servicios levantados desde una carpeta o desde omni. */
  dev: ListeningProcess[]
  /** Apps y daemons del sistema (cwd `/`): plegados al final. */
  system: ListeningProcess[]
}

/** Texto donde busca el filtro: puertos, nombre, repo, rama, carpeta y comando. */
function haystack(p: ListeningProcess): string {
  return [p.ports.join(' '), p.name, p.repo?.name, p.repo?.branch, p.repo?.sub, p.cwd, p.command].filter(Boolean).join(' ').toLowerCase()
}

/**
 * Agrupa en aquí (servicios del workspace actual, según `here`), el resto de servicios y sistema; con
 * `query`, solo los que contienen todas sus palabras. Mantiene el orden de main (por puerto).
 */
export function groupPorts(list: readonly ListeningProcess[], query = '', here: (p: ListeningProcess) => boolean = () => false): PortGroups {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '')
  const match = (p: ListeningProcess): boolean => words.length === 0 || words.every((w) => haystack(p).includes(w))
  const shown = list.filter(match)
  const dev = shown.filter((p) => p.kind === 'dev')
  return { here: dev.filter(here), dev: dev.filter((p) => !here(p)), system: shown.filter((p) => p.kind === 'system') }
}

/** Ids en el orden en que se ven: aquí, el resto y, con Sistema desplegado (o filtrando), los del sistema. */
export function visiblePortIds(groups: PortGroups, systemOpen: boolean): string[] {
  return [...groups.here, ...groups.dev, ...(systemOpen ? groups.system : [])].map(portRowId)
}

/** Secuencias de control de terminal (CSI y OSC), para leer la salida como texto. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d+))?(?:\/[^\s'"<>)\]]*)?/g

/**
 * URL que el propio servidor anunció en su terminal para ese puerto (`➜ Local: https://localhost:5173/app/`),
 * la última si hay varias; `null` si no anunció ninguna. Como Orca: así se abre con su esquema y su ruta
 * base en vez de suponer `http://localhost:<puerto>`. `0.0.0.0` se abre como `localhost`.
 */
export function advertisedUrl(output: string, port: number): string | null {
  const text = output.replace(ANSI, '')
  let found: string | null = null
  for (const m of text.matchAll(LOCAL_URL)) {
    const url = m[0].replace(/[.,;:]+$/, '')
    const explicit = m[1] ? Number(m[1]) : url.startsWith('https') ? 443 : 80
    if (explicit === port) found = url.replace('0.0.0.0', 'localhost')
  }
  return found
}

/** URL para abrir el servicio: siempre `localhost` (resuelve a IPv4 o IPv6 según dónde escuche). */
export function portUrl(p: Pick<ListeningProcess, 'ports'>): string {
  return `http://localhost:${p.ports[0]}`
}

/** `~/acme/web` en vez de `/Users/<yo>/acme/web`. */
function tildePath(path: string, home: string | null): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

/**
 * Dónde corre, para la segunda línea: `repo/sub · rama` si hay repo (la rama distingue worktrees del
 * mismo repo), si no la carpeta. Las apps del sistema no tienen lugar.
 */
export function portPlace(p: Pick<ListeningProcess, 'repo' | 'cwd' | 'kind'>, home: string | null = null): string {
  if (p.repo) {
    const where = p.repo.sub ? `${p.repo.name}/${p.repo.sub}` : p.repo.name
    return p.repo.branch ? `${where} · ${p.repo.branch}` : where
  }
  if (p.kind === 'system' || p.cwd === null || p.cwd === '/') return ''
  return tildePath(p.cwd, home)
}

/** Carpeta home del usuario deducida de las rutas de los workspaces (`/Users/<yo>`), para acortar con `~`. */
export function homeOf(paths: readonly string[]): string | null {
  for (const path of paths) {
    const m = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(path)
    if (m) return m[1]
  }
  return null
}

/** Cuánto lleva arriba: `recién`, `14m`, `3h`, `2d`. Vacío si no se sabe. */
export function uptimeLabel(startedAt: number | null, now: number): string {
  if (startedAt === null) return ''
  const m = Math.floor(Math.max(0, now - startedAt) / 60000)
  if (m < 1) return 'recién'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** Puertos de más (HMR, inspector) para la segunda línea: `+ 24678 9229`. Vacío si escucha en uno solo. */
export function extraPorts(p: Pick<ListeningProcess, 'ports'>): string {
  return p.ports.length > 1 ? `+ ${p.ports.slice(1).join(' ')}` : ''
}

/** Escucha solo en loopback (127.0.0.1, ::1): no se ve desde la red. */
export function loopbackOnly(p: Pick<ListeningProcess, 'hosts'>): boolean {
  return p.hosts.every((h) => h === '127.0.0.1' || h === '::1' || h === 'localhost')
}

/** Workspace de omni donde corre: el de su sesión, si no el de ruta más larga que contiene su cwd. */
export function workspaceOfPort(p: Pick<ListeningProcess, 'cwd' | 'sessionId'>, workspaces: readonly Workspace[], sessionWorkspace: string | null): Workspace | null {
  if (sessionWorkspace) {
    const ws = workspaces.find((w) => w.id === sessionWorkspace)
    if (ws) return ws
  }
  const cwd = p.cwd
  if (!cwd || cwd === '/') return null
  let best: Workspace | null = null
  for (const w of workspaces) if ((cwd === w.path || cwd.startsWith(`${w.path}/`)) && (!best || w.path.length > best.path.length)) best = w
  return best
}

/** `localhost:3000`, `127.0.0.1:3000` y `[::1]:3000` son el mismo servicio. */
export function samePortOrigin(url: string, port: number): boolean {
  try {
    const u = new URL(url)
    return ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(u.hostname) && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === port
  } catch {
    return false
  }
}

/** Predicado "corre en el workspace actual" para `groupPorts`: por su sesión o por su carpeta. Sin workspace actual, nada. */
export function inWorkspace(workspaceId: string | null, workspaces: readonly Workspace[], sessions: readonly SessionInfo[]): (p: ListeningProcess) => boolean {
  if (workspaceId === null) return () => false
  return (p) => {
    const owner = p.sessionId ? sessions.find((s) => s.id === p.sessionId) : undefined
    return workspaceOfPort(p, workspaces, owner?.workspaceId ?? null)?.id === workspaceId
  }
}
