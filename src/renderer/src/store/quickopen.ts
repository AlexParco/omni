import { create } from 'zustand'
import type { FileHit } from '@shared/types'
import { omni } from '@/lib/omni'

/**
 * Estado del quick open (ARCHITECTURE §3.11): el texto del campo, el cursor sobre la lista plana,
 * los archivos que devolvió main para la consulta vigente y la cache de ramas por workspace.
 * Qué se lista y en qué orden lo decide `features/quickopen` (derivado, no almacenado).
 */
export interface Branch {
  name: string | null
  at: number
}

interface QuickOpenState {
  query: string
  /** Índice del resultado activo sobre la lista plana que pinta el overlay. */
  index: number
  /** Archivos de main para `filesQuery`; vacío si la consulta no pide archivos. */
  files: FileHit[]
  /** Carpetas que main sugiere para la ruta escrita (abrir proyecto por ruta); vacío si no se escribe una ruta. */
  paths: string[]
  /** Rama git por workspace, con el momento en que se pidió. */
  branches: Record<string, Branch>
  setQuery(query: string): void
  setIndex(index: number): void
  /** Vuelve al estado inicial al abrir: consulta vacía y cursor arriba. La cache de ramas se queda. */
  reset(): void
  /** Pide a main los archivos que casan (debounce de 80 ms); `null` descarta la lista. */
  searchFiles(text: string | null, limit: number): void
  /** Pide a main las carpetas que completan la ruta (mismo debounce que los archivos); `null` las descarta. */
  suggestPaths(input: string | null): void
  /** Pide la rama del workspace si no está en cache o ya caducó. */
  loadBranch(workspaceId: string): void
}

/** Las teclas llegan a ritmo de escritura: se pide a main cuando el usuario para un instante. */
export const FILES_DEBOUNCE_MS = 80
/** Una rama cambia poco: se vuelve a pedir pasado este tiempo. */
const BRANCH_TTL_MS = 30_000

let debounce: ReturnType<typeof setTimeout> | undefined
/** Generación de la última consulta: una respuesta vieja que llega tarde no pisa a la nueva. */
let generation = 0
let pathDebounce: ReturnType<typeof setTimeout> | undefined
let pathGeneration = 0
const branchInFlight = new Set<string>()

export const useQuickOpen = create<QuickOpenState>((set, get) => ({
  query: '',
  index: 0,
  files: [],
  paths: [],
  branches: {},

  // Los archivos son de la consulta anterior: se vacían hasta que main conteste la nueva.
  setQuery: (query) => set({ query, index: 0, files: [] }),
  setIndex: (index) => set({ index }),

  reset() {
    clearTimeout(debounce)
    clearTimeout(pathDebounce)
    generation++
    pathGeneration++
    set({ query: '', index: 0, files: [], paths: [] })
  },

  suggestPaths(input) {
    clearTimeout(pathDebounce)
    const gen = ++pathGeneration
    if (input === null) {
      if (get().paths.length > 0) set({ paths: [] })
      return
    }
    pathDebounce = setTimeout(() => {
      omni
        .invoke('project:suggestPaths', input)
        .then((paths) => {
          if (gen === pathGeneration) set({ paths })
        })
        .catch(() => {
          if (gen === pathGeneration) set({ paths: [] })
        })
    }, FILES_DEBOUNCE_MS)
  },

  searchFiles(text, limit) {
    clearTimeout(debounce)
    const gen = ++generation
    if (text === null || text.length === 0) {
      if (get().files.length > 0) set({ files: [] })
      return
    }
    debounce = setTimeout(() => {
      omni
        .invoke('files:search', text, limit)
        .then((files) => {
          if (gen === generation) set({ files })
        })
        .catch(() => {
          if (gen === generation) set({ files: [] })
        })
    }, FILES_DEBOUNCE_MS)
  },

  loadBranch(workspaceId) {
    const cached = get().branches[workspaceId]
    if ((cached && Date.now() - cached.at < BRANCH_TTL_MS) || branchInFlight.has(workspaceId)) return
    branchInFlight.add(workspaceId)
    omni
      .invoke('workspace:branch', workspaceId)
      .then((name) => set((s) => ({ branches: { ...s.branches, [workspaceId]: { name, at: Date.now() } } })))
      .catch(() => set((s) => ({ branches: { ...s.branches, [workspaceId]: { name: null, at: Date.now() } } })))
      .finally(() => branchInFlight.delete(workspaceId))
  }
}))
