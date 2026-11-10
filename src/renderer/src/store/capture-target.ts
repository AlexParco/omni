import type { SessionInfo } from '@shared/types'
import { leaves, type Tab } from './layout'
import type { SessionStatus } from './sessions'

/**
 * A qué terminal va la ruta de una captura del navegador (ARCHITECTURE §3.9). Selector puro sobre
 * sesiones + layout + historial de foco; vive aparte del store para testearse sin IPC.
 *
 * Orden: 1) otro pane del mismo tab que no sea navegador, el que tuvo el foco más recientemente;
 * 2) el último agente (no shell) del mismo workspace; 3) la última terminal del workspace; 4) nada.
 * "Último" = más reciente en `recentFocus` (ids de sesión, el más reciente primero); si ninguno
 * aparece ahí, el de creación más reciente.
 */
export function captureTarget(browserId: string, sessions: SessionInfo[], tabs: Tab[], recentFocus: string[]): string | null {
  const browser = sessions.find((s) => s.id === browserId)
  if (!browser) return null
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const rank = (id: string): number => {
    const i = recentFocus.indexOf(id)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  const pick = (candidates: SessionInfo[]): string | null => {
    if (candidates.length === 0) return null
    const sorted = [...candidates].sort((a, b) => rank(a.id) - rank(b.id) || b.createdAt - a.createdAt)
    return sorted[0].id
  }

  const tab = tabs.find((t) => leaves(t.root).some((l) => l.sessionId === browserId))
  if (tab) {
    const siblings = leaves(tab.root)
      .map((l) => byId.get(l.sessionId))
      .filter((s): s is SessionInfo => !!s && s.id !== browserId && s.agent !== 'browser')
    const hit = pick(siblings)
    if (hit) return hit
  }

  const inWorkspace = sessions.filter((s) => s.workspaceId === browser.workspaceId && s.agent !== 'browser')
  return pick(inWorkspace.filter((s) => s.agent !== 'shell')) ?? pick(inWorkspace.filter((s) => s.agent === 'shell'))
}

/** Orden de los grupos del diálogo "Enviar al agente": la pregunta abierta primero. */
const STATUS_RANK: Record<SessionStatus, number> = { question: 0, working: 1, idle: 2 }

/**
 * Destinos del diálogo "Enviar al agente": las sesiones de terminal del workspace del navegador,
 * con pregunta abierta primero, luego trabajando, luego en reposo; dentro de cada grupo, los agentes
 * antes que los shells, `preferred` (lo que elegiría `captureTarget`) primero y después el creado
 * más recientemente. El primero es el preseleccionado.
 */
export function rankTargets(sessions: SessionInfo[], workspaceId: string, statusOf: (id: string) => SessionStatus, preferred: string | null = null): SessionInfo[] {
  return sessions
    .filter((s) => s.workspaceId === workspaceId && s.agent !== 'browser')
    .sort(
      (a, b) =>
        STATUS_RANK[statusOf(a.id)] - STATUS_RANK[statusOf(b.id)] ||
        Number(a.agent === 'shell') - Number(b.agent === 'shell') ||
        Number(b.id === preferred) - Number(a.id === preferred) ||
        b.createdAt - a.createdAt
    )
}
