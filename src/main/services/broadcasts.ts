import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentId, Broadcast, BroadcastCandidate, BroadcastState } from '@shared/types'

const DEFAULT_FILE = join(homedir(), '.config', 'omni', 'broadcasts.json')

const STATES: readonly BroadcastState[] = ['running', 'done', 'merged', 'discarded']

/**
 * `~/.config/omni/broadcasts.json`: las rondas de broadcast (ARCHITECTURE §3.18). El renderer es
 * el dueño del estado (crea worktrees y lanza agentes); main solo persiste, atómico (tmp + rename),
 * como `TodoStore`. Un archivo corrupto se ignora: arrancar sin rondas es siempre válido.
 */
export class BroadcastStore {
  constructor(private readonly file = DEFAULT_FILE) {}

  load(): Broadcast[] {
    if (!existsSync(this.file)) return []
    try {
      return sanitizeBroadcasts(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (err) {
      console.warn(`[omni] se ignora ${this.file}:`, err)
      return []
    }
  }

  save(rounds: Broadcast[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(rounds, null, 2) + '\n')
    renameSync(tmp, this.file)
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isState(x: unknown): x is BroadcastState {
  return typeof x === 'string' && (STATES as readonly string[]).includes(x)
}

function sanitizeCandidate(x: unknown): BroadcastCandidate | null {
  if (!isRecord(x) || typeof x.workspaceId !== 'string' || x.workspaceId === '' || typeof x.agent !== 'string' || x.agent === '') return null
  // El catálogo de agentes vive en otro servicio: aquí basta con que sea un id no vacío.
  return { workspaceId: x.workspaceId, sessionId: typeof x.sessionId === 'string' ? x.sessionId : null, agent: x.agent as AgentId }
}

function sanitizeBroadcast(x: unknown): Broadcast | null {
  if (!isRecord(x) || typeof x.id !== 'string' || x.id === '' || typeof x.projectId !== 'string' || x.projectId === '') return null
  if (typeof x.prompt !== 'string' || !isState(x.state)) return null
  const candidates = Array.isArray(x.candidates) ? x.candidates.map(sanitizeCandidate).filter((c): c is BroadcastCandidate => c !== null) : []
  const chosen = typeof x.chosen === 'string' && candidates.some((c) => c.workspaceId === x.chosen) ? x.chosen : null
  return {
    id: x.id,
    projectId: x.projectId,
    prompt: x.prompt,
    createdAt: typeof x.createdAt === 'number' && Number.isFinite(x.createdAt) ? x.createdAt : 0,
    candidates,
    chosen,
    state: x.state
  }
}

/**
 * Deja solo las rondas con forma (id, proyecto, prompt y estado válidos); candidatos rotos se
 * descartan y un `chosen` que no apunta a un candidato pasa a `null`. Con ids repetidos se queda
 * la primera. Lo que no es un array → `[]`. Exportado para tests y para `broadcast:save`.
 */
export function sanitizeBroadcasts(raw: unknown): Broadcast[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const rounds: Broadcast[] = []
  for (const item of raw) {
    const round = sanitizeBroadcast(item)
    if (!round || seen.has(round.id)) continue
    seen.add(round.id)
    rounds.push(round)
  }
  return rounds
}
