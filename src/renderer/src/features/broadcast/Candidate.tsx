import type { JSX } from 'react'
import type { AgentDef, BroadcastCandidate, TestsResult, Workspace } from '@shared/types'
import { depsLabel, depsOf, diffLabel, visibleFiles, type CandidateDiff } from '@/store/broadcast-logic'
import { STATUS_LABEL, type SessionStatus } from '@/store/sessions'
import { Badge } from '@/ui/Badge'
import { Dot } from '@/ui/Dot'
import { AgentIcon } from '@/ui/icons'
import './broadcast.css'

interface Props {
  candidate: BroadcastCandidate
  workspace: Workspace
  def: AgentDef | undefined
  /** Estado del agente; `null` = murió o nunca nació ("sin agente"). */
  status: SessionStatus | null
  cursor: boolean
  chosen: boolean
  /** Diff resumido del worktree, si ya llegó. */
  diff: CandidateDiff | undefined
  tests: TestsResult | null
  /** `$3.10 · 62k` o `null` sin registro (§3.17). */
  cost: string | null
  /** Última línea no vacía de la terminal. */
  summary: string | undefined
  /** `hace 14m` y el instante del que sale (tooltip). */
  age: string
  since: number
  onClick(): void
  onDoubleClick(): void
}

const TESTS_SHORT: Record<TestsResult['status'], string> = { pass: 'ok', fail: 'fallaron', running: 'corriendo' }

/**
 * Tarjeta de un candidato (ARCHITECTURE §3.18): cabecera con `Dot`, nombre del worktree, badge del
 * agente, `★ elegido` y tiempo; pares Diff / Tests / Costo / Deps; resumen de la terminal y la lista
 * mono de archivos con `+a −d` (máx. 6 y `…n más`). Solo datos y contenedor: el clic mueve el cursor
 * y el doble clic corre `broadcast.enter` desde la vista.
 */
export function Candidate({ candidate, workspace, def, status, cursor, chosen, diff, tests, cost, summary, age, since, onClick, onDoubleClick }: Props): JSX.Element {
  const files = diff?.files ?? []
  const deps = depsOf(files)
  const { shown, more } = visibleFiles(files)
  const statusLabel = status ? STATUS_LABEL[status] : 'sin agente'
  return (
    <article
      className="candidate"
      role="option"
      data-cursor={cursor || undefined}
      data-chosen={chosen || undefined}
      data-status={status ?? 'none'}
      aria-selected={cursor}
      aria-label={`${workspace.name} · ${def?.name ?? candidate.agent} · ${statusLabel}`}
      title={`${workspace.name} · ${statusLabel} · clic para mirar, doble clic para entrar al agente`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <header className="candidate__head">
        <Dot status={status ?? 'empty'} title={statusLabel} />
        <span className="candidate__name">{workspace.name}</span>
        <AgentIcon agent={candidate.agent} size={14} />
        <Badge title={def?.name}>{def?.badge ?? candidate.agent}</Badge>
        {chosen && <span className="candidate__chosen">★ elegido</span>}
        <span className="candidate__time" title={new Date(since).toLocaleString()}>
          {age}
        </span>
      </header>
      <span className="candidate__status" data-status={status ?? 'none'}>
        {statusLabel}
      </span>
      <dl className="candidate__pairs">
        <dt className="candidate__key">Diff</dt>
        <dd className="candidate__value" data-tone={diff ? undefined : 'muted'}>
          {diffLabel(diff) || 'pendiente'}
        </dd>
        <dt className="candidate__key">Tests</dt>
        <dd className="candidate__value" data-tone={tests ? tests.status : 'muted'} title={tests?.summary || undefined}>
          {tests ? TESTS_SHORT[tests.status] : 'sin correr'}
        </dd>
        <dt className="candidate__key">Costo</dt>
        <dd className="candidate__value" data-tone={cost ? undefined : 'muted'} title="Costo de la sesión según los logs locales (piso)">
          {cost ?? 'sin registro'}
        </dd>
        <dt className="candidate__key">Deps</dt>
        <dd className="candidate__value" data-tone={deps.length > 0 ? 'deps' : 'muted'} title={deps.length > 0 ? 'Archivos de dependencias tocados' : undefined}>
          {depsLabel(deps)}
        </dd>
      </dl>
      <p className="candidate__summary" data-empty={!summary || undefined} title={summary || undefined}>
        {summary || 'Sin salida todavía.'}
      </p>
      {shown.length > 0 && (
        <ul className="candidate__files" aria-label="Archivos tocados">
          {shown.map((f) => (
            <li key={f.path} className="candidate__file" data-dep={deps.includes(f.path.split('/').pop() ?? f.path) || undefined} title={`${f.path} · ${f.status}`}>
              <span className="candidate__path">{f.path}</span>
              <span className="candidate__stat">
                <span className="candidate__stat-add">+{f.additions}</span>
                <span className="candidate__stat-del">−{f.deletions}</span>
              </span>
            </li>
          ))}
          {more > 0 && <li className="candidate__more">…{more} más</li>}
        </ul>
      )}
    </article>
  )
}
