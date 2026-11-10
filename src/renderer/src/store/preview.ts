import { create } from 'zustand'
import { externalUrl } from '@shared/url'
import { omni } from '@/lib/omni'
import { useDocs } from './docs'
import { baseName, hostOf, isExternal, isInside, kindOf, normalizePath, resolveRelative, splitHref, stepZoom, type PreviewKind } from './preview-logic'
import { useSessions } from './sessions'

/** Cuánto dura el aviso de la franja ("Enlace copiado"). */
const NOTICE_MS = 3000

/** Estado de un pane de vista previa (ARCHITECTURE §3.20), por id de sesión. */
export interface PreviewDoc {
  sessionId: string
  workspaceId: string
  workspacePath: string
  /** Ruta absoluta del archivo que se muestra ahora (puede diferir de `args[0]` tras seguir enlaces). */
  path: string
  kind: PreviewKind
  /** Rutas anteriores (seguir un enlace apila; `back` desapila). */
  history: string[]
  /** Fuente Markdown; `null` para imágenes, PDF o mientras carga. */
  text: string | null
  /** Sube con cada cambio en disco: rompe la caché de `<img>` e `<iframe>`. */
  version: number
  /** Zoom de una imagen; `null` = ajustar al pane. */
  zoom: number | null
  /** Tamaño natural de la imagen, cuando ya cargó. */
  dims: { width: number; height: number } | null
  /** Zoom efectivo con la imagen ajustada (ancho pintado / natural), medido por el pane. */
  fitScale: number
  error: string | null
  /** Aviso transitorio en la franja. */
  notice: string | null
  /** Fragmento al que ir cuando el documento termine de pintarse. */
  pendingHash: string | null
}

interface PreviewState {
  docs: Record<string, PreviewDoc>
  /** Arranca (o retoma) el doc de una sesión `preview` y vigila su archivo. */
  open(sessionId: string): Promise<void>
  /** El pane se desmontó: deja de vigilar; si la sesión murió, olvida el doc. */
  close(sessionId: string): void
  /** Vuelve a leer el archivo (cambio en disco). */
  reload(sessionId: string): Promise<void>
  /** `file:changed` de main: recarga los panes que muestran esa ruta. La suscripción es única (`ensureWatching`). */
  fileChanged(workspaceId: string, path: string): void
  /** Muestra otro archivo del workspace en el mismo pane (apila el actual en el historial). */
  navigate(sessionId: string, absPath: string, hash?: string): Promise<void>
  back(sessionId: string): Promise<void>
  /** Clic en un enlace del documento: ancla, archivo del workspace, o externo (al portapapeles). */
  followLink(sessionId: string, href: string): Promise<void>
  zoomIn(sessionId: string): void
  zoomOut(sessionId: string): void
  zoomReset(sessionId: string): void
  setDims(sessionId: string, dims: { width: number; height: number } | null): void
  setFitScale(sessionId: string, scale: number): void
  notify(sessionId: string, text: string): void
  clearHash(sessionId: string): void
  /** `preview.toggle`: desde un preview abre (o enfoca) el editor del mismo archivo al lado, y al revés. */
  toggle(sessionId: string): Promise<void>
}

const sessions = useSessions.getState

/** Aviso que se borra solo. */
const noticeTimers = new Map<string, ReturnType<typeof setTimeout>>()

function errorText(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : String(e)
  // Electron antepone "Error invoking remote method 'x': Error: " al mensaje de main.
  const clean = msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
  return clean || fallback
}

/** Lee el archivo según su tipo: el Markdown como texto; imágenes y PDF los sirve el protocolo. */
async function readInto(doc: PreviewDoc): Promise<Partial<PreviewDoc>> {
  if (doc.kind !== 'md') return { text: null, error: null }
  try {
    const { text } = await omni.invoke('file:read', doc.workspaceId, doc.path)
    return { text, error: null }
  } catch (e) {
    return { text: null, error: errorText(e, 'No se pudo leer el archivo') }
  }
}

function patch(set: (fn: (s: PreviewState) => Partial<PreviewState>) => void, id: string, p: Partial<PreviewDoc>): void {
  set((s) => {
    const doc = s.docs[id]
    return doc ? { docs: { ...s.docs, [id]: { ...doc, ...p } } } : {}
  })
}

/** Suscripción única a `file:changed` (se abre con el primer doc y se cierra con el último). */
let offChanged: (() => void) | null = null

function ensureWatching(): void {
  if (offChanged) return
  offChanged = omni.on('file:changed', (workspaceId, path) => usePreview.getState().fileChanged(workspaceId, path))
}

function stopWatchingIfIdle(docs: Record<string, PreviewDoc>): void {
  if (Object.keys(docs).length > 0 || !offChanged) return
  offChanged()
  offChanged = null
}

function watch(workspaceId: string, path: string): void {
  ensureWatching()
  void omni.invoke('file:watch', workspaceId, path).catch(() => undefined)
}
function unwatch(workspaceId: string, path: string): void {
  void omni.invoke('file:unwatch', workspaceId, path).catch(() => undefined)
}

export const usePreview = create<PreviewState>((set, get) => ({
  docs: {},

  async open(sessionId) {
    const existing = get().docs[sessionId]
    if (existing) {
      // Remontaje (cambio de tab, zoom, split): se retoma donde estaba y se vuelve a vigilar.
      watch(existing.workspaceId, existing.path)
      await get().reload(sessionId)
      return
    }
    const session = sessions().sessions.find((x) => x.id === sessionId)
    if (!session) return
    const ws = sessions().workspaces.find((w) => w.id === session.workspaceId)
    const raw = session.args?.[0] ?? ''
    const root = ws?.path ?? session.cwd
    const path = raw.startsWith('/') ? normalizePath(raw) : normalizePath(`${root}/${raw}`)
    const doc: PreviewDoc = {
      sessionId,
      workspaceId: session.workspaceId,
      workspacePath: root,
      path,
      kind: kindOf(path),
      history: [],
      text: null,
      version: 0,
      zoom: null,
      dims: null,
      fitScale: 1,
      error: raw === '' ? 'La sesión no tiene archivo' : null,
      notice: null,
      pendingHash: null
    }
    set((s) => ({ docs: { ...s.docs, [sessionId]: doc } }))
    sessions().setTitle(sessionId, baseName(path))
    if (doc.error) return
    watch(doc.workspaceId, path)
    patch(set, sessionId, await readInto(doc))
  },

  close(sessionId) {
    const doc = get().docs[sessionId]
    if (!doc) return
    unwatch(doc.workspaceId, doc.path)
    const alive = sessions().sessions.some((x) => x.id === sessionId)
    if (alive) return
    const t = noticeTimers.get(sessionId)
    if (t !== undefined) clearTimeout(t)
    noticeTimers.delete(sessionId)
    set((s) => {
      const { [sessionId]: _gone, ...docs } = s.docs
      stopWatchingIfIdle(docs)
      return { docs }
    })
  },

  async reload(sessionId) {
    const doc = get().docs[sessionId]
    if (!doc) return
    patch(set, sessionId, { ...(await readInto(doc)), version: doc.version + 1 })
  },

  fileChanged(workspaceId, path) {
    const target = normalizePath(path)
    Object.values(get().docs).forEach((doc) => {
      if (doc.workspaceId === workspaceId && doc.path === target) void get().reload(doc.sessionId)
    })
  },

  async navigate(sessionId, absPath, hash) {
    const doc = get().docs[sessionId]
    if (!doc) return
    const path = normalizePath(absPath)
    if (!isInside(doc.workspacePath, path)) {
      get().notify(sessionId, 'Fuera del workspace')
      return
    }
    const kind = kindOf(path)
    if (kind === 'other') {
      // No se sabe pintar: lo abre la app del sistema, como ⇧⏎ en el quick open.
      void omni.invoke('file:open', path).catch((e: unknown) => get().notify(sessionId, errorText(e, 'No se pudo abrir')))
      return
    }
    if (path !== doc.path) {
      unwatch(doc.workspaceId, doc.path)
      watch(doc.workspaceId, path)
      patch(set, sessionId, { path, kind, history: [...doc.history, doc.path], text: null, zoom: null, dims: null, error: null, pendingHash: hash ?? null })
      sessions().setTitle(sessionId, baseName(path))
      const next = get().docs[sessionId]
      if (next) patch(set, sessionId, await readInto(next))
    } else if (hash) patch(set, sessionId, { pendingHash: hash })
  },

  async back(sessionId) {
    const doc = get().docs[sessionId]
    if (!doc || doc.history.length === 0) return
    const prev = doc.history[doc.history.length - 1]
    unwatch(doc.workspaceId, doc.path)
    watch(doc.workspaceId, prev)
    patch(set, sessionId, { path: prev, kind: kindOf(prev), history: doc.history.slice(0, -1), text: null, zoom: null, dims: null, error: null, pendingHash: null })
    sessions().setTitle(sessionId, baseName(prev))
    const next = get().docs[sessionId]
    if (next) patch(set, sessionId, await readInto(next))
  },

  async followLink(sessionId, href) {
    const doc = get().docs[sessionId]
    if (!doc) return
    const { path, hash } = splitHref(href.trim())
    if (path === '' && hash) {
      patch(set, sessionId, { pendingHash: hash })
      return
    }
    if (isExternal(href)) {
      // Externo: main lo abre con el navegador del sistema. `externalUrl` (shared) es la misma regla que
      // aplica main (solo http/https): se comprueba aquí para no ir y volver por IPC con un `mailto:`;
      // lo que no pasa (o lo que main rechace igual) va al portapapeles y la franja lo dice.
      let opened = false
      try {
        await omni.invoke('shell:openExternal', externalUrl(href))
        opened = true
      } catch {
        /* esquema no abrible o main lo rechazó: cae al portapapeles */
      }
      if (opened) {
        get().notify(sessionId, `Abierto en el navegador · ${hostOf(href)}`)
        return
      }
      try {
        await navigator.clipboard.writeText(href)
        get().notify(sessionId, `Enlace copiado · ${hostOf(href)}`)
      } catch {
        get().notify(sessionId, 'No se pudo abrir el enlace')
      }
      return
    }
    const abs = resolveRelative(doc.path, href, doc.workspacePath)
    if (abs) await get().navigate(sessionId, abs, hash || undefined)
  },

  zoomIn(sessionId) {
    const doc = get().docs[sessionId]
    if (doc) patch(set, sessionId, { zoom: stepZoom(doc.zoom ?? doc.fitScale, 1) })
  },
  zoomOut(sessionId) {
    const doc = get().docs[sessionId]
    if (doc) patch(set, sessionId, { zoom: stepZoom(doc.zoom ?? doc.fitScale, -1) })
  },
  zoomReset(sessionId) {
    patch(set, sessionId, { zoom: null })
  },
  setDims(sessionId, dims) {
    patch(set, sessionId, { dims })
  },
  setFitScale(sessionId, fitScale) {
    const doc = get().docs[sessionId]
    if (doc && Math.abs(doc.fitScale - fitScale) > 0.001) patch(set, sessionId, { fitScale })
  },

  notify(sessionId, text) {
    const t = noticeTimers.get(sessionId)
    if (t !== undefined) clearTimeout(t)
    patch(set, sessionId, { notice: text })
    noticeTimers.set(
      sessionId,
      setTimeout(() => {
        noticeTimers.delete(sessionId)
        patch(set, sessionId, { notice: null })
      }, NOTICE_MS)
    )
  },

  clearHash(sessionId) {
    if (get().docs[sessionId]?.pendingHash !== null) patch(set, sessionId, { pendingHash: null })
  },

  async toggle(sessionId) {
    const session = sessions().sessions.find((x) => x.id === sessionId)
    if (!session) return
    // Desde un preview, el editor del archivo que se muestra AHORA (puede no ser `args[0]` tras seguir enlaces).
    const path = session.agent === 'preview' ? (get().docs[sessionId]?.path ?? session.args?.[0]) : session.agent === 'editor' ? session.args?.[0] : undefined
    if (!path) return
    const kind = session.agent === 'preview' ? 'editor' : 'preview'
    // `docs.open` enfoca el pane si ya existe o lo abre en un split a la derecha (§3.19).
    try {
      await useDocs.getState().open(session.workspaceId, path, kind, 'split-right')
    } catch (e) {
      if (session.agent === 'preview') get().notify(sessionId, errorText(e, 'No se pudo abrir el editor'))
    }
  }
}))
