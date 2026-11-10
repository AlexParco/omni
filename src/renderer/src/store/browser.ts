import { create } from 'zustand'
import type { BrowserElement, BrowserProfile, BrowserState, Capture, CapturePayload, CookieImportSource, ElementHint, ForwardedKey, Rect, SessionInfo, ViewportPreset } from '@shared/types'
import { normalizeUrl } from '@shared/url'
import { commands } from '@/core/commands/registry'
import { chordFromForwarded, isModifierOnly, type Chord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { omni } from '@/lib/omni'
import { browserUrlDraft, focusBrowserRoot, focusBrowserUrl, forwardModeKey } from '@/panes/browser/browser-host'
import { stepHint } from './element-hints'
import { leaves, useLayout } from './layout'
import { writeToSession, writeWhenSettled } from './session-write'
import { useSessions } from './sessions'
import { currentPrefix } from './settings'
import { PREFIX_TIMEOUT_MS, useUi } from './ui'
import { toggledMobile } from './viewport-presets'

/** Líneas de consola que main adjunta al paquete al agente (`browser:consoleTail`). */
const CONSOLE_TAIL = 20
/** Cuánto dura el aviso de la franja ("Enviado a Claude Code"). */
const NOTICE_MS = 3000
/** Sesiones que se recuerdan como "último foco" para elegir el destino de una captura. */
const RECENT_MAX = 50

/** Captura completa mostrada en un lienzo DOM mientras el usuario recorta un área o dibuja el markup. */
export interface Snapshot {
  id: string
  dataUrl: string
}

/**
 * Modo del navegador con foco: elegir un elemento por letra, o uno de los dos pasos de la captura
 * (`area`: recortar; `markup`: dibujar sobre el recorte). El footer lo lee.
 */
export type BrowserMode = null | 'element' | 'area' | 'markup'

/** Qué captura muestra el diálogo "Enviar al agente": tal cual (recorte o elemento) o con dibujo encima. */
export type SendKind = 'capture' | 'markup'

/** Modo elemento activo: los hints que main dibujó, la letra acumulada (hints de dos letras) y el elegido, si ya hay uno. */
export interface ElementPick {
  id: string
  hints: ElementHint[]
  typed: string
  /** Elegido con su letra (resaltado en la página); ⏎ lo captura y abre el diálogo. */
  chosen: BrowserElement | null
}

interface BrowserStoreState {
  /** Estado de navegación por sesión, tal como lo publica main. */
  states: Record<string, BrowserState>
  /** La vista nativa tiene el teclado (clic dentro de la página). */
  focused: Record<string, true>
  /** Aviso transitorio en la franja del pane. */
  notices: Record<string, string>
  /** Paso 1 de la captura: la página completa sobre la que se recorta (`panes/browser/AreaCapture.tsx`). */
  areaCapture: Snapshot | null
  /** Paso 2 de la captura: el recorte, fondo del lienzo de dibujo (`panes/browser/Markup.tsx`). */
  markup: Snapshot | null
  browserMode: BrowserMode
  elementPick: ElementPick | null
  /** Tamaño del hueco de cada vista en px CSS (lo que mide el pane al mandar `browser:bounds`). */
  viewports: Record<string, { width: number; height: number }>
  /** Paquete que muestra el diálogo "Enviar al agente" (overlay `sendCapture`). */
  sendPayload: CapturePayload | null
  sendKind: SendKind
  /** Perfiles de navegación (`browser:profiles`); se piden al abrir el menú o los ajustes. */
  profiles: BrowserProfile[]
  /** Navegador al que pertenecen el menú `…` y los diálogos de perfil y ajustes abiertos. */
  menuId: string | null
  /** Ids de sesión que tuvieron el foco del layout, el más reciente primero (destino de capturas). */
  recentFocus: string[]

  /** Suscribe los eventos `browser:*` y `session:exit` e hidrata el estado de los navegadores vivos. Devuelve la función para desuscribirse. */
  init(): () => void
  /** Pide a main el estado de cada navegador que aún no lo tiene (tras recargar el renderer). */
  hydrate(): Promise<void>
  navigate(id: string, input: string): Promise<void>
  /** Navega a lo que hay escrito en la barra del pane (comando `browser.navigate`) y le da el teclado a la página. */
  navigateFromBar(id: string): Promise<void>
  back(id: string): Promise<void>
  forward(id: string): Promise<void>
  reload(id: string): Promise<void>
  stop(id: string): Promise<void>
  /** Guarda el PNG final de la captura (recorte, con o sin dibujo) y abre el diálogo de envío con él. */
  saveCapture(id: string, dataUrl: string, kind?: SendKind): Promise<Capture | null>
  /**
   * Captura (`browser.capture`): toma la página y abre el lienzo de recorte (modo `area`). El flujo
   * sigue con `cropDone` (dibujo) y termina en el diálogo de envío con `saveCapture`.
   */
  startAreaCapture(id: string): Promise<void>
  endAreaCapture(): void
  /** Recorte elegido (o la página entera): pasa al lienzo de dibujo con esa imagen de fondo (modo `markup`). */
  cropDone(id: string, dataUrl: string): void
  /** Modo elemento: main dibuja letras sobre los elementos visibles; `a–z` eligen (resaltan), ⏎ captura y abre el diálogo, Esc sale. */
  startElementMode(id: string): Promise<void>
  exitElementMode(): Promise<void>
  /** Tecla en modo elemento (venga del renderer o reenviada por main). Devuelve `true` si el modo estaba activo: la tecla no sigue. */
  elementKey(chord: Chord): boolean
  /** Cierra el lienzo de dibujo (Esc, o al pasar al diálogo de envío). */
  endMarkup(): void
  /** Alterna el viewport entre responsive y el preset móvil (`browser.mobile`). */
  toggleMobile(id: string): Promise<void>
  /** Viewport fijo o `null` = responsive; main publica el resultado en `browser:state`. */
  setViewport(id: string, preset: ViewportPreset | null): Promise<void>
  /** Abre el overlay `sendCapture` con el paquete; toda captura (viewport, área, elemento, markup) pasa por aquí. */
  openSendDialog(payload: CapturePayload, kind?: SendKind): void
  closeSendDialog(): void
  /** Escribe el paquete en la PTY del destino (con ⏎ si no es shell). */
  sendToSession(targetId: string, text: string): void
  /** Lanza Claude Code en el workspace del navegador y escribe el paquete cuando el prompt se calma. */
  sendToNewAgent(browserId: string, text: string): Promise<SessionInfo | null>
  /** Abre o cierra las DevTools acopladas; el estado real llega en `browser:state` (`devtools`). */
  toggleDevtools(id: string): Promise<void>
  setBounds(id: string, rect: Rect | null): void
  /** Dónde pintar las DevTools acopladas; `null` las esconde. */
  setDevtoolsBounds(id: string, rect: Rect | null): void
  /* perfiles, cookies y datos */
  openMenu(id: string): void
  openSettings(id: string): void
  /** Diálogo "Nuevo perfil" para ese navegador. */
  openNewProfile(id: string): void
  loadProfiles(): Promise<void>
  /** Crea el perfil y lo activa en ese navegador. */
  createProfile(id: string, name: string): Promise<void>
  setProfile(id: string, profileId: string): Promise<void>
  deleteProfile(id: string, profileId: string): Promise<void>
  /** Importa cookies al perfil de ese navegador; `file` abre antes el diálogo nativo. Avisa el resultado en la franja. */
  importCookies(id: string, source: CookieImportSource): Promise<void>
  /** Borra cookies y storage del perfil de ese navegador. */
  clearData(id: string): Promise<void>
  /** El renderer quiere el teclado de vuelta (main enfoca su webContents). */
  blur(id: string): void
  /** La página debe tomar el teclado. */
  focusView(id: string): void
  /** Enfoca la barra de URL (y recupera el teclado si lo tenía la página). */
  focusUrl(id: string): void
  notify(id: string, text: string): void
}

const sessions = useSessions.getState
const ui = useUi.getState

/* ---------- prefijo armado desde el navegador ---------- */

// La página se queda con casi todo el teclado; main solo reenvía ⌘ y el prefijo. Al reenviar el
// prefijo devuelve el foco al renderer, y la tecla siguiente llega como keydown normal: `useKeyboard`
// pregunta aquí si hay un prefijo pendiente y la resuelve contra la capa `terminal`.
let prefixArmed = false
let prefixTimer = 0

function setArmed(on: boolean): void {
  prefixArmed = on
  clearTimeout(prefixTimer)
  ui().setPrefixArmed(on)
  if (on) prefixTimer = window.setTimeout(() => setArmed(false), PREFIX_TIMEOUT_MS)
}

/** Arma el prefijo con el mismo timeout que la terminal. */
export function armBrowserPrefix(): void {
  setArmed(true)
}

/** `true` (y desarma) si había un prefijo armado desde el navegador esperando su tecla. */
export function takeBrowserPrefix(): boolean {
  if (!prefixArmed) return false
  setArmed(false)
  return true
}

export function isBrowserPrefixArmed(): boolean {
  return prefixArmed
}

/**
 * Resuelve cuando la vista puede estar en pantalla: sin overlay y dos frames después, que es lo que
 * tarda el pane en volver a mandar `browser:bounds`. Capturar antes daría una vista oculta
 * (`closeOverlay()` y `commands.run` caen en el mismo tick al elegir en la paleta).
 */
function whenVisible(): Promise<void> {
  return new Promise((resolve) => {
    const settle = (): void => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }
    if (ui().overlay === null) {
      settle()
      return
    }
    const off = useUi.subscribe((s) => {
      if (s.overlay !== null) return
      off()
      settle()
    })
  })
}

const CAPTURE_FAILED = 'No se pudo capturar: la vista no está visible'

/* ---------- store ---------- */

const noticeTimers = new Map<string, number>()
/** Ids con `browser:state` en vuelo (hidratación). */
const hydrating = new Set<string>()

function dropId<T>(record: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _gone, ...rest } = record
  return rest
}

export const useBrowser = create<BrowserStoreState>((set, get) => ({
  states: {},
  focused: {},
  notices: {},
  areaCapture: null,
  markup: null,
  browserMode: null,
  elementPick: null,
  viewports: {},
  sendPayload: null,
  sendKind: 'capture',
  profiles: [],
  menuId: null,
  recentFocus: [],

  init() {
    const offs: Array<() => void> = []

    offs.push(omni.on('browser:crashed', (id) => get().notify(id, 'La página se cerró inesperadamente; se recargó')))
    offs.push(omni.on('browser:state', (id, state) => {
      set((s) => ({ states: { ...s.states, [id]: state } }))
      // El título y el "trabajando" viven en sessions para que sidebar, tabs y franja no sepan de navegadores.
      // La página vacía se titula "about:blank" en Chromium: para sidebar y tabs es "Navegador".
      sessions().setTitle(id, browserTitle(state))
      sessions().setBusy(id, state.loading)
    }))

    offs.push(omni.on('browser:focus', (id, focused) => {
      set((s) => ({ focused: focused ? { ...s.focused, [id]: true } : dropId(s.focused, id) }))
      if (!focused) return
      // Con un overlay abierto (p. ej. "Enviar al agente" tras elegir un elemento con ⏎ dentro de la
      // página) el teclado es del overlay: no se le devuelve a la página ni se mueve el foco del layout.
      if (ui().overlay !== null) {
        get().blur(id)
        return
      }
      // Igual que el focus del textarea de xterm: intención `terminal`, hoja del layout y cursor del sidebar.
      // El foco DOM va a la raíz del pane: si se quedara en otra terminal, al volver el teclado al
      // renderer esa terminal se enfocaría sola y el layout saltaría.
      ui().setFocus('terminal')
      useLayout.getState().focusSession(id)
      sessions().syncCursor(id)
      focusBrowserRoot(id)
    }))

    offs.push(omni.on('browser:key', (id, key) => handleForwardedKey(id, key, get())))

    offs.push(omni.on('session:exit', (id) => {
      clearTimeout(noticeTimers.get(id))
      noticeTimers.delete(id)
      set((s) => ({
        states: dropId(s.states, id),
        focused: dropId(s.focused, id),
        notices: dropId(s.notices, id),
        viewports: dropId(s.viewports, id),
        areaCapture: s.areaCapture?.id === id ? null : s.areaCapture,
        markup: s.markup?.id === id ? null : s.markup,
        browserMode: s.areaCapture?.id === id || s.markup?.id === id || s.elementPick?.id === id ? null : s.browserMode,
        elementPick: s.elementPick?.id === id ? null : s.elementPick,
        sendPayload: s.sendPayload?.browserId === id ? null : s.sendPayload,
        menuId: s.menuId === id ? null : s.menuId,
        recentFocus: s.recentFocus.filter((x) => x !== id)
      }))
      const overlay = useUi.getState().overlay
      if (overlay === 'sendCapture' && !get().sendPayload) useUi.getState().closeOverlay()
      if ((overlay === 'browserMenu' || overlay === 'browserSettings' || overlay === 'browserProfile') && !get().menuId) useUi.getState().closeOverlay()
    }))

    // Historial de foco del layout: por tab, la sesión de la hoja con foco; cada cambio sube al frente.
    const lastByTab = new Map<string, string>()
    const track = (): void => {
      const tabs = useLayout.getState().tabs
      const changed: string[] = []
      tabs.forEach((t) => {
        const sid = leaves(t.root).find((l) => l.id === t.focusedPaneId)?.sessionId
        if (sid && lastByTab.get(t.id) !== sid) {
          lastByTab.set(t.id, sid)
          changed.push(sid)
        }
      })
      if (changed.length === 0) return
      set((s) => ({ recentFocus: [...changed.reverse(), ...s.recentFocus.filter((x) => !changed.includes(x))].slice(0, RECENT_MAX) }))
    }
    track()
    offs.push(useLayout.subscribe(track))

    // Tras recargar el renderer, main ya tiene navegadores con historia: se pide su estado apenas
    // `session:list` los trae (y cada vez que aparece uno nuevo sin estado).
    void get().hydrate()
    offs.push(useSessions.subscribe((s, prev) => {
      if (s.sessions !== prev.sessions) void get().hydrate()
    }))

    return () => offs.forEach((off) => off())
  },

  async hydrate() {
    const missing = sessions().sessions.filter((s) => s.agent === 'browser' && !get().states[s.id] && !hydrating.has(s.id))
    await Promise.all(missing.map(async (s) => {
      hydrating.add(s.id)
      try {
        const state = await omni.invoke('browser:state', s.id)
        // Un evento `browser:state` pudo llegar mientras tanto: ese es más nuevo.
        if (get().states[s.id]) return
        set((st) => ({ states: { ...st.states, [s.id]: state } }))
        sessions().setTitle(s.id, state.title)
        sessions().setBusy(s.id, state.loading)
      } catch {
        /* sesión que murió entre el list y el state; `session:exit` la limpia */
      } finally {
        hydrating.delete(s.id)
      }
    }))
  },

  navigate(id, input) {
    const url = normalizeUrl(input)
    // Optimista: la barra y el "en blanco" cambian ya; main publica el estado real enseguida.
    set((s) => {
      const prev = s.states[id] ?? { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, devtools: false, profileId: '', viewport: null }
      return { states: { ...s.states, [id]: { ...prev, url, loading: true } } }
    })
    return omni.invoke('browser:navigate', id, url)
  },

  async navigateFromBar(id) {
    const text = browserUrlDraft(id)
    if (text === null) return
    await get().navigate(id, text)
    focusBrowserRoot(id)
    get().focusView(id)
  },
  back: (id) => omni.invoke('browser:back', id),
  forward: (id) => omni.invoke('browser:forward', id),
  reload: (id) => omni.invoke('browser:reload', id),
  stop: (id) => omni.invoke('browser:stop', id),

  async saveCapture(id, dataUrl, kind = 'capture') {
    let capture: Capture
    try {
      capture = await omni.invoke('capture:save', dataUrl)
    } catch {
      get().notify(id, 'No se pudo guardar la captura')
      return null
    }
    // El recorte (o el markup) ya está hecho en el renderer: sirve tal cual de miniatura.
    get().openSendDialog(await buildPayload(id, capture, dataUrl, get()), kind)
    return capture
  },

  async startAreaCapture(id) {
    if (get().areaCapture || get().browserMode) return
    await whenVisible()
    // Primero la foto (con la vista visible, sin tocar disco ni portapapeles), luego el lienzo: el
    // pane esconde la vista al ver `areaCapture`. Solo el recorte final se guarda (`capture:save`).
    let dataUrl: string
    try {
      dataUrl = await omni.invoke('browser:snapshot', id)
    } catch {
      get().notify(id, CAPTURE_FAILED)
      return
    }
    set({ areaCapture: { id, dataUrl }, browserMode: 'area' })
    // El lienzo toma el foco DOM al montar; aquí se recupera el teclado de la página y, por si se lo
    // queda igual, main reenvía todas sus teclas mientras dure el modo (H J K L, ⏎, Esc).
    omni.send('browser:keyGrab', id, true)
    get().blur(id)
  },

  endAreaCapture() {
    const area = get().areaCapture
    if (area) omni.send('browser:keyGrab', area.id, false)
    set((s) => ({ areaCapture: null, browserMode: s.browserMode === 'area' ? null : s.browserMode }))
  },

  async startElementMode(id) {
    if (get().browserMode) return
    await whenVisible()
    let hints: ElementHint[]
    try {
      hints = await omni.invoke('browser:elements', id)
    } catch {
      get().notify(id, 'No se pudo leer la página')
      return
    }
    if (hints.length === 0) {
      get().notify(id, 'Sin elementos visibles')
      await omni.invoke('browser:elementsClear', id).catch(() => undefined)
      return
    }
    set({ browserMode: 'element', elementPick: { id, hints, typed: '', chosen: null } })
  },

  async exitElementMode() {
    const pick = get().elementPick
    if (!pick) return
    set({ browserMode: null, elementPick: null })
    await omni.invoke('browser:elementsClear', pick.id).catch(() => undefined)
  },

  elementKey(chord) {
    const pick = get().elementPick
    if (!pick) return false
    if (chord === 'escape') {
      void get().exitElementMode()
      return true
    }
    if (chord === 'enter') {
      // Sin elegido no hace nada; con uno, el modo termina y su rect va al diálogo.
      if (pick.chosen) {
        set({ browserMode: null, elementPick: null })
        void sendElement(pick.id, pick.chosen, get())
      }
      return true
    }
    // Una letra elige (resalta); otra letra re-elige. El resto de teclas sueltas no sale del modo.
    const step = stepHint(pick.hints, pick.typed, chord)
    if (step.kind === 'partial') set({ elementPick: { ...pick, typed: step.typed } })
    else if (step.kind === 'none') {
      if (pick.typed) set({ elementPick: { ...pick, typed: '' } })
    } else {
      set({ elementPick: { ...pick, typed: '' } })
      void chooseElement(pick.id, step.hint.hint, pick.chosen !== null)
    }
    return true
  },

  cropDone(id, dataUrl) {
    if (get().areaCapture?.id !== id) return
    // El teclado sigue tomado (`keyGrab`): el lienzo de dibujo atiende las mismas teclas reenviadas.
    set({ areaCapture: null, markup: { id, dataUrl }, browserMode: 'markup' })
  },

  endMarkup() {
    const markup = get().markup
    if (markup) omni.send('browser:keyGrab', markup.id, false)
    set((s) => ({ markup: null, browserMode: s.browserMode === 'markup' ? null : s.browserMode }))
  },

  toggleMobile(id) {
    return get().setViewport(id, toggledMobile(get().states[id]?.viewport))
  },

  async setViewport(id, preset) {
    // El estado real lo publica main en `browser:state` (`viewport`); aquí nada optimista.
    try {
      await omni.invoke('browser:viewport', id, preset)
    } catch {
      get().notify(id, 'No se pudo cambiar el viewport')
    }
  },

  openSendDialog(payload, kind = 'capture') {
    set({ sendPayload: payload, sendKind: kind })
    // El diálogo necesita el teclado: si la página lo tenía, main se lo devuelve al renderer.
    if (get().focused[payload.browserId]) get().blur(payload.browserId)
    ui().openOverlay('sendCapture')
  },

  closeSendDialog() {
    if (ui().overlay === 'sendCapture') ui().closeOverlay()
    set({ sendPayload: null })
  },

  sendToSession(targetId, text) {
    const target = sessions().sessions.find((x) => x.id === targetId)
    writeToSession(targetId, text, target?.agent !== 'shell')
  },

  async sendToNewAgent(browserId, text) {
    const browser = sessions().sessions.find((x) => x.id === browserId)
    if (browser) sessions().setWorkspace(browser.workspaceId)
    const info = await sessions().create('claude')
    if (!info) return null
    useLayout.getState().openTab(info.workspaceId, info.id)
    writeWhenSettled(info.id, text, () => get().notify(browserId, 'El agente no respondió a tiempo: paquete escrito en texto plano'))
    return info
  },

  async toggleDevtools(id) {
    try {
      await omni.invoke('browser:devtools', id, get().states[id]?.devtools !== true)
    } catch {
      get().notify(id, 'No se pudieron abrir las DevTools')
    }
  },

  setBounds(id, rect) {
    omni.send('browser:bounds', id, rect)
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    const prev = get().viewports[id]
    if (prev && prev.width === rect.width && prev.height === rect.height) return
    set((s) => ({ viewports: { ...s.viewports, [id]: { width: rect.width, height: rect.height } } }))
  },
  setDevtoolsBounds: (id, rect) => omni.send('browser:devtoolsBounds', id, rect),
  blur: (id) => omni.send('browser:blur', id),
  focusView: (id) => {
    // Darle el teclado a la página es darle el foco del layout a su pane: no se depende del evento
    // `browser:focus` de main, que Chromium no siempre emite (p. ej. tras enfocar otra terminal).
    ui().setFocus('terminal')
    useLayout.getState().focusSession(id)
    sessions().syncCursor(id)
    omni.send('browser:focusView', id)
  },

  openMenu(id) {
    set({ menuId: id })
    void get().loadProfiles()
    if (get().focused[id]) get().blur(id)
    ui().openOverlay('browserMenu')
  },

  openSettings(id) {
    set({ menuId: id })
    void get().loadProfiles()
    if (get().focused[id]) get().blur(id)
    ui().openOverlay('browserSettings')
  },

  openNewProfile(id) {
    set({ menuId: id })
    if (get().focused[id]) get().blur(id)
    ui().openOverlay('browserProfile')
  },

  async loadProfiles() {
    try {
      set({ profiles: await omni.invoke('browser:profiles') })
    } catch {
      /* sin perfiles no hay menú de perfiles; el resto del menú sigue */
    }
  },

  async createProfile(id, name) {
    const clean = name.trim()
    if (!clean) return
    try {
      const profile = await omni.invoke('browser:profileCreate', clean)
      set((s) => ({ profiles: [...s.profiles.filter((p) => p.id !== profile.id), profile] }))
      await get().setProfile(id, profile.id)
    } catch (e) {
      get().notify(id, errorText(e, 'No se pudo crear el perfil'))
    }
  },

  async setProfile(id, profileId) {
    if (get().states[id]?.profileId === profileId) return
    try {
      await omni.invoke('browser:profileSet', id, profileId)
    } catch (e) {
      get().notify(id, errorText(e, 'No se pudo cambiar el perfil'))
    }
  },

  async deleteProfile(id, profileId) {
    try {
      await omni.invoke('browser:profileDelete', profileId)
      set((s) => ({ profiles: s.profiles.filter((p) => p.id !== profileId) }))
      get().notify(id, 'Perfil eliminado')
    } catch (e) {
      get().notify(id, errorText(e, 'No se pudo eliminar el perfil'))
    }
  },

  async importCookies(id, source) {
    let path: string | undefined
    if (source === 'file') {
      const picked = await omni.invoke('browser:pickCookieFile').catch(() => null)
      if (!picked) return
      path = picked
    }
    try {
      const result = await omni.invoke('browser:importCookies', id, source, path)
      const count = result.imported === 1 ? '1 cookie importada' : `${result.imported} cookies importadas`
      get().notify(id, result.note ? `${count} · ${result.note}` : count)
    } catch (e) {
      get().notify(id, errorText(e, 'No se pudieron importar las cookies'))
    }
  },

  async clearData(id) {
    try {
      await omni.invoke('browser:clearData', id)
      get().notify(id, 'Datos del perfil borrados')
    } catch (e) {
      get().notify(id, errorText(e, 'No se pudieron borrar los datos'))
    }
  },

  focusUrl(id) {
    if (focusBrowserUrl(id)) get().blur(id)
  },

  notify(id, text) {
    clearTimeout(noticeTimers.get(id))
    set((s) => ({ notices: { ...s.notices, [id]: text } }))
    noticeTimers.set(id, window.setTimeout(() => set((s) => ({ notices: dropId(s.notices, id) })), NOTICE_MS))
  }
}))

/* ---------- helpers ---------- */

/**
 * Mensaje humano de un error de IPC: Electron lo envuelve ("Error invoking remote method '…': Error: …");
 * se queda con lo último. Sin mensaje, el texto por defecto.
 */
function errorText(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  const last = raw.split(/Error: /).pop()?.trim() ?? ''
  return last || fallback
}

/** Paquete para el diálogo: captura, miniatura, URL, viewport (preset o medido), elemento y cola de consola (main la guarda). */
async function buildPayload(id: string, capture: Capture, thumb: string, s: BrowserStoreState, element?: BrowserElement): Promise<CapturePayload> {
  const preset = s.states[id]?.viewport
  const viewport = preset ? { width: preset.width, height: preset.height } : (s.viewports[id] ?? { width: capture.width, height: capture.height })
  const consoleTail = await omni.invoke('browser:consoleTail', id, CONSOLE_TAIL).catch((): string[] => [])
  return { browserId: id, capture, thumb, url: s.states[id]?.url ?? '', viewport, element, consoleTail }
}

/**
 * Miniatura: `browser:snapshot` (data URL de la vista, sin tocar disco ni portapapeles), recortada
 * al `rect` (px CSS de la página) con canvas si lo hay. La vista debe estar en pantalla.
 */
async function snapshotThumb(id: string, rect: Rect | undefined, s: BrowserStoreState): Promise<string> {
  const dataUrl = await omni.invoke('browser:snapshot', id)
  if (!rect) return dataUrl
  const viewport = s.viewports[id]
  return cropDataUrl(dataUrl, rect, viewport ? viewport.width : null)
}

/** Recorta una imagen (data URL) a `rect` en px CSS: la foto va a escala física, se escala por su ancho real sobre el del hueco. */
function cropDataUrl(dataUrl: string, rect: Rect, cssWidth: number | null): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = cssWidth && cssWidth > 0 ? img.naturalWidth / cssWidth : window.devicePixelRatio || 1
      const sx = Math.max(0, Math.round(rect.x * scale))
      const sy = Math.max(0, Math.round(rect.y * scale))
      const sw = Math.max(1, Math.min(img.naturalWidth - sx, Math.round(rect.width * scale)))
      const sh = Math.max(1, Math.min(img.naturalHeight - sy, Math.round(rect.height * scale)))
      const canvas = document.createElement('canvas')
      canvas.width = sw
      canvas.height = sh
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(dataUrl)
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

/**
 * Letra en modo elemento: main resalta el elemento y devuelve su detalle (html, css), que queda como
 * `chosen` hasta que ⏎ lo mande o Esc salga. Si ya había uno elegido, se vuelven a pedir los hints
 * (`browser:elements` es idempotente) para que el nuevo pick los encuentre. Si el modo se cerró
 * mientras tanto, la respuesta se descarta.
 */
async function chooseElement(id: string, hint: string, rehint: boolean): Promise<void> {
  let element: BrowserElement | null
  try {
    if (rehint) {
      const hints = await omni.invoke('browser:elements', id)
      const pick = useBrowser.getState().elementPick
      if (pick?.id === id) useBrowser.setState({ elementPick: { ...pick, hints } })
    }
    element = await omni.invoke('browser:elementPick', id, hint)
  } catch {
    element = null
  }
  const pick = useBrowser.getState().elementPick
  if (pick?.id !== id) return
  if (!element) {
    useBrowser.getState().notify(id, 'No se pudo leer el elemento')
    return
  }
  useBrowser.setState({ elementPick: { ...pick, chosen: element } })
}

/**
 * ⏎ con un elemento elegido: se recorta su rect con `browser:capture`, se toma la miniatura (con el
 * elegido aún resaltado), se borran los hints y se abre el diálogo.
 */
async function sendElement(id: string, element: BrowserElement, s: BrowserStoreState): Promise<void> {
  const clear = (): Promise<void> => omni.invoke('browser:elementsClear', id).catch(() => undefined)
  let capture: Capture
  let thumb: string
  try {
    capture = await omni.invoke('browser:capture', id, element.rect)
    thumb = await snapshotThumb(id, element.rect, s)
  } catch {
    await clear()
    s.notify(id, CAPTURE_FAILED)
    return
  }
  await clear()
  s.openSendDialog(await buildPayload(id, capture, thumb, useBrowser.getState(), element))
}

/* `writeToSession` y `writeWhenSettled` viven en `session-write.ts`: también los usa el widget de tareas. */

/**
 * Tecla que la página recibió y main reenvió: en modo elemento, área o markup se la queda el modo; el
 * prefijo arma (main ya devolvió el teclado al renderer); lo demás se resuelve contra la capa
 * `global`. Si el comando abrió un overlay o volvió a la lista, el teclado tiene que estar en el
 * renderer, no en la página.
 */
function handleForwardedKey(id: string, key: ForwardedKey, s: BrowserStoreState): void {
  const chord = chordFromForwarded(key)
  if (isModifierOnly(chord)) return
  if (s.browserMode === 'element') {
    s.elementKey(chord)
    return
  }
  if (s.browserMode === 'area' || s.browserMode === 'markup') {
    forwardModeKey(chord)
    return
  }
  if (chord === currentPrefix()) {
    armBrowserPrefix()
    focusBrowserRoot(id)
    // Main ya devuelve el teclado al renderer; se repite por si el `focus` de la raíz llegó antes que
    // esta tecla y le devolvió la página el teclado (`focusView`) sin saber del prefijo.
    s.blur(id)
    return
  }
  const commandId = keymap.resolve(['global'], chord)
  if (!commandId) return
  void commands.run(commandId).then(() => {
    if (ui().overlay !== null || ui().focus === 'list') s.blur(id)
  })
}

/* ---------- selectores ---------- */

/** Id del navegador cuya vista tiene el teclado ahora mismo, si alguno. */
/**
 * Tras un comando disparado con el prefijo desde un navegador (p. ej. `prefijo z`), si el pane con
 * foco del layout sigue siendo un navegador con página y no se abrió ningún overlay, la página
 * recupera el teclado: así `prefijo z` dos veces seguidas hace y deshace el zoom sin clic.
 */
export function refocusBrowserAfterCommand(): void {
  const u = useUi.getState()
  if (u.overlay !== null || u.focus !== 'terminal') return
  const ws = useSessions.getState().currentWorkspaceId
  const lay = useLayout.getState()
  const tab = ws ? lay.tabs.find((t) => t.workspaceId === ws && t.id === lay.activeTab[ws]) : undefined
  const leaf = tab ? leaves(tab.root).find((l) => l.id === tab.focusedPaneId) : undefined
  const session = leaf ? useSessions.getState().sessions.find((x) => x.id === leaf.sessionId) : undefined
  if (!session || session.agent !== 'browser') return
  const b = useBrowser.getState()
  if (isBlank(b.states[session.id]) || b.focused[session.id] || b.browserMode !== null) return
  b.focusView(session.id)
}

export function liveBrowserId(s: Pick<BrowserStoreState, 'focused'>): string | null {
  return Object.keys(s.focused)[0] ?? null
}

/** URL sin esquema ni barra final, para la franja cuando la página no tiene título. */
export function displayUrl(url: string): string {
  if (!url || url === 'about:blank') return ''
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** Título de la franja: título de la página, si no la URL pelada, si no "Navegador". */
export function browserTitle(state: BrowserState | undefined): string {
  // Chromium titula la página vacía "about:blank": no es un título, es ruido.
  if (isBlank(state)) return 'Navegador'
  return state?.title || displayUrl(state?.url ?? '') || 'Navegador'
}

export function isBlank(state: BrowserState | undefined): boolean {
  return !state || !state.url || state.url === 'about:blank'
}
