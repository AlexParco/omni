import { create } from 'zustand'
import type { SessionInfo, Workspace, WorkspaceDiff, WorktreeStatus } from '@shared/types'
import { clampCursor, cursorAfterFile, cursorAfterHunk, cursorAfterLine, fileAt, firstCursor, lineAt, type DiffCursor } from '@/core/diff-nav'
import { omni } from '@/lib/omni'
import { blurTerminals } from '@/panes/terminal/terminal-host'
import { liveBrowserId, useBrowser } from './browser'
import { anchorOf, formatComments, newComment, pendingComments, reanchorComments, reviewMarkdown, type CommentAnchor, type ReviewComment } from './review-logic'
import { providedReviewTarget } from './review-target'
import { writeToSession } from './session-write'
import { useSessions, workspaceOf } from './sessions'
import { useUi } from './ui'
import { useWorktrees } from './worktrees'

/** Compositor abierto bajo una línea: dónde se ancla y lo escrito hasta ahora. */
export interface Composer extends CommentAnchor {
  text: string
}

interface ReviewState {
  workspaceId: string | null
  /** Rama contra la que se pide el diff (broadcast `⇧D`, §3.18); `null` = la base del worktree. */
  base: string | null
  diff: WorkspaceDiff | null
  status: WorktreeStatus | null
  loading: boolean
  /** Error de la última carga o acción (merge, descarte); se pinta en el pie y se limpia al recargar. */
  error: string | null
  /** Aviso breve del pie ("copiado al portapapeles", "merge hecho"). */
  notice: string | null
  cursor: DiffCursor | null
  comments: ReviewComment[]
  composer: Composer | null

  /** Escucha `worktree:changed`: con la revisión en pantalla recarga; si el worktree desapareció, vuelve. Devuelve la función para pararlo. */
  init(): () => void
  /** `review.open`: saca el teclado de la terminal, pone la vista y pide `git:diff` y `worktree:status`. `base` = otra rama como base (diff entre dos candidatos de broadcast). */
  open(workspaceId: string, base?: string): Promise<void>
  /** `review.reload`: vuelve a pedir diff y estado; el cursor se asienta y los comentarios se re-anclan por texto (`reanchorComments`). */
  reload(): Promise<void>
  /** `review.back`: vuelve a Worktrees. */
  back(): void
  setCursor(cursor: DiffCursor | null): void
  nextLine(): void
  prevLine(): void
  nextHunk(): void
  prevHunk(): void
  nextFile(): void
  prevFile(): void
  /** `review.comment`: abre el compositor bajo la línea del cursor (o lo enfoca si ya estaba ahí). */
  startComment(): void
  setComposerText(text: string): void
  /** `⌘⏎` en el compositor: guarda el comentario (vacío = cancela). */
  saveComment(): void
  cancelComment(): void
  removeComment(id: string): void
  /** `review.send`: escribe los comentarios pendientes al agente del worktree; sin agente, al portapapeles. */
  send(): Promise<void>
  /** `review.export`: la revisión entera (resumen, comentarios y diff) como Markdown para un PR, al portapapeles. */
  exportMarkdown(): Promise<void>
  /** `review.merge`: con sesiones vivas en el worktree pide confirmación (se matarán); si no, mergea al toque. */
  merge(): void
  /** El usuario confirmó el merge: `git:merge`, mata las sesiones del worktree y vuelve a Worktrees. */
  confirmMerge(): Promise<void>
  /** `review.discard`: pasa por el overlay `confirmDiscard` de Worktrees; al desaparecer el worktree, `init` vuelve a la vista. */
  discard(): void
  /** `review.editor`: abre el archivo bajo el cursor con la app del sistema. */
  openInEditor(): void
  clearNotice(): void
}

const sessions = useSessions.getState
const ui = useUi.getState

/* ---------- destino de `review.open` ---------- */

/** Worktree que abriría `review.open` ahora mismo: proveedores (`review-target.ts`), cursor del sidebar sobre un worktree, o el workspace actual si lo es. */
export function reviewTargetId(): string | null {
  const provided = providedReviewTarget()
  if (provided) return provided
  const s = sessions()
  const cur = s.cursor
  if (cur?.startsWith('ws:')) {
    const ws = workspaceOf(s, cur.slice(3))
    if (ws?.kind === 'worktree') return ws.id
  }
  const ws = s.currentWorkspaceId ? workspaceOf(s, s.currentWorkspaceId) : undefined
  return ws?.kind === 'worktree' ? ws.id : null
}

/* ---------- selectores ---------- */

/** Sesiones vivas del worktree. */
export function worktreeSessions(s: Pick<ReturnType<typeof useSessions.getState>, 'sessions'>, workspaceId: string | null): SessionInfo[] {
  return workspaceId ? s.sessions.filter((x) => x.workspaceId === workspaceId) : []
}

/** El agente del worktree: la primera sesión que no es shell ni navegador. A él se le escriben los comentarios. */
export function worktreeAgent(s: Pick<ReturnType<typeof useSessions.getState>, 'sessions'>, workspaceId: string | null): SessionInfo | undefined {
  return worktreeSessions(s, workspaceId).find((x) => x.agent !== 'shell' && x.agent !== 'browser')
}

export function reviewWorkspace(r: Pick<ReviewState, 'workspaceId'>, s: Pick<ReturnType<typeof useSessions.getState>, 'workspaces'>): Workspace | undefined {
  return r.workspaceId ? workspaceOf(s, r.workspaceId) : undefined
}

/** Ancla de la línea bajo el cursor, o `null` si no hay línea (binario, diff vacío). */
export function cursorAnchor(r: Pick<ReviewState, 'diff' | 'cursor'>): CommentAnchor | null {
  const files = r.diff?.files ?? []
  const file = fileAt(files, r.cursor)
  const line = lineAt(files, r.cursor)
  return file && line ? anchorOf(file.path, line) : null
}

/** Ruta absoluta del archivo bajo el cursor, si existe en disco (los borrados no). */
export function cursorFilePath(r: Pick<ReviewState, 'diff' | 'cursor' | 'workspaceId'>, s: Pick<ReturnType<typeof useSessions.getState>, 'workspaces'>): string | null {
  const ws = reviewWorkspace(r, s)
  const file = fileAt(r.diff?.files ?? [], r.cursor)
  if (!ws || !file || file.status === 'D') return null
  return `${ws.path}/${file.path}`
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useReview = create<ReviewState>((set, get) => {
  const move = (fn: (files: WorkspaceDiff['files'], cursor: DiffCursor | null) => DiffCursor | null): void => {
    const { diff, cursor } = get()
    if (!diff) return
    set({ cursor: fn(diff.files, cursor) })
  }

  /** Pide diff y estado del worktree; `fresh` resetea cursor y comentarios (otro worktree). */
  const load = async (workspaceId: string, fresh: boolean): Promise<void> => {
    set({ loading: true, error: null })
    try {
      const base = get().base
      const [diff, status] = await Promise.all([base === null ? omni.invoke('git:diff', workspaceId) : omni.invoke('git:diff', workspaceId, base), omni.invoke('worktree:status', workspaceId).catch(() => null)])
      if (get().workspaceId !== workspaceId) return
      set((s) => ({ diff, status, loading: false, cursor: fresh ? firstCursor(diff.files) : clampCursor(diff.files, s.cursor), comments: fresh ? [] : reanchorComments(diff.files, s.comments) }))
    } catch (e) {
      if (get().workspaceId !== workspaceId) return
      set({ loading: false, error: errorText(e) })
    }
  }

  /** Mata las sesiones del worktree y vuelve a Worktrees con el aviso. */
  const leaveWith = (notice: string): void => {
    for (const s of worktreeSessions(sessions(), get().workspaceId)) sessions().kill(s.id)
    set({ notice, composer: null })
    ui().setView('worktrees')
  }

  return {
    workspaceId: null,
    base: null,
    diff: null,
    status: null,
    loading: false,
    error: null,
    notice: null,
    cursor: null,
    comments: [],
    composer: null,

    init() {
      const off = omni.on('worktree:changed', (id) => {
        const { workspaceId } = get()
        if (!workspaceId || ui().view !== 'review') return
        if (id !== null && id !== workspaceId) return
        void get().reload()
      })
      // Si el worktree desaparece de la lista (descartado, o lo limpió main) con la revisión en pantalla, se vuelve a Worktrees.
      const offSessions = useSessions.subscribe((s, prev) => {
        if (s.workspaces === prev.workspaces) return
        const { workspaceId } = get()
        if (workspaceId && ui().view === 'review' && !workspaceOf(s, workspaceId)) {
          set({ notice: 'Worktree descartado' })
          get().back()
        }
      })
      return () => {
        off()
        offSessions()
      }
    },

    async open(workspaceId, base) {
      // Si la página de un navegador tenía el teclado, main se lo devuelve al renderer antes de cambiar de vista.
      const live = liveBrowserId(useBrowser.getState())
      if (live) useBrowser.getState().blur(live)
      blurTerminals()
      // Otro worktree u otra base (diff entre dos candidatos) es otra revisión: cursor y comentarios desde cero.
      const fresh = get().workspaceId !== workspaceId || get().base !== (base ?? null)
      if (fresh) set({ workspaceId, base: base ?? null, diff: null, status: null, cursor: null, comments: [], composer: null, notice: null, error: null })
      ui().setView('review')
      await load(workspaceId, fresh)
    },

    async reload() {
      const { workspaceId } = get()
      if (workspaceId) await load(workspaceId, false)
    },

    back() {
      set({ composer: null })
      ui().setView('worktrees')
    },

    setCursor: (cursor) => set({ cursor }),
    nextLine: () => move((f, c) => cursorAfterLine(f, c, 1)),
    prevLine: () => move((f, c) => cursorAfterLine(f, c, -1)),
    nextHunk: () => move((f, c) => cursorAfterHunk(f, c, 1)),
    prevHunk: () => move((f, c) => cursorAfterHunk(f, c, -1)),
    nextFile: () => move((f, c) => cursorAfterFile(f, c, 1)),
    prevFile: () => move((f, c) => cursorAfterFile(f, c, -1)),

    startComment() {
      const anchor = cursorAnchor(get())
      if (!anchor) return
      const { composer } = get()
      if (composer && composer.path === anchor.path && composer.line === anchor.line && composer.side === anchor.side) return
      set({ composer: { ...anchor, text: '' } })
    },

    setComposerText(text) {
      const { composer } = get()
      if (composer) set({ composer: { ...composer, text } })
    },

    saveComment() {
      const { composer } = get()
      if (!composer) return
      const text = composer.text.trim()
      if (text === '') return set({ composer: null })
      set((s) => ({ composer: null, comments: [...s.comments, newComment(composer, text)] }))
    },

    cancelComment: () => set({ composer: null }),

    removeComment: (id) => set((s) => ({ comments: s.comments.filter((c) => c.id !== id) })),

    async send() {
      const { workspaceId, diff, comments } = get()
      const pending = pendingComments(comments)
      if (!workspaceId || pending.length === 0) return
      const ws = workspaceOf(sessions(), workspaceId)
      const branch = diff?.branch ?? `omni/${ws?.name ?? ''}`
      const text = formatComments(branch, pending)
      const agent = worktreeAgent(sessions(), workspaceId)
      if (agent) {
        writeToSession(agent.id, text, true)
        set({ notice: pending.length === 1 ? 'Comentario enviado al agente' : `${pending.length} comentarios enviados al agente` })
      } else {
        await navigator.clipboard.writeText(text)
        set({ notice: 'Sin agente en el worktree: comentarios copiados al portapapeles' })
      }
      set((s) => ({ comments: s.comments.map((c) => (pending.some((p) => p.id === c.id) ? { ...c, sent: true } : c)) }))
    },

    async exportMarkdown() {
      const { workspaceId, diff, comments } = get()
      if (!workspaceId || !diff) return
      const text = reviewMarkdown(diff, comments, useWorktrees.getState().statuses[workspaceId]?.tests)
      try {
        await navigator.clipboard.writeText(text)
        const n = comments.length
        set({ notice: n === 0 ? 'Revisión copiada como Markdown' : `Revisión copiada como Markdown, con ${n === 1 ? '1 comentario' : `${n} comentarios`}` })
      } catch {
        set({ notice: 'No se pudo copiar la revisión' })
      }
    },

    merge() {
      if (!get().workspaceId) return
      if (worktreeSessions(sessions(), get().workspaceId).length > 0) ui().openOverlay('confirmMerge')
      else void get().confirmMerge()
    },

    async confirmMerge() {
      const { workspaceId } = get()
      if (!workspaceId) return
      set({ error: null })
      try {
        const { commit } = await omni.invoke('git:merge', workspaceId)
        leaveWith(`Merge hecho: ${commit.slice(0, 7)}`)
      } catch (e) {
        set({ error: errorText(e) })
      }
    },

    discard() {
      const { workspaceId } = get()
      if (!workspaceId) return
      set({ error: null, composer: null })
      useWorktrees.getState().discard(workspaceId)
    },

    openInEditor() {
      const path = cursorFilePath(get(), sessions())
      if (path) void omni.invoke('file:open', path).catch((e: unknown) => set({ error: errorText(e) }))
    },

    clearNotice: () => set({ notice: null })
  }
})
