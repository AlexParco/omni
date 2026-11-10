import { Terminal, type FontWeight, type ITerminalOptions } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { ImageAddon } from '@xterm/addon-image'
import { LigaturesAddon } from '@xterm/addon-ligatures'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { commands } from '@/core/commands/registry'
import { dropText, isEphemeralDrop } from '@/core/drop-paths'
import { chordOf, isModifierOnly } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { omni } from '@/lib/omni'
import { focusStays, insidePane } from '@/panes/pane-focus'
import { useLayout } from '@/store/layout'
import { useSessions } from '@/store/sessions'
import { setScreenReader } from '@/store/screen-probe'
import { PREFIX_TIMEOUT_MS, useUi } from '@/store/ui'
import { currentPrefix, useSettings } from '@/store/settings'
import { terminalFontFamily, type Settings } from '@shared/types'
import type { PaneHandle } from '../types'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { openTerminalLink } from '@/store/links'

/** Espera tras el último cambio de tamaño antes de avisar al PTY. */
const RESIZE_SETTLE_MS = 80

interface Instance extends PaneHandle {
  term: Terminal
  fitAddon: FitAddon
  /** Contenedor propio de xterm; se reparenta al pane que lo muestre. */
  el: HTMLDivElement
  observer: ResizeObserver | null
  /** xterm se abre recién en el primer attach: medir fuente con el DOM desconectado da 0. */
  opened: boolean
  /** Ya se mandó al PTY el tamaño real (primer `fit`): recién ahí vale el empujón de repintado. */
  fitted: boolean
  /** Salida en vivo retenida mientras llega `session:history`; `null` = se escribe directo. */
  queue: string[] | null
  /** El historial llegó antes del primer `fit`: el empujón de repintado se hace tras ese `fit`. */
  repaintPending: boolean
  /**
   * Renderer WebGL mientras la terminal está montada en un pane; `null` = pinta el renderer DOM.
   * Chromium limita los contextos WebGL vivos por ventana (unos 16) y, al pasarse, mata el más viejo:
   * su canvas queda en blanco con una carita. Por eso solo las terminales visibles tienen uno.
   */
  webgl: WebglAddon | null
}

const instances = new Map<string, Instance>()
/** Salida que llegó antes de montar la terminal (sesiones restauradas). */
const pending = new Map<string, string[]>()
let wired = false

function wireEvents(): void {
  if (wired) return
  wired = true
  omni.on('session:data', (id, data) => {
    const inst = instances.get(id)
    if (!inst) pending.set(id, [...(pending.get(id) ?? []), data])
    else if (inst.queue) inst.queue.push(data)
    else inst.term.write(data)
  })
}

/**
 * Las TUI (Claude Code, Codex) no repintan solas al reconectar: un resize de un carácter y vuelta
 * les manda dos SIGWINCH y redibujan sobre el historial recién escrito.
 */
function nudgeRepaint(inst: Instance, sessionId: string): void {
  const { cols, rows } = inst.term
  omni.send('session:resize', sessionId, Math.max(1, cols - 1), rows)
  omni.send('session:resize', sessionId, cols, rows)
}

/**
 * Sesión que ya existía antes de este arranque del renderer: se pide la salida reciente al daemon
 * y se escribe antes que nada. Lo que llegue en vivo mientras tanto espera en `queue`; los chunks
 * de `early` (anteriores a la petición) ya están dentro del historial y solo se usan si este falla.
 */
function restoreHistory(inst: Instance, sessionId: string, early: string[]): void {
  inst.queue = []
  // La terminal pudo morir (`session:exit`) mientras el historial venía en camino.
  const alive = (): boolean => instances.get(sessionId) === inst
  const done = (): void => {
    const live = inst.queue ?? []
    inst.queue = null
    live.forEach((chunk) => inst.term.write(chunk))
  }
  const fallback = (): void => {
    if (!alive()) return
    early.forEach((chunk) => inst.term.write(chunk))
    done()
  }
  omni.invoke('session:history', sessionId).then((history) => {
    if (!alive()) return
    // Sin historial (daemon apagado, sesión recién nacida) lo único que hay es lo que llegó en vivo.
    if (!history) {
      fallback()
      return
    }
    inst.term.write(history, () => {
      if (!alive()) return
      done()
      if (inst.fitted) nudgeRepaint(inst, sessionId)
      else inst.repaintPending = true
    })
  }, fallback)
}

/** Opciones de xterm que salen de los ajustes (fuente, tamaño, interlineado, grosor y velocidad del scroll). */
function fontOptions(settings: Settings): Pick<ITerminalOptions, 'fontFamily' | 'fontSize' | 'lineHeight' | 'fontWeight' | 'fontWeightBold' | 'scrollSensitivity'> {
  return {
    fontFamily: terminalFontFamily(settings.terminalFont),
    fontSize: settings.terminalFontSize,
    lineHeight: settings.terminalLineHeight,
    fontWeight: settings.terminalFontWeight,
    // El negrito va dos pasos por encima del texto normal (500 → 700), con tope en 800.
    fontWeightBold: Math.min(800, settings.terminalFontWeight + 200) as FontWeight,
    scrollSensitivity: settings.terminalScrollSpeed
  }
}

function buildTerminal(): Terminal {
  return new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    ...fontOptions(useSettings.getState().settings),
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: {
      background: '#050505',
      foreground: '#d4d4d4',
      cursor: '#fafafa',
      cursorAccent: '#050505',
      selectionBackground: 'rgba(255,255,255,0.2)',
      black: '#171717',
      brightBlack: '#525252',
      red: '#ef4444',
      green: '#16a34a',
      yellow: '#d4a300',
      blue: '#60a5fa',
      magenta: '#a78bfa',
      cyan: '#22d3ee',
      white: '#a1a1a1',
      brightWhite: '#fafafa'
    }
  })
}

/** Comandos del prefijo que se repiten sin volver a pulsarlo (`repeat-time` de tmux). */
const REPEATABLE = new Set(['pane.resize.left', 'pane.resize.right', 'pane.resize.up', 'pane.resize.down'])
/** Ventana de repetición tras cada pulsación. */
export const PREFIX_REPEAT_MS = 600

/**
 * Teclado dentro de la terminal: ⌘ se deja pasar a la app (xterm no lo procesa),
 * C-a arma el prefijo y la siguiente tecla se resuelve contra la capa `terminal`.
 * Los modificadores sueltos no desarman (si no, `C-a %` moriría al apretar Shift).
 * El prefijo caduca solo, y el store lo expone para que el footer lo muestre.
 */
function attachPrefixHandler(term: Terminal, sessionId: string): void {
  let armed = false
  let timer = 0
  /** Hasta cuándo un comando repetible (tamaño del pane) se repite sin volver a pulsar el prefijo. */
  let repeatUntil = 0
  const arm = (on: boolean): void => {
    armed = on
    clearTimeout(timer)
    useUi.getState().setPrefixArmed(on)
    if (on) timer = window.setTimeout(() => arm(false), PREFIX_TIMEOUT_MS)
  }
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return !armed
    const chord = chordOf(e)
    if (isModifierOnly(chord)) return !armed
    if (e.metaKey) {
      if (armed) arm(false)
      return false
    }
    if (armed) {
      arm(false)
      // Sin preventDefault el carácter del atajo (`"`, `%`) llegaría como keypress al input
      // del overlay que el comando acaba de abrir.
      e.preventDefault()
      const id = keymap.resolve(['terminal'], chord)
      if (id) void commands.run(id)
      repeatUntil = id && REPEATABLE.has(id) ? Date.now() + PREFIX_REPEAT_MS : 0
      return false
    }
    // Como el `repeat-time` de tmux: `prefijo ⇧L ⇧L ⇧L` sin repetir el prefijo mientras se sigan pulsando.
    if (Date.now() < repeatUntil) {
      const id = keymap.resolve(['terminal'], chord)
      if (id && REPEATABLE.has(id)) {
        e.preventDefault()
        repeatUntil = Date.now() + PREFIX_REPEAT_MS
        void commands.run(id)
        return false
      }
      repeatUntil = 0
    }
    if (chord === currentPrefix()) {
      e.preventDefault()
      arm(true)
      return false
    }
    // ⌃V es el "pegar imagen" de Claude Code: lee el portapapeles de la máquina donde corre. En una
    // terminal remota ese es el del VPS (vacío): omni sube la imagen del Mac y pega su ruta. Sin imagen,
    // el ⌃V llega tal cual.
    if (chord === 'ctrl+v' && isRemote(sessionId)) {
      e.preventDefault()
      void pasteClipboardImage(term, sessionId)
      return false
    }
    // Shift+⏎ = salto de línea en Claude Code y Codex (CSI u, como kitty y Ghostty); xterm solo mandaría \r.
    if (chord === 'shift+enter') {
      omni.send('session:write', sessionId, '\x1b[13;2u')
      return false
    }
    return true
  })
}

/** Crea (una sola vez) la terminal de una sesión, desacoplada del DOM. */
export function ensureTerminal(sessionId: string): Instance {
  const existing = instances.get(sessionId)
  if (existing) return existing
  wireEvents()

  const el = document.createElement('div')
  el.className = 'term-root'
  const term = buildTerminal()
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  // Enlaces (texto plano y OSC 8) con ⌘-clic, como Terminal.app e iTerm: un clic suelto selecciona o va a
  // la TUI. Los artifacts de Claude se abren en el navegador de omni; el resto, en el del sistema.
  const activate = (e: MouseEvent, uri: string): void => {
    if (e.metaKey) openTerminalLink(uri, sessionId)
  }
  term.options.linkHandler = { activate, allowNonHttpProtocols: false }
  term.loadAddon(new WebLinksAddon(activate))
  attachPrefixHandler(term, sessionId)
  term.onData((data) => {
    omni.send('session:write', sessionId, data)
    // El usuario le escribió: la pregunta (si había) queda atendida.
    useSessions.getState().clearAttention(sessionId)
  })
  // Claude Code y Codex meten su propio símbolo al inicio del título; el icono ya lo pone omni.
  term.onTitleChange((title) => useSessions.getState().setTitle(sessionId, title.replace(/^[^\p{L}\p{N}]+/u, '')))
  term.onBell(() => useSessions.getState().markAttention(sessionId))
  // Soltar archivos (una captura, un PDF) pega sus rutas como Terminal.app: Claude Code adjunta la imagen.
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  })
  el.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    e.preventDefault()
    void pasteDropped(term, files, sessionId)
  })
  // ⌘V con una imagen (una captura de macOS, una imagen copiada del navegador): xterm solo pega texto y
  // no mandaría nada. Se trata como soltarla: se guarda (o se sube, si es remota) y se pega su ruta.
  // Con texto en el portapapeles manda el pegado normal de xterm.
  el.addEventListener(
    'paste',
    (e) => {
      const data = e.clipboardData
      if (!data || data.getData('text/plain') !== '') return
      const images = [...data.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => f !== null)
      if (images.length === 0) return
      e.preventDefault()
      e.stopImmediatePropagation()
      void pasteDropped(term, images.map(namedClipboardImage), sessionId)
    },
    true
  )

  let fitFrame = 0
  let resizeTimer = 0

  const inst: Instance = {
    term,
    fitAddon,
    el,
    observer: null,
    opened: false,
    fitted: false,
    queue: null,
    repaintPending: false,
    webgl: null,
    focus: () => term.focus(),
    blur: () => term.blur(),
    // Coalesce por frame y difiere el SIGWINCH: arrastrar un divisor no redibuja la TUI 60 veces/s.
    fit() {
      cancelAnimationFrame(fitFrame)
      fitFrame = requestAnimationFrame(() => {
        if (!inst.opened || el.offsetWidth === 0 || el.offsetHeight === 0) return
        fitAddon.fit()
        clearTimeout(resizeTimer)
        resizeTimer = window.setTimeout(() => {
          omni.send('session:resize', sessionId, term.cols, term.rows)
          inst.fitted = true
          if (inst.repaintPending) {
            inst.repaintPending = false
            nudgeRepaint(inst, sessionId)
          }
        }, RESIZE_SETTLE_MS)
      })
    },
    dispose() {
      cancelAnimationFrame(fitFrame)
      clearTimeout(resizeTimer)
      inst.observer?.disconnect()
      term.dispose()
      el.remove()
      instances.delete(sessionId)
    }
  }
  instances.set(sessionId, inst)
  const early = pending.get(sessionId) ?? []
  pending.delete(sessionId)
  if (useSessions.getState().restored[sessionId]) restoreHistory(inst, sessionId, early)
  else early.forEach((chunk) => term.write(chunk))
  return inst
}

/**
 * Pega en la terminal las rutas de lo soltado, como un pegado normal (`term.paste` respeta el
 * bracketed paste de la TUI). Un archivo sin ruta en disco se guarda antes en un temporal.
 */
async function pasteDropped(term: Terminal, files: File[], sessionId: string): Promise<void> {
  // Terminal remota (§3.26): una ruta del Mac no le sirve al agente del VPS; se suben los bytes al host.
  const session = useSessions.getState().sessions.find((x) => x.id === sessionId)
  if (session?.remote) return pasteUploaded(term, files, session.workspaceId)
  const paths = await Promise.all(
    files.map(async (file) => {
      const path = omni.pathForFile(file)
      if (path && !isEphemeralDrop(path)) return path
      // Sin ruta, o en una carpeta temporal protegida: omni sí puede leer los bytes (recibió el
      // arrastre) y los deja en su carpeta de soltados, que el agente sí puede abrir.
      try {
        return await omni.invoke('file:saveDrop', file.name, new Uint8Array(await file.arrayBuffer()))
      } catch {
        return path
      }
    })
  )
  const text = dropText(paths)
  if (!text) return
  term.paste(text)
  term.focus()
}

/** `true` si la sesión corre en un servidor por SSH (§3.26). */
function isRemote(sessionId: string): boolean {
  return useSessions.getState().sessions.find((x) => x.id === sessionId)?.remote === true
}

/** Las imágenes del portapapeles llegan como `image.png`: se llaman `portapapeles.<ext>` (la carpeta de soltados les antepone la hora). */
function namedClipboardImage(file: File): File {
  const ext = file.type === 'image/jpeg' ? 'jpg' : (file.type.split('/')[1] ?? 'png')
  return new File([file], `portapapeles.${ext}`, { type: file.type })
}

/** ⌃V en una terminal remota: sube la imagen del portapapeles del Mac y pega su ruta; sin imagen, manda el ⌃V. */
async function pasteClipboardImage(term: Terminal, sessionId: string): Promise<void> {
  const png = await omni.invoke('clipboard:readImage').catch(() => null)
  if (!png) {
    omni.send('session:write', sessionId, '\x16')
    return
  }
  await pasteDropped(term, [new File([new Uint8Array(png)], 'portapapeles.png', { type: 'image/png' })], sessionId)
}

/**
 * Sube lo soltado a `~/.omni/drops/` del host y pega esas rutas. Una carpeta (sin bytes legibles) o algo
 * que no se pudo subir se avisa y no se pega: una ruta del Mac confundiría al agente remoto.
 */
async function pasteUploaded(term: Terminal, files: File[], workspaceId: string): Promise<void> {
  const failed: string[] = []
  const paths = await Promise.all(
    files.map(async (file) => {
      try {
        return await omni.invoke('file:uploadDrop', workspaceId, file.name, new Uint8Array(await file.arrayBuffer()))
      } catch {
        failed.push(file.name)
        return null
      }
    })
  )
  if (failed.length > 0) void import('@/store/control').then((m) => m.useControl.getState().announce(`No se pudo subir al servidor: ${failed.join(', ')}`))
  const text = dropText(paths.filter((p): p is string => p !== null))
  if (!text) return
  term.paste(text)
  term.focus()
}

/**
 * Activa el renderer WebGL si la terminal no tiene uno. Si Chromium pierde el contexto (límite de
 * contextos, GPU reiniciada), lo suelta y repinta con el renderer DOM: nunca queda el canvas muerto.
 * Sin WebGL disponible no hace nada; el renderer DOM funciona igual.
 */
function enableWebgl(inst: Instance): void {
  if (inst.webgl) return
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      if (inst.webgl !== addon) return
      disableWebgl(inst)
      inst.term.refresh(0, inst.term.rows - 1)
    })
    inst.term.loadAddon(addon)
    inst.webgl = addon
  } catch {
    inst.webgl = null
  }
}

/** Suelta el renderer WebGL (y su contexto) y deja el DOM; no hace nada si no había uno. */
function disableWebgl(inst: Instance): void {
  const addon = inst.webgl
  inst.webgl = null
  addon?.dispose()
}

/** Abre xterm con el contenedor ya en el DOM; se hace una sola vez por sesión. */
function openTerminal(inst: Instance, sessionId: string): void {
  inst.opened = true
  inst.term.open(inst.el)
  enableWebgl(inst)
  // Imágenes en línea (SIXEL y el protocolo de iTerm), como `imgcat` o los previews de algunas TUIs.
  try {
    inst.term.loadAddon(new ImageAddon())
  } catch {
    /* sin imágenes: el texto sigue igual */
  }
  // Ligaduras de la fuente (lee la fuente con Local Font Access; si no puede, usa las comunes como `=>`).
  try {
    inst.term.loadAddon(new LigaturesAddon())
  } catch {
    /* sin ligaduras: cada carácter va suelto */
  }
  // Única fuente de verdad del foco: el textarea de xterm. Al entrar, layout y sidebar se alinean;
  // al salir hacia la app (no hacia un overlay), el teclado vuelve a la lista.
  inst.term.textarea?.addEventListener('focus', () => {
    useUi.getState().setFocus('terminal')
    useLayout.getState().focusSession(sessionId)
    useSessions.getState().syncCursor(sessionId)
  })
  const textarea = inst.term.textarea
  textarea?.addEventListener('blur', () => {
    // Se decide un tick después: al reparentar o cerrar un pane, el foco ya habrá llegado a otra terminal.
    setTimeout(() => {
      // El pane del navegador (su barra de URL o su raíz) también es "teclado en un pane": la intención sigue en `terminal`.
      const active = document.activeElement
      if (focusStays(active)) return
      // Pane muerto: la intención sigue siendo "terminal" y el pane vecino la toma al enfocarse.
      if (!textarea.isConnected) return
      useUi.getState().setFocus('list')
    }, 0)
  })
}

/** Monta la terminal dentro de `parent` (reparenta: no se pierde el buffer) y le da renderer WebGL. */
export function attachTerminal(sessionId: string, parent: HTMLElement): Instance {
  const inst = ensureTerminal(sessionId)
  parent.appendChild(inst.el)
  if (!inst.opened) openTerminal(inst, sessionId)
  else enableWebgl(inst)
  inst.observer?.disconnect()
  inst.observer = new ResizeObserver(() => inst.fit())
  inst.observer.observe(parent)
  inst.fit()
  return inst
}

/** Saca la terminal del DOM sin cerrarla: el buffer sigue vivo, pero suelta su contexto WebGL. */
export function detachTerminal(sessionId: string): void {
  const inst = instances.get(sessionId)
  if (!inst) return
  inst.observer?.disconnect()
  inst.observer = null
  // Oculta no necesita GPU: liberar el contexto evita que Chromium mate el de una terminal visible.
  disableWebgl(inst)
  inst.el.remove()
}

export function disposeTerminal(sessionId: string): void {
  instances.get(sessionId)?.dispose()
}

export function getTerminal(sessionId: string): PaneHandle | undefined {
  return instances.get(sessionId)
}

/**
 * Últimas `n` líneas no vacías de lo que xterm tiene pintado ahora (pantalla alternativa incluida).
 * Las TUI a pantalla completa (Claude Code) dibujan con posicionamiento absoluto: el historial crudo
 * no forma líneas, la pantalla renderizada sí. `null` si la sesión no tiene xterm.
 */
export function screenLines(sessionId: string, n: number): string[] | null {
  const inst = instances.get(sessionId)
  if (!inst) return null
  const term = inst.term
  const buffer = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < term.rows; i++) {
    const line = buffer.getLine(buffer.viewportY + i)?.translateToString(true).replace(/\s+$/, '') ?? ''
    if (line.trim() !== '') out.push(line)
  }
  return out.slice(-n)
}

/**
 * Saca el teclado de cualquier terminal y deja la intención en "lista" al instante, para que un
 * workspace que se monte justo después no enfoque su terminal por el efecto de `TerminalPane`.
 */
export function blurTerminals(): void {
  useUi.getState().setFocus('list')
  const el = document.activeElement
  if (el instanceof HTMLElement && insidePane(el)) el.blur()
}

/** Escribe el prefijo literal (`C-a` → 0x01, `M-x` → ESC x) para el comando `terminal.sendPrefix`. */
export function sendRawPrefix(sessionId: string): void {
  const bytes = prefixBytes(currentPrefix())
  if (bytes) omni.send('session:write', sessionId, bytes)
}

/** Bytes que una terminal recibiría por ese chord; `null` si no tiene equivalente. */
export function prefixBytes(prefix: string): string | null {
  const parts = prefix.split('+')
  const key = parts.pop() ?? ''
  if (key.length !== 1) return null
  if (parts.length === 1 && parts[0] === 'ctrl' && /[a-z]/.test(key)) return String.fromCharCode(key.charCodeAt(0) - 96)
  if (parts.length === 1 && parts[0] === 'alt') return `\x1b${key}`
  return null
}

/** Aplica a todas las terminales vivas lo que depende de los ajustes: fuente, tamaño, interlineado, grosor y scroll. */
export function applyTerminalSettings(settings: Settings): void {
  const next = fontOptions(settings)
  instances.forEach((inst) => {
    const o = inst.term.options
    // La velocidad del scroll no cambia la métrica: se aplica sin reajustar.
    if (o.scrollSensitivity !== next.scrollSensitivity) o.scrollSensitivity = next.scrollSensitivity
    if (o.fontSize === next.fontSize && o.fontFamily === next.fontFamily && o.lineHeight === next.lineHeight && o.fontWeight === next.fontWeight && o.fontWeightBold === next.fontWeightBold) return
    Object.assign(inst.term.options, next)
    inst.fit()
  })
}

setScreenReader(screenLines)
