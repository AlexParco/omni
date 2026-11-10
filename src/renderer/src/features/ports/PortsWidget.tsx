import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react'
import type { ListeningProcess } from '@shared/types'
import { chordOf, prettyChord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { Badge } from '@/ui/Badge'
import { IconButton } from '@/ui/Button'
import { Empty } from '@/ui/Empty'
import { Hint } from '@/ui/Hint'
import { ChevronDown, ChevronRight, CircleStop, Copy, Globe, ICON_SM, MoveUpRight, Search } from '@/ui/icons'
import { Kbd } from '@/ui/Kbd'
import { Widget } from '@/ui/Widget'
import { Row, RowActions, RowCount, RowEnd, RowLabel, RowLine, RowLines, RowTime } from '@/ui/Row'
import { TextInput } from '@/ui/TextInput'
import { useClock } from '@/store/clock'
import { extraPorts, groupPorts, homeOf, loopbackOnly, portPlace, portRowId, portUrl, uptimeLabel } from '@/store/ports-logic'
import { hereNow, usePorts } from '@/store/ports'
import { agentOf, useSessions } from '@/store/sessions'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import './ports.css'

/** Id DOM de la fila de un proceso, para `aria-activedescendant`. */
const domId = (id: string): string => `port-${id}`

/** Atajo global vigente de un comando, ya formateado. */
function globalKey(id: string): string | undefined {
  const chord = keymap.chordsFor(id).find((c) => c.layer === 'global')?.chord
  return chord ? prettyChord(chord) : undefined
}

/**
 * Widget Puertos (ARCHITECTURE §3.24): los servicios que escuchan en esta máquina, al estilo del widget
 * de Tareas. Una fila por proceso: puerto, qué es, repo · rama (distingue worktrees), cuánto lleva y el
 * agente de omni que lo levantó. Overlay `ports`: `J K` cursor, `⏎` abrir en omni, `O` en el navegador
 * del sistema, `C` copiar URL, `G` ir a su terminal, `X X` detener, `/` filtrar, `H` plegar Sistema,
 * Esc cierra (desde el filtro, vuelve a la lista).
 */
export function PortsWidget(): JSX.Element {
  const list = usePorts((s) => s.list)
  const loaded = usePorts((s) => s.loaded)
  const cursor = usePorts((s) => s.cursor)
  const query = usePorts((s) => s.query)
  const systemOpen = usePorts((s) => s.systemOpen)
  const armed = usePorts((s) => s.armed)
  const stopping = usePorts((s) => s.stopping)
  const notice = usePorts((s) => s.notice)
  const filtering = usePorts((s) => s.filtering)
  const actions = usePorts.getState
  const sessions = useSessions()
  const closeOverlay = useUi((s) => s.closeOverlay)
  const now = useClock((c) => c.now)
  useSettings((s) => s.settings.keys)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)

  const filtered = query.trim() !== ''
  // Como el "Active Workspace" de Orca: lo del workspace actual arriba, el resto después.
  const here = hereNow()
  const groups = groupPorts(list, query, here)
  const showSystem = systemOpen || filtered
  const all = groupPorts(list)
  const total = all.dev.length
  // Nombre visible: el del proyecto; un worktree lleva además el suyo (`acme · cc-51`). El workspace local se llama "Local".
  const hereWs = sessions.workspaces.find((w) => w.id === sessions.currentWorkspaceId)
  const hereProject = sessions.projects.find((p) => p.id === hereWs?.projectId)?.name
  const hereName = hereWs ? (hereWs.kind === 'worktree' ? `${hereProject ?? ''} · ${hereWs.name}` : (hereProject ?? hereWs.name)) : 'este proyecto'
  const toggleKey = globalKey('ports.toggle')
  const home = homeOf(sessions.workspaces.map((w) => w.path))

  // Al abrir, lista fresca (el foco lo maneja Widget).
  useEffect(() => {
    void actions().refresh()
  }, [actions])

  // `ports.filter`: el filtro toma el foco, también con el widget ya abierto.
  useEffect(() => {
    if (!filtering) return
    fieldRef.current?.focus()
    actions().setFiltering(false)
  }, [filtering, actions])

  useEffect(() => {
    listRef.current?.querySelector('[data-cursor]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const chord = chordOf(e.nativeEvent)
    const inField = e.target === fieldRef.current
    const act = (fn: () => void): void => {
      e.preventDefault()
      e.stopPropagation()
      fn()
    }
    if (chord === 'escape') return act(inField ? () => rootRef.current?.focus() : closeOverlay)
    // Desde el filtro las flechas mueven el cursor y ⏎ abre: se filtra y se elige sin salir del campo.
    if (chord === 'down') return act(() => actions().moveCursor(1))
    if (chord === 'up') return act(() => actions().moveCursor(-1))
    if (inField) {
      if (chord === 'enter' && cursor) act(() => void actions().open(cursor))
      return
    }
    if (chord === 'j') return act(() => actions().moveCursor(1))
    if (chord === 'k') return act(() => actions().moveCursor(-1))
    if (chord === '/' || chord === 'f') return act(() => fieldRef.current?.focus())
    if (chord === 'h') return act(() => actions().setSystemOpen(!systemOpen))
    if (chord === 'r') return act(() => void actions().refresh())
    if (cursor === null) return
    if (chord === 'enter') return act(() => void actions().open(cursor))
    if (chord === 'o' || chord === 'shift+enter') return act(() => actions().openExternal(cursor))
    if (chord === 'c') return act(() => void actions().copyUrl(cursor))
    if (chord === 'g') return act(() => actions().goTo(cursor))
    if (chord === 'x') return act(() => void actions().stop(cursor))
  }

  const renderPort = (p: ListeningProcess): JSX.Element => {
    const id = portRowId(p)
    const session = p.sessionId ? sessions.sessions.find((s) => s.id === p.sessionId) : undefined
    const agent = session ? agentOf(sessions, session.agent) : undefined
    const place = portPlace(p, home)
    const extra = extraPorts(p)
    const isArmed = armed === id
    const isStopping = stopping[id] === true
    const second = isStopping ? 'Deteniendo' : isArmed ? 'X otra vez para detener' : [place, extra].filter(Boolean).join(' · ')
    const where = loopbackOnly(p) ? 'solo esta máquina' : 'visible en la red'
    const title = `${portUrl(p)} · ${p.command}${p.cwd && p.cwd !== '/' ? `\n${p.cwd}` : ''}\npid ${p.pid} · ${where}${agent ? ` · lanzado desde ${agent.name}` : ''}`
    return (
      <Row key={id} id={domId(id)} multiline cursor={cursor === id} status={isArmed || isStopping ? 'stopping' : undefined} title={title} onClick={() => actions().setCursor(id)} onDoubleClick={() => void actions().open(id)}>
        <span className="ports__port">{p.ports[0]}</span>
        <RowLines>
          <RowLine>
            <RowLabel>{p.name}</RowLabel>
            <RowTime title={p.startedAt ? `Arriba desde ${new Date(p.startedAt).toLocaleString()}` : undefined}>{uptimeLabel(p.startedAt, now)}</RowTime>
          </RowLine>
          {second && <RowLine muted>{second}</RowLine>}
        </RowLines>
        {agent && (
          <RowEnd>
            <Badge title={`Lo levantó ${agent.name} en omni`}>{agent.badge}</Badge>
          </RowEnd>
        )}
        <RowActions>
          <IconButton label="Abrir en omni (⏎)" onClick={() => void actions().open(id)}>
            <Globe {...ICON_SM} />
          </IconButton>
          <IconButton label="Copiar URL (C)" onClick={() => void actions().copyUrl(id)}>
            <Copy {...ICON_SM} />
          </IconButton>
          {p.sessionId && (
            <IconButton label="Ir a su terminal (G)" onClick={() => actions().goTo(id)}>
              <MoveUpRight {...ICON_SM} />
            </IconButton>
          )}
          {!p.self && (
            <IconButton label={isArmed ? 'Confirmar: detener (X)' : 'Detener (X dos veces)'} onClick={() => void actions().stop(id)}>
              <CircleStop {...ICON_SM} />
            </IconButton>
          )}
        </RowActions>
      </Row>
    )
  }

  const SystemChevron = showSystem ? ChevronDown : ChevronRight
  const cursorVisible = cursor !== null && list.some((p) => portRowId(p) === cursor)
  const nothing = loaded && groups.dev.length === 0 && groups.system.length === 0

  return (
    <Widget
      name="ports"
      title="Puertos"
      shortcut={toggleKey}
      value={total}
      valueLabel={total === 1 ? 'servicio levantado' : 'servicios levantados'}
      label={`Puertos, ${total} ${total === 1 ? 'servicio levantado' : 'servicios levantados'}`}
      rootRef={rootRef}
      onClose={closeOverlay}
      onKeyDown={onKeyDown}
      foot={
        notice ? (
          <span className="ports__notice">{notice}</span>
        ) : (
          <>
            <Hint kbd="⏎">abrir</Hint>
            <Hint kbd="C">copiar</Hint>
            <Hint kbd="G">terminal</Hint>
            <Hint kbd="X">detener</Hint>
          </>
        )
      }
    >
        <label className="ports__filter">
          <Search {...ICON_SM} aria-hidden="true" />
          <TextInput ref={fieldRef} value={query} placeholder="Filtrar por puerto, repo o rama" label="Filtrar puertos" onChange={(q) => actions().setQuery(q)} />
          <Kbd>/</Kbd>
        </label>

        <div ref={listRef} className="ports__list" role="listbox" aria-label="Puertos en escucha" aria-activedescendant={cursorVisible ? domId(cursor) : undefined}>
          {nothing && (
            <Empty title={filtered ? 'Nada coincide' : 'Nada levantado'}>
              {filtered ? 'Prueba con otro puerto, repo o rama' : 'Cuando levantes un servidor aparece aquí'}
            </Empty>
          )}
          {loaded && !nothing && groups.here.length + groups.dev.length === 0 && <p className="ports__none">{filtered ? 'Ningún servicio coincide' : 'Ningún servicio levantado'}</p>}
          {groups.here.length > 0 && (
            <div className="ports__group" data-static>
              <span className="ports__group-name">En {hereName}</span>
              <RowCount>{groups.here.length}</RowCount>
            </div>
          )}
          {groups.here.map(renderPort)}
          {groups.here.length > 0 && groups.dev.length > 0 && (
            <div className="ports__group" data-static>
              <span className="ports__group-name">Otros</span>
              <RowCount>{groups.dev.length}</RowCount>
            </div>
          )}
          {groups.dev.map(renderPort)}
          {groups.system.length > 0 && (
            <button type="button" className="ports__group" tabIndex={-1} aria-expanded={showSystem} title={showSystem ? 'Plegar (H)' : 'Desplegar (H)'} onMouseDown={(e) => e.preventDefault()} onClick={() => actions().setSystemOpen(!systemOpen)}>
              <SystemChevron {...ICON_SM} aria-hidden="true" />
              <span className="ports__group-name">Sistema</span>
              <RowCount title={`${groups.system.length} ${groups.system.length === 1 ? 'app del sistema' : 'apps del sistema'}`}>{groups.system.length}</RowCount>
            </button>
          )}
          {showSystem && groups.system.map(renderPort)}
        </div>

    </Widget>
  )
}
