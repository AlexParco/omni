import { useEffect, useRef, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import type { Project, Workspace } from '@shared/types'
import { commands } from '@/core/commands/registry'
import { prettyChord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { blurTerminals } from '@/panes/terminal/terminal-host'
import { Badge } from '@/ui/Badge'
import { WindowHead } from '@/app/TitleBar'
import { Button, IconButton } from '@/ui/Button'
import { Dot } from '@/ui/Dot'
import { AgentIcon, ChevronDown, ChevronRight, Columns2, Ellipsis, EthernetPort, EyeOff, Folder, FolderPlus, GitCompare, ICON, ICON_SM, ListTodo, Plus, Search, Server } from '@/ui/icons'
import { Kbd } from '@/ui/Kbd'
import { NavItem } from '@/ui/NavItem'
import { Row, RowActions, RowChip, RowCount, RowEnd, RowLabel, RowMeta, chipOf } from '@/ui/Row'
import { runningRounds, useBroadcast } from '@/store/broadcast'
import { useClock } from '@/store/clock'
import { hostStateLabel, useHosts } from '@/store/hosts'
import { listRows, liveAgent, locationMeta, projectStatus, rowKey, sessionStatus, sessionTitle, shortPath, tabStatus, tabUnread, useSessions, visibleProjects, workspaceStatus, type SessionStatus } from '@/store/sessions'
import { useSettings } from '@/store/settings'
import { usePorts } from '@/store/ports'
import { pendingTodoCount } from '@/store/todos-logic'
import { useTodos } from '@/store/todos'
import { leaves, tabsOf, useLayout, type Tab } from '@/store/layout'
import { SIDEBAR_DEFAULT, useUi } from '@/store/ui'
import { useWorktrees, worktreeCount } from '@/store/worktrees'
import { branchOf } from '@/store/worktrees-logic'
import './sidebar.css'

/** Tiempo desde la última actividad, solo cuando ya pasó un minuto (como Orca: 49m, 3h). */
/** Lo que dice el punto de una fila (al pasar el mouse). */
const SIGNAL_LABEL: Record<'working' | 'question' | 'unread', string> = {
  working: 'Trabajando',
  question: 'Espera tu respuesta',
  unread: 'Terminó, sin revisar'
}

/**
 * Punto de una fila del sidebar: solo cuando hay algo que mirar (trabaja, pregunta o terminó sin que lo
 * vieras). En reposo y ya visto no lleva punto: un punto en cada fila no dice nada.
 */
function Signal({ status, unread }: { status: SessionStatus | null; unread: boolean }): JSX.Element | null {
  const signal = status === 'question' || status === 'working' ? status : unread ? 'unread' : null
  return signal ? <Dot status={signal} title={SIGNAL_LABEL[signal]} /> : null
}

function since(ts: number, now: number): string | null {
  const m = Math.floor((now - ts) / 60000)
  if (m < 1) return null
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

/** Id DOM de una fila, para `aria-activedescendant`. */
const domId = (key: string): string => `row-${key.replace(':', '-')}`

/** Atajo global vigente de un comando, ya formateado para una `Kbd`; nada escrito a mano. */
function globalKey(id: string): string | undefined {
  const chord = keymap.chordsFor(id).find((c) => c.layer === 'global')?.chord
  return chord ? prettyChord(chord) : undefined
}

/** Tooltip "Qué (atajo)" sin paréntesis vacíos cuando el comando no tiene atajo. */
const withKey = (label: string, id: string): string => {
  const key = globalKey(id)
  return key ? `${label} (${key})` : label
}

/**
 * Sidebar: cabecera (nombre, ocultar, ajustes), buscar, navegación (Worktrees, Broadcast, Tareas, Puertos) y
 * la sección Proyectos: proyecto (pastilla de color, plegable) → tabs → panes si el tab tiene varios.
 * Compone primitivos de `ui/` (Row, NavItem, Dot, Badge, IconButton); aquí solo hay datos y contenedor.
 * Mouse: clic en un tab entra a su terminal; en un pane, a ese pane; en el proyecto lo pliega o
 * despliega; `…` abre el menú. Teclado: J/K recorren, ⏎ entra o pliega, N lanza, M menú, X cierra.
 */
export function Sidebar(): JSX.Element | null {
  const state = useSessions()
  const hostStatus = useHosts((s) => s.status)
  const hostList = useHosts((s) => s.hosts)
  const hostNames = Object.fromEntries(hostList.map((h) => [h.id, h.name]))
  const lay = useLayout()
  const now = useClock((c) => c.now)
  const focus = useUi((s) => s.focus)
  const collapsed = useUi((s) => s.collapsed)
  const hidden = useUi((s) => s.sidebarCollapsed)
  const width = useUi((s) => s.sidebarWidth)
  const showHidden = useUi((s) => s.showHidden)
  const pendingTodos = useTodos((s) => pendingTodoCount(s.todos))
  const devPorts = usePorts((s) => s.list.filter((p) => p.kind === 'dev').length)
  const view = useUi((s) => s.view)
  // Rama de cada worktree (§3.15): `omni/<name>` hasta que llegue el estado de main.
  const worktreeStatuses = useWorktrees((s) => s.statuses)
  // Aviso transitorio de `project.remove`: los worktrees con cambios que main conserva en disco.
  const worktreeNotice = useWorktrees((s) => s.notice)
  const worktrees = worktreeCount(state)
  // Rondas de broadcast en marcha (§3.18): el conteo del ítem.
  const rounds = useBroadcast((s) => runningRounds(s))
  const setCollapsed = useUi((s) => s.setCollapsed)
  // Los atajos pintados salen del keymap: se vuelve a pintar cuando el usuario los cambia.
  useSettings((s) => s.settings.keys)
  const listRef = useRef<HTMLDivElement>(null)
  const rows = listRows(state, lay, collapsed, showHidden)

  // El cursor nunca se sale de la vista al navegar con J/K.
  useEffect(() => {
    listRef.current?.querySelector('[data-cursor]')?.scrollIntoView({ block: 'nearest' })
  }, [state.cursor])

  if (hidden) return null

  const pick = (key: string): void => {
    blurTerminals()
    state.setCursor(key)
  }
  const enter = (key: string): void => {
    state.setCursor(key)
    void commands.run('session.enter')
  }
  const launchIn = (key: string): void => {
    pick(key)
    void commands.run('launcher.open')
  }
  const openMenu = (key: string): void => {
    pick(key)
    void commands.run('project.menu')
  }

  const renderTab = (tab: Tab, shown: boolean, nested: boolean): JSX.Element[] => {
    const key = rowKey.tab(tab.id)
    const panes = leaves(tab.root)
    const lead = panes.find((l) => l.id === tab.focusedPaneId) ?? panes[0]
    const session = state.sessions.find((x) => x.id === lead?.sessionId)
    const status = tabStatus(state, tab, now)
    const latest = Math.max(...panes.map((l) => state.activity[l.sessionId]?.lastOutput ?? 0), session?.createdAt ?? 0)
    const age = since(latest, now)
    const row = (
      <Row
        key={tab.id}
        id={domId(key)}
        level={1}
        nested={nested}
        cursor={state.cursor === key}
        active={shown}
        status={status}
        onClick={() => enter(key)}
        title="Clic o ⏎ para entrar"
      >
        {session && <AgentIcon agent={liveAgent(state, session, now)} size={16} />}
        <RowLabel>
          {session ? sessionTitle(state, session) : 'tab'}
          {panes.length > 1 && <RowCount title={`${panes.length} panes`}>{panes.length}</RowCount>}
        </RowLabel>
        {tab.zoomedPaneId && <Badge tone="mark">Z</Badge>}
        <RowEnd>
          {age && <span className="sidebar__time">{age}</span>}
          <Signal status={status} unread={tabUnread(state, tab)} />
        </RowEnd>
      </Row>
    )
    if (panes.length < 2) return [row]
    // Panes de un tab con split: fila de nivel 2 con guía; el que tiene el foco del layout va activo
    // (además del tab, que sigue marcando "lo que está en pantalla").
    const paneRows = panes.map((leaf) => {
      const paneKey = rowKey.pane(leaf.id)
      const paneSession = state.sessions.find((x) => x.id === leaf.sessionId)
      const paneStatus = sessionStatus(state, leaf.sessionId, now)
      return (
        <Row
          key={leaf.id}
          id={domId(paneKey)}
          level={2}
          nested={nested}
          guide
          cursor={state.cursor === paneKey}
          active={shown && leaf.id === tab.focusedPaneId}
          status={paneStatus}
          onClick={() => enter(paneKey)}
          title="Clic o ⏎ para enfocar este pane"
        >
          <RowLabel>{paneSession ? sessionTitle(state, paneSession) : 'pane'}</RowLabel>
          <RowEnd>
            <Signal status={paneStatus} unread={state.unread[leaf.sessionId] === true} />
          </RowEnd>
        </Row>
      )
    })
    return [row, ...paneRows]
  }

  /** Solo el tab que está en pantalla se marca activo: el de otros workspaces no, aunque sea su activo. */
  const renderTabs = (w: Workspace): JSX.Element[] => {
    const tabs = tabsOf(lay, w.id)
    const shown = w.id === state.currentWorkspaceId ? (lay.activeTab[w.id] ?? tabs[0]?.id) : null
    // Los tabs de la ubicación única cuelgan del proyecto; los de una carpeta o worktree, de esa fila.
    return tabs.flatMap((t) => renderTab(t, t.id === shown, w.kind !== 'local'))
  }

  /** Tarjeta de worktree (§3.15): nombre con estado, chip y rama en gris. El workspace local no la usa. */
  const renderWorkspace = (w: Workspace): JSX.Element => {
    const status = workspaceStatus(state, w.id, now)
    const key = rowKey.workspace(w.id)
    const branch = branchOf(w, worktreeStatuses[w.id])
    return (
      <div key={w.id} className="worktree" data-current={w.id === state.currentWorkspaceId || undefined}>
        <Row id={domId(key)} level={1} cursor={state.cursor === key} onClick={() => pick(key)} onDoubleClick={() => launchIn(key)} title={`${branch} · ${w.path} · doble clic o ⏎ para lanzar un agente`}>
          <Dot status={status ?? 'empty'} />
          <div className="worktree__body">
            <div className="worktree__line">
              <RowLabel strong>{w.name}</RowLabel>
              <RowActions>
                <IconButton label="Nuevo agente" title="Nuevo agente (N)" size="sm" onClick={() => launchIn(key)}>
                  <Plus {...ICON_SM} aria-hidden="true" />
                </IconButton>
                <IconButton label="Menú del proyecto" title="Menú (M)" size="sm" onClick={() => openMenu(key)}>
                  <Ellipsis {...ICON_SM} aria-hidden="true" />
                </IconButton>
              </RowActions>
            </div>
            <div className="worktree__line">
              <span className="worktree__chip">Worktree</span>
              <RowMeta>{branch}</RowMeta>
            </div>
          </div>
        </Row>
        {renderTabs(w)}
      </div>
    )
  }

  /**
   * Subcarpeta registrada (§3.5c): fila con su nombre y la ruta relativa en gris si no coincide; sus
   * tabs cuelgan debajo, como en un worktree. Fija el `cwd` de lo que se lance ahí.
   */
  const renderFolder = (w: Workspace, rel: string): JSX.Element => {
    const key = rowKey.workspace(w.id)
    const hostState = w.host ? (hostStatus[w.host]?.state ?? 'disconnected') : undefined
    const where = w.host ? `${hostNames[w.host] ?? 'servidor'} (${hostStateLabel(hostStatus[w.host])}) · ${w.path}` : shortPath(w.path)
    return (
      <div key={w.id} className="folder" data-current={w.id === state.currentWorkspaceId || undefined} data-host-state={hostState}>
        <Row id={domId(key)} level={1} cursor={state.cursor === key} onClick={() => pick(key)} onDoubleClick={() => launchIn(key)} title={`${where} · doble clic o ⏎ para lanzar un agente`}>
          {w.host ? <Server {...ICON_SM} aria-hidden="true" className="folder__icon" /> : <Folder {...ICON_SM} aria-hidden="true" className="folder__icon" />}
          <RowLabel strong>{w.name}</RowLabel>
          {/* Remota sin conexión: lo que importa es eso, no la ruta. */}
          {hostState && hostState !== 'connected' ? <RowMeta>{hostStateLabel(hostStatus[w.host ?? ''])}</RowMeta> : rel !== w.name && <RowMeta>{rel}</RowMeta>}
          <RowActions>
            <IconButton label="Nuevo agente" title="Nuevo agente (N)" size="sm" onClick={() => launchIn(key)}>
              <Plus {...ICON_SM} aria-hidden="true" />
            </IconButton>
            <IconButton label="Menú del proyecto" title="Menú (M)" size="sm" onClick={() => openMenu(key)}>
              <Ellipsis {...ICON_SM} aria-hidden="true" />
            </IconButton>
          </RowActions>
        </Row>
        {renderTabs(w)}
      </div>
    )
  }

  /**
   * Fila de proyecto: pastilla de color + nombre, plegable (§3.5c). Con una sola ubicación la representa
   * (`local`): sus tabs cuelgan directo debajo. Con dos o más es la cabecera del grupo y cada ubicación
   * tiene su fila con sus tabs. Sin carpetas, una pista para agregar la primera.
   */
  const renderProject = (p: Project): JSX.Element => {
    const key = rowKey.project(p.id)
    const open = !collapsed[p.id]
    const workspaces = state.workspaces.filter((w) => w.projectId === p.id)
    const local = workspaces.find((w) => w.kind === 'local')
    const folders = workspaces.filter((w) => w.kind === 'folder')
    const worktrees = workspaces.filter((w) => w.kind === 'worktree')
    const empty = p.locations.length === 0
    const status = projectStatus(state, p.id, now)
    const unreadIn = state.sessions.some((x) => state.unread[x.id] === true && workspaces.some((w) => w.id === x.workspaceId))
    const current = workspaces.some((w) => w.id === state.currentWorkspaceId)
    const tabCount = workspaces.reduce((n, w) => n + tabsOf(lay, w.id).length, 0)
    const Chevron = open ? ChevronDown : ChevronRight
    const toggle = (): void => {
      pick(key)
      setCollapsed(p.id, open)
    }
    return (
      <section key={p.id} className="sidebar__group" aria-label={p.name}>
        <Row id={domId(key)} level={0} cursor={state.cursor === key} expanded={open} onClick={toggle} title={`${p.locations.map((l) => (l.host ? `${hostNames[l.host] ?? 'servidor'}:${l.path}` : shortPath(l.path))).join(' · ')} · ${open ? 'clic o H para plegar' : 'clic o L para desplegar'}`}>
          <RowChip color={chipOf(p.id)}>
            <Folder size={13} strokeWidth={2.25} />
          </RowChip>
          <RowLabel>
            {p.name}
            {tabCount > 0 && <RowCount title={`${tabCount} ${tabCount === 1 ? 'agente' : 'agentes'}`}>{tabCount}</RowCount>}
            {/* Dentro de la etiqueta: fuera de ella se montaba sobre los botones de la fila. */}
            {p.hidden && <EyeOff {...ICON_SM} aria-label="Proyecto oculto" className="sidebar__hidden-mark" />}
          </RowLabel>
          {/* Única ubicación remota: la marca va en el proyecto; con varias, cada fila lleva su icono. */}
          {local?.host && <Server {...ICON_SM} aria-label={`En ${hostNames[local.host] ?? 'un servidor'} (${hostStateLabel(hostStatus[local.host])})`} className="sidebar__host-mark" data-host-state={hostStatus[local.host]?.state ?? 'disconnected'} />}
          {/* Plegado, el punto resume lo que esconde; desplegado, cada fila lleva el suyo. */}
          {!open && (
            <RowEnd>
              <Signal status={status} unread={unreadIn} />
            </RowEnd>
          )}
          <RowActions>
            <IconButton label="Menú del proyecto" title="Menú (M)" size="sm" onClick={() => openMenu(key)}>
              <Ellipsis {...ICON_SM} aria-hidden="true" />
            </IconButton>
            <IconButton label={open ? 'Plegar' : 'Desplegar'} title={open ? 'Plegar (H)' : 'Desplegar (L)'} size="sm" onClick={toggle}>
              <Chevron {...ICON_SM} aria-hidden="true" className="row__chevron" />
            </IconButton>
          </RowActions>
        </Row>
        {open && local && renderTabs(local)}
        {open && local && tabCount === 0 && folders.length === 0 && worktrees.length === 0 && (
          <div className="sidebar__hint">
            Sin agentes · <Kbd>{current && focus === 'list' ? 'N' : (globalKey('launcher.open') ?? '⌘T')}</Kbd> para lanzar uno
          </div>
        )}
        {open && empty && (
          <div className="sidebar__hint">
            Sin carpetas · <Kbd>⏎</Kbd> para agregar una
          </div>
        )}
        {open && folders.map((w) => renderFolder(w, locationMeta(p, w, w.host ? hostNames[w.host] : undefined)))}
        {open && worktrees.map(renderWorkspace)}
      </section>
    )
  }

  const cursorRow = rows.find((r) => r.key === state.cursor)
  const searchKey = globalKey('quickopen.open')
  const todoKey = globalKey('todo.toggle')
  const portsKey = globalKey('ports.toggle')
  const worktreesKey = globalKey('worktrees.open')
  const broadcastKey = globalKey('broadcast.open')

  return (
    <nav className="sidebar" data-focus={focus} aria-label="Sidebar" style={width !== SIDEBAR_DEFAULT ? { width } : undefined}>
      <div className="sidebar__head">
        <WindowHead sidebarVisible />
      </div>

      <button className="sidebar__search" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => void commands.run('quickopen.open')}>
        <Search {...ICON} aria-hidden="true" />
        <span>Buscar</span>
        {searchKey && <Kbd>{searchKey}</Kbd>}
      </button>

      <div className="sidebar__nav">
        <NavItem
          icon={<GitCompare {...ICON} aria-hidden="true" />}
          active={view === 'worktrees'}
          title={withKey(worktrees > 0 ? `Worktrees: ${worktrees} ${worktrees === 1 ? 'activo' : 'activos'}` : 'Worktrees: un agente, un worktree', 'worktrees.open')}
          count={worktrees}
          end={worktreesKey && <Kbd>{worktreesKey}</Kbd>}
          onClick={() => void commands.run('worktrees.open')}
        >
          Worktrees
        </NavItem>
        <NavItem
          icon={<Columns2 {...ICON} aria-hidden="true" />}
          active={view === 'broadcast'}
          title={withKey(rounds > 0 ? `Broadcast: ${rounds} ${rounds === 1 ? 'ronda en marcha' : 'rondas en marcha'}` : 'Broadcast: un prompt a varios agentes', 'broadcast.open')}
          count={rounds}
          end={broadcastKey && <Kbd>{broadcastKey}</Kbd>}
          onClick={() => void commands.run('broadcast.open')}
        >
          Broadcast
        </NavItem>
        <NavItem
          icon={<ListTodo {...ICON} aria-hidden="true" />}
          title={withKey(pendingTodos > 0 ? `Tareas: ${pendingTodos} ${pendingTodos === 1 ? 'pendiente' : 'pendientes'} hoy` : 'Tareas de hoy', 'todo.toggle')}
          count={pendingTodos}
          end={todoKey && <Kbd>{todoKey}</Kbd>}
          onClick={() => void commands.run('todo.toggle')}
        >
          Tareas
        </NavItem>
        <NavItem
          icon={<EthernetPort {...ICON} aria-hidden="true" />}
          title={withKey(devPorts > 0 ? `Puertos: ${devPorts} ${devPorts === 1 ? 'servicio levantado' : 'servicios levantados'}` : 'Puertos: servicios en escucha', 'ports.toggle')}
          count={devPorts}
          end={portsKey && <Kbd>{portsKey}</Kbd>}
          onClick={() => void commands.run('ports.toggle')}
        >
          Puertos
        </NavItem>
        {worktreeNotice && (
          <p className="sidebar__hint" role="status">
            {worktreeNotice}
          </p>
        )}
      </div>

      <div className="sidebar__section">
        <span>Proyectos</span>
        {/* Solo con los ocultos a la vista: así el botón no delata que existen. */}
        {showHidden && (
          <IconButton label="Volver a esconder los ocultos" title={withKey('Volver a esconder los proyectos ocultos', 'project.showHidden')} size="sm" onClick={() => void commands.run('project.showHidden')}>
            <EyeOff {...ICON_SM} aria-hidden="true" />
          </IconButton>
        )}
        <IconButton label="Agregar proyecto" title="Nuevo proyecto o abrir una carpeta" size="sm" onClick={() => void commands.run('project.add')}>
          <Plus {...ICON_SM} aria-hidden="true" />
        </IconButton>
      </div>

      <div
        className="sidebar__list"
        ref={listRef}
        role="listbox"
        aria-label="Proyectos y tabs"
        aria-activedescendant={cursorRow ? domId(cursorRow.key) : undefined}
        tabIndex={-1}
      >
        {rows.length === 0 && state.projects.length > 0 && (
          <div className="sidebar__empty">
            <p>Todos los proyectos están ocultos.</p>
            <Button kbd={globalKey('project.showHidden')} onClick={() => void commands.run('project.showHidden')}>
              <span>Mostrar ocultos</span>
            </Button>
          </div>
        )}
        {rows.length === 0 && state.projects.length === 0 && (
          <div className="sidebar__empty">
            <p>Sin proyectos todavía.</p>
            <Button variant="primary" kbd={globalKey('project.open')} onClick={() => void commands.run('project.open')}>
              <FolderPlus {...ICON_SM} aria-hidden="true" />
              <span>Abrir proyecto</span>
            </Button>
            <Button kbd={globalKey('project.new')} onClick={() => void commands.run('project.new')}>
              <Plus {...ICON_SM} aria-hidden="true" />
              <span>Nuevo proyecto</span>
            </Button>
          </div>
        )}
        {visibleProjects(state.projects, showHidden).map(renderProject)}
      </div>
      <SidebarResizer />

    </nav>
  )
}

/**
 * Borde derecho del sidebar: arrastrarlo cambia el ancho (`ui.sidebarWidth`, entre `SIDEBAR_MIN` y
 * `SIDEBAR_MAX`, recordado entre recargas); doble clic vuelve al de por defecto. Mientras se arrastra,
 * las vistas nativas (navegador) se esconden para no tragarse el mouse, igual que con los divisores del layout.
 */
function SidebarResizer(): JSX.Element {
  const startDrag = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0
    const onMove = (ev: MouseEvent): void => useUi.getState().setSidebarWidth(ev.clientX - left)
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      delete document.body.dataset.dragging
      useUi.getState().setDragging(false)
    }
    document.body.dataset.dragging = 'row'
    useUi.getState().setDragging(true)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  return <div className="sidebar__resizer" role="separator" aria-orientation="vertical" aria-label="Ancho del sidebar" title="Arrastra para cambiar el ancho · doble clic lo restaura" onMouseDown={startDrag} onDoubleClick={() => useUi.getState().setSidebarWidth(SIDEBAR_DEFAULT)} />
}
