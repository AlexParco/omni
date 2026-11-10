import { create } from 'zustand'
import type { AgentId, Project, SessionInfo, Workspace, WorktreeStatus } from '@shared/types'
import { omni } from '@/lib/omni'
import { blurTerminals, getTerminal } from '@/panes/terminal/terminal-host'
import { liveBrowserId, useBrowser } from './browser'
import { useLayout } from './layout'
import { useQuickOpen } from './quickopen'
import { addReviewTarget } from './review-target'
import { writeWhenSettled } from './session-write'
import { WORKING_WINDOW_MS, agentOf, useSessions, visibleProjects } from './sessions'
import { cursorAfterMove, settleCursor } from './todos-logic'
import { useUi } from './ui'
import { hasChanges, issuePrompt, launcherWorktreeName, normalizeWorktreeName, worktreeRows, type WorktreeRow } from './worktrees-logic'

/** Lo que el launcher debe hacer con la sesión que cree: nacer en ese workspace y, si hay, escribir el primer prompt. */
export interface PendingWorktreeLaunch {
  workspaceId: string
  /** Primer prompt (issue): se escribe cuando el agente se calma, como el texto de una tarea. */
  prompt: string | null
}

/**
 * Para que una pausa dispare los tests, el agente tiene que haber estado `working` al menos este tiempo
 * seguido: un prompt que imprime una línea y se calla no es "terminó de trabajar".
 */
export const AUTO_TESTS_MIN_WORKING_MS = 5000
/** Cuánto dura un aviso (`notice`), p. ej. los worktrees que se conservan al quitar un proyecto. */
export const NOTICE_MS = 8000
/** Agentes que no editan código: su reposo no corre tests. */
const NON_CODING: ReadonlySet<AgentId> = new Set<AgentId>(['shell', 'browser', 'editor', 'preview'])

interface WorktreesState {
  /** Estado git/tests por workspace de worktree (`worktree:status`). */
  statuses: Record<string, WorktreeStatus>
  /** Último error humano al pedir el estado de un worktree (se pinta en su fila y en el detalle). */
  errors: Record<string, string>
  /** Cuándo vio el renderer cada worktree por primera vez: antigüedad de los que no tienen sesión. */
  firstSeen: Record<string, number>
  /** Workspace bajo el cursor de la vista; si ya no está, manda la primera fila. */
  cursor: string | null
  /** Proyecto para el que se pide un nombre o un issue (`worktreeName` / `worktreeIssue`) o el comando de tests (`testCommand`). */
  targetProjectId: string | null
  /** Carpeta cuyo comando de tests se edita (`testCommand` sobre una carpeta, §3.5c); `null` = el del proyecto. */
  targetLocationId: string | null
  /** Worktree que espera confirmación en `confirmDiscard`. */
  discardId: string | null
  /** El launcher eligió "en worktree nuevo" (⇧⏎): `launch` lo toma antes de crear la sesión. */
  launchInNew: boolean
  /** Worktree recién creado que espera a que el launcher cree su agente. */
  pendingLaunch: PendingWorktreeLaunch | null
  /** Último error humano (crear, issue, descartar): la vista lo pinta hasta la siguiente acción. */
  error: string | null
  /** Aviso transitorio (worktrees conservados al quitar un proyecto): sidebar y pie de la vista lo pintan. */
  notice: string | null

  /** Suscripciones: `worktree:changed`, cambios en `sessions` (worktrees nuevos, `working` → `idle`) y limpieza. Devuelve la función para pararlas. */
  init(): () => void
  /** Pide el estado; `fresh` salta la caché de 5 s de main. Un error queda en `errors[workspaceId]`. */
  refresh(workspaceId: string, fresh?: boolean): Promise<void>
  refreshAll(): Promise<void>
  /** `worktrees.open`: saca el teclado de la terminal y pone la vista. */
  open(): void
  back(): void
  setCursor(workspaceId: string): void
  moveCursor(delta: number): void
  /** Crea el worktree (nombre a mano o `<badge>-<n>`); devuelve su workspace o `null` con `error` puesto. */
  create(projectId: string, name?: string): Promise<Workspace | null>
  /** Resuelve el issue con `gh`, crea el worktree y deja el prompt `Issue #n: título\nurl` para el agente que se lance ahí. */
  createFromIssue(projectId: string, issue: number): Promise<Workspace | null>
  /** Borra un worktree sin preguntar (el ⇧⏎ abortado): `worktree:remove` y recarga. */
  remove(workspaceId: string): Promise<void>
  /** Pide confirmación (`confirmDiscard`) antes de tirar el worktree. */
  discard(workspaceId: string): void
  /** Confirmado: mata sus sesiones, `git:discard` y recarga proyectos. */
  confirmDiscard(workspaceId: string): Promise<void>
  /** Corre el `testCommand` ahora; el resultado llega por `worktree:changed`. */
  runTests(workspaceId: string): Promise<void>
  /** Abre el launcher para que el agente elegido nazca en ese worktree (con el prompt del issue, si lo hay). */
  launchIn(workspaceId: string, prompt?: string | null): void
  /** Crea el worktree `<badge>-<n>` del proyecto actual para el agente que el launcher acaba de elegir (⇧⏎). */
  createForLaunch(agent: AgentId): Promise<Workspace | null>
  setLaunchInNew(on: boolean): void
  /** Devuelve y limpia la marca "en worktree nuevo". Síncrono: se llama antes de cerrar el launcher. */
  takeLaunchInNew(): boolean
  /** Devuelve y limpia el worktree en espera. Síncrono: se llama antes de cerrar el launcher, que es lo que lo cancela. */
  takePendingLaunch(): PendingWorktreeLaunch | null
  /** El launcher creó `info` en el worktree en espera: escribe el prompt del issue cuando el agente se calma. */
  linkLaunched(pending: PendingWorktreeLaunch, info: SessionInfo): void
  /** `O`: entra al pane del agente del worktree y vuelve a la flota. */
  enterAgent(workspaceId: string): void
  /** Guarda el comando de tests del proyecto (`''` lo quita) y recarga proyectos. */
  setTestCommand(projectId: string, command: string, locationId?: string | null): Promise<void>
  setTargetProject(projectId: string | null, locationId?: string | null): void
  /** Pide la rama de la ubicación de la que saldría un worktree del proyecto (cache de `workspace:branch` del quick open): así `projectIsRepo` sabe contestar. */
  probeRepo(projectId: string): void
  /** Aviso transitorio; `null` lo quita. Se borra solo pasado `NOTICE_MS`. */
  setNotice(text: string | null): void
  /**
   * Un agente de un worktree pasó de `working` a `idle` tras trabajar al menos `AUTO_TESTS_MIN_WORKING_MS`
   * seguidos: pide el estado fresco y corre los tests si el proyecto tiene `testCommand`, hay cambios, no
   * hay tests corriendo y el `stat` + `dirty` cambió desde la última corrida automática.
   */
  autoTests(sessionId: string): Promise<void>
}

const sessions = useSessions.getState
const ui = useUi.getState

/** Mensaje humano de un error del puente (main lanza `Error` con texto para el usuario). */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  // Electron antepone "Error invoking remote method 'x': Error: " al mensaje de main.
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').trim() || 'No se pudo completar'
}

/** Huella de lo que cambiaría el resultado de los tests: el diff contra la base y si hay cambios sin commit. */
export function statusFingerprint(status: Pick<WorktreeStatus, 'stat' | 'dirty'>): string {
  return `${status.stat.files}:${status.stat.additions}:${status.stat.deletions}:${status.dirty ? 1 : 0}`
}

/** Lleva el teclado al pane de una sesión: misma receta que Broadcast y el widget de tareas. */
function focusSessionPane(id: string): void {
  const live = liveBrowserId(useBrowser.getState())
  if (live) useBrowser.getState().blur(live)
  useLayout.getState().focusSession(id)
  sessions().syncCursor(id)
  ui().setFocus('terminal')
  getTerminal(id)?.focus()
}

/** Temporizador de reposo por sesión de worktree: se rearma con cada salida y dispara `autoTests` al callarse. */
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Desde cuándo lleva `working` cada sesión de worktree (primer chunk tras un reposo); se borra al pasar a idle. */
const workingSince = new Map<string, number>()
/** Huella (`statusFingerprint`) con la que corrieron los tests automáticos por última vez, por worktree. */
const lastAutoRun = new Map<string, string>()
let noticeTimer: ReturnType<typeof setTimeout> | undefined

function clearIdleTimer(id: string): void {
  const t = idleTimers.get(id)
  if (t !== undefined) clearTimeout(t)
  idleTimers.delete(id)
}

function forgetSession(id: string): void {
  clearIdleTimer(id)
  workingSince.delete(id)
}

/**
 * Comando de tests de un workspace: el de la carpeta de la que salió el worktree (o de la propia carpeta)
 * y, si no tiene, el del proyecto (§3.5c). `undefined` = no hay tests que correr.
 */
export function testCommandOf(projects: readonly Project[], ws: Pick<Workspace, 'id' | 'projectId' | 'locationId'>): string | undefined {
  const project = projects.find((p) => p.id === ws.projectId)
  const location = project?.locations.find((l) => l.id === (ws.locationId ?? ws.id))
  return location?.testCommand ?? project?.testCommand ?? undefined
}

export const useWorktrees = create<WorktreesState>((set, get) => {
  const rows = (): WorktreeRow[] => visibleRows(get(), sessions())
  const ids = (): string[] => rows().map((r) => r.workspace.id)
  const isWorktree = (workspaceId: string): boolean => sessions().workspaces.some((w) => w.id === workspaceId && w.kind === 'worktree')

  /** Tras cambiar la lista: estados y marcas de los que ya no existen fuera, `firstSeen` de los nuevos, cursor asentado. */
  const sync = (before: readonly string[]): void => {
    const alive = new Set(sessions().workspaces.filter((w) => w.kind === 'worktree').map((w) => w.id))
    for (const id of lastAutoRun.keys()) if (!alive.has(id)) lastAutoRun.delete(id)
    set((s) => {
      const now = Date.now()
      const firstSeen = { ...s.firstSeen }
      for (const id of alive) if (firstSeen[id] === undefined) firstSeen[id] = now
      for (const id of Object.keys(firstSeen)) if (!alive.has(id)) delete firstSeen[id]
      const statuses = Object.fromEntries(Object.entries(s.statuses).filter(([id]) => alive.has(id)))
      const errors = Object.fromEntries(Object.entries(s.errors).filter(([id]) => alive.has(id)))
      return { firstSeen, statuses, errors, cursor: settleCursor(ids(), s.cursor, before), discardId: s.discardId !== null && alive.has(s.discardId) ? s.discardId : null }
    })
    for (const id of alive) if (get().statuses[id] === undefined && get().errors[id] === undefined) void get().refresh(id)
  }

  /** Recarga la lista de proyectos y vuelve a asentar el store. */
  const reload = async (): Promise<void> => {
    await sessions().reloadProjects()
    sync(ids())
  }

  return {
    statuses: {},
    errors: {},
    firstSeen: {},
    cursor: null,
    targetProjectId: null,
    targetLocationId: null,
    discardId: null,
    launchInNew: false,
    pendingLaunch: null,
    error: null,
    notice: null,

    init() {
      const offs: Array<() => void> = []
      sync([])
      // Con la vista en pantalla, `review.open` (⏎, ⌘D) abre la revisión del worktree bajo el cursor (§3.16).
      offs.push(addReviewTarget(() => (ui().view === 'worktrees' ? (currentRow(get(), sessions())?.workspace.id ?? null) : null)))
      // Main avisa cuando un worktree nace, muere o cambian sus tests: se vuelve a pedir la lista y el estado.
      offs.push(
        omni.on('worktree:changed', (workspaceId) => {
          void reload().then(() => (workspaceId !== null && isWorktree(workspaceId) ? get().refresh(workspaceId) : get().refreshAll()))
        })
      )
      offs.push(
        useSessions.subscribe((s, prev) => {
          if (s.workspaces !== prev.workspaces) sync(ids())
          // `working` → `idle` (§3.15): cada chunk de salida rearma el reposo de su sesión; al callarse corren los tests.
          if (s.activity !== prev.activity) {
            for (const id of Object.keys(s.activity)) {
              const lastOutput = s.activity[id]?.lastOutput
              if (s.activity[id] === prev.activity[id] || lastOutput === undefined) continue
              const session = s.sessions.find((x) => x.id === id)
              if (!session || NON_CODING.has(session.agent) || !isWorktree(session.workspaceId)) continue
              if (!workingSince.has(id)) workingSince.set(id, lastOutput)
              clearIdleTimer(id)
              idleTimers.set(
                id,
                setTimeout(() => {
                  idleTimers.delete(id)
                  // Pasó a idle: la racha termina aquí; solo una racha larga de verdad dispara los tests.
                  const since = workingSince.get(id)
                  workingSince.delete(id)
                  const worked = since === undefined ? 0 : (useSessions.getState().activity[id]?.lastOutput ?? since) - since
                  if (worked >= AUTO_TESTS_MIN_WORKING_MS) void get().autoTests(id)
                }, WORKING_WINDOW_MS)
              )
            }
          }
          if (s.sessions !== prev.sessions) for (const id of [...idleTimers.keys(), ...workingSince.keys()]) if (!s.sessions.some((x) => x.id === id)) forgetSession(id)
        })
      )
      // El launcher se cerró sin que `launch()` tomara lo pendiente (Esc, otro overlay): deja de esperar.
      offs.push(
        useUi.subscribe((u, prev) => {
          if (prev.overlay === 'launcher' && u.overlay !== 'launcher' && (get().pendingLaunch !== null || get().launchInNew)) set({ pendingLaunch: null, launchInNew: false })
        })
      )
      return () => {
        offs.forEach((off) => off())
        for (const id of [...idleTimers.keys(), ...workingSince.keys()]) forgetSession(id)
        lastAutoRun.clear()
        clearTimeout(noticeTimer)
      }
    },

    async refresh(workspaceId, fresh = false) {
      if (!isWorktree(workspaceId)) return
      try {
        const status = await (fresh ? omni.invoke('worktree:status', workspaceId, true) : omni.invoke('worktree:status', workspaceId))
        if (!isWorktree(workspaceId)) return
        set((s) => {
          const { [workspaceId]: _was, ...errors } = s.errors
          return { statuses: { ...s.statuses, [workspaceId]: status }, errors }
        })
      } catch (e) {
        if (!isWorktree(workspaceId)) return
        set((s) => ({ errors: { ...s.errors, [workspaceId]: errorText(e) } }))
      }
    },

    async refreshAll() {
      await Promise.all(sessions().workspaces.filter((w) => w.kind === 'worktree').map((w) => get().refresh(w.id)))
    },

    open() {
      const live = liveBrowserId(useBrowser.getState())
      if (live) useBrowser.getState().blur(live)
      blurTerminals()
      ui().setView('worktrees')
      set((s) => ({ cursor: settleCursor(ids(), s.cursor), error: null }))
      void get().refreshAll()
      // Para saber si N / I tienen sentido en cada proyecto.
      sessions().projects.forEach((p) => get().probeRepo(p.id))
    },

    back: () => ui().setView('fleet'),

    setCursor: (cursor) => set({ cursor }),

    moveCursor(delta) {
      const list = ids()
      set((s) => ({ cursor: cursorAfterMove(list, settleCursor(list, s.cursor), delta) }))
    },

    async create(projectId, name) {
      set({ error: null })
      const clean = name === undefined ? undefined : normalizeWorktreeName(name)
      if (clean === '') {
        set({ error: 'El nombre no puede estar vacío' })
        return null
      }
      try {
        const ws = await omni.invoke('worktree:create', projectId, { ...(clean === undefined ? {} : { name: clean }), ...locationOpt(projectId) })
        await reload()
        set({ cursor: ws.id })
        void get().refresh(ws.id)
        return ws
      } catch (e) {
        set({ error: errorText(e) })
        return null
      }
    },

    async createFromIssue(projectId, issue) {
      set({ error: null })
      try {
        // `git:issue` primero: valida `gh` y trae título y URL para el primer prompt (el workspace no los lleva).
        const info = await omni.invoke('git:issue', projectId, issue)
        const ws = await omni.invoke('worktree:create', projectId, { issue, ...locationOpt(projectId) })
        await reload()
        set({ cursor: ws.id })
        void get().refresh(ws.id)
        get().launchIn(ws.id, issuePrompt(info))
        return ws
      } catch (e) {
        set({ error: errorText(e) })
        return null
      }
    },

    async remove(workspaceId) {
      try {
        await omni.invoke('worktree:remove', workspaceId)
        await reload()
      } catch (e) {
        set({ error: errorText(e) })
      }
    },

    discard(workspaceId) {
      if (!isWorktree(workspaceId)) return
      set({ discardId: workspaceId, error: null })
      ui().openOverlay('confirmDiscard')
    },

    async confirmDiscard(workspaceId) {
      set({ discardId: null })
      // Sus sesiones mueren primero: el directorio deja de existir.
      sessions()
        .sessions.filter((x) => x.workspaceId === workspaceId)
        .forEach((x) => sessions().kill(x.id))
      try {
        await omni.invoke('git:discard', workspaceId)
        await reload()
      } catch (e) {
        set({ error: errorText(e) })
      }
    },

    async runTests(workspaceId) {
      if (!isWorktree(workspaceId)) return
      set({ error: null })
      // Marca "corriendo" ya: main confirmará (o corregirá) por `worktree:changed`.
      set((s) => {
        const prev = s.statuses[workspaceId]
        return prev ? { statuses: { ...s.statuses, [workspaceId]: { ...prev, tests: { status: 'running', summary: '', at: Date.now() } } } } : {}
      })
      try {
        await omni.invoke('worktree:runTests', workspaceId)
      } catch (e) {
        set({ error: errorText(e) })
        void get().refresh(workspaceId)
      }
    },

    launchIn(workspaceId, prompt = null) {
      if (!isWorktree(workspaceId)) return
      // El workspace viaja con la espera: cerrar un overlay puede mover `currentWorkspaceId`; `launch()` lo fija de nuevo.
      sessions().setWorkspace(workspaceId)
      set({ pendingLaunch: { workspaceId, prompt }, launchInNew: false })
      ui().closeOverlay()
      ui().setLaunchTarget('tab')
      ui().openOverlay('launcher')
    },

    async createForLaunch(agent) {
      const s = sessions()
      const current = s.workspaces.find((w) => w.id === s.currentWorkspaceId)
      if (!current) return null
      const taken = s.workspaces.filter((w) => w.projectId === current.projectId && w.kind === 'worktree').map((w) => w.name)
      const badge = agentOf(s, agent)?.badge ?? agent
      return get().create(current.projectId, launcherWorktreeName(badge, taken))
    },

    setLaunchInNew: (launchInNew) => set({ launchInNew }),

    takeLaunchInNew() {
      const on = get().launchInNew
      if (on) set({ launchInNew: false })
      return on
    },

    takePendingLaunch() {
      const pending = get().pendingLaunch
      if (pending !== null) set({ pendingLaunch: null })
      return pending
    },

    linkLaunched(pending, info) {
      if (pending.prompt === null || NON_CODING.has(info.agent)) return
      writeWhenSettled(info.id, pending.prompt)
    },

    enterAgent(workspaceId) {
      const session = rows().find((r) => r.workspace.id === workspaceId)?.session
      if (!session) return
      ui().closeOverlay()
      ui().setView('fleet')
      focusSessionPane(session.id)
    },

    async setTestCommand(projectId, command, locationId) {
      const clean = command.trim()
      try {
        if (locationId) await omni.invoke('project:setTestCommand', projectId, clean === '' ? null : clean, locationId)
        else await omni.invoke('project:setTestCommand', projectId, clean === '' ? null : clean)
        await sessions().reloadProjects()
      } catch (e) {
        set({ error: errorText(e) })
      }
    },

    setTargetProject: (targetProjectId, targetLocationId = null) => set({ targetProjectId, targetLocationId }),

    probeRepo(projectId) {
      const local = localWorkspaceOf(sessions(), projectId)
      if (local) useQuickOpen.getState().loadBranch(local.id)
    },

    setNotice(notice) {
      clearTimeout(noticeTimer)
      set({ notice })
      if (notice !== null) noticeTimer = setTimeout(() => set({ notice: null }), NOTICE_MS)
    },

    async autoTests(sessionId) {
      const s = sessions()
      const session = s.sessions.find((x) => x.id === sessionId)
      if (!session || NON_CODING.has(session.agent) || !isWorktree(session.workspaceId)) return
      const ws = s.workspaces.find((w) => w.id === session.workspaceId)
      if (!ws || !testCommandOf(s.projects, ws)) return
      // Estado fresco (sin la caché de 5 s de main) antes de decidir.
      await get().refresh(session.workspaceId, true)
      const status = get().statuses[session.workspaceId]
      if (!status || !hasChanges(status) || status.tests?.status === 'running') return
      const fingerprint = statusFingerprint(status)
      if (lastAutoRun.get(session.workspaceId) === fingerprint) return
      lastAutoRun.set(session.workspaceId, fingerprint)
      await get().runTests(session.workspaceId)
    }
  }
})

/* ---------- selectores (estado derivado, nunca almacenado) ---------- */

type SessionsSlice = { workspaces: readonly Workspace[]; projects: readonly Project[]; sessions: readonly SessionInfo[] }

/**
 * Ubicación de la que saldría un worktree del proyecto (la que fija si es repo git, §3.5c): la actual si
 * es una ubicación de ese proyecto, si no la primera. `undefined` si el proyecto no tiene carpetas.
 */
export function localWorkspaceOf(s: { workspaces: readonly Workspace[]; currentWorkspaceId?: string | null }, projectId: string): Workspace | undefined {
  const current = s.workspaces.find((w) => w.id === s.currentWorkspaceId)
  if (current && current.projectId === projectId && current.kind !== 'worktree') return current
  return s.workspaces.find((w) => w.projectId === projectId && w.kind !== 'worktree')
}

/**
 * El proyecto es un repo git según la rama cacheada de su workspace local (`workspace:branch`, cache del
 * quick open): `true` / `false` si ya se sabe, `null` si aún no se pidió (se trata como posible).
 */
export function projectIsRepo(s: { workspaces: readonly Workspace[]; currentWorkspaceId?: string | null }, projectId: string, branches: Record<string, { name: string | null }> = useQuickOpen.getState().branches): boolean | null {
  const local = localWorkspaceOf(s, projectId)
  if (!local) return null
  const cached = branches[local.id]
  return cached ? cached.name !== null : null
}

/** Filas de la vista, ya ordenadas (§3.15); los worktrees de proyectos ocultos (§3.5c) solo con `showHidden`. */
export function visibleRows(w: Pick<WorktreesState, 'statuses' | 'firstSeen'>, s: SessionsSlice, showHidden = useUi.getState().showHidden): WorktreeRow[] {
  return worktreeRows(s.workspaces, visibleProjects(s.projects, showHidden), s.sessions, w.statuses, w.firstSeen)
}

/** Fila bajo el cursor (o la primera). */
export function currentRow(w: Pick<WorktreesState, 'statuses' | 'firstSeen' | 'cursor'>, s: SessionsSlice): WorktreeRow | undefined {
  const list = visibleRows(w, s)
  return list.find((r) => r.workspace.id === w.cursor) ?? list[0]
}

/** Worktrees vivos: el conteo del ítem del sidebar. Los de proyectos ocultos (§3.5c) no cuentan salvo con `showHidden`. */
export function worktreeCount(s: { workspaces: readonly Workspace[]; projects?: readonly Project[] }, showHidden = useUi.getState().showHidden): number {
  const hidden = new Set(showHidden ? [] : (s.projects ?? []).filter((p) => p.hidden).map((p) => p.id))
  return s.workspaces.filter((w) => w.kind === 'worktree' && !hidden.has(w.projectId)).length
}

/** Aviso de `project.remove` cuando main conserva worktrees con cambios en disco. */
export function keptWorktreesNotice(paths: readonly string[]): string | null {
  if (paths.length === 0) return null
  const dir = paths[0].replace(/\/[^/]+$/, '')
  return `Se ${paths.length === 1 ? 'conserva 1 worktree' : `conservan ${paths.length} worktrees`} con cambios en ${dir}`
}

/**
 * El worktree sale de la ubicación en la que está parado el usuario (§3.5c); desde un worktree o desde
 * otro proyecto, de la primera ubicación del proyecto.
 */
function locationOpt(projectId: string): { locationId?: string } {
  const ws = localWorkspaceOf(useSessions.getState(), projectId)
  return ws ? { locationId: ws.id } : {}
}
