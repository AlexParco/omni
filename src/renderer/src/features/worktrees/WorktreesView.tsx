import { useEffect, useMemo, useRef, type JSX } from 'react'
import type { Project } from '@shared/types'
import { commands } from '@/core/commands/registry'
import { prettyChord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { useClock } from '@/store/clock'
import { useCost } from '@/store/cost'
import { sessionCostLabel } from '@/store/cost-logic'
import { STATUS_LABEL, agentOf, sessionStatus, sessionTitle, useSessions } from '@/store/sessions'
import { useSettings } from '@/store/settings'
import { useQuickOpen } from '@/store/quickopen'
import { testCommandOf, localWorkspaceOf, projectIsRepo, useWorktrees, visibleRows } from '@/store/worktrees'
import { TESTS_LABEL, ageLabel, branchOf, hasChanges, statLabel, type WorktreeRow } from '@/store/worktrees-logic'
import { useUi } from '@/store/ui'
import { Badge } from '@/ui/Badge'
import { Button } from '@/ui/Button'
import { Dot } from '@/ui/Dot'
import { Empty } from '@/ui/Empty'
import { AgentIcon, Folder, GitCompare, ICON } from '@/ui/icons'
import { Kbd } from '@/ui/Kbd'
import { Row, RowChip, RowCount, RowLabel, RowLine, RowLines, RowMeta, RowTime, chipOf } from '@/ui/Row'
import './worktrees.css'

/** Id DOM de una fila, para `aria-activedescendant`. */
const domId = (id: string): string => `wt-${id.replace(/[^a-z0-9_-]/gi, '-')}`

/** Primer atajo de un comando en una capa, ya formateado; nada escrito a mano. */
function keyOf(commandId: string, layer: 'worktrees' | 'global'): string | undefined {
  const chord = keymap.chordsFor(commandId).find((c) => c.layer === layer)?.chord
  return chord ? prettyChord(chord) : undefined
}

/** Teclas de dos comandos pegadas (`J K`), para los hints del pie. */

/** Acciones del detalle, en el orden de las filas; cada una es un comando y solo se lista si está disponible. */
const ACTIONS: Array<{ command: string; label: string }> = [
  { command: 'worktrees.enter', label: 'Abrir la revisión' },
  { command: 'worktree.enterAgent', label: 'Entrar al agente' },
  { command: 'worktree.runTests', label: 'Correr los tests ahora' },
  { command: 'worktree.discard', label: 'Descartar el worktree' }
]

/**
 * Vista Worktrees (ARCHITECTURE §3.15): reemplaza el área de panes. Lista agrupada por proyecto
 * (620 px) con una fila de tres líneas por worktree y, al lado, el detalle del que está bajo el
 * cursor con el resumen de sus tests y las acciones como filas. Las teclas viven en la capa
 * `worktrees` del keymap (`useKeyboard`); aquí solo hay datos, contenedor y clics que corren comandos.
 */
export function WorktreesView(): JSX.Element {
  const cursor = useWorktrees((s) => s.cursor)
  const statuses = useWorktrees((s) => s.statuses)
  const firstSeen = useWorktrees((s) => s.firstSeen)
  const error = useWorktrees((s) => s.error)
  const errors = useWorktrees((s) => s.errors)
  const notice = useWorktrees((s) => s.notice)
  const setCursor = useWorktrees((s) => s.setCursor)
  const workspaces = useSessions((s) => s.workspaces)
  const projects = useSessions((s) => s.projects)
  const sessions = useSessions((s) => s.sessions)
  const activity = useSessions((s) => s.activity)
  const attention = useSessions((s) => s.attention)
  const busy = useSessions((s) => s.busy)
  const declared = useSessions((s) => s.declared)
  const agents = useSessions((s) => s.agents)
  const titles = useSessions((s) => s.titles)
  const now = useClock((c) => c.now)
  // Columna Costo (§3.17): piso según los logs locales del agente del worktree; nada si no hay registro.
  const costSummary = useCost((s) => s.summary)
  // Los atajos pintados salen del keymap: se vuelve a pintar cuando el usuario los cambia.
  useSettings((s) => s.settings.keys)
  const rootRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Proyecto actual: si consta que no es repo git, el vacío lo dice en vez de ofrecer `N`.
  const currentProjectId = useSessions((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId)?.projectId ?? null)
  const branches = useQuickOpen((s) => s.branches)
  const localId = currentProjectId !== null ? localWorkspaceOf({ workspaces }, currentProjectId)?.id : undefined
  useEffect(() => {
    if (localId) useQuickOpen.getState().loadBranch(localId)
  }, [localId])
  const noGitProject = currentProjectId !== null && projectIsRepo({ workspaces }, currentProjectId, branches) === false ? projects.find((p) => p.id === currentProjectId) : undefined
  const showHidden = useUi((s) => s.showHidden)
  const rows = useMemo(() => visibleRows({ statuses, firstSeen }, { workspaces, projects, sessions }, showHidden), [statuses, firstSeen, workspaces, projects, sessions, showHidden])
  const current = rows.find((r) => r.workspace.id === cursor) ?? rows[0]
  const groups = useMemo(() => {
    const out: Array<{ project: Project; rows: WorktreeRow[] }> = []
    for (const row of rows) {
      const last = out[out.length - 1]
      if (last && last.project.id === row.project.id) last.rows.push(row)
      else out.push({ project: row.project, rows: [row] })
    }
    return out
  }, [rows])

  // El teclado deja la terminal al abrir (`worktrees.open` ya hizo `blurTerminals`); la vista toma el foco DOM.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  // El cursor nunca se sale de la vista al navegar con J/K.
  useEffect(() => {
    listRef.current?.querySelector('[data-cursor]')?.scrollIntoView({ block: 'nearest' })
  }, [current?.workspace.id])

  const renderRow = (r: WorktreeRow): JSX.Element => {
    const status = r.session ? sessionStatus({ activity, attention, busy, declared }, r.session.id, now) : null
    const def = r.session ? agentOf({ agents }, r.session.agent) : undefined
    const branch = branchOf(r.workspace, r.status)
    const stat = statLabel(r.status)
    const tests = r.status?.tests ?? null
    const age = ageLabel(r.since, now)
    const cost = r.session ? sessionCostLabel(costSummary, r.session.id) : null
    const detail = [stat, tests ? TESTS_LABEL[tests.status] : '', age].filter((x) => x !== '').join(' · ')
    return (
      <Row
        key={r.workspace.id}
        id={domId(r.workspace.id)}
        level={1}
        multiline
        cursor={current?.workspace.id === r.workspace.id}
        status={status ?? undefined}
        title={`${r.workspace.name} · ${branch} · ${detail} · ⏎ abre la revisión`}
        onClick={() => setCursor(r.workspace.id)}
        onDoubleClick={() => {
          setCursor(r.workspace.id)
          void commands.run('worktrees.enter')
        }}
      >
        <Dot status={status ?? 'empty'} />
        <RowLines>
          <RowLine>
            <RowLabel strong>{r.workspace.name}</RowLabel>
            <RowMeta>{branch}</RowMeta>
            <RowTime title={new Date(r.since).toLocaleString()}>{age}</RowTime>
          </RowLine>
          <RowLine muted>
            {r.session && status ? (
              <>
                <AgentIcon agent={r.session.agent} size={14} />
                <Badge title={def?.name}>{def?.badge ?? r.session.agent}</Badge>
                <span className="worktrees__agent">{sessionTitle({ titles, agents }, r.session)}</span>
                <span data-status={status}>{STATUS_LABEL[status]}</span>
                {cost && (
                  <RowTime title="Costo de la sesión según los logs locales (piso)">
                    {cost}
                  </RowTime>
                )}
              </>
            ) : (
              'sin agente'
            )}
          </RowLine>
          <RowLine muted>
            {errors[r.workspace.id] ? <span className="worktrees__row-error">{errors[r.workspace.id]}</span> : <span>{stat || 'estado pendiente'}</span>}
            {tests && (
              <span className="worktrees__tests" data-status={tests.status}>
                · {TESTS_LABEL[tests.status]}
              </span>
            )}
          </RowLine>
        </RowLines>
      </Row>
    )
  }

  const renderGroup = ({ project, rows: list }: { project: Project; rows: WorktreeRow[] }): JSX.Element => (
    <section key={project.id} className="worktrees__group" aria-label={project.name}>
      <div className="worktrees__group-head">
        <RowChip color={chipOf(project.id)}>
          <Folder size={13} strokeWidth={2.25} />
        </RowChip>
        <span className="worktrees__group-name">{project.name}</span>
        <RowCount title={`${list.length} ${list.length === 1 ? 'worktree' : 'worktrees'}`}>{list.length}</RowCount>
        <span className="worktrees__group-tests" title={project.testCommand ? 'Comando de tests del proyecto' : 'Sin comando de tests: los tests no corren solos al terminar un agente'}>
          {project.testCommand ?? 'sin comando de tests'}
        </span>
      </div>
      {list.map(renderRow)}
    </section>
  )

  const openKey = keyOf('worktrees.open', 'global')
  const newKey = keyOf('worktree.new', 'worktrees') ?? 'N'
  const issueKey = keyOf('worktree.fromIssue', 'worktrees') ?? 'I'
  const actions = ACTIONS.filter((a) => commands.get(a.command)?.when?.() !== false)
  const currentStatus = current?.session ? sessionStatus({ activity, attention, busy, declared }, current.session.id, now) : null
  const tests = current?.status?.tests ?? null

  return (
    <main ref={rootRef} className="worktrees" tabIndex={-1} aria-label="Worktrees" data-focus="list">
      <div className="worktrees__main">
        <header className="worktrees__head">
          <GitCompare {...ICON} aria-hidden="true" />
          <span className="worktrees__title">Worktrees</span>
          {rows.length > 0 && <RowCount title={`${rows.length} ${rows.length === 1 ? 'worktree' : 'worktrees'}`}>{rows.length}</RowCount>}
          {openKey && <Kbd>{openKey}</Kbd>}
          <span className="worktrees__head-end">
            <Button quiet kbd={newKey} title="Nuevo worktree con nombre" onClick={() => void commands.run('worktree.new')}>
              Nuevo
            </Button>
            <Button quiet kbd={issueKey} title="Nuevo worktree desde un issue de GitHub" onClick={() => void commands.run('worktree.fromIssue')}>
              Desde issue
            </Button>
          </span>
        </header>
        {error && (
          <p className="worktrees__error" role="alert">
            {error}
          </p>
        )}
        <div ref={listRef} className="worktrees__list" role="listbox" aria-label="Worktrees" aria-activedescendant={current ? domId(current.workspace.id) : undefined}>
          {rows.length === 0 && noGitProject && (
            <Empty title={`${noGitProject.name} no es un repo git`}>
              <span>
                Los worktrees necesitan git: corre <code>git init</code> en la carpeta del proyecto
              </span>
            </Empty>
          )}
          {rows.length === 0 && !noGitProject && (
            <Empty title="Sin worktrees">
              <span>
                <Kbd>{newKey}</Kbd> crea uno · <Kbd>{issueKey}</Kbd> desde un issue · <Kbd>⇧⏎</Kbd> en el launcher lanza un agente en uno nuevo
              </span>
            </Empty>
          )}
          {groups.map(renderGroup)}
        </div>
        {notice && (
          <footer className="worktrees__foot" role="status">
            <span className="worktrees__notice">{notice}</span>
          </footer>
        )}
      </div>

      <section className="worktrees__detail" aria-label="Detalle">
        {current && (
          <>
            <header className="worktrees__detail-head">
              {current.session && <AgentIcon agent={current.session.agent} size={16} />}
              <span className="worktrees__detail-title">{current.workspace.name}</span>
              {current.session && <Badge title={agentOf({ agents }, current.session.agent)?.name}>{agentOf({ agents }, current.session.agent)?.badge ?? current.session.agent}</Badge>}
              {currentStatus && <Dot status={currentStatus} title={STATUS_LABEL[currentStatus]} />}
              {current.session && sessionCostLabel(costSummary, current.session.id) && <span className="worktrees__cost">{sessionCostLabel(costSummary, current.session.id)}</span>}
            </header>
            <p className="worktrees__detail-line">
              {branchOf(current.workspace, current.status)} → {current.status?.base ?? 'base pendiente'} · {statLabel(current.status) || 'estado pendiente'}
              {current.status?.dirty && ' · sin commit'}
            </p>
            {errors[current.workspace.id] && (
              <p className="worktrees__detail-error" role="alert">
                {errors[current.workspace.id]}
              </p>
            )}
            <p className="worktrees__detail-path">{current.workspace.path}</p>
            <div className="worktrees__detail-tests" data-status={tests?.status ?? 'none'}>
              <span className="worktrees__detail-tests-title">{tests ? TESTS_LABEL[tests.status] : testCommandOf([current.project], current.workspace) ? 'tests sin correr' : 'sin comando de tests'}</span>
              {tests?.summary && <pre className="worktrees__detail-summary">{tests.summary}</pre>}
              {tests && <span className="worktrees__detail-at">{ageLabel(tests.at, now)}</span>}
            </div>
            {actions.length > 0 && (
              <div className="worktrees__actions" role="listbox" aria-label="Acciones">
                {actions.map((a) => (
                  <Row key={a.command} id={`wt-action-${a.command.replace(/\./g, '-')}`} level={1} active={a.command === 'worktrees.enter'} title={a.label} onClick={() => void commands.run(a.command)}>
                    <Kbd>{keyOf(a.command, 'worktrees') ?? ''}</Kbd>
                    <RowLabel>{a.label}</RowLabel>
                    {a.command === 'worktree.discard' && hasChanges(current.status) && <RowMeta>se pierden los cambios</RowMeta>}
                  </Row>
                ))}
              </div>
            )}
          </>
        )}
        {!current && (
          <Empty title="Un agente, un worktree">
            <span>El diff de cada worktree es la unidad de revisión.</span>
          </Empty>
        )}
      </section>
    </main>
  )
}
