import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { Todo } from '@shared/types'
import { commands } from '@/core/commands/registry'
import { chordOf, prettyChord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { Badge } from '@/ui/Badge'
import { IconButton } from '@/ui/Button'
import { Checkbox, type CheckboxState } from '@/ui/Checkbox'
import { Dot } from '@/ui/Dot'
import { Empty } from '@/ui/Empty'
import { Hint } from '@/ui/Hint'
import { Bot, ChevronDown, ChevronRight, ICON_SM, MoveUpRight, Plus, Trash2 } from '@/ui/icons'
import { Kbd } from '@/ui/Kbd'
import { Row, RowActions, RowCount, RowEnd, RowLabel } from '@/ui/Row'
import { TextInput } from '@/ui/TextInput'
import { useClock } from '@/store/clock'
import { agentOf, sessionStatus, useSessions } from '@/store/sessions'
import { useSettings } from '@/store/settings'
import { groupTodos, pendingTodoCount } from '@/store/todos-logic'
import { linkedSession, useTodos } from '@/store/todos'
import { useUi } from '@/store/ui'
import './todo.css'

/** Id DOM de la fila de una tarea, para `aria-activedescendant`. */
const domId = (id: string): string => `todo-${id}`

/** Atajo global vigente de un comando, ya formateado; nada escrito a mano. */
function globalKey(id: string): string | undefined {
  const chord = keymap.chordsFor(id).find((c) => c.layer === 'global')?.chord
  return chord ? prettyChord(chord) : undefined
}

/**
 * Widget To-do (ARCHITECTURE §3.12): modal al centro al estilo de un widget de macOS (material
 * translúcido, el número de pendientes en grande) con las tareas del día. Overlay
 * `todo`: mientras está abierto solo él recibe teclas. `J K` cursor, `X` hecha, `D`
 * borra (`⌘Z` deshace), `A` enfoca el campo, `⏎` lanza o entra al agente, `G` entra al agente, `H`
 * pliega o despliega Hecho, Esc cierra (desde el campo, vuelve a la lista). Compone primitivos de
 * `ui/`; aquí solo hay datos, teclas y contenedor. Cada tecla tiene su camino con mouse: la casilla
 * marca, y la fila con cursor (o bajo el mouse) muestra sus acciones.
 */
export function TodoWidget(): JSX.Element {
  const todos = useTodos((s) => s.todos)
  const cursor = useTodos((s) => s.cursor)
  const doneOpen = useTodos((s) => s.doneOpen)
  const composing = useTodos((s) => s.composing)
  const actions = useTodos.getState
  const sessions = useSessions()
  const closeOverlay = useUi((s) => s.closeOverlay)
  const now = useClock((c) => c.now)
  // El atajo pintado sale del keymap: se vuelve a pintar cuando el usuario lo cambia.
  useSettings((s) => s.settings.keys)
  const [draft, setDraft] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const prevFocus = useRef<HTMLElement | null>(null)

  const groups = groupTodos(todos, now)
  const pending = pendingTodoCount(todos)
  const toggleKey = globalKey('todo.toggle')
  const currentProjectId = sessions.workspaces.find((w) => w.id === sessions.currentWorkspaceId)?.projectId ?? null

  // Al abrir, el teclado va a la tarjeta; al cerrar vuelve a quien lo tenía, salvo que otro overlay
  // (el launcher tras ⏎) lo haya tomado: enfocar xterm ahí movería el tab activo y el workspace.
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && !active.closest('.todo-overlay')) prevFocus.current = active
    if (!rootRef.current?.contains(document.activeElement)) rootRef.current?.focus()
    return () => {
      const prev = prevFocus.current
      if (useUi.getState().overlay !== null) return
      if (prev?.isConnected && (document.activeElement === document.body || document.activeElement === null)) prev.focus()
    }
  }, [])

  // `todo.add`: el campo toma el foco, también con el widget ya abierto; la marca se consume aquí.
  useEffect(() => {
    if (!composing) return
    fieldRef.current?.focus()
    actions().setComposing(false)
  }, [composing, actions])

  // El cursor nunca se sale de la vista al navegar con J/K.
  useEffect(() => {
    listRef.current?.querySelector('[data-cursor]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const focusList = (): void => rootRef.current?.focus()
  const submit = (text: string): void => {
    if (actions().add(text, currentProjectId)) setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const chord = chordOf(e.nativeEvent)
    const inField = e.target === fieldRef.current
    const act = (fn: () => void): void => {
      e.preventDefault()
      e.stopPropagation()
      fn()
    }
    // Repetir el atajo que abrió el widget lo cierra: lo atiende `useKeyboard` (OPENER), no llega aquí.
    if (chord === 'escape') return act(inField ? focusList : closeOverlay)
    // Dentro del campo las teclas sueltas son texto; ⏎ lo atiende el propio TextInput.
    if (inField) return
    const id = cursor
    if (chord === 'j' || chord === 'down') return act(() => actions().moveCursor(1))
    if (chord === 'k' || chord === 'up') return act(() => actions().moveCursor(-1))
    if (chord === 'a') return act(() => fieldRef.current?.focus())
    if (chord === 'h') return act(() => void commands.run('todo.foldDone'))
    if (chord === 'cmd+z') return act(() => actions().undoRemove())
    if (id === null) return
    if (chord === 'x') return act(() => void commands.run('todo.done'))
    if (chord === 'd') return act(() => actions().remove(id))
    if (chord === 'enter') return act(() => actions().launch(id))
    if (chord === 'g') return act(() => actions().enterAgent(id))
  }

  const renderTodo = (t: Todo): JSX.Element => {
    const session = linkedSession(t, sessions.sessions)
    const status = session ? sessionStatus(sessions, session.id, now) : null
    const box: CheckboxState = t.done ? 'done' : status === 'working' ? 'working' : 'todo'
    const title = session ? `${t.text} · ${status === 'question' ? 'el agente pregunta' : status === 'working' ? 'el agente trabaja' : 'agente listo'}` : t.text
    return (
      <Row key={t.id} id={domId(t.id)} level={1} cursor={cursor === t.id} status={t.done ? 'done' : status === 'question' ? 'question' : undefined} title={title} onClick={() => actions().setCursor(t.id)}>
        <Checkbox state={box} label={t.done ? `Marcar "${t.text}" como pendiente` : `Marcar "${t.text}" como hecha`} title={t.done ? 'Pendiente (X)' : 'Hecha (X)'} onToggle={() => actions().toggleDone(t.id)} />
        <RowLabel>{t.text}</RowLabel>
        {session && (
          <RowEnd>
            {status === 'question' ? <Dot status="question" title="El agente pregunta" /> : <Badge title={agentOf(sessions, session.agent)?.name}>{agentOf(sessions, session.agent)?.badge ?? session.agent}</Badge>}
          </RowEnd>
        )}
        <RowActions>
          {!t.done &&
            (session ? (
              <IconButton label="Ir al agente (G)" onClick={() => actions().enterAgent(t.id)}>
                <MoveUpRight {...ICON_SM} />
              </IconButton>
            ) : (
              <IconButton label="Lanzar un agente con esta tarea (⏎)" onClick={() => actions().launch(t.id)}>
                <Bot {...ICON_SM} />
              </IconButton>
            ))}
          <IconButton label="Borrar (D, ⌘Z deshace)" onClick={() => actions().remove(t.id)}>
            <Trash2 {...ICON_SM} />
          </IconButton>
        </RowActions>
      </Row>
    )
  }

  const DoneChevron = doneOpen ? ChevronDown : ChevronRight
  const cursorVisible = cursor !== null && todos.some((t) => t.id === cursor)

  return (
    <div className="todo-overlay" onMouseDown={closeOverlay}>
      <div
        ref={rootRef}
        className="todo"
        role="dialog"
        aria-modal="true"
        aria-label={`Tareas, ${pending} ${pending === 1 ? 'pendiente' : 'pendientes'}`}
        data-focus="list"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="todo__head">
          <span className="todo__title">
            Tareas
            {toggleKey && <Kbd>{toggleKey}</Kbd>}
          </span>
          <span className="todo__count" aria-hidden="true">
            {pending}
          </span>
          <span className="todo__pending">{pending === 1 ? 'pendiente' : 'pendientes'}</span>
        </div>

        <label className="todo__add">
          <Plus {...ICON_SM} aria-hidden="true" />
          <TextInput ref={fieldRef} value={draft} placeholder="Nueva tarea" label="Nueva tarea" onChange={setDraft} onSubmit={submit} />
          <Kbd>{draft.trim() ? '⏎' : 'A'}</Kbd>
        </label>

        <div ref={listRef} className="todo__list" role="listbox" aria-label="Tareas" aria-activedescendant={cursorVisible ? domId(cursor) : undefined}>
          {todos.length === 0 && (
            <Empty title="Sin tareas">
              <span className="todo__empty-hint">
                Escribe la primera arriba, o pulsa <Kbd>A</Kbd>
              </span>
            </Empty>
          )}
          {todos.length > 0 && groups.pending.length === 0 && <p className="todo__none">{groups.done.length > 0 ? 'Todo hecho' : 'Nada pendiente'}</p>}
          {groups.pending.map(renderTodo)}
          {groups.done.length > 0 && (
            <button type="button" className="todo__group" data-fold data-open={doneOpen || undefined} tabIndex={-1} aria-expanded={doneOpen} title={doneOpen ? 'Plegar (H)' : 'Desplegar (H)'} onMouseDown={(e) => e.preventDefault()} onClick={() => void commands.run('todo.foldDone')}>
              <DoneChevron {...ICON_SM} aria-hidden="true" />
              <span className="todo__group-name">Hecho</span>
              <RowCount title={`${groups.done.length} ${groups.done.length === 1 ? 'tarea hecha' : 'tareas hechas'} hoy`}>{groups.done.length}</RowCount>
            </button>
          )}
          {doneOpen && groups.done.map(renderTodo)}
        </div>

        <div className="todo__foot">
          <Hint kbd="X">hecha</Hint>
          <Hint kbd="⏎">lanzar agente</Hint>
          <Hint kbd="D">borrar</Hint>
        </div>
      </div>
    </div>
  )
}
