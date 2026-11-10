import { useEffect, useMemo, useRef, type JSX } from 'react'
import type { Broadcast } from '@shared/types'
import { commands } from '@/core/commands/registry'
import { prettyChord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { broadcastProjectId, candidateStatus, currentRound, useBroadcast, visibleRounds } from '@/store/broadcast'
import { ROUND_STATE_LABEL, clampCandidate, headerLine, liveCandidates, roundMeta, roundName } from '@/store/broadcast-logic'
import { useClock } from '@/store/clock'
import { useCost } from '@/store/cost'
import { sessionCostLabel } from '@/store/cost-logic'
import { agentOf, projectOf, useSessions, workspaceOf } from '@/store/sessions'
import { useSettings } from '@/store/settings'
import { useWorktrees } from '@/store/worktrees'
import { ageLabel } from '@/store/worktrees-logic'
import { Button } from '@/ui/Button'
import { Dot } from '@/ui/Dot'
import { Empty } from '@/ui/Empty'
import { Kbd } from '@/ui/Kbd'
import { Row, RowLabel, RowLine, RowLines, RowTime } from '@/ui/Row'
import { Candidate } from './Candidate'
import './broadcast.css'

/** Id DOM de una fila de ronda, para `aria-activedescendant`. */
const domId = (id: string): string => `bc-${id.replace(/[^a-z0-9_-]/gi, '-')}`

/** Primer atajo de un comando en una capa, ya formateado; nada escrito a mano. */
function keyOf(commandId: string, layer: 'broadcast' | 'global'): string | undefined {
  const chord = keymap.chordsFor(commandId).find((c) => c.layer === layer)?.chord
  return chord ? prettyChord(chord) : undefined
}

/** Teclas de dos comandos pegadas (`H L`), para los hints del pie. */

/** `Dot` de una ronda: en marcha = trabajando, lista = reposo, mergeada o descartada = aro vacío. */
const roundDot = (r: Broadcast): 'working' | 'idle' | 'empty' => (r.state === 'running' ? 'working' : r.state === 'done' ? 'idle' : 'empty')

/**
 * Vista Broadcast (ARCHITECTURE §3.18): reemplaza el área de panes. Nav interno de 260 px con las
 * rondas del proyecto actual, cabecera con el estado de la ronda y las acciones, bloque del prompt y
 * una tarjeta por candidato en fila. Las teclas viven en la capa `broadcast` del keymap (`useKeyboard`);
 * aquí solo hay datos, contenedor y clics que corren comandos (o mueven el cursor).
 */
export function BroadcastView(): JSX.Element {
  const rounds = useBroadcast((s) => s.rounds)
  const cursor = useBroadcast((s) => s.cursor)
  const diffs = useBroadcast((s) => s.diffs)
  const summaries = useBroadcast((s) => s.summaries)
  const promptOpen = useBroadcast((s) => s.promptOpen)
  const launching = useBroadcast((s) => s.launching)
  const error = useBroadcast((s) => s.error)
  const notice = useBroadcast((s) => s.notice)
  const setCursor = useBroadcast((s) => s.setCursor)
  const workspaces = useSessions((s) => s.workspaces)
  const projects = useSessions((s) => s.projects)
  const sessions = useSessions((s) => s.sessions)
  const activity = useSessions((s) => s.activity)
  const attention = useSessions((s) => s.attention)
  const busy = useSessions((s) => s.busy)
  const declared = useSessions((s) => s.declared)
  const agents = useSessions((s) => s.agents)
  const currentWorkspaceId = useSessions((s) => s.currentWorkspaceId)
  const statuses = useWorktrees((s) => s.statuses)
  const costSummary = useCost((s) => s.summary)
  const now = useClock((c) => c.now)
  // Los atajos pintados salen del keymap: se vuelve a pintar cuando el usuario los cambia.
  useSettings((s) => s.settings.keys)
  const rootRef = useRef<HTMLElement>(null)
  const navRef = useRef<HTMLDivElement>(null)

  const projectId = broadcastProjectId({ workspaces, currentWorkspaceId })
  const project = projectId !== null ? projectOf({ projects }, projectId) : undefined
  const list = useMemo(() => visibleRounds({ rounds }, { workspaces, currentWorkspaceId }), [rounds, workspaces, currentWorkspaceId])
  const round = currentRound({ rounds, cursor }, { workspaces, currentWorkspaceId })
  // Solo los candidatos con worktree se pintan, se recorren y se cuentan (en una ronda mergeada quedan los históricos).
  const candidates = useMemo(() => liveCandidates(round, workspaces), [round, workspaces])
  const candidateIndex = clampCandidate(candidates, cursor.candidate)
  const firstWs = candidates[0] ? workspaceOf({ workspaces }, candidates[0].workspaceId) : undefined
  const base = firstWs ? (statuses[firstWs.id]?.base ?? null) : null

  // El teclado deja la terminal al abrir (`broadcast.open` ya hizo `blurTerminals`); la vista toma el foco DOM.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  // El cursor nunca se sale del nav al navegar con J/K.
  useEffect(() => {
    navRef.current?.querySelector('[data-cursor]')?.scrollIntoView({ block: 'nearest' })
  }, [round?.id])

  const renderRound = (r: Broadcast): JSX.Element => {
    const name = roundName(r.prompt)
    const meta = roundMeta(r, ageLabel(r.createdAt, now))
    return (
      <Row key={r.id} id={domId(r.id)} level={1} multiline cursor={round?.id === r.id} title={`${name} · ${meta} · ${ROUND_STATE_LABEL[r.state]}`} onClick={() => setCursor(r.id)}>
        <Dot status={roundDot(r)} title={ROUND_STATE_LABEL[r.state]} />
        <RowLines>
          <RowLine>
            <RowLabel strong>{name}</RowLabel>
            {r.chosen !== null && <span className="candidate__chosen">★</span>}
          </RowLine>
          <RowLine muted>
            <span>{meta}</span>
            <RowTime>{ROUND_STATE_LABEL[r.state]}</RowTime>
          </RowLine>
        </RowLines>
      </Row>
    )
  }

  const openKey = keyOf('broadcast.open', 'global')
  const newKey = keyOf('broadcast.new', 'broadcast') ?? '⇧B'
  const promptKey = keyOf('broadcast.prompt', 'broadcast') ?? 'P'
  const canNew = commands.get('broadcast.new')?.when?.() !== false
  const canBetween = commands.get('broadcast.diffBetween')?.when?.() !== false
  const canRelaunch = commands.get('broadcast.relaunch')?.when?.() !== false
  const canMerge = commands.get('broadcast.merge')?.when?.() !== false

  return (
    <main ref={rootRef} className="broadcast" tabIndex={-1} aria-label="Broadcast" data-focus="list">
      <aside className="broadcast__nav">
        <div className="broadcast__nav-head">
          <span className="broadcast__nav-title">Rondas</span>
          {openKey && <Kbd>{openKey}</Kbd>}
        </div>
        <div ref={navRef} className="broadcast__rounds" role="listbox" aria-label="Rondas" aria-activedescendant={round ? domId(round.id) : undefined}>
          {list.length === 0 && <p className="broadcast__rounds-empty">{project ? `Sin rondas en ${project.name}.` : 'Sin proyecto.'}</p>}
          {list.map(renderRound)}
        </div>
        <button className="broadcast__new" tabIndex={-1} disabled={!canNew} onMouseDown={(e) => e.preventDefault()} onClick={() => void commands.run('broadcast.new')} title="Un prompt a varios agentes, cada uno en su worktree">
          <Kbd>{newKey}</Kbd>
          <span>{launching ? 'Lanzando' : 'Nueva ronda'}</span>
          {project && <span className="broadcast__new-where">{project.name}</span>}
        </button>
      </aside>

      <div className="broadcast__main">
        {round ? (
          <>
            <header className="broadcast__head">
              <div className="broadcast__head-row">
                <span className="broadcast__title">{roundName(round.prompt)}</span>
                <span className="broadcast__state" data-state={round.state}>
                  {launching ? 'lanzando' : ROUND_STATE_LABEL[round.state]}
                </span>
                <span className="broadcast__actions">
                  <Button quiet kbd={keyOf('broadcast.diffBetween', 'broadcast')} disabled={!canBetween} title="Revisión del segundo candidato con el primero (o el elegido) como base" onClick={() => void commands.run('broadcast.diffBetween')}>
                    Comparar dos
                  </Button>
                  <Button quiet kbd={keyOf('broadcast.relaunch', 'broadcast')} disabled={!canRelaunch} title="Nuevos worktrees con el mismo prompt y agentes; los no elegidos se descartan" onClick={() => void commands.run('broadcast.relaunch')}>
                    Relanzar
                  </Button>
                  <Button quiet variant="primary" kbd={keyOf('broadcast.merge', 'broadcast')} disabled={!canMerge} title={round.chosen === null ? 'Elige un candidato con S' : 'Merge del elegido y descarte del resto'} onClick={() => void commands.run('broadcast.merge')}>
                    Merge del elegido
                  </Button>
                </span>
              </div>
              <div className="broadcast__head-line">{headerLine({ candidates }, base, project?.testCommand)}</div>
            </header>
            {error && (
              <p className="broadcast__error" role="alert">
                {error}
              </p>
            )}
            <div className="broadcast__prompt" data-open={promptOpen || undefined} title={promptOpen ? 'P pliega el prompt' : 'P muestra el prompt completo'} onClick={() => void commands.run('broadcast.prompt')}>
              <Kbd>{promptKey}</Kbd>
              <pre className="broadcast__prompt-text">{round.prompt}</pre>
            </div>
            <div className="broadcast__cards" role="listbox" aria-label="Candidatos" aria-orientation="horizontal">
              {candidates.length === 0 && (
                <Empty title={launching ? 'Creando worktrees' : round.state === 'merged' ? 'Ronda mergeada' : 'Sin candidatos'}>
                  <span>{launching ? 'Un worktree por agente; el prompt se escribe cuando el agente se calma.' : round.state === 'merged' ? 'El elegido ya está en la rama local.' : 'Todos los candidatos se descartaron.'}</span>
                </Empty>
              )}
              {candidates.map((c, i) => {
                const ws = workspaceOf({ workspaces }, c.workspaceId)
                if (!ws) return null
                const session = c.sessionId !== null ? sessions.find((x) => x.id === c.sessionId) : undefined
                return (
                  <Candidate
                    key={c.workspaceId}
                    candidate={c}
                    workspace={ws}
                    def={agentOf({ agents }, c.agent)}
                    status={candidateStatus({ sessions, activity, attention, busy, declared }, c, now)}
                    cursor={i === candidateIndex}
                    chosen={round.chosen === c.workspaceId}
                    diff={diffs[c.workspaceId]}
                    tests={statuses[c.workspaceId]?.tests ?? null}
                    cost={c.sessionId !== null ? sessionCostLabel(costSummary, c.sessionId) : null}
                    summary={c.sessionId !== null ? summaries[c.sessionId] : undefined}
                    age={ageLabel(session?.createdAt ?? round.createdAt, now)}
                    since={session?.createdAt ?? round.createdAt}
                    onClick={() => setCursor(round.id, i)}
                    onDoubleClick={() => {
                      setCursor(round.id, i)
                      void commands.run('broadcast.enter')
                    }}
                  />
                )
              })}
            </div>
          </>
        ) : (
          <Empty title="Un prompt a varios agentes">
            <span>
              <Kbd>{newKey}</Kbd> lanza una ronda: cada agente trabaja en su worktree y aquí comparas, eliges y mergeas.
            </span>
          </Empty>
        )}
        {(notice || (error && !round)) && (
          <footer className="broadcast__foot" role="status">
            <span className="broadcast__foot-end" data-error={!notice && error ? true : undefined}>
              {notice ?? error}
            </span>
          </footer>
        )}
      </div>
    </main>
  )
}
