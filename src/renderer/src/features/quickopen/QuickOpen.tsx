import { useEffect, useMemo, useRef, type JSX, type KeyboardEvent, type MouseEvent } from 'react'
import type { FileHit, SessionInfo } from '@shared/types'
import { commands, type Command } from '@/core/commands/registry'
import { chordOf } from '@/core/keys/chord'
import { hintFor } from '@/features/palette/Palette'
import { useClock } from '@/store/clock'
import { useCost } from '@/store/cost'
import { sessionCostLabel } from '@/store/cost-logic'
import { activeTabOf, leaves, useLayout } from '@/store/layout'
import { useQuickOpen } from '@/store/quickopen'
import { STATUS_LABEL, agentOf, sessionStatus, sessionTitle, shortPath, useSessions, workspaceOf, type SessionStatus } from '@/store/sessions'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { Badge } from '@/ui/Badge'
import { Highlight, type HighlightRange } from '@/ui/Highlight'
import { Hint } from '@/ui/Hint'
import { AgentIcon, Command as CommandIcon, File, Folder, ICON, Search } from '@/ui/icons'
import { Kbd } from '@/ui/Kbd'
import { Row, RowEnd, RowLabel, RowMeta } from '@/ui/Row'
import { Toggle } from '@/ui/Toggle'
import { openAgent, openFile, openProjectPath, runCommand } from './actions'
import { KIND_LABEL, KINDS, LIMIT_ALL, LIMIT_KIND, PREFIX, completePath, nextKind, parseQuery, pathQuery, rank, withKind, type Range } from './search'
import '@/ui/overlay.css'
import './quickopen.css'

type Item =
  | { kind: 'agent'; id: string; session: SessionInfo; title: string; status: SessionStatus; ranges: Range[] }
  | { kind: 'command'; id: string; command: Command; kbd: string | undefined; ranges: Range[] }
  | { kind: 'file'; id: string; hit: FileHit; ranges: Range[] }
  /** Carpeta sugerida para la ruta escrita: ⏎ la abre como proyecto (§3.11). */
  | { kind: 'folder'; id: string; path: string }

const STATUS_RANK: Record<SessionStatus, number> = { question: 0, working: 1, idle: 2 }

/** Id DOM de un resultado, solo para `aria-activedescendant` (colapsa caracteres: no sirve de `key`). */
const domId = (item: Item): string => `qo-${item.kind}-${item.id.replace(/[^a-z0-9_-]/gi, '-')}`

/** Tiempo transcurrido con segundos: `40s`, `2m 14s`, `1h 03m`. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/**
 * Quick open ⌘K (ARCHITECTURE §3.11): un campo con prefijos `:` `@` `/`, chips de tipo, resultados
 * agrupados (Agentes, Comandos, Archivos) y un panel con el detalle del activo. El foco DOM vive en el
 * input (patrón combobox, como ListPicker): ↑↓ o C-j/C-k mueven, Tab rota el tipo, ⏎ abre, ⌘⏎ y ⌥⏎
 * son las variantes, Esc cierra y devuelve el foco a quien lo tenía.
 */
export function QuickOpen(): JSX.Element {
  const closeOverlay = useUi((s) => s.closeOverlay)
  const focus = useUi((s) => s.focus)
  const query = useQuickOpen((s) => s.query)
  const index = useQuickOpen((s) => s.index)
  const files = useQuickOpen((s) => s.files)
  const paths = useQuickOpen((s) => s.paths)
  const suggestPaths = useQuickOpen((s) => s.suggestPaths)
  const branches = useQuickOpen((s) => s.branches)
  const setQuery = useQuickOpen((s) => s.setQuery)
  const setIndex = useQuickOpen((s) => s.setIndex)
  const searchFiles = useQuickOpen((s) => s.searchFiles)
  const loadBranch = useQuickOpen((s) => s.loadBranch)
  const state = useSessions()
  const lay = useLayout()
  const now = useClock((c) => c.now)
  const costSummary = useCost((c) => c.summary)
  // Los atajos pintados salen del keymap: se vuelve a pintar cuando el usuario los cambia.
  useSettings((s) => s.settings.keys)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Una ruta (`~/repo`, `/Users/yo/repo`) cambia de modo: solo se listan carpetas para abrir como proyecto.
  const path = pathQuery(query)
  const parsed = parseQuery(query)
  const kind = path === null ? parsed.kind : 'all'
  const text = path === null ? parsed.text : ''
  const limit = kind === 'all' ? LIMIT_ALL : LIMIT_KIND

  const agents = useMemo((): Item[] => {
    if (path !== null || (kind !== 'all' && kind !== 'agent')) return []
    // Se busca en el título y en el nombre del agente ("claude" encuentra un Claude Code con título propio);
    // los rangos se recortan al título, que es lo que se pinta.
    const hits = rank(state.sessions, text, (s) => `${sessionTitle(state, s)} ${agentOf(state, s.agent)?.name ?? ''}`)
    const items = hits.map(({ item: session, match }) => {
      const title = sessionTitle(state, session)
      const ranges = match.ranges.filter(([start]) => start < title.length).map(([start, end]): Range => [start, Math.min(end, title.length)])
      return { kind: 'agent' as const, id: session.id, session, title, status: sessionStatus(state, session.id, now), ranges, score: match.score }
    })
    const last = (s: SessionInfo): number => state.activity[s.id]?.lastOutput ?? s.createdAt
    items.sort((a, b) => (text ? b.score - a.score : 0) || STATUS_RANK[a.status] - STATUS_RANK[b.status] || last(b.session) - last(a.session))
    return items.slice(0, limit).map(({ score: _s, ...item }) => item)
  }, [path, kind, text, state, now, limit])

  // Sin memo: `commands.list()` depende de `when()` de cada comando, que lee estado fuera de React.
  const cmds: Item[] =
    path === null && (kind === 'all' || kind === 'command')
      ? rank(commands.list().filter((c) => c.id !== 'quickopen.open'), text, (c) => c.title)
          .slice(0, limit)
          .map(({ item: command, match }) => ({ kind: 'command', id: command.id, command, kbd: hintFor(command.id, focus), ranges: match.ranges }))
      : []

  const fileItems = useMemo((): Item[] => {
    if ((kind !== 'all' && kind !== 'file') || !text) return []
    // Main ya filtró y ordenó; aquí solo se calculan los rangos para resaltar.
    return files.slice(0, limit).map((hit) => ({ kind: 'file', id: hit.path, hit, ranges: rank([hit], text, (h) => h.rel)[0]?.match.ranges ?? [] }))
  }, [kind, text, files, limit])

  const folderItems: Item[] = path === null ? [] : paths.map((p) => ({ kind: 'folder', id: p, path: p }))

  const groups = [
    { title: 'Carpetas', items: folderItems },
    { title: 'Agentes', items: agents },
    { title: 'Comandos', items: cmds },
    { title: 'Archivos', items: fileItems }
  ].filter((g) => g.items.length > 0)
  const flat = groups.flatMap((g) => g.items)
  const idx = flat.length > 0 ? Math.min(index, flat.length - 1) : 0
  const active: Item | undefined = flat[idx]

  // Archivos: a main con debounce; sin consulta (o con prefijo de otro tipo) no se listan.
  useEffect(() => {
    searchFiles(path === null && (kind === 'all' || kind === 'file') ? text : null, limit)
  }, [path, kind, text, limit, searchFiles])
  useEffect(() => {
    suggestPaths(path)
  }, [path, suggestPaths])

  // Rama del workspace del resultado activo, con cache en el store.
  const activeWorkspaceId = active ? (active.kind === 'agent' ? active.session.workspaceId : active.kind === 'file' ? active.hit.workspaceId : null) : null
  useEffect(() => {
    if (activeWorkspaceId) loadBranch(activeWorkspaceId)
  }, [activeWorkspaceId, loadBranch])

  // Quién tenía el foco antes de abrir, para devolvérselo al cerrar (misma regla que ListPicker).
  const prevFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = document.activeElement as HTMLElement | null
    if (el && !el.closest('.overlay')) prevFocus.current = el
    inputRef.current?.focus()
    return () => {
      // Si la acción abrió otro overlay (el launcher, una confirmación), el foco ya es suyo: no se le quita.
      if (useUi.getState().overlay !== null) return
      const prev = prevFocus.current
      if (prev?.isConnected && (document.activeElement === document.body || document.activeElement === null)) prev.focus()
    }
  }, [])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [idx, flat.length])

  const move = (delta: number): void => {
    if (flat.length > 0) setIndex((idx + delta + flat.length) % flat.length)
  }
  const pick = (item: Item, mods: { cmd: boolean; alt: boolean; shift: boolean }): void => {
    if (item.kind === 'agent') openAgent(item.id, mods.cmd)
    else if (item.kind === 'command') runCommand(item.command.id)
    else if (item.kind === 'folder') openProjectPath(item.path)
    else openFile(item.hit, mods.cmd ? 'open' : mods.alt ? 'reveal' : mods.shift ? 'system' : 'insert')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const chord = chordOf(e.nativeEvent)
    const act = (fn: () => void): void => {
      e.preventDefault()
      e.stopPropagation()
      fn()
    }
    if (chord === 'escape') return act(closeOverlay)
    // Escribiendo una ruta, Tab completa con la carpeta activa (como en el shell) en vez de rotar el tipo.
    if (chord === 'tab' && active?.kind === 'folder') return act(() => setQuery(completePath(query, active.path)))
    if (chord === 'tab') return act(() => setQuery(withKind(query, nextKind(kind))))
    if (chord === 'shift+tab') return act(() => setQuery(withKind(query, nextKind(kind, -1))))
    if (chord === 'down' || chord === 'ctrl+j' || chord === 'ctrl+n') return act(() => move(1))
    if (chord === 'up' || chord === 'ctrl+k' || chord === 'ctrl+p') return act(() => move(-1))
    if (chord === 'enter' || chord === 'cmd+enter' || chord === 'alt+enter' || chord === 'shift+enter') return act(() => active && pick(active, { cmd: chord === 'cmd+enter', alt: chord === 'alt+enter', shift: chord === 'shift+enter' }))
  }
  const onClickRow = (item: Item) => (e: MouseEvent<HTMLDivElement>) => pick(item, { cmd: e.metaKey, alt: e.altKey, shift: e.shiftKey })

  /** La sesión está en pantalla: su tab es el activo del workspace actual y ningún otro pane está en zoom. */
  const onScreen = (id: string): boolean => {
    const ws = state.currentWorkspaceId
    const tab = ws ? activeTabOf(lay, ws) : undefined
    const leaf = tab && leaves(tab.root).find((l) => l.sessionId === id)
    return !!tab && !!leaf && (tab.zoomedPaneId === null || tab.zoomedPaneId === leaf.id)
  }
  const branchOf = (workspaceId: string): string => {
    const b = branches[workspaceId]
    return b ? (b.name ?? 'sin repo') : ''
  }

  const renderItem = (item: Item, i: number): JSX.Element => {
    const isActive = i === idx
    const id = domId(item)
    const end = <RowEnd>{isActive && <Kbd>⏎</Kbd>}</RowEnd>
    let body: JSX.Element
    if (item.kind === 'agent') {
      body = (
        <>
          <AgentIcon agent={item.session.agent} size={16} />
          <RowLabel>
            <Highlight text={item.title} ranges={item.ranges} />
          </RowLabel>
          <span className="quickopen__status" data-status={item.status}>
            {STATUS_LABEL[item.status]}
          </span>
        </>
      )
    } else if (item.kind === 'command') {
      body = (
        <>
          <CommandIcon {...ICON} aria-hidden="true" className="quickopen__icon" />
          <RowLabel>
            <Highlight text={item.command.title} ranges={item.ranges} />
          </RowLabel>
          {item.kbd && <Kbd>{item.kbd}</Kbd>}
        </>
      )
    } else if (item.kind === 'folder') {
      const cut = item.path.lastIndexOf('/') + 1
      body = (
        <>
          <Folder {...ICON} aria-hidden="true" className="quickopen__icon" />
          <RowLabel>{item.path.slice(cut)}</RowLabel>
          <RowMeta>{shortPath(item.path.slice(0, cut))}</RowMeta>
        </>
      )
    } else {
      body = (
        <>
          <File {...ICON} aria-hidden="true" className="quickopen__icon" />
          {/* Nombre del archivo como etiqueta y carpeta como meta: el final de la ruta es lo que distingue
              dos resultados, y un recorte por la derecha lo escondería. */}
          <RowLabel>
            <Highlight text={item.hit.rel.slice(item.hit.rel.lastIndexOf('/') + 1)} ranges={shiftRanges(item.ranges, item.hit.rel.lastIndexOf('/') + 1, item.hit.rel.length)} />
          </RowLabel>
          <RowMeta>
            <Highlight text={item.hit.rel.slice(0, item.hit.rel.lastIndexOf('/') + 1)} ranges={shiftRanges(item.ranges, 0, item.hit.rel.lastIndexOf('/') + 1)} />
          </RowMeta>
        </>
      )
    }
    // `Row` no expone mouseenter: el envoltorio mueve el cursor al pasar el mouse, como en ListPicker.
    return (
      <div key={`${item.kind}:${item.id}`} className="quickopen__item" onMouseEnter={() => setIndex(i)}>
        <Row id={id} level={1} cursor={isActive} onClick={onClickRow(item)}>
          {body}
          {end}
        </Row>
      </div>
    )
  }

  const renderDetail = (): JSX.Element | null => {
    if (!active) return null
    const prop = (key: string, value: JSX.Element | string, mono?: boolean, status?: SessionStatus): JSX.Element => (
      <div className="quickopen__prop" key={key}>
        <span className="quickopen__key">{key}</span>
        <span className="quickopen__value" data-mono={mono || undefined} data-status={status}>
          {value}
        </span>
      </div>
    )
    if (active.kind === 'agent') {
      const s = active.session
      const def = agentOf(state, s.agent)
      const last = state.activity[s.id]?.lastOutput ?? s.createdAt
      // Piso según los logs locales (§3.17); sin registro no hay fila.
      const cost = sessionCostLabel(costSummary, s.id)
      const statusText = active.status === 'question' ? `${STATUS_LABEL.question} · ${elapsed(now - last)}` : STATUS_LABEL[active.status]
      return (
        <>
          <div className="quickopen__title">
            <AgentIcon agent={s.agent} size={16} />
            <span>{active.title}</span>
            {def && <Badge>{def.badge}</Badge>}
          </div>
          <div className="quickopen__props">
            {prop('estado', statusText, false, active.status)}
            {prop('cwd', shortPath(s.cwd), true)}
            {prop('rama', branchOf(s.workspaceId), true)}
            {prop('pane', onScreen(s.id) ? 'en pantalla' : 'en otro tab')}
            {cost && prop('costo', cost, true)}
          </div>
        </>
      )
    }
    if (active.kind === 'folder') {
      const known = state.projects.find((p) => p.locations.some((l) => !l.host && l.path === active.path))
      return (
        <>
          <div className="quickopen__title">
            <Folder {...ICON} aria-hidden="true" className="quickopen__icon" />
            <span>{active.path.slice(active.path.lastIndexOf('/') + 1)}</span>
          </div>
          <div className="quickopen__props">
            {prop('ruta', shortPath(active.path), true)}
            {prop('proyecto', known ? 'ya abierto en omni' : 'se abre como proyecto nuevo')}
          </div>
        </>
      )
    }
    if (active.kind === 'file') {
      const ws = workspaceOf(state, active.hit.workspaceId)
      return (
        <>
          <div className="quickopen__title">
            <File {...ICON} aria-hidden="true" className="quickopen__icon" />
            <span>{active.hit.rel.split('/').pop()}</span>
          </div>
          <div className="quickopen__props">
            {prop('ruta', shortPath(active.hit.path), true)}
            {prop('workspace', ws?.name ?? '')}
            {prop('rama', branchOf(active.hit.workspaceId), true)}
          </div>
        </>
      )
    }
    return (
      <>
        <div className="quickopen__title">
          <CommandIcon {...ICON} aria-hidden="true" className="quickopen__icon" />
          <span>{active.command.title}</span>
        </div>
        <div className="quickopen__props">
          {prop('grupo', active.command.group ?? 'General')}
          {prop('atajo', active.kbd ? <Kbd>{active.kbd}</Kbd> : 'sin atajo')}
        </div>
      </>
    )
  }

  const activeId = active ? domId(active) : undefined
  return (
    <div className="overlay" onMouseDown={closeOverlay}>
      <div className="quickopen" role="dialog" aria-modal="true" aria-label="Buscar" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="quickopen__head">
          <Search {...ICON} aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="quickopen-list"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            value={query}
            placeholder="Agentes, comandos, archivos o la ruta de un proyecto"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="quickopen__chips" role="group" aria-label="Tipo">
            {KINDS.map((k) => (
              <Toggle key={k} on={kind === k} title={k === 'all' ? 'Buscar en todo' : `Solo ${KIND_LABEL[k].toLowerCase()} (prefijo ${PREFIX[k]})`} onClick={() => setQuery(withKind(query, k))}>
                {k === 'all' ? KIND_LABEL.all : `${PREFIX[k]} ${KIND_LABEL[k]}`}
              </Toggle>
            ))}
          </div>
        </div>
        <div className="quickopen__body">
          <div id="quickopen-list" className="quickopen__list" ref={listRef} role="listbox" aria-label="Resultados" data-focus="list" tabIndex={-1}>
            {flat.length === 0 && <div className="quickopen__empty">{path !== null ? 'Ninguna carpeta con ese nombre.' : 'Nada que coincida.'}</div>}
            {groups.map((g) => {
              const offset = flat.indexOf(g.items[0])
              return (
                <div key={g.title} role="group" aria-label={g.title}>
                  <div className="quickopen__group" role="presentation">
                    {g.title}
                  </div>
                  {g.items.map((item, i) => renderItem(item, offset + i))}
                </div>
              )
            })}
          </div>
          <aside className="quickopen__detail" aria-label="Detalle">
            {renderDetail()}
            {active && active.kind !== 'folder' && (
              <div className="quickopen__detail-foot">
                <Hint kbd="Tab">tipo</Hint>
              </div>
            )}
          </aside>
        </div>
        <div className="quickopen__foot">
          <Hint kbd="↑↓">mover</Hint>
          <Hint kbd="⏎">abrir</Hint>
          {active?.kind === 'folder' ? (
            <Hint kbd="Tab">completar</Hint>
          ) : active?.kind === 'file' ? (
            <>
              <Hint kbd="⌘⏎">editor en split</Hint>
              <Hint kbd="⇧⏎">app del sistema</Hint>
              <Hint kbd="⌥⏎">Finder</Hint>
            </>
          ) : (
            <Hint kbd="⌘⏎">en split</Hint>
          )}
          <span className="quickopen__prefixes">
            prefijo <Kbd>:</Kbd> <Kbd>@</Kbd> <Kbd>/</Kbd> filtra
          </span>
        </div>
      </div>
    </div>
  )
}

/** Recorta los rangos de resaltado a `[from, to)` y los desplaza para un subtexto que empieza en `from`. */
function shiftRanges(ranges: readonly HighlightRange[], from: number, to: number): HighlightRange[] {
  const out: HighlightRange[] = []
  for (const [a, b] of ranges) {
    const start = Math.max(a, from)
    const end = Math.min(b, to)
    if (end > start) out.push([start - from, end - from])
  }
  return out
}
