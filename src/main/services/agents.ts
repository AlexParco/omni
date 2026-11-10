import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef } from '@shared/types'

/** Catálogo sin overrides. Exportado para tests. */
export const DEFAULT_AGENTS: AgentDef[] = [
  { id: 'shell', name: 'Terminal', badge: '$', command: null },
  { id: 'claude', name: 'Claude Code', badge: 'CC', command: 'claude' },
  { id: 'codex', name: 'Codex', badge: 'CX', command: 'codex' },
  { id: 'opencode', name: 'OpenCode', badge: 'OC', command: 'opencode' },
  { id: 'goose', name: 'Goose', badge: 'GO', command: 'goose' },
  { id: 'hermes', name: 'Hermes', badge: 'HM', command: 'hermes' },
  // No es un PTY: `session:create` con este agente abre un WebContentsView (ARCHITECTURE §3.9).
  { id: 'browser', name: 'Navegador', badge: 'WB', command: null }
]

/** Overrides del usuario: lista parcial por id en ~/.config/omni/agents.json. */
const USER_FILE = join(homedir(), '.config', 'omni', 'agents.json')

export function listAgents(): AgentDef[] {
  if (!existsSync(USER_FILE)) return DEFAULT_AGENTS
  try {
    return mergeAgents(DEFAULT_AGENTS, JSON.parse(readFileSync(USER_FILE, 'utf8')))
  } catch (err) {
    console.warn(`[omni] se ignora ${USER_FILE}:`, err)
    return DEFAULT_AGENTS
  }
}

export function findAgent(id: string): AgentDef | undefined {
  return listAgents().find((a) => a.id === id)
}

/**
 * Mezcla el catálogo con los overrides del usuario (lista de objetos parciales con `id`). Solo se
 * pisan `name`/`badge` (string no vacío) y `command` (string o null) si tienen la forma correcta;
 * cualquier otra clave o tipo se descarta con aviso y queda el default. `answers` y
 * `safePermissions` (de cuando omni respondía permisos desde el Inbox) se ignoran en silencio: un
 * agents.json viejo sigue valiendo sin llenar la consola de avisos. Exportada para tests.
 */
export function mergeAgents(defaults: AgentDef[], raw: unknown): AgentDef[] {
  const overrides = Array.isArray(raw) ? raw.filter(isRecord) : []
  return defaults.map((agent) => {
    const override = overrides.find((o) => o.id === agent.id)
    if (!override) return agent
    const { id: _id, answers: _answers, safePermissions: _safePermissions, name, badge, command, ...unknown } = override
    const merged: AgentDef = { ...agent }
    for (const key of Object.keys(unknown)) console.warn(`[omni] agents.json: clave desconocida "${key}" en ${agent.id}, se ignora`)
    if (name !== undefined) {
      if (isLabel(name)) merged.name = name
      else console.warn(`[omni] agents.json: name inválido para ${agent.id}, se usa el default`)
    }
    if (badge !== undefined) {
      if (isLabel(badge)) merged.badge = badge
      else console.warn(`[omni] agents.json: badge inválido para ${agent.id}, se usa el default`)
    }
    if (command !== undefined) {
      if (command === null || isLabel(command)) merged.command = command
      else console.warn(`[omni] agents.json: command inválido para ${agent.id}, se usa el default`)
    }
    return merged
  })
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** `name`, `badge` o `command`: string no vacío. */
function isLabel(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0
}
