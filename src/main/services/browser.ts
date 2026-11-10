import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { clipboard, ClipboardItem, nativeImage, session, shell, WebContentsView, type BrowserWindow, type Input, type NativeImage, type Session, type WebContents } from 'electron'
import type { BrowserElement, BrowserState, Capture, ConsoleEntry, ConsoleLevel, CookieImportResult, CookieImportSource, ElementHint, ForwardedKey, Rect, SessionInfo, ViewportPreset, Workspace } from '@shared/types'
import { normalizeUrl } from '@shared/url'
import { elementPickScript, elementsClearScript, elementsScript, OMNI_WORLD } from './browser-elements'
import { importCookies, readSourceCookies } from './cookies'
import { DEFAULT_PROFILE, partitionOf, type ProfileStore } from './profiles'

interface Live {
  info: SessionInfo
  view: WebContentsView
  /** Vista con las DevTools acopladas; `null` si están cerradas. */
  devtools: WebContentsView | null
  /** Perfil (partición persistente) en el que corre la vista. */
  profileId: string
  /** Reenviar TODAS las teclas de la página (modo elemento o área con teclado), no solo ⌘ y el prefijo. */
  grab: boolean
  /** Viewport fijo aplicado con emulación; `null` = responsive. */
  viewport: ViewportPreset | null
  /** UA original del webContents, para restaurarlo al apagar la emulación móvil. */
  userAgent: string
  /** Último rect que mandó el renderer (`setBounds`); `null` si está oculta. */
  bounds: Rect | null
  /** Último rect de las DevTools (`setDevToolsBounds`); `null` si están escondidas. */
  devtoolsBounds: Rect | null
  /** Últimas entradas de `console-message` (tope `CONSOLE_TAIL`), solo para `consoleTail`. */
  console: ConsoleEntry[]
  /** Teclas sintéticas del agente en curso (MCP `omni-browser`): no se reenvían a omni como atajos. */
  agentInput: number
  /** Vuelve a dejar que la vista se frene en segundo plano cuando el agente lleva un rato sin tocarla. */
  awakeTimer: ReturnType<typeof setTimeout> | null
}

type StateListener = (id: string, state: BrowserState) => void
type KeyListener = (id: string, key: ForwardedKey) => void
type FocusListener = (id: string, focused: boolean) => void
type ExitListener = (id: string, code: number) => void

export interface BrowserServiceOptions {
  /** Ventana principal sobre la que se montan las vistas; `null` si aún no existe o se cerró. */
  getWindow: () => BrowserWindow | null
  /** Prefijo tipo tmux vigente, como chord canónico (`ctrl+a`). Se lee en cada tecla: el usuario lo puede cambiar en caliente. */
  getPrefix: () => string
  /** Perfiles de navegación: cada vista corre en la partición de uno. */
  profiles: ProfileStore
  /** Carpeta de capturas. Por defecto `~/.config/omni/captures`. */
  captureDir?: string
}

const DEFAULT_CAPTURE_DIR = join(homedir(), '.config', 'omni', 'captures')

/** Esquemas a los que la página puede navegar. Todo lo demás (`file:`, `javascript:`…) se deniega. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'about:', 'data:', 'blob:', 'chrome:'])

/** Solo estos se abren fuera (navegador del sistema) cuando la página pide `window.open`. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/**
 * Atajos de edición que la página se queda aunque lleven ⌘: sin esto copiar, pegar, deshacer o
 * moverse por un campo de texto dentro del navegador embebido no funcionaría (preventDefault
 * también anula el menú). ⌥⌘← / ⌥⌘→ no están: en Chrome son historial y sí se reenvían.
 */
const PAGE_EDIT_CHORDS = new Set([
  'cmd+c', 'cmd+v', 'cmd+x', 'cmd+a', 'cmd+z', 'shift+cmd+z', 'shift+cmd+v',
  'cmd+left', 'cmd+right', 'cmd+up', 'cmd+down',
  'shift+cmd+left', 'shift+cmd+right', 'shift+cmd+up', 'shift+cmd+down',
  'cmd+backspace', 'cmd+delete'
])

/** Atajos del menú de la app (salir, ocultar, minimizar, pantalla completa): pasan al menú, no se reenvían. `cmd+,` sí se reenvía (ajustes). */
const MENU_CHORDS = new Set(['cmd+q', 'cmd+h', 'alt+cmd+h', 'cmd+m', 'ctrl+cmd+f'])

/** Color de fondo de la vista mientras la página no pinta: el del renderer, para no ver un flash blanco. */
// Blanco como cualquier navegador: una página sin fondo propio (la mayoría) se vería negra con el fondo
// oscuro de la app, y la captura también. La página vacía la tapa el placeholder del renderer.
const VIEW_BACKGROUND = '#ffffff'

/** Cuánto sigue despierta una vista tras la última operación del agente (`keepAwake`). */
const AGENT_AWAKE_MS = 60_000

/** Entradas de consola que se guardan por vista para `consoleTail` (adjunto del diálogo de envío). */
const CONSOLE_TAIL = 200

/** UA de Safari iOS para los presets móviles del viewport (ARCHITECTURE §3.9). */
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

/** Lo que espera el renderer antes de capturar el elemento elegido: que el resaltado haya pintado. */
const PICK_SETTLE_MS = 60

/* ---------- helpers puros (exportados para tests) ---------- */

/** Nivel de `console-message`: Electron 44 da un string en `details.level`; los args numéricos (0-3) están deprecados. */
export function consoleLevel(level: number | string): ConsoleLevel {
  switch (level) {
    case 1:
    case 'info':
      return 'info'
    case 2:
    case 'warning':
      return 'warn'
    case 3:
    case 'error':
      return 'error'
    default:
      // 0 / 'verbose' / 'debug' y cualquier cosa rara
      return 'log'
  }
}

/** Lo que `chordOfInput` necesita de un `Input` de Electron. */
export type KeyInput = Pick<Input, 'key' | 'code' | 'control' | 'alt' | 'shift' | 'meta'>

const KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  Escape: 'escape',
  Enter: 'enter',
  Tab: 'tab',
  Backspace: 'backspace',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
}

const MODIFIER_KEYS = new Set(['control', 'alt', 'shift', 'meta'])

/**
 * Chord canónico de un `Input` de `before-input-event`, con las mismas reglas que
 * `core/keys/chord.ts` del renderer (ctrl, alt, shift, cmd + tecla en minúscula; con ⌥ se usa
 * la tecla física; los símbolos imprimibles van sin `shift`). Devuelve '' si solo es un modificador.
 */
export function chordOfInput(input: KeyInput): string {
  let key = KEY_ALIASES[input.key] ?? input.key.toLowerCase()
  if (input.alt && /^(Key|Digit)/.test(input.code)) key = input.code.slice(-1).toLowerCase()
  if (MODIFIER_KEYS.has(key)) return ''
  const printableSymbol = key.length === 1 && !/[a-z0-9]/.test(key)
  const parts: string[] = []
  if (input.control) parts.push('ctrl')
  if (input.alt) parts.push('alt')
  if (input.shift && !printableSymbol) parts.push('shift')
  if (input.meta) parts.push('cmd')
  parts.push(key)
  return parts.join('+')
}

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'cmd'] as const

/** Lleva un chord escrito a mano (`alt+ctrl+a`) a la forma canónica (`ctrl+alt+a`). */
function normalizeChord(chord: string): string {
  const parts = chord.trim().toLowerCase().split('+')
  const key = parts.pop() ?? ''
  return [...MODIFIER_ORDER.filter((m) => parts.includes(m)), key].join('+')
}

/** `true` si la tecla es exactamente el prefijo configurado (`ctrl+a`, `alt+shift+x`…). */
export function matchesPrefix(input: KeyInput, prefix: string): boolean {
  const wanted = normalizeChord(prefix)
  if (wanted === '') return false
  const chord = chordOfInput(input)
  return chord !== '' && chord === wanted
}

/** Qué hacer con una tecla que recibió la página: quedársela, reenviarla a omni, o reenviarla y además devolver el foco (prefijo). */
export type KeyDisposition = 'page' | 'forward' | 'prefix'

/**
 * Con `grab` (modo elemento o área con teclado) se reenvía TODO salvo modificadores sueltos y los
 * atajos del menú (⌘Q tiene que seguir saliendo); el prefijo sigue devolviendo el foco como siempre.
 */
export function keyDisposition(input: KeyInput, prefix: string, grab = false): KeyDisposition {
  const chord = chordOfInput(input)
  if (chord === '' || MENU_CHORDS.has(chord)) return 'page'
  if (grab) return matchesPrefix(input, prefix) ? 'prefix' : 'forward'
  if (PAGE_EDIT_CHORDS.has(chord)) return 'page'
  if (matchesPrefix(input, prefix)) return 'prefix'
  return input.meta ? 'forward' : 'page'
}

/** `true` si la URL (ya normalizada) tiene un esquema al que la vista puede navegar. `will-navigate` no se emite en `loadURL`, así que se valida aquí. */
export function isAllowedUrl(url: string): boolean {
  return ALLOWED_SCHEMES.has(schemeOf(url))
}

/** `archivo:línea` de una entrada de consola; solo cuando el origen es una URL real (en `data:` Chromium manda basura tipo `script>`). */
export function consoleSource(sourceId: string | undefined, lineNumber: number): string | undefined {
  if (!sourceId || !/^(https?|file):/i.test(sourceId)) return undefined
  return `${basename(sourceId)}:${lineNumber}`
}

/** Ruta libre para una captura: `base.png`, y si existe, `base-2.png`, `base-3.png`… sin tocar la hora del nombre. */
export function nextCapturePath(dir: string, fileName: string, exists: (path: string) => boolean): string {
  const base = fileName.replace(/\.png$/, '')
  let path = join(dir, fileName)
  for (let n = 2; exists(path); n++) path = join(dir, `${base}-${n}.png`)
  return path
}

/** Nombre de archivo de captura: `omni-YYYYMMDD-HHmmss.png`. */
export function captureFileName(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `omni-${ymd}-${hms}.png`
}

/** `setBounds` exige enteros: se redondea el rect CSS del renderer. */
function toIntRect(rect: Rect): Rect {
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) }
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return ''
  }
}

/**
 * Dueño de los navegadores embebidos: una `WebContentsView` por sesión `browser`, montada
 * sobre la ventana principal. Como los PTY, sobreviven a recargas del renderer; este solo
 * manda dónde pintarlas (`setBounds`) y refleja el estado que se publica por los listeners.
 */
export class BrowserService {
  private live = new Map<string, Live>()
  /** Último navegador que estuvo en pantalla: el destino por defecto del agente. */
  private shownLast: string | null = null
  private nextConsoleId = 1
  private stateListeners = new Set<StateListener>()
  /** Avisos de una página cuyo proceso se cayó y se recargó sola (`render-process-gone`). */
  private crashListeners = new Set<(id: string, reason: string) => void>()
  private keyListeners = new Set<KeyListener>()
  private focusListeners = new Set<FocusListener>()
  private exitListeners = new Set<ExitListener>()
  private readonly captureDir: string
  /** Ventanas cuyo renderer ya escuchamos para ocultar las vistas cuando recarga. */
  private hookedWindows = new WeakSet<BrowserWindow>()
  /** Sesiones (particiones) a las que ya se les negaron los permisos de la página. */
  private guardedSessions = new WeakSet<Session>()

  constructor(private readonly opts: BrowserServiceOptions) {
    this.captureDir = opts.captureDir ?? DEFAULT_CAPTURE_DIR
  }

  /**
   * `opts.id` permite recrear un navegador guardado con su mismo id (el layout guardado sigue
   * válido); `opts.profileId` elige la partición (un perfil borrado cae al builtin).
   */
  create(workspace: Workspace, url?: string, opts: { id?: string; profileId?: string } = {}): SessionInfo {
    const win = this.opts.getWindow()
    if (!win) throw new Error('no hay ventana principal para montar el navegador')

    this.guardSession(session.defaultSession)
    this.hookWindow(win)

    const profile = this.opts.profiles.resolve(opts.profileId)
    const view = this.createView(win, partitionOf(profile))
    const id = opts.id && !this.live.has(opts.id) ? opts.id : randomUUID()
    const info: SessionInfo = { id, agent: 'browser', workspaceId: workspace.id, cwd: workspace.path, createdAt: Date.now() }
    this.live.set(info.id, {
      info,
      view,
      devtools: null,
      profileId: profile.id,
      grab: false,
      viewport: null,
      userAgent: view.webContents.getUserAgent(),
      bounds: null,
      devtoolsBounds: null,
      console: [],
      agentInput: 0,
      awakeTimer: null
    })
    this.wire(info.id, view)

    this.load(view.webContents, url ?? '')
    return info
  }

  /** Vista nueva en la partición dada, montada en la ventana e invisible hasta que el renderer diga dónde va (`setBounds`). */
  private createView(win: BrowserWindow, partition: string): WebContentsView {
    this.guardSession(session.fromPartition(partition))
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition }
    })
    view.setVisible(false)
    view.setBackgroundColor(VIEW_BACKGROUND)
    win.contentView.addChildView(view)
    return view
  }

  /** Quita una vista de la ventana y cierra su página. */
  private dropView(view: WebContentsView): void {
    const win = this.opts.getWindow()
    if (win) win.contentView.removeChildView(view)
    const wc: WebContents | undefined = view.webContents
    // En Electron 44 `WebContents` no tiene `destroy()`: `close()` cierra la página y destruye el webContents.
    if (wc !== undefined && !wc.isDestroyed()) wc.close()
  }

  list(): SessionInfo[] {
    return [...this.live.values()].map((l) => l.info)
  }

  has(id: string): boolean {
    return this.live.has(id)
  }

  destroy(id: string): void {
    const live = this.live.get(id)
    if (!live) return
    this.live.delete(id)
    if (live.awakeTimer) clearTimeout(live.awakeTimer)
    // Si la página (o sus DevTools) tenía el teclado, que vuelva al renderer antes de que la vista desaparezca.
    const hadFocus = this.hasFocus(live)
    this.closeDevTools(live)
    this.dropView(live.view)
    if (hadFocus) this.focusHost()
    this.exitListeners.forEach((l) => l(id, 0))
  }

  private hasFocus(live: Live): boolean {
    // `view.webContents` queda undefined cuando el webContents ya murió (p. ej. en el `destroyed` que dispara `destroy`).
    const focused = (wc: WebContents | undefined): boolean => wc !== undefined && !wc.isDestroyed() && wc.isFocused()
    return focused(live.view.webContents) || (live.devtools !== null && focused(live.devtools.webContents))
  }

  navigate(id: string, url: string): void {
    const wc = this.contents(id)
    if (wc) this.load(wc, url)
  }

  back(id: string): void {
    const wc = this.contents(id)
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  forward(id: string): void {
    const wc = this.contents(id)
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  reload(id: string): void {
    this.contents(id)?.reload()
  }

  stop(id: string): void {
    this.contents(id)?.stop()
  }

  state(id: string): BrowserState {
    const live = this.live.get(id)
    const wc = this.contents(id)
    if (!live || !wc) return { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, devtools: false, profileId: DEFAULT_PROFILE.id, viewport: null }
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      devtools: live.devtools !== null,
      profileId: live.profileId,
      viewport: live.viewport
    }
  }

  /** Últimas `lines` entradas de consola de la página como `nivel: texto` (adjunto del diálogo "Enviar al agente"). */
  consoleTail(id: string, lines: number): string[] {
    const live = this.live.get(id)
    if (!live) return []
    const n = Math.max(0, Math.floor(lines))
    return live.console.slice(-n).map((e) => `${e.level}: ${e.text}`)
  }

  /* ---------- perfiles, cookies y datos (ARCHITECTURE §3.9) ---------- */

  /**
   * Cambia el perfil de una vista: se recrea en la partición nueva con el mismo id, la misma URL,
   * los mismos bounds, el mismo viewport y las DevTools como estaban. El historial no sobrevive.
   */
  profileSet(id: string, profileId: string): void {
    const live = this.live.get(id)
    if (!live) return
    const profile = this.opts.profiles.get(profileId)
    if (!profile) throw new Error(`perfil desconocido: ${profileId}`)
    if (live.profileId === profile.id) return
    const win = this.opts.getWindow()
    if (!win) throw new Error('no hay ventana principal para montar el navegador')

    const url = this.contents(id)?.getURL() ?? ''
    const devtoolsWereOpen = live.devtools !== null
    const hadFocus = this.hasFocus(live)
    this.closeDevTools(live)

    // La vista nueva se vuelve la actual ANTES de cerrar la vieja: si `close()` emitiera `destroyed`
    // en el acto, el listener de la vieja ya no la reconocería y no mataría la sesión.
    const old = live.view
    const view = this.createView(win, partitionOf(profile))
    live.view = view
    this.dropView(old)
    live.profileId = profile.id
    live.userAgent = view.webContents.getUserAgent()
    live.grab = false
    live.console = []
    this.wire(id, view)
    // La emulación de dispositivo necesita un renderer: en un webContents recién creado
    // `disableDeviceEmulation`/`enableDeviceEmulation` hacen segfault. El UA sí se fija ya; la
    // emulación se aplica cuando la página nueva tenga DOM (y solo si la vista sigue siendo esta).
    if (live.viewport) {
      view.webContents.setUserAgent(live.viewport.mobile ? MOBILE_USER_AGENT : live.userAgent)
      view.webContents.once('dom-ready', () => {
        if (live.view === view && !view.webContents.isDestroyed()) this.applyViewport(live, view.webContents)
      })
    }
    if (live.bounds) {
      view.setBounds(live.bounds)
      view.setVisible(true)
    }
    // Una vista que reemplaza a otra puede quedarse sin superficie de composición hasta que cambie
    // de tamaño (las capturas fallan con "display surface not available"): se la empuja un pixel
    // y se la devuelve en cuanto la página tiene DOM.
    view.webContents.once('dom-ready', () => {
      const b = live.bounds
      if (live.view !== view || !b || view.webContents.isDestroyed()) return
      view.setBounds({ ...b, height: b.height + 1 })
      view.setBounds(b)
    })
    this.load(view.webContents, url)
    if (devtoolsWereOpen) this.openDevTools(live, win)
    if (hadFocus) view.webContents.focus()
    this.publish(id)
  }

  /** Importa cookies de otro navegador (o de un archivo) a la partición de esa vista. */
  async importCookies(id: string, source: CookieImportSource, path?: string): Promise<CookieImportResult> {
    const wc = this.contents(id)
    if (!wc) throw new Error(`navegador desconocido: ${id}`)
    const raw = await readSourceCookies(source, path)
    return importCookies(raw, wc.session.cookies)
  }

  /** Borra cookies, storage y caché de la partición de esa vista (afecta a todas las vistas del mismo perfil). */
  async clearData(id: string): Promise<void> {
    const wc = this.contents(id)
    if (!wc) throw new Error(`navegador desconocido: ${id}`)
    await wc.session.clearStorageData()
    await wc.session.clearCache()
  }

  /* ---------- modo elemento (ARCHITECTURE §3.9) ---------- */

  /**
   * Enciende el modo elemento: inyecta el script de solo lectura que dibuja las letras y devuelve
   * los hints. Idempotente (borra y redibuja). Desde aquí hasta `elementPick`/`elementsClear`
   * se reenvían todas las teclas de la página.
   */
  async elements(id: string): Promise<ElementHint[]> {
    const live = this.live.get(id)
    const wc = this.contents(id)
    if (!live || !wc) throw new Error(`navegador desconocido: ${id}`)
    const result: unknown = await wc.executeJavaScriptInIsolatedWorld(OMNI_WORLD, [{ code: elementsScript() }])
    live.grab = true
    return Array.isArray(result) ? (result as ElementHint[]) : []
  }

  /**
   * Elige un elemento por su letra: lo resalta (se queda resaltado hasta `elementsClear`, para que
   * el renderer capture su rect), espera a que pinte y devuelve su detalle. Apaga el reenvío de teclas.
   */
  async elementPick(id: string, hint: string): Promise<BrowserElement | null> {
    const live = this.live.get(id)
    const wc = this.contents(id)
    if (!live || !wc) throw new Error(`navegador desconocido: ${id}`)
    const result: unknown = await wc.executeJavaScriptInIsolatedWorld(OMNI_WORLD, [{ code: elementPickScript(hint) }])
    // El modo sigue activo tras elegir (otra letra re-elige, ⏎ envía, Esc sale): el reenvío de teclas
    // se apaga en `elementsClear`, que es quien cierra el ciclo desde el renderer.
    if (!result || typeof result !== 'object') return null
    await new Promise((r) => setTimeout(r, PICK_SETTLE_MS))
    return result as BrowserElement
  }

  /** Apaga el modo elemento: borra hints, resaltado y mapa, y deja de reenviar todas las teclas. */
  async elementsClear(id: string): Promise<void> {
    const live = this.live.get(id)
    const wc = this.contents(id)
    if (!live || !wc) return
    live.grab = false
    await wc.executeJavaScriptInIsolatedWorld(OMNI_WORLD, [{ code: elementsClearScript() }])
  }

  /** El renderer pide (área con H J K L) o suelta el reenvío de todas las teclas; mismo flag que el modo elemento. */
  setKeyGrab(id: string, on: boolean): void {
    const live = this.live.get(id)
    if (live) live.grab = on
  }

  /**
   * Viewport fijo con emulación de dispositivo (pantalla móvil con UA de iPhone si el preset es
   * móvil, de escritorio si no); `null` = responsive: sin emulación y UA original. No recarga; el
   * UA nuevo aplica a la siguiente navegación. Sin eventos touch. La vista se sigue pintando en el
   * rect de `setBounds` (el renderer centra el hueco al tamaño del preset).
   */
  setViewport(id: string, preset: ViewportPreset | null): void {
    const live = this.live.get(id)
    const wc = this.contents(id)
    if (!live || !wc) return
    live.viewport = preset ? { ...preset } : null
    this.applyViewport(live, wc)
    this.publish(id)
  }

  private applyViewport(live: Live, wc: WebContents): void {
    const preset = live.viewport
    if (!preset) {
      wc.disableDeviceEmulation()
      wc.setUserAgent(live.userAgent)
      return
    }
    const size = { width: Math.max(1, Math.round(preset.width)), height: Math.max(1, Math.round(preset.height)) }
    wc.enableDeviceEmulation({ screenPosition: preset.mobile ? 'mobile' : 'desktop', screenSize: size, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: size, scale: 1 })
    wc.setUserAgent(preset.mobile ? MOBILE_USER_AGENT : live.userAgent)
  }

  /** `null` oculta la vista sin destruirla (pane fuera de pantalla u overlay encima). */
  setBounds(id: string, rect: Rect | null): void {
    const live = this.live.get(id)
    if (!live) return
    live.bounds = rect ? toIntRect(rect) : null
    if (live.bounds) this.shownLast = id
    if (!live.bounds) {
      live.view.setVisible(false)
      return
    }
    live.view.setBounds(live.bounds)
    live.view.setVisible(true)
  }

  /* ---------- DevTools acopladas (ARCHITECTURE §3.9) ---------- */

  /**
   * Abre o cierra las DevTools de Chromium dentro del pane: una segunda `WebContentsView` por
   * navegador enganchada con `setDevToolsWebContents`, invisible hasta `setDevToolsBounds`.
   */
  setDevTools(id: string, on: boolean): void {
    const live = this.live.get(id)
    if (!live || !this.contents(id)) return
    if (on) {
      const win = this.opts.getWindow()
      if (!win || live.devtools) return
      this.openDevTools(live, win)
    } else {
      if (!live.devtools) return
      const hadFocus = this.hasFocus(live)
      this.closeDevTools(live)
      if (hadFocus) this.focusHost()
    }
    this.publish(id)
  }

  /** `null` esconde las DevTools sin cerrarlas (overlay abierto, pane fuera de pantalla); mismo patrón que `setBounds`. */
  setDevToolsBounds(id: string, rect: Rect | null): void {
    const live = this.live.get(id)
    if (!live) return
    live.devtoolsBounds = rect ? toIntRect(rect) : null
    if (!live.devtools) return
    if (!live.devtoolsBounds) {
      live.devtools.setVisible(false)
      return
    }
    live.devtools.setBounds(live.devtoolsBounds)
    live.devtools.setVisible(true)
  }

  private openDevTools(live: Live, win: BrowserWindow): void {
    const wc = live.view.webContents
    const devtools = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    devtools.setVisible(false)
    win.contentView.addChildView(devtools)
    live.devtools = devtools
    wc.setDevToolsWebContents(devtools.webContents)
    wc.openDevTools({ mode: 'detach' })
    this.wireDevTools(live.info.id, devtools)
    if (live.devtoolsBounds) {
      devtools.setBounds(live.devtoolsBounds)
      devtools.setVisible(true)
    }
  }

  /** Cierra las DevTools y quita su vista; no hace nada si estaban cerradas. */
  private closeDevTools(live: Live): void {
    const devtools = live.devtools
    if (!devtools) return
    live.devtools = null
    const wc: WebContents | undefined = live.view.webContents
    if (wc !== undefined && !wc.isDestroyed() && wc.isDevToolsOpened()) wc.closeDevTools()
    this.dropView(devtools)
  }

  /** Devuelve el teclado al renderer: la vista deja de ser el webContents enfocado. */
  blur(id: string): void {
    if (!this.live.has(id)) return
    this.focusHost()
  }

  /** La página toma el teclado (espejo de `blur`). Dispara `onFocus(id, true)` por el evento `focus` normal. */
  focusView(id: string): void {
    this.contents(id)?.focus()
  }

  /** PNG de la página (o de `rect`, en px CSS de la página) a disco y al portapapeles. */
  async capture(id: string, rect?: Rect): Promise<Capture> {
    const wc = this.contents(id)
    if (!wc) throw new Error(`navegador desconocido: ${id}`)
    const image = await this.captureWithRetry(wc, rect)
    return this.persist(image)
  }

  /** PNG de la vista como data URL, sin persistir ni tocar el portapapeles (para la captura de área). */
  async snapshot(id: string): Promise<string> {
    const wc = this.contents(id)
    if (!wc) throw new Error(`navegador desconocido: ${id}`)
    const image = await this.captureWithRetry(wc)
    return image.toDataURL()
  }

  /**
   * `capturePage` devuelve vacío si la vista aún no pintó su primer frame (recién mostrada o
   * redimensionada) o si la ventana está tapada. Se reintenta un par de veces antes de rendirse.
   */
  private async captureWithRetry(wc: WebContents, rect?: Rect): Promise<NativeImage> {
    // Chromium lanza UnknownVizError o "display surface not available" si aún no hay frame compuesto
    // (vista recién mostrada, redimensionada o recreada por un cambio de perfil, que tras haber tenido
    // DevTools tarda varios segundos en componer): se reintenta ~6 s.
    const ATTEMPTS = 12
    for (let attempt = 0; ; attempt++) {
      try {
        const image = await wc.capturePage(rect ? toIntRect(rect) : undefined)
        if (!image.isEmpty()) return image
      } catch (err) {
        if (attempt >= ATTEMPTS - 1) throw err
      }
      if (attempt >= ATTEMPTS - 1) throw new Error('la captura salió vacía: la ventana de omni tiene que estar visible')
      await new Promise((r) => setTimeout(r, 150 + attempt * 80))
    }
  }

  /** Guarda un PNG que el renderer ya recortó (data URL); mismo destino que `capture`. */
  async saveCapture(dataUrl: string): Promise<Capture> {
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) throw new Error('la captura está vacía o no es una imagen válida')
    return this.persist(image)
  }

  /**
   * Vuelve a poner en el portapapeles la imagen de una captura ya guardada ("Copiar imagen" del diálogo
   * de envío, que puede haber copiado texto después). Solo acepta archivos de la carpeta de capturas:
   * la ruta llega del renderer y no debe servir para leer cualquier archivo del disco.
   */
  async copyCapture(path: string): Promise<void> {
    if (!isCaptureFile(this.captureDir, path)) throw new Error('la ruta no es una captura de omni')
    await writeImageToClipboard(readFileSync(resolve(path)))
  }

  /* ---------- lo que usa el agente del MCP `omni-browser` (ARCHITECTURE §3.23) ---------- */

  webContents(id: string): WebContents | undefined {
    return this.contents(id)
  }

  /** Rect en pantalla, o `null` si la vista está oculta. */
  bounds(id: string): Rect | null {
    return this.live.get(id)?.bounds ?? null
  }

  lastShown(): string | null {
    return this.shownLast !== null && this.live.has(this.shownLast) ? this.shownLast : null
  }

  /** PNG de la vista en memoria: sin archivo ni portapapeles (la captura del agente no pisa el del usuario). */
  async captureImage(id: string): Promise<NativeImage> {
    const wc = this.contents(id)
    if (!wc) throw new Error(`navegador desconocido: ${id}`)
    return this.captureWithRetry(wc)
  }

  /**
   * Mientras el agente maneja la vista, no se frena en segundo plano: con la ventana de omni tapada
   * macOS la daría por oculta (no pinta, `visibilityState` hidden) y Chromium tiraría su input.
   * `AGENT_AWAKE_MS` después de la última operación se restaura y se suelta el debugger del agente.
   */
  keepAwake(id: string): void {
    const live = this.live.get(id)
    const wc = this.contents(id)
    if (!live || !wc) return
    if (live.awakeTimer) clearTimeout(live.awakeTimer)
    else wc.setBackgroundThrottling(false)
    live.awakeTimer = setTimeout(() => {
      live.awakeTimer = null
      const current = this.contents(id)
      if (!current) return
      current.setBackgroundThrottling(true)
      // Se suelta el debugger del agente (y con él la emulación de foco): la página vuelve a ser normal.
      if (current.debugger.isAttached()) {
        try {
          current.debugger.detach()
        } catch {
          // ya estaba suelto
        }
      }
    }, AGENT_AWAKE_MS)
  }

  /** Mientras corre `fn`, las teclas que manda el agente a esta vista son de la página, nunca atajos de omni. */
  async withAgentInput<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const live = this.live.get(id)
    if (!live) throw new Error(`navegador desconocido: ${id}`)
    live.agentInput++
    try {
      return await fn()
    } finally {
      // Los eventos sintéticos se procesan en el siguiente giro del loop: se suelta un poco después.
      setTimeout(() => {
        live.agentInput = Math.max(0, live.agentInput - 1)
      }, 50)
    }
  }

  killAll(): void {
    for (const id of [...this.live.keys()]) this.destroy(id)
  }

  onState(l: StateListener): () => void {
    this.stateListeners.add(l)
    return () => this.stateListeners.delete(l)
  }

  onCrash(l: (id: string, reason: string) => void): () => void {
    this.crashListeners.add(l)
    return () => this.crashListeners.delete(l)
  }

  /**
   * El renderer dice qué navegadores tienen un pane montado; los demás se esconden. Es la red de
   * seguridad de `setBounds(null)`: si un pane se fue sin avisar, su vista nativa no puede quedar
   * pintada encima de las terminales. No muestra nada: eso lo hace cada pane con sus bounds.
   */
  keepOnly(mounted: readonly string[]): void {
    const keep = new Set(mounted)
    for (const [id, live] of this.live) {
      if (keep.has(id)) continue
      live.bounds = null
      live.view.setVisible(false)
      live.devtools?.setVisible(false)
    }
  }

  onKey(l: KeyListener): () => void {
    this.keyListeners.add(l)
    return () => this.keyListeners.delete(l)
  }

  onFocus(l: FocusListener): () => void {
    this.focusListeners.add(l)
    return () => this.focusListeners.delete(l)
  }

  onExit(l: ExitListener): () => void {
    this.exitListeners.add(l)
    return () => this.exitListeners.delete(l)
  }

  /* ---------- internos ---------- */

  private contents(id: string): Electron.WebContents | undefined {
    const wc = this.live.get(id)?.view.webContents
    return wc && !wc.isDestroyed() ? wc : undefined
  }

  /** Normaliza y valida antes de `loadURL`: `will-navigate` no se emite en cargas programáticas, así que `file:` y similares se cortan aquí. */
  private load(wc: WebContents, url: string): void {
    const target = normalizeUrl(url)
    if (!isAllowedUrl(target)) return
    wc.loadURL(target).catch(() => {
      // did-fail-load ya publica el estado; la promesa rechazada no aporta nada.
    })
  }

  /** Una vez por sesión (partición): la página embebida no obtiene permisos (cámara, micro, geolocalización, notificaciones…); el renderer de omni sí. */
  private guardSession(ses: Session): void {
    if (this.guardedSessions.has(ses)) return
    this.guardedSessions.add(ses)
    ses.setPermissionRequestHandler((wc, _permission, callback) => callback(!this.isView(wc)))
    ses.setPermissionCheckHandler((wc) => !(wc && this.isView(wc)))
  }

  private isView(wc: WebContents): boolean {
    for (const live of this.live.values()) if (live.view.webContents === wc || live.devtools?.webContents === wc) return true
    return false
  }

  /** Cuando el renderer recarga, las vistas quedarían pintadas con bounds viejos encima de la UI nueva: se ocultan y el pane las vuelve a mostrar al montar. */
  private hookWindow(win: BrowserWindow): void {
    if (this.hookedWindows.has(win)) return
    this.hookedWindows.add(win)
    win.webContents.on('did-start-loading', () => {
      // Recarga del renderer: las vistas se esconden hasta que sus panes vuelvan a montar, y el
      // teclado vuelve al host (si una vista lo tenía, el usuario escribiría en una página oculta).
      // El renderer nuevo no sabe de ningún modo elemento/área: el reenvío total se apaga.
      for (const live of this.live.values()) {
        live.view.setVisible(false)
        live.devtools?.setVisible(false)
        live.grab = false
      }
      this.focusHost()
    })
  }

  private focusHost(): void {
    const win = this.opts.getWindow()
    if (win) win.webContents.focus()
  }

  /** Publica el estado actual de la vista a los listeners (`browser:state`). */
  private publish(id: string): void {
    if (!this.live.has(id)) return
    const state = this.state(id)
    this.stateListeners.forEach((l) => l(id, state))
  }

  private wire(id: string, view: WebContentsView): void {
    const wc = view.webContents
    // Tras `profileSet` la vista vieja sigue emitiendo hasta cerrarse del todo: sus eventos no cuentan.
    const current = (): Live | undefined => {
      const live = this.live.get(id)
      return live?.view === view ? live : undefined
    }

    const publishState = (): void => {
      if (current()) this.publish(id)
    }
    wc.on('did-start-loading', publishState)
    wc.on('did-stop-loading', publishState)
    wc.on('did-navigate', publishState)
    // Documento nuevo: los hints y el mapa se fueron con el anterior; el reenvío total no puede quedar colgado.
    const resetGrab = (): void => {
      const live = current()
      if (live) live.grab = false
    }
    wc.on('did-start-navigation', (details) => {
      if (!details.isSameDocument) resetGrab()
    })
    wc.on('did-navigate', resetGrab)
    wc.on('did-navigate-in-page', publishState)
    wc.on('page-title-updated', publishState)
    wc.on('did-fail-load', publishState)
    // Proceso de la página caído (memoria, crash de la página): Chromium dejaría una carita gris
    // tapando el pane. Se recarga sola y el pane lo avisa en la franja.
    wc.on('render-process-gone', (_event, details) => {
      if (!current() || details.reason === 'clean-exit') return
      console.warn(`[omni] el navegador ${id} perdió su proceso (${details.reason}); se recarga`)
      this.crashListeners.forEach((l) => l(id, details.reason))
      setTimeout(() => {
        if (current() && !wc.isDestroyed()) wc.reload()
      }, 300)
    })

    // Electron 44: el primer argumento trae `{ level, message, lineNumber, sourceId }`; el resto está deprecado.
    // Solo se guarda un tail por vista (`consoleTail`): las DevTools acopladas son la consola de verdad.
    wc.on('console-message', (details) => {
      const live = current()
      if (!live) return
      const entry: ConsoleEntry = {
        id: this.nextConsoleId++,
        at: Date.now(),
        level: consoleLevel(details.level),
        text: details.message
      }
      const source = consoleSource(details.sourceId, details.lineNumber)
      if (source) entry.source = source
      live.console.push(entry)
      if (live.console.length > CONSOLE_TAIL) live.console.splice(0, live.console.length - CONSOLE_TAIL)
    })

    // Teclado: ⌘ y el prefijo son de omni; edición y menú se los queda la página / el menú; el resto, la
    // página. Con `grab` (modo elemento, área con teclado) TODO va a omni salvo el menú.
    this.wireKeys(id, wc, () => current()?.grab ?? false, () => (current()?.agentInput ?? 0) > 0)
    wc.on('focus', () => {
      if (current()) this.focusListeners.forEach((l) => l(id, true))
    })
    wc.on('blur', () => {
      if (current()) this.focusListeners.forEach((l) => l(id, false))
    })

    // Las DevTools se cerraron desde su propia UI (o por `closeDevTools`): la vista acoplada sobra.
    wc.on('devtools-closed', () => {
      const live = current()
      if (!live?.devtools) return
      this.closeDevTools(live)
      this.publish(id)
    })

    // Popups al navegador del sistema; nada de ventanas nuevas dentro de omni.
    wc.setWindowOpenHandler(({ url }) => {
      if (EXTERNAL_SCHEMES.has(schemeOf(url))) void shell.openExternal(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (details) => {
      if (!ALLOWED_SCHEMES.has(schemeOf(details.url))) details.preventDefault()
    })

    // Si la página se cierra sola (window.close, crash fatal) la sesión también termina.
    wc.on('destroyed', () => {
      if (current()) this.destroy(id)
    })
  }

  /**
   * Reenvío de teclas de un webContents nativo (página o DevTools) al renderer: ⌘ y el prefijo son
   * de omni; edición y menú se los queda el webContents. `grab` lo decide quien llama.
   */
  private wireKeys(id: string, wc: WebContents, grab: () => boolean, agent: () => boolean = () => false): void {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || agent()) return
      const disposition = keyDisposition(input, this.opts.getPrefix(), grab())
      if (disposition === 'page') return
      event.preventDefault()
      const key: ForwardedKey = { key: input.key, code: input.code, ctrl: input.control, alt: input.alt, shift: input.shift, meta: input.meta }
      this.keyListeners.forEach((l) => l(id, key))
      // Tras el prefijo la siguiente tecla tiene que caer en el renderer, no en la página.
      if (disposition === 'prefix') this.focusHost()
    })
  }

  /** Las DevTools acopladas también toman el teclado al hacer clic: mismos atajos de omni y mismo aviso de foco que la página. */
  private wireDevTools(id: string, devtools: WebContentsView): void {
    const wc = devtools.webContents
    const current = (): boolean => this.live.get(id)?.devtools === devtools
    this.wireKeys(id, wc, () => false)
    wc.on('focus', () => {
      if (current()) this.focusListeners.forEach((l) => l(id, true))
    })
    wc.on('blur', () => {
      if (current()) this.focusListeners.forEach((l) => l(id, false))
    })
    // Nada sale de las DevTools hacia ventanas nuevas (p. ej. "abrir en pestaña nueva" de un recurso).
    wc.setWindowOpenHandler(({ url }) => {
      if (EXTERNAL_SCHEMES.has(schemeOf(url))) void shell.openExternal(url)
      return { action: 'deny' }
    })
  }

  private async persist(image: NativeImage): Promise<Capture> {
    const png = image.toPNG()
    const { width, height } = image.getSize()
    mkdirSync(this.captureDir, { recursive: true })
    // Dos capturas en el mismo segundo: sufijo incremental en vez de pisar la anterior.
    const path = nextCapturePath(this.captureDir, captureFileName(new Date()), existsSync)
    writeFileSync(path, png)
    try {
      await writeImageToClipboard(png)
    } catch (err) {
      // El archivo ya está en disco; el portapapeles es un extra.
      console.warn('[omni] no se pudo copiar la captura al portapapeles:', err)
    }
    return { path, width, height }
  }
}

/** `true` si `path` es un PNG dentro de `dir` (resueltos `..` y rutas relativas). Exportado para tests. */
export function isCaptureFile(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && rel.endsWith('.png')
}

/** Deja un PNG en el portapapeles del sistema (reemplaza lo que hubiera). */
async function writeImageToClipboard(png: Buffer): Promise<void> {
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
}
