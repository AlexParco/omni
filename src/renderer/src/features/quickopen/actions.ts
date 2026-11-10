import type { FileHit } from '@shared/types'
import { commands } from '@/core/commands/registry'
import { omni } from '@/lib/omni'
import { getTerminal } from '@/panes/terminal/terminal-host'
import { useDocs } from '@/store/docs'
import { isBlank, liveBrowserId, useBrowser } from '@/store/browser'
import { activeTabOf, focusedSessionId, leaves, useLayout } from '@/store/layout'
import { writeToSession } from '@/store/session-write'
import { useControl } from '@/store/control'
import { humanError } from '@/store/control-logic'
import { useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { quoteForShell } from './search'

/**
 * Acciones del quick open (ARCHITECTURE §3.11). Cierran el overlay y actúan sobre el resultado
 * elegido: son el equivalente de `session.enter`, `commands.run` y las aperturas de archivo, con el
 * destino que el overlay ya conoce (un comando del registro no recibe argumentos).
 */

/** Lleva el teclado al pane de la sesión: tab activo, foco del layout, cursor del sidebar y foco DOM. */
function focusSession(id: string): void {
  const sessions = useSessions.getState()
  const lay = useLayout.getState()
  const tab = lay.tabs.find((t) => leaves(t.root).some((l) => l.sessionId === id))
  const leaf = tab && leaves(tab.root).find((l) => l.sessionId === id)
  if (!tab || !leaf) return
  // Si la página de un navegador tenía el teclado y el destino es otro pane, main lo devuelve primero.
  const live = liveBrowserId(useBrowser.getState())
  if (live && live !== id) useBrowser.getState().blur(live)
  sessions.activatePane(tab.id, leaf.id)
  useUi.getState().setFocus('terminal')
  const session = sessions.sessions.find((x) => x.id === id)
  if (session?.agent === 'browser') {
    const b = useBrowser.getState()
    if (isBlank(b.states[id])) b.focusUrl(id)
    else if (live !== id) b.focusView(id)
  } else {
    // Si el pane aún no montó (cambio de tab), `TerminalPane` enfoca al montar con la intención ya puesta.
    getTerminal(id)?.focus()
  }
}

/**
 * ⏎ sobre un agente: entrar a su pane. Con `split`, se muestra en un split a la derecha del pane
 * actual: si ya está en el tab en pantalla solo se enfoca; si vive en otro tab del mismo workspace,
 * su hoja se muda (la sesión no se toca); desde otro workspace no hay split y se entra a su tab.
 */
export function openAgent(id: string, split: boolean): void {
  useUi.getState().closeOverlay()
  const sessions = useSessions.getState()
  const lay = useLayout.getState()
  const session = sessions.sessions.find((x) => x.id === id)
  if (!session) return
  const ws = sessions.currentWorkspaceId
  const current = ws ? activeTabOf(lay, ws) : undefined
  const home = lay.tabs.find((t) => leaves(t.root).some((l) => l.sessionId === id))
  if (split && ws && current && home && home.id !== current.id && session.workspaceId === ws) {
    // `closeSession` solo quita la hoja del layout (y su tab si quedó vacío); el PTY sigue vivo.
    lay.closeSession(id)
    lay.setActiveTab(ws, current.id)
    lay.split(ws, 'row', id)
  }
  focusSession(id)
}

/** ⏎ sobre un comando: correrlo con el overlay ya cerrado (puede abrir otro). */
export function runCommand(id: string): void {
  useUi.getState().closeOverlay()
  void commands.run(id)
}

export type FileAction = 'insert' | 'open' | 'system' | 'reveal'

/**
 * Archivo: `insert` (⏎) escribe la ruta en la terminal con foco (relativa si es del mismo workspace,
 * entre comillas si hace falta, sin `\r`: el agente la recibe como contexto); `open` (⌘⏎) abre el
 * editor de omni en un split a la derecha del pane con foco (ARCHITECTURE §3.19); `system` (⇧⏎) con
 * la app del sistema; `reveal` (⌥⏎) en el Finder. Sin terminal bajo el teclado (nada abierto, un
 * navegador o un documento), `insert` cae al editor para que ⏎ haga algo visible.
 */
export function openFile(hit: FileHit, action: FileAction): void {
  useUi.getState().closeOverlay()
  if (action === 'reveal') return void omni.invoke('file:reveal', hit.path)
  if (action === 'system') return void omni.invoke('file:open', hit.path)
  if (action === 'open') return void useDocs.getState().openEditorBeside(hit.path)
  const sessions = useSessions.getState()
  const ws = sessions.currentWorkspaceId
  const id = ws ? focusedSessionId(useLayout.getState(), ws) : null
  const target = id ? sessions.sessions.find((x) => x.id === id) : undefined
  if (!target || target.agent === 'browser' || target.agent === 'editor' || target.agent === 'preview') return void useDocs.getState().openEditorBeside(hit.path)
  const path = target.workspaceId === hit.workspaceId ? hit.rel : hit.path
  writeToSession(target.id, quoteForShell(path), false)
  focusSession(target.id)
}

/** ⏎ sobre una carpeta (ruta escrita en el quick open): abrirla como proyecto y dejarla en pantalla. */
export function openProjectPath(path: string): void {
  useUi.getState().closeOverlay()
  useSessions
    .getState()
    .openProjectPath(path)
    .catch((e: unknown) => useControl.getState().announce(humanError(e, `No se pudo abrir ${path}`)))
}
