import { create } from 'zustand'
import type { DocKind, SessionInfo } from '@shared/types'
import { omni } from '@/lib/omni'
import { getEditor } from '@/panes/editor/editor-host'
import { relPath, workspaceOfPath } from '@/panes/editor/editor-logic'
import { leaves, useLayout } from './layout'
import { useSessions } from './sessions'
import { useUi, type LaunchTarget } from './ui'

/**
 * Panes de documento (ARCHITECTURE §3.19 y §3.20): abrir un editor o una vista previa es pedir a
 * main una sesión sin proceso (`doc:open`) y colocarla en el layout como hace el navegador (tab
 * nuevo o split del pane con foco). Aquí también vive lo que el resto de la app necesita saber de
 * un documento sin tocar CodeMirror: si está sucio (para no cerrarlo a ciegas) y el diálogo que
 * pide una ruta desde el launcher.
 */

export interface PathDialog {
  kind: DocKind
  target: LaunchTarget
  error: string | null
}

interface DocsState {
  /** Editores con cambios sin guardar; lo mantiene `editor-host`. */
  dirty: Record<string, true>
  /** Editores sucios que el usuario intentó cerrar: esperan en el overlay `confirmDiscardDoc`. */
  pendingClose: string[]
  /** Editor cuyo archivo cambió en disco y el usuario quiere guardar: espera en `confirmOverwriteDoc`. */
  pendingSave: string | null
  /** Diálogo "Abrir en el editor / vista previa" (overlay `editorPath`). */
  pathDialog: PathDialog | null
  setDirty(id: string, dirty: boolean): void
  /**
   * Abre el documento en el workspace y lo coloca según `target`. Si ya hay un pane con ese archivo
   * y tipo, solo se enfoca. Devuelve la sesión, o `null` si main no pudo (sin workspace, ruta fuera).
   */
  open(workspaceId: string, path: string, kind: DocKind, target: LaunchTarget): Promise<SessionInfo | null>
  /** Editor en un split a la derecha del pane con foco (quick open `⌘⏎`), en el workspace que contiene la ruta. */
  openEditorBeside(path: string): Promise<void>
  /** Cierra el pane (mata la sesión) si no está sucio; si lo está, abre la confirmación y devuelve `false`. */
  closeIfClean(id: string): boolean
  /**
   * Varios panes a la vez (cerrar un tab): los editores sucios van juntos a la confirmación y se
   * devuelven los demás, para que quien llama los mate por su camino normal.
   */
  closeManyIfClean(ids: string[]): string[]
  /** El usuario confirmó descartar: se matan las sesiones pendientes. */
  confirmDiscard(): void
  cancelDiscard(): void
  /** `⌘S` con el archivo cambiado en disco: abre `confirmOverwriteDoc` para ese editor. */
  askOverwrite(id: string): void
  clearPendingSave(): void
  openPathDialog(kind: DocKind, target: LaunchTarget): void
  closePathDialog(): void
  /** ⏎ en el diálogo: ruta relativa al workspace actual (o absoluta). */
  openFromDialog(input: string): Promise<void>
}

/** Carpeta home deducida de una ruta (`/Users/<u>` o `/home/<u>`), para expandir `~`; `null` si no se ve. */
export function homeOf(path: string): string | null {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(path)
  return m ? m[1] : null
}

/**
 * Ruta canónica: `~` expandido (con la home que se deduce del workspace), `.` y `..` resueltos,
 * barras repetidas y final quitadas. Así `/repo//src/../src/a.ts` y `/repo/src/a.ts` son el mismo
 * documento y no se abre dos veces (`findDoc`).
 */
export function normalizePath(path: string, homeHint = ''): string {
  let p = path.trim()
  if (p === '~' || p.startsWith('~/')) {
    const home = homeOf(homeHint)
    if (home) p = home + p.slice(1)
  }
  const absolute = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return absolute ? `/${joined}` : joined || '.'
}

/** Resuelve lo escrito en el diálogo contra la raíz del workspace y lo canoniza. */
export function resolveInput(workspacePath: string, input: string): string {
  const text = input.trim()
  if (text.startsWith('/') || text === '~' || text.startsWith('~/')) return normalizePath(text, workspacePath)
  return normalizePath(`${workspacePath}/${text}`, workspacePath)
}

/** Sesión de documento ya abierta con ese archivo (rutas canonizadas) y tipo, si existe. */
export function findDoc(sessions: SessionInfo[], workspaceId: string, path: string, kind: DocKind): SessionInfo | undefined {
  const wanted = normalizePath(path)
  return sessions.find((s) => s.agent === kind && s.workspaceId === workspaceId && s.args?.[0] !== undefined && normalizePath(s.args[0]) === wanted)
}

/** La sesión es un pane de documento (editor o vista previa). */
function isDoc(id: string): boolean {
  const agent = useSessions.getState().sessions.find((s) => s.id === id)?.agent
  return agent === 'editor' || agent === 'preview'
}

/** Lleva el teclado al pane del documento: tab activo, foco del layout, cursor del sidebar y foco DOM. */
function focusDoc(id: string): void {
  const lay = useLayout.getState()
  const tab = lay.tabs.find((t) => leaves(t.root).some((l) => l.sessionId === id))
  const leaf = tab && leaves(tab.root).find((l) => l.sessionId === id)
  if (tab && leaf) useSessions.getState().activatePane(tab.id, leaf.id)
  useUi.getState().setFocus('terminal')
  // Si el pane aún no montó, `EditorPane` enfoca al montar con la intención ya puesta.
  getEditor(id)?.focus()
}

export const useDocs = create<DocsState>((set, get) => ({
  dirty: {},
  pendingClose: [],
  pendingSave: null,
  pathDialog: null,

  setDirty(id, dirty) {
    set((s) => {
      const { [id]: _was, ...rest } = s.dirty
      return { dirty: dirty ? { ...rest, [id]: true } : rest }
    })
  },

  async open(workspaceId, rawPath, kind, target) {
    const sessions = useSessions.getState()
    const ws = sessions.workspaces.find((w) => w.id === workspaceId)
    const path = normalizePath(rawPath, ws?.path ?? '')
    const existing = findDoc(sessions.sessions, workspaceId, path, kind)
    if (existing) {
      focusDoc(existing.id)
      return existing
    }
    const info = await omni.invoke('doc:open', workspaceId, path, kind)
    useSessions.setState((s) => ({ sessions: s.sessions.some((x) => x.id === info.id) ? s.sessions : [...s.sessions, info], currentWorkspaceId: workspaceId }))
    const lay = useLayout.getState()
    if (target === 'tab') lay.openTab(info.workspaceId, info.id)
    else lay.split(info.workspaceId, target === 'split-right' ? 'row' : 'col', info.id)
    focusDoc(info.id)
    return info
  },

  async openEditorBeside(path) {
    const s = useSessions.getState()
    const ws = workspaceOfPath(s.workspaces, path, s.currentWorkspaceId)
    if (!ws) return
    try {
      await get().open(ws.id, path, 'editor', 'split-right')
    } catch (e) {
      console.warn('No se pudo abrir el editor', e)
    }
  },

  closeIfClean(id) {
    if (get().dirty[id]) {
      set({ pendingClose: [id] })
      useUi.getState().openOverlay('confirmDiscardDoc')
      return false
    }
    useSessions.getState().kill(id)
    return true
  },

  closeManyIfClean(ids) {
    const dirty = ids.filter((id) => get().dirty[id])
    const clean = ids.filter((id) => !get().dirty[id])
    if (dirty.length > 0) {
      set({ pendingClose: dirty })
      useUi.getState().openOverlay('confirmDiscardDoc')
    }
    // Solo los documentos limpios se matan aquí; las terminales y navegadores de la lista los mata quien llama.
    clean.filter((id) => isDoc(id)).forEach((id) => useSessions.getState().kill(id))
    return clean
  },

  confirmDiscard() {
    const ids = get().pendingClose
    set({ pendingClose: [] })
    ids.forEach((id) => useSessions.getState().kill(id))
  },

  cancelDiscard: () => set({ pendingClose: [] }),

  askOverwrite(id) {
    set({ pendingSave: id })
    useUi.getState().openOverlay('confirmOverwriteDoc')
  },

  clearPendingSave: () => set({ pendingSave: null }),

  openPathDialog(kind, target) {
    set({ pathDialog: { kind, target, error: null } })
    useUi.getState().openOverlay('editorPath')
  },

  closePathDialog() {
    set({ pathDialog: null })
    useUi.getState().closeOverlay()
  },

  async openFromDialog(input) {
    const dialog = get().pathDialog
    const s = useSessions.getState()
    const ws = s.workspaces.find((w) => w.id === s.currentWorkspaceId)
    if (!dialog || !ws || input.trim() === '') return
    const path = resolveInput(ws.path, input)
    try {
      const info = await get().open(ws.id, path, dialog.kind, dialog.target)
      if (info) get().closePathDialog()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ pathDialog: { ...dialog, error: msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') } })
    }
  }
}))

/** Ruta relativa del documento para la franja y los diálogos. */
export function docLabel(info: SessionInfo, workspacePath: string | undefined): string {
  const path = info.args?.[0] ?? ''
  return workspacePath ? relPath(workspacePath, path) : path
}
