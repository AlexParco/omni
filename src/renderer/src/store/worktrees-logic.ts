import type { Project, SessionInfo, TestsStatus, Workspace, WorktreeStatus } from '@shared/types'

/**
 * Fila de la vista Worktrees (ARCHITECTURE §3.15): un workspace `kind: 'worktree'` con su proyecto,
 * la sesión que vive ahí (la primera que no es navegador; `undefined` = "sin agente"), su estado git
 * si ya llegó y desde cuándo existe.
 */
export interface WorktreeRow {
  workspace: Workspace
  project: Project
  session: SessionInfo | undefined
  status: WorktreeStatus | undefined
  /** Antigüedad: la sesión más vieja del worktree o, sin sesiones, cuándo lo vio el renderer por primera vez. */
  since: number
}

/** Sesión que representa a un worktree: la primera que no es navegador (un navegador no edita código). */
export function agentSessionOf(sessions: readonly SessionInfo[], workspaceId: string): SessionInfo | undefined {
  const own = sessions.filter((s) => s.workspaceId === workspaceId)
  return own.find((s) => s.agent !== 'browser') ?? own[0]
}

/**
 * Filas de la vista en su orden: por proyecto (el orden de la lista de proyectos), dentro primero los
 * que tienen agente y luego los más nuevos arriba. Un worktree sin proyecto conocido no se lista.
 */
export function worktreeRows(
  workspaces: readonly Workspace[],
  projects: readonly Project[],
  sessions: readonly SessionInfo[],
  statuses: Readonly<Record<string, WorktreeStatus>>,
  firstSeen: Readonly<Record<string, number>>
): WorktreeRow[] {
  const rows: WorktreeRow[] = []
  for (const w of workspaces) {
    if (w.kind !== 'worktree') continue
    const project = projects.find((p) => p.id === w.projectId)
    if (!project) continue
    const own = sessions.filter((s) => s.workspaceId === w.id)
    const oldest = own.length > 0 ? Math.min(...own.map((s) => s.createdAt)) : undefined
    rows.push({ workspace: w, project, session: agentSessionOf(sessions, w.id), status: statuses[w.id], since: oldest ?? firstSeen[w.id] ?? Date.now() })
  }
  const order = new Map(projects.map((p, i) => [p.id, i]))
  return rows.sort((a, b) => {
    const p = (order.get(a.project.id) ?? 0) - (order.get(b.project.id) ?? 0)
    if (p !== 0) return p
    const agent = Number(b.session !== undefined) - Number(a.session !== undefined)
    if (agent !== 0) return agent
    return b.since - a.since
  })
}

/** Antigüedad legible: `ahora` bajo el minuto, luego `hace 14m`, `hace 3h`, `hace 2d`. */
export function ageLabel(since: number, now: number): string {
  const m = Math.floor(Math.max(0, now - since) / 60000)
  if (m < 1) return 'ahora'
  if (m < 60) return `hace ${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `hace ${h}h`
  return `hace ${Math.floor(h / 24)}d`
}

/** `+a −d · n archivos`; sin archivos tocados, `sin cambios`. Sin estado aún, vacío. */
export function statLabel(status: Pick<WorktreeStatus, 'stat'> | undefined): string {
  if (!status) return ''
  const { files, additions, deletions } = status.stat
  if (files === 0) return 'sin cambios'
  return `+${additions} −${deletions} · ${files} ${files === 1 ? 'archivo' : 'archivos'}`
}

export const TESTS_LABEL: Record<TestsStatus, string> = { pass: 'tests ok', fail: 'tests fallaron', running: 'tests corriendo' }

/** Etiqueta de la última corrida de tests; vacío si nunca corrieron. */
export function testsLabel(status: Pick<WorktreeStatus, 'tests'> | undefined): string {
  return status?.tests ? TESTS_LABEL[status.tests.status] : ''
}

/** Tercera línea de la fila: estadística, tests y antigüedad, separados por ` · `, sin huecos. */
export function detailLine(status: WorktreeStatus | undefined, since: number, now: number): string {
  return [statLabel(status), testsLabel(status), ageLabel(since, now)].filter((x) => x !== '').join(' · ')
}

/** El worktree tiene algo que perder: cambios respecto a su base o archivos sin commit. */
export function hasChanges(status: Pick<WorktreeStatus, 'dirty' | 'stat'> | undefined): boolean {
  return status !== undefined && (status.dirty || status.stat.files > 0)
}

/** Rama que se pinta en el sidebar antes de que llegue el estado: main nombra las ramas `omni/<name>`. */
export function branchOf(workspace: Pick<Workspace, 'name'>, status: Pick<WorktreeStatus, 'branch'> | undefined): string {
  return status?.branch ?? `omni/${workspace.name}`
}

/**
 * Nombre de un worktree lanzado desde el launcher (⇧⏎): `<badge en minúscula>-<n>`, con el primer `n`
 * libre entre los nombres que ya existen en el proyecto (`cc-1`, `cc-2`…).
 */
export function launcherWorktreeName(badge: string, taken: readonly string[]): string {
  const base = badge.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'wt'
  const used = new Set(taken)
  let n = 1
  while (used.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** Nombre escrito a mano, normalizado como lo haría main para la rama: minúsculas, guiones, ≤ 40 chars. */
export function normalizeWorktreeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** Primer prompt de un agente lanzado desde un issue (§3.15). */
export function issuePrompt(issue: { number: number; title: string; url: string }): string {
  return `Issue #${issue.number}: ${issue.title}\n${issue.url}`
}

/** Número de issue escrito a mano: `41`, `#41` o una URL de GitHub que termina en `/issues/41`. */
export function parseIssueNumber(raw: string): number | null {
  const m = raw.trim().match(/(?:^#?|\/issues\/)(\d+)\/?$/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}
