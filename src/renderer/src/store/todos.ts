import { create } from 'zustand'
import type { SessionInfo, Todo } from '@shared/types'
import { omni } from '@/lib/omni'
import { getTerminal } from '@/panes/terminal/terminal-host'
import { liveBrowserId, useBrowser } from './browser'
import { useLayout } from './layout'
import { writeWhenSettled } from './session-write'
import { primaryWorkspace, useSessions } from './sessions'
import { cursorAfterMove, groupTodos, newTodo, pruneDone, settleCursor, toggledDone, unlinkMissing, unlinkSession, visibleIds } from './todos-logic'
import { useUi } from './ui'

/** Cada cambio se guarda en main tras este silencio (ARCHITECTURE §3.12). */
const SAVE_DEBOUNCE_MS = 300

/** Tarea que espera a que el launcher cree su agente, y en qué workspace debe crearse. */
export interface PendingLaunch {
  todoId: string
  workspaceId: string
}

interface TodosState {
  todos: Todo[]
  /** `todo:list` ya llegó: a partir de aquí cada cambio se persiste. */
  loaded: boolean
  /** Id de la tarea bajo el cursor del widget. */
  cursor: string | null
  /** Última borrada, para ⌘Z mientras el widget esté abierto. */
  undo: Todo | null
  /** Grupo Hecho desplegado. */
  doneOpen: boolean
  /** El widget abre con el campo de nueva tarea enfocado (`todo.add`). */
  composing: boolean
  /** Tarea que espera a que el launcher cree su agente (`launch` en `app/commands.ts` la consume). */
  pendingLaunch: PendingLaunch | null

  /** `todo:list`, suscripciones (`session:exit`, launcher) y persistencia. Devuelve la función para deshacerlo. */
  init(): () => void
  add(text: string, projectId: string | null): Todo | null
  toggleDone(id: string): void
  remove(id: string): void
  undoRemove(): void
  link(id: string, sessionId: string): void
  /** El agente murió: sus tareas pierden el vínculo (no se marcan hechas solas). */
  unlinkDead(sessionId: string): void
  setCursor(id: string | null): void
  moveCursor(delta: number): void
  setDoneOpen(open: boolean): void
  setComposing(composing: boolean): void
  /**
   * ⏎ sobre una tarea: sin agente deja la tarea en espera y abre el launcher; el comando que crea la
   * sesión (`launch` en `app/commands.ts`) la toma con `takePendingLaunch` y la vincula con
   * `linkLaunched`. Con agente entra a su pane.
   */
  launch(id: string): void
  /** Devuelve y limpia la tarea en espera. Síncrono: se llama antes de cerrar el launcher, que es lo que la cancela. */
  takePendingLaunch(): PendingLaunch | null
  /**
   * El launcher creó `info` para la tarea: la vincula y escribe su texto como primer prompt cuando el
   * agente se calma. Una terminal pelada o un navegador no se vinculan (el texto correría como comando
   * o no tendría dónde ir).
   */
  linkLaunched(todoId: string, info: SessionInfo): void
  /** `G`: activa el tab del agente, le da el teclado al pane y cierra el widget. */
  enterAgent(id: string): void
}

const sessions = useSessions.getState
const ui = useUi.getState

/**
 * Workspace donde lanzar el agente de una tarea: la primera ubicación de su proyecto; sin proyecto o si
 * su proyecto no tiene carpetas, el actual.
 */
function workspaceFor(projectId: string | null): string | null {
  const s = sessions()
  if (projectId === null) return s.currentWorkspaceId
  return primaryWorkspace(s, projectId)?.id ?? s.currentWorkspaceId
}

/** Lleva el teclado a la terminal de una sesión (tab, pane, cursor y foco DOM), soltando la página de un navegador si lo tenía. */
function focusSessionTerminal(id: string): void {
  const live = liveBrowserId(useBrowser.getState())
  if (live) useBrowser.getState().blur(live)
  useLayout.getState().focusSession(id)
  sessions().syncCursor(id)
  ui().setFocus('terminal')
  getTerminal(id)?.focus()
}

export const useTodos = create<TodosState>((set, get) => {
  /** Lista nueva con el cursor ya asentado sobre ella. */
  const apply = (todos: Todo[], cursor = get().cursor): Pick<TodosState, 'todos' | 'cursor'> => {
    const before = visibleIds(groupTodos(get().todos), get().doneOpen)
    const after = visibleIds(groupTodos(todos), get().doneOpen)
    return { todos, cursor: settleCursor(after, cursor, before) }
  }
  const patch = (id: string, fn: (t: Todo) => Todo): void => {
    if (!get().todos.some((t) => t.id === id)) return
    set(apply(get().todos.map((t) => (t.id === id ? fn(t) : t))))
  }

  return {
    todos: [],
    loaded: false,
    cursor: null,
    undo: null,
    doneOpen: false,
    composing: false,
    pendingLaunch: null,

    init() {
      // `setTimeout` pelado (no `window.`): el store también corre en los tests de Node.
      let saveTimer: ReturnType<typeof setTimeout> | undefined
      /** Última lista que main tiene (la cargada o la última guardada): solo lo distinto se persiste. */
      let persisted: Todo[] = []
      const offs: Array<() => void> = []

      void omni.invoke('todo:list').then((todos) => {
        persisted = todos
        // Poda de hechas viejas y, si las sesiones ya cargaron, vínculos muertos (si no, al llegar `ready`).
        // Las funciones puras devuelven el mismo array cuando no cambian nada: así no se guarda en vano.
        const s = sessions()
        const pruned = pruneDone(todos)
        const clean = s.ready ? unlinkMissing(pruned, new Set(s.sessions.map((x) => x.id))) : pruned
        set({ ...apply(clean), loaded: true })
      })

      // Persistencia con debounce: solo lo que difiere de lo que main ya tiene (antes de cargar se pisaría el archivo con nada).
      offs.push(
        useTodos.subscribe((s) => {
          if (!s.loaded || s.todos === persisted) return
          clearTimeout(saveTimer)
          saveTimer = setTimeout(() => {
            persisted = s.todos
            void omni.invoke('todo:save', s.todos)
          }, SAVE_DEBOUNCE_MS)
        })
      )
      offs.push(omni.on('session:exit', (id) => get().unlinkDead(id)))
      // Sesiones restauradas (daemon) ya listadas: lo que no esté vivo se desvincula.
      offs.push(
        useSessions.subscribe((s, prev) => {
          if (s.ready && !prev.ready && get().loaded) set(apply(unlinkMissing(get().todos, new Set(s.sessions.map((x) => x.id)))))
        })
      )
      // El launcher se cerró sin que `launch()` tomara la tarea (Esc, otro overlay): deja de esperar.
      offs.push(
        useUi.subscribe((u, prev) => {
          if (prev.overlay === 'launcher' && u.overlay !== 'launcher' && get().pendingLaunch !== null) set({ pendingLaunch: null })
        })
      )

      return () => {
        clearTimeout(saveTimer)
        offs.forEach((off) => off())
      }
    },

    add(text, projectId) {
      const clean = text.trim()
      if (!clean) return null
      const todo = newTodo(clean, projectId)
      set(apply([...get().todos, todo], todo.id))
      return todo
    },

    toggleDone: (id) => patch(id, (t) => toggledDone(t)),

    remove(id) {
      const victim = get().todos.find((t) => t.id === id)
      if (!victim) return
      set({ ...apply(get().todos.filter((t) => t.id !== id)), undo: victim })
    },

    undoRemove() {
      const back = get().undo
      if (!back) return
      set({ ...apply([...get().todos, back], back.id), undo: null })
    },

    link: (id, sessionId) => patch(id, (t) => ({ ...t, sessionId })),

    unlinkDead(sessionId) {
      if (!get().todos.some((t) => t.sessionId === sessionId)) return
      set(apply(unlinkSession(get().todos, sessionId)))
    },

    setCursor: (cursor) => set({ cursor }),

    moveCursor(delta) {
      const ids = visibleIds(groupTodos(get().todos), get().doneOpen)
      set({ cursor: cursorAfterMove(ids, get().cursor, delta) })
    },

    setDoneOpen(doneOpen) {
      const before = visibleIds(groupTodos(get().todos), get().doneOpen)
      const after = visibleIds(groupTodos(get().todos), doneOpen)
      set({ doneOpen, cursor: settleCursor(after, get().cursor, before) })
    },

    setComposing: (composing) => set({ composing }),

    launch(id) {
      const todo = get().todos.find((t) => t.id === id)
      if (!todo) return
      if (todo.sessionId !== null) return get().enterAgent(id)
      const wsId = workspaceFor(todo.projectId)
      if (wsId === null) return
      // El workspace viaja con la espera: al cerrar el widget el foco vuelve a una terminal y eso
      // puede mover `currentWorkspaceId`; `launch()` lo fija de nuevo justo antes de crear la sesión.
      sessions().setWorkspace(wsId)
      set({ pendingLaunch: { todoId: id, workspaceId: wsId } })
      ui().closeOverlay()
      ui().setLaunchTarget('tab')
      ui().openOverlay('launcher')
    },

    takePendingLaunch() {
      const pending = get().pendingLaunch
      if (pending !== null) set({ pendingLaunch: null })
      return pending
    },

    linkLaunched(todoId, info) {
      const todo = get().todos.find((t) => t.id === todoId)
      if (!todo || info.agent === 'shell' || info.agent === 'browser') return
      get().link(todoId, info.id)
      writeWhenSettled(info.id, todo.text)
    },

    enterAgent(id) {
      const todo = get().todos.find((t) => t.id === id)
      if (!todo?.sessionId) return
      const sessionId = todo.sessionId
      if (!sessions().sessions.some((x) => x.id === sessionId)) return get().unlinkDead(sessionId)
      ui().closeOverlay()
      focusSessionTerminal(sessionId)
    }
  }
})

/* ---------- selectores ---------- */

/** Sesión del agente vinculado a una tarea, si sigue viva. */
export function linkedSession(todo: Pick<Todo, 'sessionId'>, all: readonly SessionInfo[] = sessions().sessions): SessionInfo | undefined {
  return todo.sessionId === null ? undefined : all.find((x) => x.id === todo.sessionId)
}
