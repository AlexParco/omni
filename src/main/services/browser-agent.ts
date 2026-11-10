import type { NativeImage, WebContents } from 'electron'
import type { BrowserState, Rect, SessionInfo } from '@shared/types'
import { OMNI_WORLD } from './browser-elements'

/**
 * Navegador manejado por un agente (ARCHITECTURE §3.23): lo que hay detrás del MCP `omni-browser`.
 * Lee la página como lista de elementos con refs (`r12`), hace clic, escribe, pulsa teclas, desplaza,
 * captura, lee la consola y evalúa JS sobre las vistas de `BrowserService`. La lectura corre en el
 * isolated world de omni (la página no ve los refs); clics y teclas son eventos de input de verdad por
 * CDP (`webContents.debugger`), los mismos que da el usuario. No importa `BrowserService`: recibe
 * un `AgentHost` que cablea `main/ipc.ts`.
 */

/** Operaciones del socket (`page.<op>`), en el orden en que se documentan. */
export const PAGE_OPS = ['tabs', 'navigate', 'read', 'click', 'type', 'key', 'scroll', 'screenshot', 'draw', 'console', 'eval', 'wait'] as const
export type PageOp = (typeof PAGE_OPS)[number]

/** Lo que el agente necesita del servicio del navegador. */
export interface AgentHost {
  list(): SessionInfo[]
  state(id: string): BrowserState
  webContents(id: string): WebContents | undefined
  /** Rect en pantalla de la vista; `null` si está oculta (pane fuera de pantalla u overlay encima). */
  bounds(id: string): Rect | null
  /** El último navegador que estuvo en pantalla: destino por defecto. */
  lastShown(): string | null
  navigate(id: string, url: string): void
  back(id: string): void
  forward(id: string): void
  reload(id: string): void
  consoleTail(id: string, lines: number): string[]
  captureImage(id: string): Promise<NativeImage>
  /**
   * La vista sigue viva aunque la ventana de omni esté tapada: sin esto macOS la marca oculta, la página
   * deja de pintar y Chromium descarta el input. Dura un rato tras la última operación del agente.
   */
  keepAwake(id: string): void
  /** Mientras corre `fn`, las teclas sintéticas de esta vista no se reenvían a omni como atajos. */
  withAgentInput<T>(id: string, fn: () => Promise<T>): Promise<T>
  /** Abre un navegador nuevo con la URL (tab propio, como el launcher) y devuelve su id. */
  open(url: string, from: string): Promise<string>
  /** Pone el pane en pantalla sin mover el teclado (para capturar). */
  show(id: string, from: string): Promise<void>
  /** Aviso `MCP · <agente>` en la franja del pane. */
  notice(id: string, from: string): void
}

/** Imagen que el MCP devuelve como contenido `image` (no como texto). */
export interface PageImage {
  image: { data: string; mimeType: 'image/jpeg' }
  width: number
  height: number
  url: string
}

type Args = Record<string, unknown>

/** Topes: la respuesta tiene que caber en el contexto de un agente. */
export const MAX_ITEMS = 400
export const MAX_TEXT_CHARS = 20_000
export const MAX_EVAL_CHARS = 20_000
export const EVAL_TIMEOUT_MS = 30_000
export const LOAD_TIMEOUT_MS = 30_000
export const WAIT_DEFAULT_MS = 10_000
export const WAIT_MAX_MS = 60_000
/** Ancho máximo de la captura que se devuelve (px CSS): más no aporta y pesa en el contexto. */
export const SHOT_MAX_WIDTH = 1280

/* ---------- validación (pura) ---------- */

const str = (args: Args, key: string): string | undefined => {
  const v = args[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}
const num = (args: Args, key: string): number | undefined => {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export type PageValidated = { ok: true; args: Args } | { ok: false; error: string }

/** Forma mínima de cada operación antes de tocar una vista. Pura, exportada para tests. */
export function validatePageArgs(op: PageOp, args: Args): PageValidated {
  const sessionId = str(args, 'sessionId')
  const base = sessionId ? { sessionId } : {}
  switch (op) {
    case 'tabs':
      return { ok: true, args: {} }
    case 'navigate': {
      const url = str(args, 'url')
      if (!url) return { ok: false, error: 'navigate: falta la dirección (url, o back / forward / reload)' }
      return { ok: true, args: { ...base, url, newTab: args.newTab === true } }
    }
    case 'read': {
      const mode = args.mode === undefined ? 'interactive' : args.mode
      if (mode !== 'interactive' && mode !== 'all' && mode !== 'text') return { ok: false, error: 'read: mode es interactive, all o text' }
      const ref = str(args, 'ref')
      if (ref && !isRef(ref)) return { ok: false, error: `read: ref no válido: ${ref}` }
      return { ok: true, args: { ...base, mode, ref, viewport: args.viewport === true } }
    }
    case 'click': {
      const ref = str(args, 'ref')
      const x = num(args, 'x')
      const y = num(args, 'y')
      if (ref && !isRef(ref)) return { ok: false, error: `click: ref no válido: ${ref}` }
      if (!ref && (x === undefined || y === undefined)) return { ok: false, error: 'click: falta el destino (ref, o x e y)' }
      const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left'
      return { ok: true, args: { ...base, ref, x, y, double: args.double === true, button } }
    }
    case 'type': {
      const text = typeof args.text === 'string' ? args.text : undefined
      if (text === undefined) return { ok: false, error: 'type: falta el texto (text)' }
      const ref = str(args, 'ref')
      if (ref && !isRef(ref)) return { ok: false, error: `type: ref no válido: ${ref}` }
      if (text === '' && args.clear !== true) return { ok: false, error: 'type: texto vacío (usa clear para vaciar el campo)' }
      return { ok: true, args: { ...base, text, ref, clear: args.clear === true } }
    }
    case 'key': {
      const keys = str(args, 'keys')
      if (!keys) return { ok: false, error: 'key: faltan las teclas (keys), p. ej. "Enter" o "cmd+a Backspace"' }
      const strokes = parseKeys(keys)
      if (!strokes.ok) return strokes
      return { ok: true, args: { ...base, keys } }
    }
    case 'scroll': {
      const direction = args.direction ?? 'down'
      if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') return { ok: false, error: 'scroll: direction es up, down, left o right' }
      const ref = str(args, 'ref')
      if (ref && !isRef(ref)) return { ok: false, error: `scroll: ref no válido: ${ref}` }
      const amount = num(args, 'amount')
      return { ok: true, args: { ...base, direction, ref, amount: amount !== undefined && amount > 0 ? Math.min(amount, 20_000) : undefined } }
    }
    case 'screenshot':
      return { ok: true, args: base }
    case 'draw': {
      const shapes = validateShapes(args.shapes)
      if (!shapes.ok) return shapes
      if (shapes.shapes.length === 0 && args.clear !== true) return { ok: false, error: 'draw: faltan las formas (shapes) o clear' }
      return { ok: true, args: { ...base, shapes: shapes.shapes, clear: args.clear === true } }
    }
    case 'console': {
      const pattern = str(args, 'pattern')
      if (pattern) {
        try {
          new RegExp(pattern, 'i')
        } catch {
          return { ok: false, error: `console: pattern no es una expresión regular válida: ${pattern}` }
        }
      }
      const lines = num(args, 'lines')
      return { ok: true, args: { ...base, pattern, lines: lines !== undefined ? Math.max(1, Math.min(200, Math.round(lines))) : 50 } }
    }
    case 'eval': {
      const code = str(args, 'code')
      if (!code) return { ok: false, error: 'eval: falta el código (code)' }
      return { ok: true, args: { ...base, code } }
    }
    case 'wait': {
      const text = str(args, 'text')
      const selector = str(args, 'selector')
      const ms = num(args, 'ms')
      if (!text && !selector && ms === undefined) return { ok: false, error: 'wait: falta qué esperar (text, selector o ms)' }
      const timeout = num(args, 'timeout')
      return { ok: true, args: { ...base, text, selector, gone: args.gone === true, ms: ms !== undefined ? Math.max(0, Math.min(ms, WAIT_MAX_MS)) : undefined, timeout: timeout !== undefined ? Math.max(100, Math.min(timeout, WAIT_MAX_MS)) : WAIT_DEFAULT_MS } }
    }
  }
}

export function isPageOp(op: string): op is PageOp {
  return (PAGE_OPS as readonly string[]).includes(op)
}

const isRef = (ref: string): boolean => /^r\d{1,7}$/.test(ref)

/* ---------- dibujo (puro) ---------- */

/** Colores que acepta `draw`; van inline en la página (no son tokens de omni: la página no los tiene). */
export const DRAW_COLORS: Record<string, string> = {
  orange: '#f97316', red: '#ef4444', yellow: '#eab308', green: '#22c55e', blue: '#3b82f6', purple: '#a855f7'
}
export const MAX_SHAPES = 50

/**
 * Forma sobre la página, en px CSS del viewport actual (o pegada a un ref):
 * - `box`: rectángulo (ref, o x y w h), con `label` opcional encima.
 * - `arrow`: de (x, y) a (x2, y2), o de (x, y) al centro de `ref`.
 * - `text`: etiqueta suelta en (x, y).
 * - `dot`: punto numerado en (x, y) o en el centro de `ref`.
 */
export interface Shape {
  kind: 'box' | 'arrow' | 'text' | 'dot'
  ref?: string
  x?: number
  y?: number
  w?: number
  h?: number
  x2?: number
  y2?: number
  label?: string
  color: string
}

type ShapesResult = { ok: true; shapes: Shape[] } | { ok: false; error: string }

/** Pura, exportada para tests. */
export function validateShapes(raw: unknown): ShapesResult {
  if (raw === undefined) return { ok: true, shapes: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'draw: shapes es una lista' }
  if (raw.length > MAX_SHAPES) return { ok: false, error: `draw: máximo ${MAX_SHAPES} formas por llamada` }
  const shapes: Shape[] = []
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: `draw: la forma ${i} no es un objeto` }
    const o = item as Args
    const kind = o.kind
    if (kind !== 'box' && kind !== 'arrow' && kind !== 'text' && kind !== 'dot') return { ok: false, error: `draw: forma ${i}: kind es box, arrow, text o dot` }
    const ref = str(o, 'ref')
    if (ref && !isRef(ref)) return { ok: false, error: `draw: forma ${i}: ref no válido: ${ref}` }
    const n = (k: string): number | undefined => num(o, k)
    const colorName = str(o, 'color') ?? 'orange'
    const color = DRAW_COLORS[colorName]
    if (!color) return { ok: false, error: `draw: forma ${i}: color es ${Object.keys(DRAW_COLORS).join(', ')}` }
    const label = str(o, 'label')
    const shape: Shape = { kind, color }
    if (ref) shape.ref = ref
    if (label) shape.label = label.slice(0, 200)
    for (const k of ['x', 'y', 'w', 'h', 'x2', 'y2'] as const) {
      const v = n(k)
      if (v !== undefined) shape[k] = v
    }
    const has = (...ks: Array<'x' | 'y' | 'w' | 'h' | 'x2' | 'y2'>): boolean => ks.every((k) => shape[k] !== undefined)
    if (kind === 'box' && !ref && !has('x', 'y', 'w', 'h')) return { ok: false, error: `draw: forma ${i}: box necesita ref, o x y w h` }
    if (kind === 'arrow' && !has('x', 'y') ) return { ok: false, error: `draw: forma ${i}: arrow necesita x e y de origen` }
    if (kind === 'arrow' && !ref && !has('x2', 'y2')) return { ok: false, error: `draw: forma ${i}: arrow necesita ref, o x2 e y2 de destino` }
    if (kind === 'text' && (!has('x', 'y') || !label)) return { ok: false, error: `draw: forma ${i}: text necesita x, y y label` }
    if (kind === 'dot' && !ref && !has('x', 'y')) return { ok: false, error: `draw: forma ${i}: dot necesita ref, o x e y` }
    shapes.push(shape)
  }
  return { ok: true, shapes }
}

/* ---------- teclas (puro) ---------- */

/**
 * Un golpe de teclado listo para `Input.dispatchKeyEvent` de CDP: `key` y `code` del DOM, keyCode de
 * Windows (lo que leen los handlers viejos), `text` solo si la tecla escribe algo y `commands` para los
 * atajos de edición de macOS (por CDP ⌘A no selecciona nada si no se pide `selectAll`).
 */
export interface KeyStroke {
  key: string
  code: string
  keyCode: number
  modifiers: Array<'shift' | 'control' | 'alt' | 'meta'>
  text?: string
  commands?: string[]
}

const MODIFIERS: Record<string, KeyStroke['modifiers'][number]> = {
  cmd: 'meta', meta: 'meta', command: 'meta',
  ctrl: 'control', control: 'control',
  alt: 'alt', option: 'alt', opt: 'alt',
  shift: 'shift'
}

/** Teclas con nombre: [key, code, keyCode, texto]. */
const NAMED: Record<string, [string, string, number, string?]> = {
  enter: ['Enter', 'Enter', 13, '\r'], return: ['Enter', 'Enter', 13, '\r'],
  tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27],
  backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], del: ['Delete', 'Delete', 46],
  space: [' ', 'Space', 32, ' '],
  up: ['ArrowUp', 'ArrowUp', 38], arrowup: ['ArrowUp', 'ArrowUp', 38],
  down: ['ArrowDown', 'ArrowDown', 40], arrowdown: ['ArrowDown', 'ArrowDown', 40],
  left: ['ArrowLeft', 'ArrowLeft', 37], arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
  right: ['ArrowRight', 'ArrowRight', 39], arrowright: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
  insert: ['Insert', 'Insert', 45]
}

/** Atajos de edición de macOS → comando del editor de Chromium. */
const EDIT_COMMANDS: Record<string, string> = {
  'meta+a': 'selectAll', 'meta+c': 'copy', 'meta+x': 'cut', 'meta+v': 'paste', 'meta+z': 'undo', 'meta+shift+z': 'redo'
}

/** Símbolos de una tecla física: code del DOM y keyCode de Windows. */
const SYMBOLS: Record<string, [string, number]> = {
  '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220],
  ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192]
}

export type ParsedKeys = { ok: true; strokes: KeyStroke[] } | { ok: false; error: string }

/**
 * `"cmd+a Backspace"` → golpes. Separados por espacio; cada uno es `mod+mod+tecla`. La tecla es un
 * nombre (`Enter`, `Tab`, `Escape`, `ArrowDown`, `F5`…) o un carácter. Pura, exportada para tests.
 */
export function parseKeys(spec: string): ParsedKeys {
  const strokes: KeyStroke[] = []
  const tokens = spec.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { ok: false, error: 'key: sin teclas' }
  if (tokens.length > 50) return { ok: false, error: 'key: máximo 50 golpes por llamada' }
  for (const token of tokens) {
    // `+` sola o al final (`shift++`) es la tecla más.
    const parts = token === '+' ? ['+'] : token.endsWith('++') ? [...token.slice(0, -2).split('+'), '+'] : token.split('+')
    const raw = parts.pop() ?? ''
    const modifiers: KeyStroke['modifiers'] = []
    for (const m of parts) {
      const mod = MODIFIERS[m.toLowerCase()]
      if (!mod) return { ok: false, error: `key: modificador desconocido "${m}" en ${token}` }
      if (!modifiers.includes(mod)) modifiers.push(mod)
    }
    const lower = raw.toLowerCase()
    const shift = modifiers.includes('shift')
    let stroke: KeyStroke
    const named = NAMED[lower]
    const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower)
    if (named) {
      const [key, code, keyCode, text] = named
      stroke = { key, code, keyCode, modifiers, ...(text !== undefined ? { text } : {}) }
    } else if (fn) {
      const n = Number(fn[1])
      stroke = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n, modifiers }
    } else if ([...raw].length === 1) {
      const ch = raw
      const letter = /^[a-z]$/i.test(ch)
      const digit = /^[0-9]$/.test(ch)
      const sym = SYMBOLS[ch]
      const key = letter && shift ? ch.toUpperCase() : letter ? ch.toLowerCase() : ch
      const code = letter ? `Key${ch.toUpperCase()}` : digit ? `Digit${ch}` : (sym?.[0] ?? '')
      const keyCode = letter ? ch.toUpperCase().charCodeAt(0) : digit ? ch.charCodeAt(0) : (sym?.[1] ?? 0)
      stroke = { key, code, keyCode, modifiers, text: key }
    } else {
      return { ok: false, error: `key: tecla desconocida "${raw}" en ${token}` }
    }
    // Con ⌘ o ctrl la tecla es un atajo: no escribe (y los de edición llevan su comando).
    if (modifiers.includes('meta') || modifiers.includes('control')) {
      delete stroke.text
      const combo = [...(modifiers.includes('meta') ? ['meta'] : []), ...(shift ? ['shift'] : []), stroke.key.toLowerCase()].join('+')
      const command = modifiers.includes('control') ? undefined : EDIT_COMMANDS[combo]
      if (command) stroke.commands = [command]
    }
    strokes.push(stroke)
  }
  return { ok: true, strokes }
}

/** Máscara de modificadores de CDP: alt 1, ctrl 2, meta 4, shift 8. */
export function cdpModifiers(mods: KeyStroke['modifiers']): number {
  return (mods.includes('alt') ? 1 : 0) | (mods.includes('control') ? 2 : 0) | (mods.includes('meta') ? 4 : 0) | (mods.includes('shift') ? 8 : 0)
}

/* ---------- scripts del isolated world ---------- */

/**
 * Helpers comunes: refs estables por elemento (WeakMap) guardados en el isolated world, que la página
 * no ve y que se pierden solos al cambiar de documento.
 */
function prelude(): string {
  return `
  const W = window;
  if (!W.__omniRefs) { W.__omniRefs = new Map(); W.__omniRefIds = new WeakMap(); W.__omniNextRef = 1; }
  const refOf = (el) => {
    let id = W.__omniRefIds.get(el);
    if (!id) { id = 'r' + W.__omniNextRef++; W.__omniRefIds.set(el, id); W.__omniRefs.set(id, new WeakRef(el)); }
    return id;
  };
  const byRef = (ref) => { const el = W.__omniRefs.get(ref)?.deref(); return el && el.isConnected ? el : null; };
  const squash = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  /* el ancestro compuesto (atraviesa shadow roots) */
  const parentOf = (n) => n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentElement;
  const within = (inner, outer) => { for (let n = inner; n; n = parentOf(n)) if (n === outer) return true; return false; };
  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  };`
}

/**
 * Lectura de la página. `interactive`: controles (con ref) y títulos; `all`: además el texto;
 * `text`: solo el texto visible (innerText). `ref` limita a ese subárbol; `viewport` a lo que se ve.
 */
export function readScript(opts: { mode: 'interactive' | 'all' | 'text'; ref?: string; viewport: boolean }): string {
  return `(() => {
  ${prelude()}
  const MODE = ${JSON.stringify(opts.mode)};
  const ONLY_VIEW = ${opts.viewport ? 'true' : 'false'};
  const MAX_ITEMS = ${MAX_ITEMS};
  const MAX_TEXT = ${MAX_TEXT_CHARS};
  const root = ${opts.ref ? `byRef(${JSON.stringify(opts.ref)})` : 'document.body || document.documentElement'};
  if (!root) return { error: 'gone' };
  const vw = innerWidth, vh = innerHeight;
  const se = document.scrollingElement || document.documentElement;
  const head = [
    '# ' + cut(squash(document.title) || '(sin título)', 120),
    location.href,
    'viewport ' + vw + '×' + vh + ' · scroll ' + Math.round(se.scrollTop) + '/' + Math.max(0, se.scrollHeight - vh)
  ];
  if (MODE === 'text') {
    const t = (root.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
    return { text: head.join('\\n') + '\\n\\n' + (t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '\\n… (texto recortado: ' + t.length + ' caracteres; usa ref para leer una parte)' : t) };
  }
  const INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', color: 'button', range: 'slider', search: 'searchbox', number: 'spinbutton', hidden: null };
  const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'slider', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'spinbutton', 'treeitem', 'listbox', 'clickable']);
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit && explicit.trim()) { const r = explicit.trim().split(/\\s+/)[0]; if (r !== 'presentation' && r !== 'none' && r !== 'generic') return r; }
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') { const t = (el.getAttribute('type') || 'text').toLowerCase(); return t in INPUT_ROLE ? INPUT_ROLE[t] : 'textbox'; }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'iframe') return 'iframe';
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
    if (el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0)) return 'clickable';
    if (getComputedStyle(el).cursor === 'pointer' && !el.parentElement?.closest('a,button,[role=button],[onclick]') && squash(el.innerText).length > 0 && el.children.length <= 3) return 'clickable';
    return null;
  };
  const nameOf = (el, role) => {
    const aria = el.getAttribute('aria-label');
    if (aria && squash(aria)) return squash(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = squash(by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')); if (t) return t; }
    if (el.labels && el.labels.length) { const t = squash([...el.labels].map((l) => l.innerText).join(' ')); if (t) return t; }
    if (role === 'img') return squash(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (role === 'iframe') return squash(el.getAttribute('title') || el.getAttribute('src') || '');
    if (role !== 'textbox' && role !== 'searchbox' && role !== 'combobox' && role !== 'spinbutton') { const t = squash(el.innerText); if (t) return t; }
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type)) return squash(el.value);
    return squash(el.getAttribute('placeholder') || el.getAttribute('title') || el.querySelector?.('img[alt]')?.getAttribute('alt') || '');
  };
  const shown = (el) => {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };
  const inView = (r) => r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  const flags = (el, role) => {
    const out = [];
    if (role === 'heading') out.push('h' + (el.getAttribute('aria-level') || el.tagName.slice(1)));
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    const checked = el.getAttribute('aria-checked') ?? (role === 'checkbox' || role === 'radio' || role === 'switch' ? String(!!el.checked) : null);
    if (checked === 'true') out.push('checked');
    if (el.getAttribute('aria-expanded') === 'true') out.push('expanded');
    if (el.getAttribute('aria-expanded') === 'false') out.push('collapsed');
    if (el.getAttribute('aria-selected') === 'true' || (el.tagName === 'OPTION' && el.selected)) out.push('selected');
    if (el.required || el.getAttribute('aria-required') === 'true') out.push('required');
    if (document.activeElement === el) out.push('focused');
    if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton') {
      const v = el.isContentEditable ? squash(el.innerText) : el.value;
      if (v) out.push('value=' + JSON.stringify(cut(String(v), 80)));
    }
    if (role === 'combobox' && el.tagName === 'SELECT') { const o = el.selectedOptions?.[0]; if (o) out.push('value=' + JSON.stringify(cut(squash(o.textContent), 60))); }
    if (role === 'link') {
      const href = el.getAttribute('href') || '';
      try { const u = new URL(href, location.href); out.push('href=' + (u.origin === location.origin ? u.pathname + u.search + u.hash : u.href)); } catch { if (href) out.push('href=' + href); }
    }
    return out;
  };
  const lines = [];
  let skipped = 0;
  const emit = (line) => { if (lines.length < MAX_ITEMS) lines.push(line); else skipped++; };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG', 'HEAD', 'META', 'LINK']);
  const walk = (el, insideControl) => {
    if (SKIP.has(el.tagName) || el.hasAttribute('data-omni-draw') || el.hasAttribute('data-omni-hints')) return;
    if (!shown(el) && el.tagName !== 'DETAILS' && getComputedStyle(el).display !== 'contents') return;
    const role = roleOf(el);
    const r = el.getBoundingClientRect();
    const visibleHere = !ONLY_VIEW || inView(r);
    let control = insideControl;
    if (role && !insideControl && visibleHere) {
      if (INTERACTIVE.has(role)) {
        const off = inView(r) ? '' : ' (offscreen)';
        emit('[' + refOf(el) + '] ' + role + ' ' + JSON.stringify(cut(nameOf(el, role), 100)) + flags(el, role).map((f) => ' ' + f).join('') + off);
        control = true;
      } else if (role === 'heading') {
        emit('heading ' + JSON.stringify(cut(squash(el.innerText), 120)) + ' ' + flags(el, role).join(' '));
        control = true;
      } else if (role === 'iframe') {
        emit('[' + refOf(el) + '] iframe ' + JSON.stringify(cut(nameOf(el, role), 100)) + ' (su contenido no se lee)');
      } else if (role === 'img' && MODE === 'all') {
        const name = nameOf(el, role);
        if (name) emit('img ' + JSON.stringify(cut(name, 100)));
      }
    }
    if (MODE === 'all' && !control && visibleHere) {
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      own = squash(own);
      if (own) emit('text ' + JSON.stringify(cut(own, 200)));
    }
    if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c, control);
    for (const c of el.children) walk(c, control);
  };
  walk(root, false);
  if (skipped > 0) lines.push('… ' + skipped + ' elementos más: usa viewport (y scroll) o ref para leer por partes');
  if (lines.length === 0) lines.push(MODE === 'interactive' ? '(sin controles visibles; prueba mode all o text)' : '(sin contenido visible)');
  return { text: head.join('\\n') + '\\n\\n' + lines.join('\\n') };
})()`
}

/**
 * Punto de clic de un ref: lo trae al centro de la vista y devuelve el centro de su parte visible.
 * Si otro elemento lo tapa en ese punto, lo dice en vez de hacer clic a ciegas.
 */
export function pointScript(ref: string): string {
  return `(() => {
  ${prelude()}
  const el = byRef(${JSON.stringify(ref)});
  if (!el) return { error: 'gone' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { error: 'hidden' };
  const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth), top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
  if (right - left < 1 || bottom - top < 1) return { error: 'outside' };
  const x = (left + right) / 2, y = (top + bottom) / 2;
  let hit = document.elementFromPoint(x, y);
  while (hit && hit.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
  const ok = !hit || within(hit, el) || within(el, hit);
  return { x, y, covered: ok ? null : describe(hit) };
})()`
}

/** Enfoca el ref (o el elemento con foco) y, con `clear`, selecciona todo su contenido para reemplazarlo. */
export function focusScript(ref: string | undefined, clear: boolean): string {
  return `(() => {
  ${prelude()}
  const el = ${ref ? `byRef(${JSON.stringify(ref)})` : 'document.activeElement'};
  if (!el) return { error: ${ref ? "'gone'" : "'nofocus'"} };
  if (document.activeElement !== el && el.focus) el.focus();
  if (${clear ? 'true' : 'false'}) {
    if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.select();
    else if (el.isContentEditable) { const s = getSelection(); const range = document.createRange(); range.selectNodeContents(el); s.removeAllRanges(); s.addRange(range); }
  }
  return { focused: describe(el), editable: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable };
})()`
}

/** Desplaza el contenedor con scroll bajo el ref (o la página) y devuelve la posición nueva. */
export function scrollScript(opts: { ref?: string; dx: number; dy: number; intoView: boolean }): string {
  return `(() => {
  ${prelude()}
  const target = ${opts.ref ? `byRef(${JSON.stringify(opts.ref)})` : 'null'};
  ${opts.ref ? "if (!target) return { error: 'gone' };" : ''}
  if (target && ${opts.intoView ? 'true' : 'false'}) { target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); const r = target.getBoundingClientRect(); return { into: describe(target), top: Math.round(r.top) }; }
  const scrollable = (el) => { const cs = getComputedStyle(el); return (/(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) || (/(auto|scroll|overlay)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth); };
  let box = null;
  for (let n = target; n && n !== document.body && n !== document.documentElement; n = parentOf(n)) if (scrollable(n)) { box = n; break; }
  if (!box) {
    /* sin ref: si la página no se desplaza, el contenedor grande bajo el centro de la vista (apps con layout fijo) */
    const se = document.scrollingElement || document.documentElement;
    box = se;
    if (!target && se.scrollHeight <= innerHeight + 1 && ${opts.dy} !== 0) {
      for (let n = document.elementFromPoint(innerWidth / 2, innerHeight / 2); n && n !== document.documentElement; n = parentOf(n)) if (scrollable(n)) { box = n; break; }
    }
  }
  const beforeTop = box.scrollTop, beforeLeft = box.scrollLeft;
  box.scrollBy({ left: ${opts.dx}, top: ${opts.dy}, behavior: 'instant' });
  return { box: box === (document.scrollingElement || document.documentElement) ? 'page' : describe(box), top: Math.round(box.scrollTop), left: Math.round(box.scrollLeft), max: Math.max(0, box.scrollHeight - box.clientHeight), moved: box.scrollTop !== beforeTop || box.scrollLeft !== beforeLeft };
})()`
}

/**
 * Dibuja (o borra, con `clear`) las formas en una capa propia `<div data-omni-draw>` encima de la
 * página, sin capturar el ratón. Las coordenadas del viewport se pasan a coordenadas de documento, así
 * las marcas se quedan sobre lo que señalan al desplazarse. Se van solas al cambiar de página.
 */
export function drawScript(shapes: Shape[], clear: boolean): string {
  return `(() => {
  ${prelude()}
  const ATTR = 'data-omni-draw';
  let layer = document.querySelector('[' + ATTR + ']');
  if (${clear ? 'true' : 'false'} && layer) { layer.remove(); layer = null; }
  const shapes = ${JSON.stringify(shapes)};
  if (shapes.length === 0) return { drawn: 0, total: 0 };
  if (!layer) {
    layer = document.createElement('div');
    layer.setAttribute(ATTR, '');
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483646;pointer-events:none;';
    document.documentElement.appendChild(layer);
  }
  const sx = scrollX, sy = scrollY;
  const FONT = '600 12px/16px -apple-system,BlinkMacSystemFont,"Inter",sans-serif';
  const missing = [];
  const rectOf = (ref) => { const el = byRef(ref); if (!el) { missing.push(ref); return null; } const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const tag = (text, color, x, y) => {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:absolute;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis;padding:2px 6px;border-radius:4px;color:#0a0a0a;font:' + FONT + ';background:' + color + ';left:' + (x + sx) + 'px;top:' + (y + sy) + 'px;';
    layer.appendChild(t);
  };
  const svgNS = 'http://www.w3.org/2000/svg';
  let drawn = 0;
  for (const s of shapes) {
    const r = s.ref ? rectOf(s.ref) : null;
    if (s.ref && !r) continue;
    if (s.kind === 'box') {
      const b = r || { x: s.x, y: s.y, w: s.w, h: s.h };
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;box-sizing:border-box;border:2px solid ' + s.color + ';border-radius:4px;background:' + s.color + '1a;left:' + (b.x - 3 + sx) + 'px;top:' + (b.y - 3 + sy) + 'px;width:' + (b.w + 6) + 'px;height:' + (b.h + 6) + 'px;';
      layer.appendChild(d);
      if (s.label) tag(s.label, s.color, b.x - 3, b.y - 3 >= 22 ? b.y - 25 : b.y + b.h + 6);
    } else if (s.kind === 'arrow') {
      /* hacia un ref: la punta se queda a 6px del borde de su caja, no encima del centro */
      let x2 = r ? r.x + r.w / 2 : s.x2, y2 = r ? r.y + r.h / 2 : s.y2;
      if (r) {
        const dx = x2 - s.x, dy = y2 - s.y;
        const hx = r.w / 2 + 6, hy = r.h / 2 + 6;
        const k = Math.max(Math.abs(dx) / hx, Math.abs(dy) / hy);
        if (k > 1) { x2 -= dx / k; y2 -= dy / k; }
      }
      const minX = Math.min(s.x, x2) - 12, minY = Math.min(s.y, y2) - 12;
      const w = Math.abs(x2 - s.x) + 24, h = Math.abs(y2 - s.y) + 24;
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('width', w); svg.setAttribute('height', h);
      svg.style.cssText = 'position:absolute;overflow:visible;left:' + (minX + sx) + 'px;top:' + (minY + sy) + 'px;';
      const ax = s.x - minX, ay = s.y - minY, bx = x2 - minX, by = y2 - minY;
      const ang = Math.atan2(by - ay, bx - ax), head = 12;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', ax); line.setAttribute('y1', ay);
      line.setAttribute('x2', bx - Math.cos(ang) * 4); line.setAttribute('y2', by - Math.sin(ang) * 4);
      line.setAttribute('stroke', s.color); line.setAttribute('stroke-width', '3'); line.setAttribute('stroke-linecap', 'round');
      const tip = document.createElementNS(svgNS, 'polygon');
      const p = (a) => (bx - head * Math.cos(ang + a)) + ',' + (by - head * Math.sin(ang + a));
      tip.setAttribute('points', bx + ',' + by + ' ' + p(0.45) + ' ' + p(-0.45));
      tip.setAttribute('fill', s.color);
      svg.appendChild(line); svg.appendChild(tip);
      layer.appendChild(svg);
      if (s.label) tag(s.label, s.color, s.x + 6, s.y - 22);
    } else if (s.kind === 'text') {
      tag(s.label, s.color, s.x, s.y);
    } else if (s.kind === 'dot') {
      const cx = r ? r.x + r.w / 2 : s.x, cy = r ? r.y + r.h / 2 : s.y;
      const d = document.createElement('div');
      d.textContent = s.label || '';
      d.style.cssText = 'position:absolute;box-sizing:border-box;min-width:22px;height:22px;padding:0 6px;border-radius:11px;display:flex;align-items:center;justify-content:center;color:#0a0a0a;font:' + FONT + ';background:' + s.color + ';box-shadow:0 0 0 2px #fff;left:' + (cx - 11 + sx) + 'px;top:' + (cy - 11 + sy) + 'px;';
      layer.appendChild(d);
    }
    drawn++;
  }
  return { drawn, total: layer.childElementCount, missing };
})()`
}

/** ¿Se cumple la espera? Texto en `innerText` o selector visible; con `gone`, que ya no estén. */
export function waitScript(opts: { text?: string; selector?: string; gone: boolean }): string {
  return `(() => {
  const text = ${JSON.stringify(opts.text ?? null)}, selector = ${JSON.stringify(opts.selector ?? null)};
  let found = false;
  if (text !== null) found = (document.body?.innerText || '').includes(text);
  if (!found && selector !== null) {
    try { const el = document.querySelector(selector); found = !!el && (!el.checkVisibility || el.checkVisibility()); } catch { return { error: 'selector' }; }
  }
  return { done: ${opts.gone ? '!found' : 'found'} };
})()`
}

/* ---------- el agente ---------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Operaciones que necesitan la página con layout: una vista que nunca estuvo en pantalla mide 0×0 (nada
 * es visible ni clicable). Antes de ellas el pane se pone en pantalla, sin mover el teclado.
 */
const NEEDS_SCREEN: ReadonlySet<PageOp> = new Set(['read', 'click', 'type', 'key', 'scroll', 'screenshot', 'draw'])

const GONE = 'ese ref ya no existe (la página cambió): vuelve a leerla con read_page'

/** Resultado de un script del isolated world, como objeto. */
type ScriptResult = Record<string, unknown>

export class BrowserAgent {
  constructor(private readonly host: AgentHost) {}

  /** Corre una operación ya validada. `from` es quien la pidió (`mcp:<agente>`), para el aviso. */
  async run(op: PageOp, args: Args, from: string): Promise<unknown> {
    if (op === 'tabs') return this.tabs()
    if (op === 'navigate') return this.navigate(args, from)
    const id = this.target(args.sessionId)
    this.host.keepAwake(id)
    if (NEEDS_SCREEN.has(op)) await this.ensureShown(id, from)
    const result = await this.dispatch(op, id, args, from)
    this.host.notice(id, from)
    return result
  }

  private dispatch(op: Exclude<PageOp, 'tabs' | 'navigate'>, id: string, a: Args, from: string): Promise<unknown> {
    switch (op) {
      case 'read':
        return this.read(id, a)
      case 'click':
        return this.click(id, a)
      case 'type':
        return this.type(id, a)
      case 'key':
        return this.key(id, a)
      case 'scroll':
        return this.scroll(id, a)
      case 'screenshot':
        return this.screenshot(id)
      case 'draw':
        return this.draw(id, a)
      case 'console':
        return Promise.resolve(this.console(id, a))
      case 'eval':
        return this.evaluate(id, a)
      case 'wait':
        return this.wait(id, a)
    }
  }

  /* ---- destino ---- */

  /** Navegadores con su estado; `target` marca el que se usa sin `sessionId`. */
  tabs(): unknown {
    const fallback = this.fallback()
    return this.host.list().map((s) => {
      const st = this.host.state(s.id)
      return { sessionId: s.id, url: st.url, title: st.title, loading: st.loading, onScreen: this.host.bounds(s.id) !== null, target: s.id === fallback }
    })
  }

  /** Id pedido (exacto o prefijo único de 4+), o el navegador por defecto. */
  private target(raw: unknown): string {
    const ids = this.host.list().map((s) => s.id)
    if (typeof raw === 'string' && raw !== '') {
      if (ids.includes(raw)) return raw
      const matches = raw.length >= 4 ? ids.filter((i) => i.startsWith(raw)) : []
      if (matches.length === 1) return matches[0] as string
      if (matches.length > 1) throw new Error(`varios navegadores empiezan por ${raw}: ${matches.join(', ')}`)
      throw new Error(`no hay navegador ${raw} en omni (mira tabs)`)
    }
    const id = this.fallback()
    if (!id) throw new Error('no hay ningún navegador abierto en omni: usa navigate con una url para abrir uno')
    return id
  }

  /** El último que estuvo en pantalla; si no, uno visible; si no, el más nuevo. */
  private fallback(): string | null {
    const list = this.host.list()
    const last = this.host.lastShown()
    if (last && list.some((s) => s.id === last)) return last
    const visible = list.find((s) => this.host.bounds(s.id) !== null)
    if (visible) return visible.id
    const newest = [...list].sort((a, b) => b.createdAt - a.createdAt)[0]
    return newest?.id ?? null
  }

  private wc(id: string): WebContents {
    const wc = this.host.webContents(id)
    if (!wc) throw new Error(`el navegador ${id.slice(0, 8)} ya no existe`)
    return wc
  }

  private async script(id: string, code: string): Promise<ScriptResult> {
    const result: unknown = await this.wc(id).executeJavaScriptInIsolatedWorld(OMNI_WORLD, [{ code }])
    if (!result || typeof result !== 'object') throw new Error('la página no respondió al script de omni')
    return result as ScriptResult
  }

  /* ---- navegar ---- */

  private async navigate(a: Args, from: string): Promise<unknown> {
    const url = a.url as string
    const keyword = url.toLowerCase()
    let id: string
    if (a.newTab === true || (this.host.list().length === 0 && !['back', 'forward', 'reload'].includes(keyword))) {
      id = await this.host.open(url, from)
      this.host.keepAwake(id)
    } else {
      id = this.target(a.sessionId)
      this.host.keepAwake(id)
      if (keyword === 'back') this.host.back(id)
      else if (keyword === 'forward') this.host.forward(id)
      else if (keyword === 'reload') this.host.reload(id)
      else this.host.navigate(id, url)
    }
    await this.settle(id, LOAD_TIMEOUT_MS)
    this.host.notice(id, from)
    const st = this.host.state(id)
    return { sessionId: id, url: st.url, title: st.title, loading: st.loading }
  }

  /** Pone el pane en pantalla si está oculto y espera a que tenga sitio (lo dice `setBounds`). */
  private async ensureShown(id: string, from: string): Promise<void> {
    if (this.host.bounds(id) !== null) return
    await this.host.show(id, from)
    for (let i = 0; i < 40 && this.host.bounds(id) === null; i++) await sleep(50)
    if (this.host.bounds(id) === null) throw new Error('el navegador no se pudo poner en pantalla (¿hay un diálogo abierto en omni?)')
    // Un frame para que la página haga layout con el tamaño nuevo.
    await sleep(120)
  }

  /** Espera a que la vista termine de cargar (también si la carga aún no empezó). */
  private async settle(id: string, timeoutMs: number): Promise<void> {
    const end = Date.now() + timeoutMs
    await sleep(120)
    while (Date.now() < end) {
      const wc = this.host.webContents(id)
      if (!wc || !wc.isLoading()) return
      await sleep(100)
    }
  }

  /* ---- leer ---- */

  private async read(id: string, a: Args): Promise<string> {
    const mode = a.mode as 'interactive' | 'all' | 'text'
    const ref = typeof a.ref === 'string' ? a.ref : undefined
    const r = await this.script(id, readScript({ mode, ref, viewport: a.viewport === true }))
    if (r.error === 'gone') throw new Error(GONE)
    return typeof r.text === 'string' ? r.text : ''
  }

  /* ---- input por CDP ---- */

  /**
   * Comando de Chrome DevTools Protocol sobre la vista (`webContents.debugger`, como Claude in Chrome):
   * el input llega a la página aunque la ventana de omni esté en segundo plano o el teclado esté en
   * otro pane. Se engancha la primera vez; `keepAwake` lo suelta cuando el agente deja de usarla.
   */
  private async cdp(id: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const dbg = this.wc(id).debugger
    if (!dbg.isAttached()) {
      try {
        dbg.attach('1.3')
      } catch (e) {
        throw new Error(`no se pudo controlar la página: ${e instanceof Error ? e.message : String(e)}`)
      }
      // Chromium descarta el input de CDP si la página no tiene el foco, y el foco suele estar en la
      // terminal de omni donde corre el agente: se emula (como hace el harness e2e con el renderer).
      await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
    }
    return dbg.sendCommand(method, params)
  }

  /* ---- ratón ---- */

  private async click(id: string, a: Args): Promise<unknown> {
    let x: number
    let y: number
    let on = 'punto'
    if (typeof a.ref === 'string') {
      const p = await this.stablePoint(id, a.ref)
      if (p.error === 'gone') throw new Error(GONE)
      if (p.error) throw new Error(`no se puede hacer clic en ${a.ref}: no está visible`)
      if (typeof p.covered === 'string') throw new Error(`${a.ref} está tapado por ${p.covered}: ciérralo o desplázate antes de hacer clic`)
      x = p.x as number
      y = p.y as number
      on = a.ref
    } else {
      x = a.x as number
      y = a.y as number
    }
    // CDP trabaja en px CSS del viewport: las mismas coordenadas que devuelve la página y la captura.
    const button = a.button as 'left' | 'right' | 'middle'
    const clicks = a.double === true ? 2 : 1
    const via = await this.host.withAgentInput(id, () => this.deliverClick(id, x, y, button, clicks, typeof a.ref === 'string' ? a.ref : undefined))
    await this.settleIfNavigating(id)
    return { clicked: on, x: Math.round(x), y: Math.round(y), via, url: this.host.state(id).url }
  }

  /**
   * Entrega el clic por CDP y comprueba que la página lo recibió (un `mousedown` en el isolated world).
   * Si Chromium lo descartó se reintenta una vez y, con ref, como último recurso `el.click()` (sin
   * coordenadas, pero llega). Nunca `sendInputEvent`: sin foco en la vista, macOS lo puede entregar al
   * renderer de omni y una tecla suelta dispararía sus atajos.
   */
  private async deliverClick(id: string, x: number, y: number, button: 'left' | 'right' | 'middle', clicks: number, ref?: string): Promise<'cdp' | 'dom'> {
    const arm = (): Promise<ScriptResult> => this.script(id, `(() => { window.__omniHit = false; addEventListener('mousedown', () => { window.__omniHit = true; }, { capture: true, once: true }); return {}; })()`)
    const hit = async (): Promise<boolean> => {
      for (let i = 0; i < 4; i++) {
        const r = await this.script(id, '({ hit: window.__omniHit === true })').catch(() => ({ hit: true }) as ScriptResult)
        if (r.hit === true) return true
        await sleep(40)
      }
      return false
    }
    await this.painted(id)
    const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4
    const viaCdp = async (): Promise<void> => {
      await this.cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      for (let n = 1; n <= clicks; n++) {
        await this.cdp(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: n })
        await this.cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: n })
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await arm()
      await viaCdp()
      if (await hit()) return 'cdp'
      await sleep(150)
    }
    if (!ref || button !== 'left') throw new Error('la página no recibió el clic: prueba con screenshot y click por coordenadas, o reintenta')
    const r = await this.script(id, `(() => { ${'const el = window.__omniRefs?.get(' + JSON.stringify(ref) + ')?.deref();'} if (!el) return { error: 'gone' }; el.focus?.(); el.click(); ${clicks === 2 ? "el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));" : ''} return {}; })()`)
    if (r.error === 'gone') throw new Error(GONE)
    return 'dom'
  }

  /**
   * Espera a que la página componga un frame (dos `requestAnimationFrame`, tope 1 s): justo después de
   * crear o mostrar la vista, Chromium descarta el input hasta tener el primer frame.
   */
  private async painted(id: string): Promise<void> {
    await this.script(id, `new Promise((r) => { const t = setTimeout(() => r({ raf: false }), 1000); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r({ raf: true }); })); })`).catch(() => undefined)
  }

  /**
   * Punto de clic de un ref cuando deja de moverse: una página que todavía mete contenido (banners,
   * carga diferida) desplaza el elemento entre la medida y el clic. Hasta 6 lecturas a 50 ms.
   */
  private async stablePoint(id: string, ref: string): Promise<ScriptResult> {
    let last = await this.script(id, pointScript(ref))
    for (let i = 0; i < 6 && !last.error; i++) {
      await sleep(50)
      const next = await this.script(id, pointScript(ref))
      if (next.error || (next.x === last.x && next.y === last.y)) return next
      last = next
    }
    return last
  }

  /** Un clic o una tecla pueden disparar una navegación: se espera si empezó una. */
  private async settleIfNavigating(id: string): Promise<void> {
    await sleep(150)
    if (this.host.webContents(id)?.isLoading()) await this.settle(id, LOAD_TIMEOUT_MS)
  }

  /* ---- teclado ---- */

  private async type(id: string, a: Args): Promise<unknown> {
    const ref = typeof a.ref === 'string' ? a.ref : undefined
    if (ref) await this.click(id, { ref, button: 'left' })
    const f = await this.script(id, focusScript(ref, a.clear === true))
    if (f.error === 'gone') throw new Error(GONE)
    if (f.error === 'nofocus') throw new Error('no hay ningún campo con foco: pasa ref o haz clic antes')
    const text = a.text as string
    await this.host.withAgentInput(id, async () => {
      if (text === '') await this.strokes(id, 'Backspace')
      else await this.cdp(id, 'Input.insertText', { text })
    })
    return { typed: text.length, into: f.focused, cleared: a.clear === true }
  }

  private async key(id: string, a: Args): Promise<unknown> {
    await this.host.withAgentInput(id, () => this.strokes(id, a.keys as string))
    await this.settleIfNavigating(id)
    return { pressed: a.keys, url: this.host.state(id).url }
  }

  /**
   * Manda los golpes de `spec` por CDP (keyDown con texto si escribe, y keyUp) y comprueba que llegó el
   * primer `keydown`. No se repiten por otra vía: una tecla en el sitio equivocado es peor que un error.
   */
  private async strokes(id: string, spec: string): Promise<void> {
    const parsed = parseKeys(spec)
    if (!parsed.ok) throw new Error(parsed.error)
    await this.painted(id)
    await this.script(id, `(() => { window.__omniKey = false; addEventListener('keydown', () => { window.__omniKey = true; }, { capture: true, once: true }); return {}; })()`)
    for (const s of parsed.strokes) {
      const common = { key: s.key, code: s.code, windowsVirtualKeyCode: s.keyCode, nativeVirtualKeyCode: s.keyCode, modifiers: cdpModifiers(s.modifiers) }
      await this.cdp(id, 'Input.dispatchKeyEvent', { type: s.text !== undefined ? 'keyDown' : 'rawKeyDown', ...common, ...(s.text !== undefined ? { text: s.text, unmodifiedText: s.text } : {}), ...(s.commands ? { commands: s.commands } : {}) })
      await this.cdp(id, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    }
    // Una tecla que navega (Enter en un formulario) se lleva el isolated world: eso cuenta como recibida.
    const got = await this.script(id, '({ hit: window.__omniKey === true })').catch(() => ({ hit: true }) as ScriptResult)
    if (got.hit !== true && !this.host.webContents(id)?.isLoading()) throw new Error('la página no recibió las teclas: ¿está tapada por un diálogo de omni? Reintenta')
  }

  private async scroll(id: string, a: Args): Promise<unknown> {
    const ref = typeof a.ref === 'string' ? a.ref : undefined
    const direction = a.direction as 'up' | 'down' | 'left' | 'right'
    // Sin cantidad y con ref: traer el ref a la vista. Sin cantidad ni ref: casi una pantalla.
    const intoView = ref !== undefined && a.amount === undefined
    const bounds = this.host.bounds(id)
    const amount = typeof a.amount === 'number' ? a.amount : Math.round((bounds?.height ?? 800) * 0.8)
    const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0
    const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0
    const r = await this.script(id, scrollScript({ ref, dx, dy, intoView }))
    if (r.error === 'gone') throw new Error(GONE)
    return r
  }

  /* ---- captura ---- */

  /**
   * JPEG de lo que se ve, al ancho en px CSS de la vista (tope `SHOT_MAX_WIDTH`): así una coordenada
   * de la imagen es la misma que pide `click { x, y }`. Una vista oculta se pone en pantalla antes.
   */
  private async screenshot(id: string): Promise<PageImage> {
    const image = await this.host.captureImage(id)
    const css = (await this.script(id, '({ w: innerWidth, h: innerHeight })')) as { w?: number; h?: number }
    const cssWidth = typeof css.w === 'number' && css.w > 0 ? css.w : image.getSize().width
    const width = Math.min(cssWidth, SHOT_MAX_WIDTH)
    const resized = image.getSize().width === width ? image : image.resize({ width, quality: 'good' })
    const size = resized.getSize()
    const scale = width / cssWidth
    return {
      image: { data: resized.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' },
      width: size.width,
      height: size.height,
      url: this.host.state(id).url + (scale < 1 ? ` (imagen a ${Math.round(scale * 100)} %: multiplica x e y por ${(1 / scale).toFixed(3)} para click)` : '')
    }
  }

  /* ---- dibujo ---- */

  private async draw(id: string, a: Args): Promise<unknown> {
    const r = await this.script(id, drawScript(a.shapes as Shape[], a.clear === true))
    const missing = Array.isArray(r.missing) ? (r.missing as string[]) : []
    if (missing.length > 0 && r.drawn === 0) throw new Error(`${missing.join(', ')}: ${GONE}`)
    return { drawn: r.drawn, onPage: r.total, ...(missing.length > 0 ? { missing } : {}) }
  }

  /* ---- consola y JS ---- */

  private console(id: string, a: Args): unknown {
    const pattern = typeof a.pattern === 'string' ? new RegExp(a.pattern, 'i') : null
    const all = this.host.consoleTail(id, 200)
    const lines = (pattern ? all.filter((l) => pattern.test(l)) : all).slice(-(a.lines as number))
    return lines.length > 0 ? lines.join('\n') : pattern ? `(nada en la consola coincide con ${a.pattern as string})` : '(consola vacía)'
  }

  /** Evalúa en el mundo de la página (ve sus variables); la última expresión es el resultado. */
  private async evaluate(id: string, a: Args): Promise<string> {
    let value: unknown
    try {
      // Una promesa que no resuelve nunca no puede dejar colgado al agente.
      value = await Promise.race([
        // El `try` envuelve sin cambiar el valor de la última expresión y deja ver el mensaje real del error
        // (Electron solo dice "Script failed to execute").
        this.wc(id).executeJavaScript(`try {\n${a.code as string}\n} catch (e) { ({ __omniError: (e && e.stack) || String(e) }) }`, true),
        sleep(EVAL_TIMEOUT_MS).then(() => {
          throw new Error(`no terminó en ${EVAL_TIMEOUT_MS / 1000} s`)
        })
      ])
    } catch (e) {
      throw new Error(`eval: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (value && typeof value === 'object' && typeof (value as { __omniError?: unknown }).__omniError === 'string') {
      throw new Error(`eval: ${(value as { __omniError: string }).__omniError.split('\n').slice(0, 4).join('\n')}`)
    }
    let out: string
    if (value === undefined) out = 'undefined'
    else if (typeof value === 'string') out = value
    else {
      try {
        out = JSON.stringify(value, null, 2) ?? String(value)
      } catch {
        out = String(value)
      }
    }
    return out.length > MAX_EVAL_CHARS ? out.slice(0, MAX_EVAL_CHARS) + `\n… (recortado: ${out.length} caracteres)` : out
  }

  /* ---- esperar ---- */

  private async wait(id: string, a: Args): Promise<unknown> {
    if (typeof a.ms === 'number' && a.text === undefined && a.selector === undefined) {
      await sleep(a.ms)
      return { waited: a.ms }
    }
    const started = Date.now()
    const end = started + (a.timeout as number)
    const code = waitScript({ text: a.text as string | undefined, selector: a.selector as string | undefined, gone: a.gone === true })
    while (Date.now() < end) {
      // Durante una navegación el isolated world se recrea: un fallo suelto no corta la espera.
      const r = await this.script(id, code).catch(() => ({}) as ScriptResult)
      if (r.error === 'selector') throw new Error(`wait: selector no válido: ${a.selector as string}`)
      if (r.done === true) return { done: true, after: Date.now() - started }
      await sleep(200)
    }
    const t = a.timeout as number
    throw new Error(`wait: no se cumplió en ${t < 1000 ? `${t} ms` : `${Math.round(t / 1000)} s`}`)
  }
}
