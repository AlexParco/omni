import { ChangeSet, type Extension, type Text } from '@codemirror/state'
import { EditorView, ViewPlugin, keymap } from '@codemirror/view'
import {
  LSPClient,
  LSPPlugin,
  Workspace,
  closeReferencePanel,
  findReferences,
  hoverTooltips,
  jumpToDefinition,
  renameSymbol,
  serverCompletion,
  signatureHelp,
  type Transport,
  type WorkspaceFile
} from '@codemirror/lsp-client'
import type { CodeDiagnostic, LspServerInfo } from '@shared/types'
import { omni } from '@/lib/omni'

/**
 * Cliente LSP del editor (ARCHITECTURE §3.19b). Main lanza el servidor del proyecto (`lsp:start`) y
 * hace de tubo: aquí vive un `LSPClient` de `@codemirror/lsp-client` por servidor, compartido por
 * todos los editores de ese workspace y lenguaje. Lo que el editor gana: autocompletado del
 * servidor, tipos al pasar el mouse, ayuda de firmas, ir a definición (`gd`, F12), referencias
 * (`gr`, ⇧F12), renombrar (F2) y errores en vivo mientras se escribe (no solo al guardar).
 */

/** Identifica esta carga del renderer: otra (recarga) hace que main relance los servidores. */
const CLIENT = crypto.randomUUID()
/** Tras cerrar el último editor de un servidor se espera esto antes de apagarlo (abrir y cerrar seguido no relanza). */
const STOP_GRACE_MS = 30_000
/** Pausa tras teclear antes de mandar los cambios al servidor (y recibir errores frescos). */
const SYNC_DELAY_MS = 400

/** Lo que el editor le da al cliente: cómo pintar errores y cómo mostrar otro archivo. */
export interface LspHost {
  /** Errores del servidor para la vista (rango ya llevado al buffer actual), o `null` si llegaron tarde. */
  diagnostics(view: EditorView, diagnostics: CodeDiagnostic[]): void
  /** Abre (o enfoca) el archivo en un editor y devuelve su vista cuando ya tiene el texto; `null` si no se puede. */
  display(workspaceId: string, path: string): Promise<EditorView | null>
}

interface Entry {
  info: LspServerInfo
  workspaceId: string
  client: LSPClient
  handlers: Set<(message: string) => void>
  /** Editores (ids de sesión) que lo usan. */
  editors: Set<string>
  stopTimer: number
  /** El proceso murió: no se le manda nada más. */
  dead: boolean
}

const entries = new Map<string, Entry>()
let host: LspHost | null = null
let wired = false
let unsubscribe: Array<() => void> = []

/** Se registra una vez desde `editor-host`: así este módulo no importa al host (ni al revés en ciclo). */
export function setLspHost(next: LspHost): void {
  host = next
}

function wire(): void {
  if (wired) return
  wired = true
  unsubscribe.push(
    omni.on('lsp:message', (serverId, message) => {
      const entry = entries.get(serverId)
      if (entry) entry.handlers.forEach((h) => h(message))
    })
  )
  unsubscribe.push(
    omni.on('lsp:exit', (serverId, error) => {
      const entry = entries.get(serverId)
      if (!entry) return
      entry.dead = true
      entries.delete(serverId)
      entry.client.disconnect()
      exitListeners.forEach((l) => l(serverId, error, [...entry.editors]))
    })
  )
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe.forEach((off) => off())
    unsubscribe = []
    wired = false
  })
}

type ExitListener = (serverId: string, error: string | null, editors: string[]) => void
const exitListeners = new Set<ExitListener>()

/** Aviso cuando un servidor muere, con los editores que lo usaban (para la cabecera). */
export function onLspExit(l: ExitListener): () => void {
  exitListeners.add(l)
  return () => exitListeners.delete(l)
}

/** Ruta absoluta de un `file://`; `null` para otros esquemas (p. ej. las libs empaquetadas de TS 7). */
export function uriToPath(uri: string): string | null {
  try {
    const url = new URL(uri)
    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : null
  } catch {
    return null
  }
}

/** `file://` de una ruta absoluta, escapado como `pathToFileURL` de Node (espacios, `#`, `?`, `%`). */
export function pathToUri(path: string): string {
  return 'file://' + encodeURI(path).replace(/[?#]/g, (c) => encodeURIComponent(c))
}

/** El paquete no exporta el tipo de lo que devuelve `syncFiles`: se deriva de la clase. */
type WorkspaceFileUpdate = ReturnType<Workspace['syncFiles']>[number]

/** Severidad LSP (1 error, 2 aviso, 3 info, 4 pista) a la del editor. */
function severityOf(n: number | undefined): CodeDiagnostic['severity'] {
  return n === undefined || n === 1 ? 'error' : n === 2 ? 'warning' : 'info'
}

interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  severity?: number
  code?: number | string
  source?: string
  message: string
}

/**
 * Código visible de un error del servidor: TypeScript manda el número (`2322` → `TS2322`, como tsc);
 * el resto, lo que mande. Exportada para tests.
 */
export function diagnosticCode(d: { code?: number | string; source?: string }): string | null {
  if (d.code === undefined || d.code === '') return null
  if (typeof d.code === 'number' && (!d.source || /^ts|typescript/i.test(d.source))) return `TS${d.code}`
  return String(d.code)
}

/** Archivo abierto en el servidor: una sola entrada por URI aunque lo muestren varios editores. */
interface OmniFile extends WorkspaceFile {
  /** Editores que lo muestran, en orden de apertura; el primero es el que se sincroniza con el servidor. */
  views: EditorView[]
  /** Cambió el editor que se sincroniza: el próximo `syncFiles` manda su texto entero (su plugin no sabe del anterior). */
  rebound: boolean
}

/**
 * Workspace de omni: como el de fábrica, pero con varios editores por archivo y `displayFile` propio.
 * El servidor ve un solo documento por URI (`didOpen` con el primer editor, `didClose` con el último);
 * si se cierra el editor que se sincronizaba, el archivo pasa al siguiente que lo muestra.
 * Exportada para tests.
 */
export class OmniWorkspace extends Workspace {
  files: OmniFile[] = []
  private versions: Record<string, number> = Object.create(null) as Record<string, number>
  /** Pedidos de errores (modelo pull) de este servidor. */
  readonly puller: DiagnosticPuller

  constructor(
    client: LSPClient,
    private readonly workspaceId: string
  ) {
    super(client)
    this.puller = new DiagnosticPuller(client)
  }

  /** Por ruta y no por texto exacto: el servidor puede escapar la URI distinto (`%40` vs `@`). */
  getFile(uri: string): OmniFile | null {
    const path = uriToPath(uri)
    return this.files.find((f) => f.uri === uri || (path !== null && uriToPath(f.uri) === path)) ?? null
  }

  private nextVersion(uri: string): number {
    this.versions[uri] = (this.versions[uri] ?? -1) + 1
    return this.versions[uri]
  }

  syncFiles(): readonly WorkspaceFileUpdate[] {
    const out: WorkspaceFileUpdate[] = []
    for (const file of this.files) {
      const view = file.getView()
      const plugin = view && LSPPlugin.get(view)
      if (!plugin) continue
      // Los demás editores del archivo no se sincronizan: sus cambios pendientes no se acumulan.
      for (const other of file.views.slice(1)) LSPPlugin.get(other)?.clear()
      const prevDoc: Text = file.doc
      const doc = plugin.view.state.doc
      let changes: ChangeSet = plugin.unsyncedChanges
      if (file.rebound) {
        file.rebound = false
        changes = prevDoc.eq(doc) ? ChangeSet.empty(doc.length) : ChangeSet.of({ from: 0, to: prevDoc.length, insert: doc }, prevDoc.length)
      }
      if (changes.empty) {
        plugin.clear()
        continue
      }
      out.push({ changes, file, prevDoc })
      file.doc = doc
      file.version = this.nextVersion(file.uri)
      plugin.clear()
    }
    return out
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    const open = this.getFile(uri)
    if (open) {
      if (!open.views.includes(view)) open.views.push(view)
      return
    }
    const file: OmniFile = { uri, languageId, version: this.nextVersion(uri), doc: view.state.doc, views: [view], rebound: false, getView: () => file.views[0] ?? null }
    this.files.push(file)
    this.client.didOpen(file)
  }

  closeFile(uri: string, view: EditorView): void {
    const file = this.getFile(uri)
    if (!file || !file.views.includes(view)) return
    const wasSynced = file.views[0] === view
    file.views = file.views.filter((v) => v !== view)
    if (file.views.length > 0) {
      if (!wasSynced) return
      // El que queda hereda el archivo: se le manda su texto y se le piden (o esperan) los errores.
      file.rebound = true
      this.puller.forget(file.uri)
      this.puller.schedule('new')
      return
    }
    this.files = this.files.filter((f) => f !== file)
    this.puller.forget(file.uri)
    this.client.didClose(file.uri)
  }

  async displayFile(uri: string): Promise<EditorView | null> {
    const open = this.getFile(uri)?.getView()
    const path = uriToPath(uri)
    if (!host || !path) return open ?? null
    return host.display(this.workspaceId, path)
  }
}

/**
 * El servidor pide que se le pregunten los errores (`textDocument/diagnostic`, LSP 3.17) en vez de
 * publicarlos: así trabaja el TypeScript 7 nativo, que publica listas vacías.
 */
function pullsDiagnostics(client: LSPClient): boolean {
  return !!client.serverCapabilities?.diagnosticProvider
}

/** Errores en vivo: el servidor publica por archivo; se llevan al buffer actual y van al host. */
function publishDiagnostics(client: LSPClient, params: { uri: string; version?: number | null; diagnostics: LspDiagnostic[] }): boolean {
  // Con modelo pull lo que se publica no cuenta (TS 7 manda vacío y borraría lo que se pidió).
  if (pullsDiagnostics(client)) return true
  return applyDiagnostics(client, params.uri, params.version ?? null, params.diagnostics)
}

type PullParams = { textDocument: { uri: string } }
type PullResult = { kind?: string; items?: LspDiagnostic[] } | null

/**
 * Pide los errores de los archivos abiertos de un servidor con modelo pull, tras mandar los cambios.
 * Se piden todos: editar `a.ts` cambia los errores de `b.ts`. Uno por servidor, para no multiplicar
 * pedidos con N editores:
 * - `schedule` junta en un solo barrido todo lo pedido en el mismo turno (N editores que conectan o se
 *   reconfiguran a la vez); `'new'` solo pide los archivos que aún no se pidieron, `'all'` todos.
 * - A lo sumo un `textDocument/diagnostic` en vuelo por archivo: si llega otro pedido, se cancela el
 *   que vuela (`$/cancelRequest`) y se repite al terminar; solo se aplica la respuesta del último, y
 *   solo si la versión del archivo no cambió.
 * Exportada para tests.
 */
export class DiagnosticPuller {
  private timer: ReturnType<typeof setTimeout> | null = null
  private mode: 'all' | 'new' | null = null
  private readonly inflight = new Map<string, { params: PullParams; again: boolean }>()
  private readonly pulled = new Set<string>()

  constructor(private readonly client: LSPClient) {}

  schedule(mode: 'all' | 'new'): void {
    if (this.mode !== 'all') this.mode = mode
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      const run = this.mode
      this.timer = null
      this.mode = null
      if (run) this.run(run)
    }, 0)
  }

  /** El archivo se cerró o cambió de editor: el próximo `'new'` lo vuelve a pedir. */
  forget(uri: string): void {
    this.pulled.delete(uri)
  }

  private run(mode: 'all' | 'new'): void {
    if (!pullsDiagnostics(this.client)) return
    this.client.sync()
    for (const file of this.client.workspace.files) {
      if (mode === 'new' && this.pulled.has(file.uri)) continue
      this.pull(file.uri)
    }
  }

  private pull(uri: string): void {
    this.pulled.add(uri)
    const flying = this.inflight.get(uri)
    if (flying) {
      flying.again = true
      this.client.cancelRequest(flying.params)
      return
    }
    const file = this.client.workspace.getFile(uri)
    if (!file) return
    const version = file.version
    const slot = { params: { textDocument: { uri } }, again: false }
    this.inflight.set(uri, slot)
    this.client
      .request<PullParams, PullResult>('textDocument/diagnostic', slot.params)
      .then(
        (r) => {
          if (!slot.again && r?.kind === 'full' && Array.isArray(r.items)) applyDiagnostics(this.client, uri, version, r.items)
        },
        () => undefined
      )
      .finally(() => {
        this.inflight.delete(uri)
        if (slot.again && this.client.workspace.getFile(uri)) this.pull(uri)
      })
  }
}

/** El que pide errores del servidor de `client` (solo los clientes de omni lo tienen). */
function pullerOf(client: LSPClient): DiagnosticPuller | null {
  return client.workspace instanceof OmniWorkspace ? client.workspace.puller : null
}

function applyDiagnostics(client: LSPClient, uri: string, version: number | null, diagnostics: LspDiagnostic[]): boolean {
  const file = client.workspace.getFile(uri)
  if (!file || (version !== null && version !== file.version)) return false
  const params = { uri, diagnostics }
  const view = file.getView()
  const plugin = view && LSPPlugin.get(view)
  if (!view || !plugin || !host) return false
  const doc = view.state.doc
  const toPos = (p: { line: number; character: number }): number => Math.min(doc.length, plugin.unsyncedChanges.mapPos(plugin.fromPosition(p, plugin.syncedDoc)))
  const out: CodeDiagnostic[] = params.diagnostics.map((d) => {
    const from = toPos(d.range.start)
    const to = Math.max(from, toPos(d.range.end))
    const a = doc.lineAt(from)
    const b = doc.lineAt(to)
    return {
      path: uriToPath(params.uri) ?? params.uri,
      line: a.number,
      col: from - a.from + 1,
      endLine: b.number,
      endCol: to - b.from + 1,
      severity: severityOf(d.severity),
      message: d.message,
      source: 'lsp',
      code: diagnosticCode(d)
    }
  })
  host.diagnostics(view, out)
  // Otro editor del mismo archivo con el mismo texto recibe los mismos errores.
  for (const other of (file as Partial<OmniFile>).views ?? []) if (other !== view && other.state.doc.eq(doc)) host.diagnostics(other, out)
  return true
}

/** Manda los cambios al servidor tras una pausa al escribir: sin esto los errores en vivo esperan a la próxima petición. */
const autoSync = ViewPlugin.fromClass(
  class {
    private timer = -1
    constructor(readonly view: EditorView) {
      // Primer pedido de errores (modelo pull) cuando el servidor ya respondió `initialize`; solo de
      // los archivos aún no pedidos, así reconfigurar el compartimento no repite el barrido.
      const client = LSPPlugin.get(view)?.client
      void client?.initializing.then(() => pullerOf(client)?.schedule('new'))
    }
    update(u: { docChanged: boolean }): void {
      if (!u.docChanged) return
      clearTimeout(this.timer)
      this.timer = window.setTimeout(() => {
        const client = LSPPlugin.get(this.view)?.client
        if (!client) return
        client.sync()
        pullerOf(client)?.schedule('all')
      }, SYNC_DELAY_MS)
    }
    destroy(): void {
      clearTimeout(this.timer)
    }
  }
)

function transportFor(serverId: string, handlers: Set<(message: string) => void>): Transport {
  return {
    send: (message) => {
      if (entries.get(serverId)?.dead === false) omni.send('lsp:send', serverId, message)
    },
    subscribe: (h) => void handlers.add(h),
    unsubscribe: (h) => void handlers.delete(h)
  }
}

function clientFor(info: LspServerInfo, workspaceId: string): Entry {
  const live = entries.get(info.id)
  if (live) return live
  const handlers = new Set<(message: string) => void>()
  const client = new LSPClient({
    rootUri: info.rootUri,
    initializationOptions: info.initializationOptions ?? undefined,
    workspace: (c) => new OmniWorkspace(c, workspaceId),
    timeout: 10_000,
    extensions: [
      {
        clientCapabilities: { textDocument: { publishDiagnostics: { versionSupport: true }, diagnostic: { dynamicRegistration: false } } },
        notificationHandlers: { 'textDocument/publishDiagnostics': (c, params) => publishDiagnostics(c, params as Parameters<typeof publishDiagnostics>[1]) }
      }
    ],
    // Los avisos del servidor (logMessage, progreso) no le dicen nada al usuario del editor.
    unhandledNotification: () => undefined
  })
  const entry: Entry = { info, workspaceId, client, handlers, editors: new Set(), stopTimer: 0, dead: false }
  entries.set(info.id, entry)
  client.connect(transportFor(info.id, handlers))
  return entry
}

/** Lo que un editor recibe al conectarse: la extensión de CodeMirror y el servidor que lo atiende. */
export interface LspAttachment {
  info: LspServerInfo
  extension: Extension
}

/**
 * Conecta el editor `editorId` (archivo `path`) al servidor de su lenguaje. `null` si el proyecto no
 * tiene servidor para ese archivo (sin TypeScript instalado, Go sin gopls…): el editor sigue como antes.
 */
export async function connectLsp(editorId: string, workspaceId: string, path: string): Promise<LspAttachment | null> {
  wire()
  const info = await omni.invoke('lsp:start', workspaceId, path, CLIENT)
  if (!info) return null
  const entry = clientFor(info, workspaceId)
  clearTimeout(entry.stopTimer)
  entry.editors.add(editorId)
  const extension: Extension = [
    entry.client.plugin(pathToUri(path), info.languageId),
    // El servidor reemplaza las sugerencias del lenguaje (ya trae variables, miembros e imports).
    serverCompletion({ override: true }),
    hoverTooltips(),
    signatureHelp(),
    autoSync,
    // F12, ⇧F12 y F2 son comandos de omni (`editor.definition`…); aquí solo Esc cierra el panel de referencias.
    keymap.of([{ key: 'Escape', run: closeReferencePanel }])
  ]
  return { info, extension }
}

/** El editor se cerró o cambió de archivo: si era el último del servidor, se apaga tras la gracia. */
export function releaseLsp(editorId: string, serverId: string): void {
  const entry = entries.get(serverId)
  if (!entry) return
  entry.editors.delete(editorId)
  if (entry.editors.size > 0) return
  clearTimeout(entry.stopTimer)
  entry.stopTimer = window.setTimeout(() => {
    if (entry.editors.size > 0) return
    entries.delete(serverId)
    entry.client.disconnect()
    omni.send('lsp:stop', serverId)
  }, STOP_GRACE_MS)
}

/* ---------- comandos (`editor.definition`, `editor.references`, `editor.rename`) ---------- */

/** `true` si la vista tiene servidor conectado (los comandos solo se ofrecen entonces). */
export function hasLsp(view: EditorView): boolean {
  return LSPPlugin.get(view) !== null
}

export function lspDefinition(view: EditorView): boolean {
  return jumpToDefinition(view)
}

export function lspReferences(view: EditorView): boolean {
  return findReferences(view)
}

export function lspRename(view: EditorView): boolean {
  return renameSymbol(view)
}
