import { create } from 'zustand'
import type { AgentId, Broadcast, BroadcastCandidate, SessionInfo, Workspace } from '@shared/types'
import { omni } from '@/lib/omni'
import { blurTerminals, getTerminal, screenLines } from '@/panes/terminal/terminal-host'
import {
  activeRounds,
  aggregateState,
  candidateAfterMove,
  clampCandidate,
  diffPair,
  liveCandidates,
  newRound,
  pruneRounds,
  replaceRound,
  roundsOf,
  agentSaid, summaryOf,
  unlinkDeadSessions,
  worktreeNamesFor,
  type CandidateDiff
} from './broadcast-logic'
import { liveBrowserId, useBrowser } from './browser'
import { useLayout } from './layout'
import { useReview } from './review'
import { addReviewTarget } from './review-target'
import { writeWhenSettled } from './session-write'
import { WORKING_WINDOW_MS, agentOf, sessionStatus, useSessions, workspaceOf, type SessionStatus } from './sessions'
import { useUi } from './ui'
import { errorText, useWorktrees } from './worktrees'
import { branchOf } from './worktrees-logic'

/** Cada cambio en las rondas se guarda en main tras este silencio (ARCHITECTURE §3.18). */
export const SAVE_DEBOUNCE_MS = 300
/** El diff de una tarjeta se pide con este debounce por worktree: `git:diff` recorre el árbol entero. */
export const DIFF_DEBOUNCE_MS = 500
/** Con la vista en pantalla, el resumen (última línea de la terminal) de cada candidato se repide cada tanto. */
export const SUMMARY_REFRESH_MS = 2000
/** Tope de espera a que una sesión matada salga (`session:exit`) antes de tirar su worktree. */
export const KILL_TIMEOUT_MS = 5000

/** Dónde está el usuario en la vista: ronda y, dentro, índice del candidato (entre los vivos). */
export interface BroadcastCursor {
  roundId: string | null
  candidate: number
}

interface BroadcastStore {
  rounds: Broadcast[]
  /** `broadcast:list` ya llegó: a partir de aquí cada cambio se persiste. */
  loaded: boolean
  cursor: BroadcastCursor
  /** Diff resumido por workspace de candidato (archivos con `+a −d`), pedido con debounce. */
  diffs: Record<string, CandidateDiff>
  /** Última línea no vacía de la terminal por sesión de candidato. */
  summaries: Record<string, string>
  /** Bloque del prompt desplegado (`P`). */
  promptOpen: boolean
  /** Prompt a medio escribir en el diálogo: sobrevive a cerrarlo para editar el comando de tests. */
  draft: string
  /** `create` o `relaunch` en curso (crear worktrees y lanzar agentes tarda). */
  launching: boolean
  /** Último error humano (crear, merge, descartar): la vista lo pinta hasta la siguiente acción. */
  error: string | null
  /** Aviso breve del pie ("merge hecho"). */
  notice: string | null

  /** `broadcast:list`, suscripciones (worktrees que desaparecen, agentes que mueren o se callan, `worktree:changed`) y refresco de resúmenes. Devuelve la función para pararlo. */
  init(): () => void
  /** Persiste las rondas con debounce. */
  save(): void
  /** `broadcast.open`: saca el teclado de la terminal y pone la vista. */
  open(): void
  back(): void
  setCursor(roundId: string, candidate?: number): void
  /** `J`/`K`: ronda siguiente o anterior con wrap-around. */
  moveRound(delta: number): void
  /** `H`/`L`: candidato anterior o siguiente con wrap-around (solo entre los que tienen worktree). */
  moveCandidate(delta: number): void
  /** Nueva ronda en el proyecto actual: un worktree `<badge>-<n>` por agente, el agente lanzado ahí y el prompt como primer mensaje. */
  create(input: { prompt: string; agents: AgentId[] }): Promise<void>
  /** `S`: elige o deselige (`★`) el candidato bajo el cursor. */
  choose(): void
  /** `X`: descarta el candidato bajo el cursor (worktree y agente) con confirmación (`confirmDiscard`). */
  discardCandidate(): void
  /** `R`: nuevos worktrees con el mismo prompt y agentes; los viejos se descartan si no están elegidos. */
  relaunch(): Promise<void>
  /** `⇧M`: `git:merge` del elegido, descarta el resto y marca la ronda `merged` (solo queda el elegido). */
  mergeChosen(): Promise<void>
  /** `⏎`: entra al agente del candidato (o abre el launcher en su worktree si el agente murió). */
  enterCandidate(): void
  /** `D`: revisión del candidato bajo el cursor. */
  diffCandidate(): void
  /** `⇧D`: revisión del segundo candidato del par con el primero como base. */
  diffBetween(): void
  togglePrompt(): void
  setDraft(draft: string): void
  /** Pide `git:diff` del worktree con debounce y guarda solo los archivos. */
  refreshDiff(workspaceId: string): void
  /** Pide `session:history` y guarda la última línea. */
  refreshSummary(sessionId: string): Promise<void>
  /** Diffs y resúmenes de la ronda bajo el cursor. */
  refreshRound(): void
}

const sessions = useSessions.getState
const ui = useUi.getState
const worktrees = useWorktrees.getState

/** Lleva el teclado al pane de una sesión: misma receta que Worktrees y el widget de tareas. */
function focusSessionPane(id: string): void {
  const live = liveBrowserId(useBrowser.getState())
  if (live) useBrowser.getState().blur(live)
  useLayout.getState().focusSession(id)
  sessions().syncCursor(id)
  ui().setFocus('terminal')
  getTerminal(id)?.focus()
}

/** Sesión que representa a un worktree: la primera que no es shell ni navegador (ninguno de los dos edita código por un prompt). */
function agentSessionIn(workspaceId: string): SessionInfo | undefined {
  return sessions().sessions.find((x) => x.workspaceId === workspaceId && x.agent !== 'shell' && x.agent !== 'browser')
}

/**
 * Mata todas las sesiones de un workspace y espera a que salgan (`session:exit` las quita de
 * `sessions`), con tope: un `git:discard` con el proceso aún vivo dentro del directorio puede fallar.
 */
function killSessionsOf(workspaceId: string): Promise<void> {
  const ids = sessions()
    .sessions.filter((x) => x.workspaceId === workspaceId)
    .map((x) => x.id)
  ids.forEach((id) => sessions().kill(id))
  return waitForExit(ids, KILL_TIMEOUT_MS)
}

/** Resuelve cuando ninguna de las sesiones sigue en `sessions`, o al vencer el tope. */
function waitForExit(ids: readonly string[], timeoutMs: number): Promise<void> {
  const gone = (): boolean => !sessions().sessions.some((x) => ids.includes(x.id))
  if (gone()) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      off()
      clearTimeout(timer)
      resolve()
    }
    const off = useSessions.subscribe((s, prev) => {
      if (s.sessions !== prev.sessions && gone()) done()
    })
    const timer = setTimeout(done, timeoutMs)
  })
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
let statesTimer: ReturnType<typeof setTimeout> | undefined
const diffTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Rondas en medio de crear, mergear o relanzar: la sincronización con `sessions` no las poda y cuentan como en marcha. */
const locked = new Set<string>()
/** Último estado visto de cada sesión de candidato: detecta `working` → `idle` para repedir su diff. */
const lastStatus = new Map<string, SessionStatus>()
/** Generación de `init`: una operación en vuelo (crear, merge, relanzar) que la vea cambiar deja de tocar el estado. */
let run = 0

export const useBroadcast = create<BroadcastStore>((set, get) => {
  const projectId = (): string | null => {
    const s = sessions()
    return s.currentWorkspaceId ? (workspaceOf(s, s.currentWorkspaceId)?.projectId ?? null) : null
  }
  const current = (): Broadcast | undefined => currentRound(get(), sessions())
  const live = (round: Broadcast | undefined): BroadcastCandidate[] => liveCandidates(round, sessions().workspaces)
  const candidate = (): BroadcastCandidate | undefined => currentCandidate(get(), sessions())
  const isCandidate = (workspaceId: string): boolean => get().rounds.some((r) => r.candidates.some((c) => c.workspaceId === workspaceId))
  const stale = (gen: number): boolean => gen !== run

  /** Reemplaza la ronda leyendo la lista actual (nunca una copia capturada antes de un `await`). */
  const patch = (roundId: string, fn: (round: Broadcast) => Broadcast): void => {
    const round = get().rounds.find((r) => r.id === roundId)
    if (!round) return
    set((s) => ({ rounds: replaceRound(s.rounds, fn(round)) }))
    get().save()
  }

  /** Estado agregado de cada ronda viva y diff de los candidatos que acaban de callarse. */
  const recomputeStates = (): void => {
    const s = sessions()
    const now = Date.now()
    let changed = false
    const rounds = get().rounds.map((r) => {
      const statuses = r.candidates.map((c) => candidateStatus(s, c, now))
      r.candidates.forEach((c, i) => {
        const status = statuses[i]
        if (c.sessionId === null || status === null) return
        const was = lastStatus.get(c.sessionId)
        lastStatus.set(c.sessionId, status)
        if (was !== undefined && was !== 'idle' && status === 'idle') {
          get().refreshDiff(c.workspaceId)
          void get().refreshSummary(c.sessionId)
        }
      })
      // Una ronda lanzando, mergeando o relanzando está en marcha aunque aún no tenga agentes.
      const state = aggregateState(r.state, statuses, locked.has(r.id))
      if (state === r.state) return r
      changed = true
      return { ...r, state }
    })
    if (changed) {
      set({ rounds })
      get().save()
    }
  }

  /** Recalcula ahora y otra vez cuando venza la ventana de "trabajando" (el estado depende del tiempo). */
  const scheduleStates = (): void => {
    recomputeStates()
    if (statesTimer !== undefined) clearTimeout(statesTimer)
    statesTimer = setTimeout(() => {
      statesTimer = undefined
      recomputeStates()
    }, WORKING_WINDOW_MS + 50)
  }

  /** Candidatos sin agente que ya tienen uno nuevo en su worktree (lanzado desde `⏎` o el launcher): se enlazan. */
  const relink = (rounds: Broadcast[]): Broadcast[] => {
    let changed = false
    const out = rounds.map((r) => {
      if (r.state === 'merged' || r.state === 'discarded' || !r.candidates.some((c) => c.sessionId === null)) return r
      const candidates = r.candidates.map((c) => {
        if (c.sessionId !== null) return c
        const found = agentSessionIn(c.workspaceId)
        if (!found) return c
        changed = true
        return { ...c, sessionId: found.id }
      })
      return changed ? { ...r, candidates } : r
    })
    return changed ? out : rounds
  }

  /** Tras cambiar workspaces o sesiones: candidatos sin worktree fuera, sesiones muertas sueltas, nuevas enlazadas, estados al día. */
  const sync = (): void => {
    const s = sessions()
    if (!s.ready || !get().loaded) return
    const alive = new Set(s.workspaces.map((w) => w.id))
    const living = new Set(s.sessions.map((x) => x.id))
    const before = get().rounds
    const free = before.filter((r) => !locked.has(r.id))
    const next = relink(unlinkDeadSessions(pruneRounds(free, alive), living))
    if (next !== free) {
      set({ rounds: before.map((r) => (locked.has(r.id) ? r : (next.find((x) => x.id === r.id) ?? r))) })
      get().save()
    }
    const diffs = Object.fromEntries(Object.entries(get().diffs).filter(([id]) => alive.has(id)))
    const summaries = Object.fromEntries(Object.entries(get().summaries).filter(([id]) => living.has(id)))
    if (Object.keys(diffs).length !== Object.keys(get().diffs).length || Object.keys(summaries).length !== Object.keys(get().summaries).length) set({ diffs, summaries })
    for (const id of lastStatus.keys()) if (!living.has(id)) lastStatus.delete(id)
    scheduleStates()
  }

  /**
   * Crea un worktree por agente, lanza el agente ahí con el prompt y suma el candidato a la ronda.
   * Si la ronda desapareció a mitad (o `init` se reinició), lo recién creado se deshace.
   */
  const launchCandidates = async (gen: number, roundId: string, pid: string, prompt: string, agents: readonly AgentId[]): Promise<void> => {
    const s = sessions()
    const before = s.currentWorkspaceId
    const taken = s.workspaces.filter((w) => w.projectId === pid && w.kind === 'worktree').map((w) => w.name)
    const names = worktreeNamesFor(agents, (a) => agentOf(s, a)?.badge ?? a, taken)
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i]
      const ws = await worktrees().create(pid, names[i])
      if (stale(gen)) return
      if (!ws) {
        set({ error: worktrees().error ?? 'No se pudo crear el worktree' })
        continue
      }
      // La sesión nace en el worktree: `create` toma el workspace actual.
      sessions().setWorkspace(ws.id)
      let info: SessionInfo | null = null
      try {
        info = await sessions().create(agent)
      } catch (e) {
        set({ error: errorText(e) })
      }
      const round = get().rounds.find((r) => r.id === roundId)
      if (stale(gen) || !round) {
        // Nadie va a listar este candidato: su agente muere y el worktree se tira.
        if (info) sessions().kill(info.id)
        await omni.invoke('git:discard', ws.id).catch(() => undefined)
        return
      }
      if (info) {
        useLayout.getState().openTab(ws.id, info.id)
        writeWhenSettled(info.id, prompt)
      }
      patch(roundId, (r) => ({ ...r, candidates: [...r.candidates, { workspaceId: ws.id, sessionId: info?.id ?? null, agent }], state: 'running' }))
    }
    // La vista sigue en pantalla: el workspace actual vuelve a donde estaba.
    if (before !== null && sessions().workspaces.some((w) => w.id === before)) sessions().setWorkspace(before)
  }

  return {
    rounds: [],
    loaded: false,
    cursor: { roundId: null, candidate: 0 },
    diffs: {},
    summaries: {},
    promptOpen: false,
    draft: '',
    launching: false,
    error: null,
    notice: null,

    init() {
      const gen = ++run
      const offs: Array<() => void> = []
      void omni
        .invoke('broadcast:list')
        .then((rounds) => {
          if (stale(gen)) return
          set({ rounds, loaded: true })
          sync()
        })
        .catch(() => {
          if (!stale(gen)) set({ loaded: true })
        })
      // Con la vista en pantalla, `review.open` (⌘D) abre la revisión del candidato bajo el cursor.
      offs.push(addReviewTarget(() => (ui().view === 'broadcast' ? (candidate()?.workspaceId ?? null) : null)))
      offs.push(
        useSessions.subscribe((s, prev) => {
          if (s.workspaces !== prev.workspaces || s.sessions !== prev.sessions || s.ready !== prev.ready) sync()
          else if (s.activity !== prev.activity || s.attention !== prev.attention) scheduleStates()
        })
      )
      // Un worktree cambió (tests, creado, borrado): su tarjeta repide el diff.
      offs.push(
        omni.on('worktree:changed', (workspaceId) => {
          if (workspaceId !== null) {
            if (isCandidate(workspaceId)) get().refreshDiff(workspaceId)
          } else get().refreshRound()
        })
      )
      // Solo con la vista en pantalla: la TUI sigue pintando y el resumen es su última línea.
      // `setInterval` pelado (no `window.`): el store también corre en los tests de Node.
      const timer = setInterval(() => {
        if (ui().view !== 'broadcast') return
        for (const c of current()?.candidates ?? []) if (c.sessionId !== null) void get().refreshSummary(c.sessionId)
      }, SUMMARY_REFRESH_MS)
      return () => {
        // Otra generación: lo que siga en vuelo (crear, merge, relanzar) ya no toca el estado. `locked` no se vacía
        // aquí: cada operación suelta su ronda en su propio `finally`.
        run++
        offs.forEach((off) => off())
        clearInterval(timer)
        if (saveTimer !== undefined) clearTimeout(saveTimer)
        if (statesTimer !== undefined) clearTimeout(statesTimer)
        for (const t of diffTimers.values()) clearTimeout(t)
        diffTimers.clear()
        lastStatus.clear()
      }
    },

    save() {
      if (!get().loaded) return
      if (saveTimer !== undefined) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = undefined
        void omni.invoke('broadcast:save', get().rounds).catch(() => undefined)
      }, SAVE_DEBOUNCE_MS)
    },

    open() {
      // Si la página de un navegador tenía el teclado, main se lo devuelve al renderer antes de cambiar de vista.
      const browserLive = liveBrowserId(useBrowser.getState())
      if (browserLive) useBrowser.getState().blur(browserLive)
      blurTerminals()
      ui().setView('broadcast')
      const round = current()
      set((s) => ({ cursor: { roundId: round?.id ?? null, candidate: clampCandidate(live(round), s.cursor.candidate) }, error: null, notice: null }))
      get().refreshRound()
    },

    back: () => ui().setView('fleet'),

    setCursor(roundId, candidateIndex = 0) {
      const round = get().rounds.find((r) => r.id === roundId)
      set({ cursor: { roundId, candidate: clampCandidate(live(round), candidateIndex) } })
      get().refreshRound()
    },

    moveRound(delta) {
      const list = visibleRounds(get(), sessions())
      if (list.length === 0) return
      const i = list.findIndex((r) => r.id === current()?.id)
      const next = i === -1 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length
      get().setCursor(list[next].id, 0)
    },

    moveCandidate(delta) {
      const round = current()
      if (!round) return
      set((s) => ({ cursor: { roundId: round.id, candidate: candidateAfterMove(live(round), s.cursor.candidate, delta) } }))
    },

    async create({ prompt, agents }) {
      const gen = run
      const pid = projectId()
      const clean = prompt.trim()
      if (pid === null || clean === '' || agents.length === 0) return
      const round = newRound(pid, clean)
      set((s) => ({ rounds: [round, ...s.rounds], cursor: { roundId: round.id, candidate: 0 }, launching: true, error: null, notice: null, draft: '', promptOpen: false }))
      locked.add(round.id)
      try {
        await launchCandidates(gen, round.id, pid, clean, agents)
      } finally {
        locked.delete(round.id)
        if (!stale(gen)) set({ launching: false })
      }
      if (stale(gen)) return
      // Ningún worktree pudo crearse (el proyecto no es repo git): la ronda no existe, queda el error.
      if (get().rounds.find((r) => r.id === round.id)?.candidates.length === 0) set((s) => ({ rounds: s.rounds.filter((r) => r.id !== round.id), cursor: { roundId: null, candidate: 0 } }))
      get().save()
      sync()
    },

    choose() {
      const round = current()
      const c = candidate()
      if (!round || !c) return
      patch(round.id, (r) => ({ ...r, chosen: r.chosen === c.workspaceId ? null : c.workspaceId }))
    },

    discardCandidate() {
      const c = candidate()
      if (!c) return
      set({ error: null })
      worktrees().discard(c.workspaceId)
    },

    async relaunch() {
      const gen = run
      const round = current()
      if (!round || get().launching) return
      const victims = live(round).filter((c) => c.workspaceId !== round.chosen)
      if (victims.length === 0) return
      set({ launching: true, error: null, notice: null })
      locked.add(round.id)
      try {
        for (const v of victims) {
          // El agente sale antes de tirar su directorio.
          await killSessionsOf(v.workspaceId)
          if (stale(gen)) return
          await omni.invoke('git:discard', v.workspaceId).catch((e: unknown) => set({ error: errorText(e) }))
          if (stale(gen)) return
        }
        patch(round.id, (r) => ({ ...r, candidates: r.candidates.filter((c) => c.workspaceId === r.chosen), state: 'running' }))
        await sessions().reloadProjects()
        if (stale(gen)) return
        await launchCandidates(
          gen,
          round.id,
          round.projectId,
          round.prompt,
          victims.map((v) => v.agent)
        )
      } finally {
        locked.delete(round.id)
        if (!stale(gen)) set({ launching: false, cursor: { roundId: round.id, candidate: 0 } })
      }
      if (!stale(gen)) sync()
    },

    async mergeChosen() {
      const gen = run
      const round = current()
      if (!round || round.chosen === null || get().launching) return
      const chosen = round.chosen
      set({ error: null, notice: null })
      locked.add(round.id)
      try {
        const { commit } = await omni.invoke('git:merge', chosen)
        if (stale(gen)) return
        // El merge borró el worktree elegido: sus agentes mueren; el resto se descarta con los suyos.
        await killSessionsOf(chosen)
        for (const c of round.candidates) {
          if (c.workspaceId === chosen || stale(gen)) continue
          await killSessionsOf(c.workspaceId)
          await omni.invoke('git:discard', c.workspaceId).catch(() => undefined)
        }
        if (stale(gen)) return
        // Mergeada: solo queda el elegido como historial (los otros worktrees ya no existen).
        patch(round.id, (r) => ({ ...r, state: 'merged', candidates: r.candidates.filter((c) => c.workspaceId === chosen) }))
        await sessions().reloadProjects()
        if (!stale(gen)) set({ notice: `Merge hecho: ${commit.slice(0, 7)}` })
      } catch (e) {
        if (!stale(gen)) set({ error: errorText(e) })
      } finally {
        locked.delete(round.id)
      }
      if (!stale(gen)) sync()
    },

    enterCandidate() {
      const round = current()
      const c = candidate()
      if (!round || !c) return
      const alive = c.sessionId !== null && sessions().sessions.some((x) => x.id === c.sessionId)
      if (alive && c.sessionId !== null) {
        ui().setView('fleet')
        focusSessionPane(c.sessionId)
      } else worktrees().launchIn(c.workspaceId, round.prompt)
    },

    diffCandidate() {
      const c = candidate()
      if (c) void useReview.getState().open(c.workspaceId)
    },

    diffBetween() {
      const pair = currentPair(get(), sessions())
      if (!pair) return
      const [a, b] = pair
      const wsA = workspaceOf(sessions(), a.workspaceId)
      if (!wsA) return
      void useReview.getState().open(b.workspaceId, branchOf(wsA, worktrees().statuses[a.workspaceId]))
    },

    togglePrompt: () => set((s) => ({ promptOpen: !s.promptOpen })),

    setDraft: (draft) => set({ draft }),

    refreshDiff(workspaceId) {
      const prev = diffTimers.get(workspaceId)
      if (prev !== undefined) clearTimeout(prev)
      diffTimers.set(
        workspaceId,
        setTimeout(() => {
          diffTimers.delete(workspaceId)
          if (!isCandidate(workspaceId) || !workspaceOf(sessions(), workspaceId)) return
          void omni
            .invoke('git:diff', workspaceId)
            .then((diff) => {
              if (!isCandidate(workspaceId)) return
              const files = diff.files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions }))
              set((s) => ({ diffs: { ...s.diffs, [workspaceId]: { files, truncated: diff.truncated } } }))
            })
            .catch(() => undefined)
        }, DIFF_DEBOUNCE_MS)
      )
    },

    async refreshSummary(sessionId) {
      const raw = await omni.invoke('session:history', sessionId).catch(() => '')
      if (!sessions().sessions.some((x) => x.id === sessionId)) return
      const summary = agentSaid(screenLines(sessionId, 60) ?? []) ?? summaryOf(raw)
      if (get().summaries[sessionId] === summary) return
      set((s) => ({ summaries: { ...s.summaries, [sessionId]: summary } }))
    },

    refreshRound() {
      for (const c of live(current())) {
        get().refreshDiff(c.workspaceId)
        if (c.sessionId !== null) void get().refreshSummary(c.sessionId)
      }
    }
  }
})

/* ---------- selectores (estado derivado, nunca almacenado) ---------- */

type SessionsSlice = Pick<ReturnType<typeof useSessions.getState>, 'workspaces' | 'currentWorkspaceId'>

/** Proyecto cuyas rondas se listan: el del workspace actual. */
export function broadcastProjectId(s: SessionsSlice): string | null {
  return s.currentWorkspaceId ? (workspaceOf(s, s.currentWorkspaceId)?.projectId ?? null) : null
}

/** Rondas del proyecto actual, la más nueva arriba. */
export function visibleRounds(b: Pick<BroadcastStore, 'rounds'>, s: SessionsSlice): Broadcast[] {
  return roundsOf(b.rounds, broadcastProjectId(s))
}

/** Ronda bajo el cursor (o la primera visible). */
export function currentRound(b: Pick<BroadcastStore, 'rounds' | 'cursor'>, s: SessionsSlice): Broadcast | undefined {
  const list = visibleRounds(b, s)
  return list.find((r) => r.id === b.cursor.roundId) ?? list[0]
}

/** Candidato bajo el cursor de la ronda actual, entre los que tienen worktree. */
export function currentCandidate(b: Pick<BroadcastStore, 'rounds' | 'cursor'>, s: SessionsSlice): BroadcastCandidate | undefined {
  const candidates = liveCandidates(currentRound(b, s), s.workspaces)
  return candidates[clampCandidate(candidates, b.cursor.candidate)]
}

/** Par de `⇧D` para la ronda actual (elegido vs cursor, o los dos primeros vivos). */
export function currentPair(b: Pick<BroadcastStore, 'rounds' | 'cursor'>, s: SessionsSlice): [BroadcastCandidate, BroadcastCandidate] | null {
  const round = currentRound(b, s)
  return diffPair(liveCandidates(round, s.workspaces), round?.chosen ?? null, b.cursor.candidate)
}

/**
 * Estado del agente de un candidato; `null` si murió o nunca nació. Una sesión recién nacida que aún
 * no ha escrito nada cuenta como `working`: nada se da por listo al nacer. Una restaurada sin
 * actividad (el renderer se recargó) es reposo hasta que escriba.
 */
export function candidateStatus(s: Pick<ReturnType<typeof useSessions.getState>, 'sessions' | 'activity' | 'attention' | 'busy'> & { declared?: ReturnType<typeof useSessions.getState>['declared'] }, c: Pick<BroadcastCandidate, 'sessionId'>, now: number): SessionStatus | null {
  if (c.sessionId === null) return null
  const session = s.sessions.find((x) => x.id === c.sessionId)
  if (!session) return null
  if (s.activity[c.sessionId] === undefined && !s.attention[c.sessionId] && now - session.createdAt < WORKING_WINDOW_MS) return 'working'
  return sessionStatus(s, c.sessionId, now)
}

/** Rondas en marcha en toda la app: el conteo del ítem del sidebar. */
export function runningRounds(b: Pick<BroadcastStore, 'rounds'>): number {
  return activeRounds(b.rounds)
}

/** Workspace de un candidato, si sigue existiendo. */
export function candidateWorkspaceOf(s: Pick<ReturnType<typeof useSessions.getState>, 'workspaces'>, c: Pick<BroadcastCandidate, 'workspaceId'>): Workspace | undefined {
  return workspaceOf(s, c.workspaceId)
}
