import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AppState, SavedBrowser, SavedDoc, SavedNode, SavedTab } from '@shared/types'

const DEFAULT_FILE = join(homedir(), '.config', 'omni', 'state.json')

/**
 * `~/.config/omni/state.json`: layout y navegadores que el renderer necesita para volver a donde
 * estaba (ARCHITECTURE §3.10). Main lo escribe en cada `state:save` (atómico: tmp + rename) y lo
 * lee al arrancar. Un archivo corrupto se ignora: arrancar sin estado es siempre válido.
 */
export class StateStore {
  constructor(private readonly file = DEFAULT_FILE) {}

  load(): AppState | null {
    if (!existsSync(this.file)) return null
    try {
      return sanitizeState(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (err) {
      console.warn(`[omni] se ignora ${this.file}:`, err)
      return null
    }
  }

  save(state: AppState): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
    renameSync(tmp, this.file)
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function sanitizeNode(x: unknown): SavedNode | null {
  if (!isRecord(x) || typeof x.id !== 'string') return null
  if (x.kind === 'leaf') return typeof x.sessionId === 'string' ? { kind: 'leaf', id: x.id, sessionId: x.sessionId } : null
  if (x.kind !== 'split' || (x.dir !== 'row' && x.dir !== 'col') || !Array.isArray(x.children)) return null
  const children = x.children.map(sanitizeNode).filter((c): c is SavedNode => c !== null)
  if (children.length === 0) return null
  const sizes = Array.isArray(x.sizes) ? x.sizes.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0) : []
  return { kind: 'split', id: x.id, dir: x.dir, sizes: sizes.length === children.length ? sizes : children.map(() => 1 / children.length), children }
}

function sanitizeTab(x: unknown): SavedTab | null {
  if (!isRecord(x) || typeof x.id !== 'string' || typeof x.workspaceId !== 'string') return null
  const root = sanitizeNode(x.root)
  if (!root) return null
  return {
    id: x.id,
    workspaceId: x.workspaceId,
    root,
    focusedPaneId: typeof x.focusedPaneId === 'string' ? x.focusedPaneId : '',
    zoomedPaneId: typeof x.zoomedPaneId === 'string' ? x.zoomedPaneId : null
  }
}

function sanitizeBrowser(x: unknown): SavedBrowser | null {
  if (!isRecord(x) || typeof x.id !== 'string' || typeof x.workspaceId !== 'string' || typeof x.url !== 'string') return null
  const browser: SavedBrowser = { id: x.id, workspaceId: x.workspaceId, url: x.url }
  if (typeof x.profileId === 'string' && x.profileId !== '') browser.profileId = x.profileId
  return browser
}

function sanitizeDoc(x: unknown): SavedDoc | null {
  if (!isRecord(x) || typeof x.id !== 'string' || typeof x.workspaceId !== 'string' || typeof x.path !== 'string' || x.path === '') return null
  if (x.kind !== 'editor' && x.kind !== 'preview') return null
  return { id: x.id, workspaceId: x.workspaceId, path: x.path, kind: x.kind }
}

/** Deja solo lo que tiene forma válida; lo demás se descarta. `null` si no es ni un objeto. Exportado para tests. */
export function sanitizeState(raw: unknown): AppState | null {
  if (!isRecord(raw)) return null
  const docs = Array.isArray(raw.docs) ? raw.docs.map(sanitizeDoc).filter((d): d is SavedDoc => d !== null) : []
  const tabs = Array.isArray(raw.tabs) ? raw.tabs.map(sanitizeTab).filter((t): t is SavedTab => t !== null) : []
  const activeTab: Record<string, string> = {}
  if (isRecord(raw.activeTab)) for (const [k, v] of Object.entries(raw.activeTab)) if (typeof v === 'string') activeTab[k] = v
  const browsers = Array.isArray(raw.browsers) ? raw.browsers.map(sanitizeBrowser).filter((b): b is SavedBrowser => b !== null) : []
  const state: AppState = {
    tabs,
    activeTab,
    currentWorkspaceId: typeof raw.currentWorkspaceId === 'string' ? raw.currentWorkspaceId : null,
    browsers,
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0
  }
  // `docs` es opcional: un estado anterior a los documentos se conserva tal cual.
  if (docs.length > 0) state.docs = docs
  if (isRecord(raw.titles)) {
    const titles: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.titles)) if (typeof v === 'string' && v !== '') titles[k] = v
    if (Object.keys(titles).length > 0) state.titles = titles
  }
  return state
}
