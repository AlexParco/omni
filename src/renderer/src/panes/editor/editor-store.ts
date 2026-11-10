import { create } from 'zustand'
import type { CodeDiagnostic, TreeEntry } from '@shared/types'
import type { LineHunk } from '@/core/line-diff'
import type { SeenHunk } from './editor-logic'

/**
 * Estado reactivo de cada pane de editor (ARCHITECTURE §3.19): lo que la franja, la cabecera, el
 * árbol y el compositor pintan. El buffer vive en CodeMirror (`editor-host.ts`); aquí solo hay
 * hechos derivados de él (sucio, modo vim, hunks, línea del cursor) y la UI que lo rodea.
 */

/** Modo de vim tal como lo publica `vim-mode-change`, en mayúsculas para la franja. */
export type VimMode = 'NORMAL' | 'INSERT' | 'VISUAL' | 'REPLACE'

export interface Composer {
  /** Línea ancla (base 0) del hunk bajo el que se escribe; es la que va en `ruta:línea`. */
  line: number
  text: string
  /** Hueco DOM que el widget de CodeMirror pinta bajo el hunk; React lo rellena por portal. */
  el: HTMLElement
}

export interface TreeState {
  /** Directorio listado (absoluto). */
  dir: string
  entries: TreeEntry[]
  cursor: number
  loading: boolean
}

export interface EditorDoc {
  id: string
  workspaceId: string
  path: string
  /** `file:read` terminó (bien o mal). */
  loaded: boolean
  error: string | null
  dirty: boolean
  mode: VimMode
  /** Texto en la base (`git:fileAtBase`); `null` si el archivo es nuevo o no hay repo. */
  base: string | null
  /** Hunks respecto a la base, todos (los vistos se filtran al pintar con `visibleHunks`). */
  hunks: LineHunk[]
  seen: SeenHunk[]
  /** Línea del cursor (base 0). */
  line: number
  lineCount: number
  composer: Composer | null
  tree: TreeState | null
  /** El archivo cambió en disco con el buffer sucio: la franja avisa y `R` recarga. */
  changedOnDisk: boolean
  /** Aviso transitorio en la cabecera ("Guardado", "Enviado a Claude Code"). */
  notice: string | null
  /** Errores y avisos: los del servidor de lenguaje en vivo más los de tsc/eslint del último chequeo (al abrir y al guardar). */
  diagnostics: CodeDiagnostic[]
  /** Herramientas que corrieron en el último chequeo; vacío si el proyecto no tiene ninguna. */
  diagnosticTools: Array<'tsc' | 'eslint'>
  /** Hay un chequeo en curso. */
  checking: boolean
  /** Diff plegado: solo se ven los cambios y unas líneas alrededor (`editor.changesOnly`). */
  changesOnly: boolean
  /** Servidor de lenguaje del archivo (§3.19b); `null` si el proyecto no tiene uno para este lenguaje. */
  lsp: LspStatus | null
}

/** Estado del servidor de lenguaje para la cabecera: arrancando, listo o caído (con el motivo). */
export interface LspStatus {
  /** "TypeScript 5.9.3", "gopls". */
  name: string
  state: 'starting' | 'ready' | 'error'
  error: string | null
}

interface EditorState {
  docs: Record<string, EditorDoc>
  ensure(id: string, workspaceId: string, path: string): void
  patch(id: string, patch: Partial<EditorDoc>): void
  remove(id: string): void
  notify(id: string, text: string): void
}

/** Cuánto dura un aviso de la cabecera. */
const NOTICE_MS = 3000
const noticeTimers = new Map<string, number>()

export const useEditor = create<EditorState>((set, get) => ({
  docs: {},

  ensure(id, workspaceId, path) {
    if (get().docs[id]) return
    const doc: EditorDoc = { id, workspaceId, path, loaded: false, error: null, dirty: false, mode: 'NORMAL', base: null, hunks: [], seen: [], line: 0, lineCount: 0, composer: null, tree: null, changedOnDisk: false, notice: null, diagnostics: [], diagnosticTools: [], checking: false, changesOnly: false, lsp: null }
    set((s) => ({ docs: { ...s.docs, [id]: doc } }))
  },

  patch(id, patch) {
    const doc = get().docs[id]
    if (!doc) return
    set((s) => ({ docs: { ...s.docs, [id]: { ...doc, ...patch } } }))
  },

  remove(id) {
    clearTimeout(noticeTimers.get(id))
    noticeTimers.delete(id)
    set((s) => {
      const { [id]: _gone, ...docs } = s.docs
      return { docs }
    })
  },

  notify(id, text) {
    clearTimeout(noticeTimers.get(id))
    get().patch(id, { notice: text })
    noticeTimers.set(id, window.setTimeout(() => get().patch(id, { notice: null }), NOTICE_MS))
  }
}))

/** Doc del pane, o `undefined` si no está cargado. */
export function docOf(s: Pick<EditorState, 'docs'>, id: string): EditorDoc | undefined {
  return s.docs[id]
}
