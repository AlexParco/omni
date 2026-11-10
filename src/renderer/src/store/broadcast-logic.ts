import type { AgentId, Broadcast, BroadcastCandidate, BroadcastState, DiffFile, Workspace } from '@shared/types'
import { agentMessage, stripAnsi, tailLines } from '@/core/terminal-text'
import type { SessionStatus } from './sessions'
import { launcherWorktreeName } from './worktrees-logic'

/**
 * Lógica pura del broadcast (ARCHITECTURE §3.18): nombre de una ronda, dependencias tocadas, orden,
 * estado agregado y navegación. Sin IPC ni stores: todo se prueba en Node.
 */

/** Palabras del prompt que dan nombre a la ronda en el nav. */
export const ROUND_NAME_WORDS = 6
/** Archivos que se listan en una tarjeta antes de `…n más`. */
export const CARD_FILES = 6
/** De la historia cruda solo se mira el final: una línea cabe de sobra y `stripAnsi` no recorre megas. */
const HISTORY_MAX_CHARS = 8192

/** Archivos de dependencias (§3.18): tocarlos es una señal que se mira aparte en la tarjeta. */
export const DEP_FILES: readonly string[] = ['package.json', 'pnpm-lock.yaml', 'go.mod', 'requirements.txt', 'Cargo.toml', 'Gemfile']

/** Lo que la tarjeta guarda del diff de un candidato: archivos con `+a −d`, sin hunks (el diff completo vive en la revisión). */
export interface CandidateDiff {
  files: Array<Pick<DiffFile, 'path' | 'status' | 'additions' | 'deletions'>>
  truncated: boolean
}

/** Nombre de una ronda: las primeras palabras del prompt, con el blanco colapsado. Prompt vacío = `Ronda`. */
export function roundName(prompt: string, words = ROUND_NAME_WORDS): string {
  const all = prompt.trim().split(/\s+/).filter((w) => w !== '')
  if (all.length === 0) return 'Ronda'
  return all.slice(0, words).join(' ')
}

/** Nombres de archivo de dependencias tocados, sin repetir y en el orden del diff. */
export function depsOf(files: ReadonlyArray<Pick<DiffFile, 'path'>>): string[] {
  const out: string[] = []
  for (const f of files) {
    const name = f.path.split('/').pop() ?? f.path
    if (DEP_FILES.includes(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** Etiqueta del par `Deps`: `ninguna` o los nombres separados por coma. */
export function depsLabel(deps: readonly string[]): string {
  return deps.length === 0 ? 'ninguna' : deps.join(', ')
}

/** Archivos que caben en la tarjeta y cuántos quedan fuera. */
export function visibleFiles<T>(files: readonly T[], max = CARD_FILES): { shown: T[]; more: number } {
  return { shown: files.slice(0, max), more: Math.max(0, files.length - max) }
}

/** `+a −d · n archivos` a partir de los archivos del diff; sin archivos, `sin cambios`. Sin diff aún, vacío. */
export function diffLabel(diff: CandidateDiff | undefined): string {
  if (!diff) return ''
  const files = diff.files.length
  if (files === 0) return 'sin cambios'
  const additions = diff.files.reduce((n, f) => n + f.additions, 0)
  const deletions = diff.files.reduce((n, f) => n + f.deletions, 0)
  return `+${additions} −${deletions} · ${files} ${files === 1 ? 'archivo' : 'archivos'}`
}

/**
 * Lo último que dijo el agente según su pantalla renderizada (`agentMessage`): el mensaje con `⏺`/`●`
 * delante, sin llamadas a herramientas. La última línea a secas suele ser el prompt o su sugerencia gris.
 */
export function agentSaid(lines: readonly string[]): string | null {
  return agentMessage(lines)
}

/** Última línea no vacía de la terminal, sin ANSI: el resumen de la tarjeta cuando no hay mensaje. */
export function summaryOf(raw: string): string {
  return tailLines(stripAnsi(raw.slice(-HISTORY_MAX_CHARS)), 1)[0] ?? ''
}

/** Rondas en el orden del nav: la más nueva arriba. */
export function sortRounds(rounds: readonly Broadcast[]): Broadcast[] {
  return [...rounds].sort((a, b) => b.createdAt - a.createdAt)
}

/** Rondas de un proyecto, ya ordenadas; sin proyecto (ningún workspace actual), todas. */
export function roundsOf(rounds: readonly Broadcast[], projectId: string | null): Broadcast[] {
  return sortRounds(projectId === null ? rounds : rounds.filter((r) => r.projectId === projectId))
}

/** Rondas en marcha: el conteo del ítem del sidebar. */
export function activeRounds(rounds: readonly Broadcast[]): number {
  return rounds.filter((r) => r.state === 'running').length
}

/**
 * Estado agregado de una ronda viva: `running` mientras algún agente trabaja o pregunta, o mientras
 * la ronda está lanzando (`busy`: crear worktrees y agentes tarda y no hay nada que dar por listo);
 * `done` cuando todos están en reposo o ya no existen. Una ronda `merged` o `discarded` no cambia.
 */
export function aggregateState(state: BroadcastState, statuses: ReadonlyArray<SessionStatus | null>, busy = false): BroadcastState {
  if (state === 'merged' || state === 'discarded') return state
  return busy || statuses.some((s) => s === 'working' || s === 'question') ? 'running' : 'done'
}

/** Candidatos cuyo worktree sigue existiendo: los únicos que se pintan, se recorren y se comparan. */
export function liveCandidates(round: Pick<Broadcast, 'candidates'> | undefined, workspaces: ReadonlyArray<Pick<Workspace, 'id'>>): BroadcastCandidate[] {
  if (!round) return []
  return round.candidates.filter((c) => workspaces.some((w) => w.id === c.workspaceId))
}

/**
 * Candidatos cuyo worktree sigue existiendo. Una ronda viva que se queda sin candidatos pasa a
 * `discarded`; las rondas cerradas (`merged`, `discarded`) se conservan tal cual como historial.
 * Sin cambios devuelve el mismo array (identidad = "nada que guardar").
 */
export function pruneRounds(rounds: Broadcast[], alive: ReadonlySet<string>): Broadcast[] {
  let changed = false
  const out = rounds.map((r) => {
    if (r.state === 'merged' || r.state === 'discarded') return r
    const candidates = r.candidates.filter((c) => alive.has(c.workspaceId))
    if (candidates.length === r.candidates.length) return r
    changed = true
    const chosen = r.chosen !== null && candidates.some((c) => c.workspaceId === r.chosen) ? r.chosen : null
    return { ...r, candidates, chosen, state: candidates.length === 0 ? ('discarded' as const) : r.state }
  })
  return changed ? out : rounds
}

/** Suelta el vínculo con las sesiones que murieron: el candidato sigue, "sin agente". Sin cambios devuelve el mismo array. */
export function unlinkDeadSessions(rounds: Broadcast[], alive: ReadonlySet<string>): Broadcast[] {
  let changed = false
  const out = rounds.map((r) => {
    if (!r.candidates.some((c) => c.sessionId !== null && !alive.has(c.sessionId))) return r
    changed = true
    return { ...r, candidates: r.candidates.map((c) => (c.sessionId !== null && !alive.has(c.sessionId) ? { ...c, sessionId: null } : c)) }
  })
  return changed ? out : rounds
}

/** Índice válido dentro de una lista de candidatos (los vivos): dentro de rango, o 0. */
export function clampCandidate(candidates: readonly BroadcastCandidate[], index: number): number {
  if (candidates.length === 0) return 0
  return Math.min(Math.max(0, index), candidates.length - 1)
}

/** Índice tras `H`/`L` con wrap-around. */
export function candidateAfterMove(candidates: readonly BroadcastCandidate[], index: number, delta: number): number {
  const n = candidates.length
  if (n === 0) return 0
  return (clampCandidate(candidates, index) + delta + n * 1000) % n
}

/**
 * Par para `⇧D` (diff entre dos) sobre los candidatos vivos: el elegido (`★`) contra el candidato bajo
 * el cursor; sin elegido o con el cursor encima del elegido, los dos primeros. `null` con menos de dos.
 */
export function diffPair(candidates: readonly BroadcastCandidate[], chosen: string | null, cursor: number): [BroadcastCandidate, BroadcastCandidate] | null {
  if (candidates.length < 2) return null
  const current = candidates[clampCandidate(candidates, cursor)]
  const star = chosen !== null ? candidates.find((c) => c.workspaceId === chosen) : undefined
  if (star && star.workspaceId !== current.workspaceId) return [star, current]
  return [candidates[0], candidates[1]]
}

/** Nombres `<badge>-<n>` para N agentes de una ronda, sin chocar entre sí ni con los que ya existen. */
export function worktreeNamesFor(agents: readonly AgentId[], badgeOf: (agent: AgentId) => string, taken: readonly string[]): string[] {
  const used = [...taken]
  return agents.map((agent) => {
    const name = launcherWorktreeName(badgeOf(agent), used)
    used.push(name)
    return name
  })
}

/** Línea mono de la cabecera: `n worktrees desde <base> · <testCommand> al terminar` (o `sin tests al terminar`). */
export function headerLine(round: Pick<Broadcast, 'candidates'>, base: string | null, testCommand: string | null | undefined): string {
  const n = round.candidates.length
  const from = base ? ` desde ${base}` : ''
  return `${n} ${n === 1 ? 'worktree' : 'worktrees'}${from} · ${testCommand ? `${testCommand} al terminar` : 'sin tests al terminar'}`
}

/** Segunda línea de una ronda en el nav: `n agentes · hace 14m`. */
export function roundMeta(round: Pick<Broadcast, 'candidates'>, age: string): string {
  const n = round.candidates.length
  return `${n} ${n === 1 ? 'agente' : 'agentes'} · ${age}`
}

export const ROUND_STATE_LABEL: Record<BroadcastState, string> = { running: 'en marcha', done: 'lista', merged: 'mergeada', discarded: 'descartada' }

/** Ronda nueva, en marcha y sin candidatos aún; `create` los va sumando. */
export function newRound(projectId: string, prompt: string, now = Date.now(), id: string = crypto.randomUUID()): Broadcast {
  return { id, projectId, prompt: prompt.trim(), createdAt: now, candidates: [], chosen: null, state: 'running' }
}

/** Reemplaza una ronda por id (inmutable). */
export function replaceRound(rounds: readonly Broadcast[], round: Broadcast): Broadcast[] {
  return rounds.map((r) => (r.id === round.id ? round : r))
}

/** Workspace de un candidato, si sigue existiendo. */
export function candidateWorkspace(workspaces: readonly Workspace[], candidate: Pick<BroadcastCandidate, 'workspaceId'>): Workspace | undefined {
  return workspaces.find((w) => w.id === candidate.workspaceId)
}
