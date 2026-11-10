/**
 * Representación canónica de una tecla: modificadores en orden fijo
 * (ctrl, alt, shift, cmd) + tecla en minúscula. Ej: `cmd+t`, `ctrl+a`, `shift+enter`, `j`.
 * Los símbolos imprimibles (`%`, `|`, `?`) van sin `shift`: el carácter ya lo codifica y
 * así el chord no depende del layout del teclado (en latinoamericano `|` no lleva shift).
 */
import type { ForwardedKey } from '@shared/types'

export type Chord = string

const KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  // ⌥Space en macOS entrega un espacio duro (U+00A0): es la misma tecla (dictado, §3.22).
  ' ': 'space',
  Escape: 'escape',
  Enter: 'enter',
  Tab: 'tab',
  Backspace: 'backspace',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
}

const MODIFIERS = ['ctrl', 'alt', 'shift', 'cmd'] as const
const MOD_NAMES = new Set(['control', 'alt', 'shift', 'meta'])

/** Lo mínimo de una tecla para armar su chord: lo tienen el KeyboardEvent del DOM y la tecla reenviada por main. */
interface KeyLike {
  key: string
  code: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

function chordFrom(k: KeyLike): Chord {
  let key = KEY_ALIASES[k.key] ?? k.key.toLowerCase()
  // Con ⌥ apretado macOS entrega el carácter alterno (⌥T → `†`): se usa la tecla física.
  if (k.alt && /^(Key|Digit)/.test(k.code)) key = k.code.slice(-1).toLowerCase()
  const printableSymbol = key.length === 1 && !/[a-z0-9]/.test(key)
  const parts: string[] = []
  if (k.ctrl) parts.push('ctrl')
  if (k.alt) parts.push('alt')
  if (k.shift && !printableSymbol) parts.push('shift')
  if (k.meta) parts.push('cmd')
  if (!MOD_NAMES.has(key)) parts.push(key)
  return parts.join('+')
}

export function chordOf(e: KeyboardEvent): Chord {
  return chordFrom({ key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey })
}

/**
 * Chord de una tecla que la página embebida recibió y main reenvió (`browser:key`). Misma forma
 * canónica que `chordOf`, así el keymap la resuelve igual que si hubiera caído en el renderer.
 */
export function chordFromForwarded(k: ForwardedKey): Chord {
  return chordFrom(k)
}

/**
 * Modificadores y tecla de un chord. `+` es separador y también puede ser la tecla (`cmd++`, `+`):
 * un `split('+')` ingenuo la perdía y `⌘+` no se mostraba ni se podía resolver.
 */
export function splitChord(chord: Chord): { mods: string[]; key: string } {
  if (chord === '+') return { mods: [], key: '+' }
  if (chord.endsWith('++')) return { mods: chord.slice(0, -2).split('+').filter((p) => p !== ''), key: '+' }
  const parts = chord.split('+')
  const key = parts.pop() ?? ''
  return { mods: parts, key }
}

/** Lleva un chord escrito a mano (`cmd+shift+d`) a la forma canónica (`shift+cmd+d`). */
export function normalizeChord(chord: string): Chord {
  const { mods, key } = splitChord(chord.toLowerCase())
  return [...MODIFIERS.filter((m) => mods.includes(m)), key].join('+')
}

export function isModifierOnly(chord: Chord): boolean {
  const { key } = splitChord(chord)
  return key === '' || (MODIFIERS as readonly string[]).includes(key)
}

const PRETTY: Record<string, string> = {
  cmd: '⌘',
  alt: '⌥',
  shift: '⇧',
  ctrl: '⌃',
  enter: '⏎',
  escape: 'Esc',
  tab: 'Tab',
  space: '␣',
  backspace: '⌫',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→'
}

/**
 * Chord legible para hints: `shift+cmd+d` → `⇧⌘D`. Un chord de solo ctrl/alt + tecla se escribe
 * como en tmux (`C-a`, `M-x`). Con `prefix`, la tecla va detrás de la etiqueta del prefijo:
 * `prettyChord('x', 'ctrl+a')` → `C-a x`.
 */
export function prettyChord(chord: Chord, prefix?: Chord): string {
  return prefix ? `${prefixLabel(prefix)} ${format(chord, true)}` : format(chord, false)
}

/** Tecla con la caja exacta (`h` ≠ `H`), para las capas donde una letra suelta es un atajo. */
export function prettyKey(chord: Chord): string {
  return format(chord, true)
}

function format(chord: Chord, exact: boolean): string {
  const { mods: parts, key } = splitChord(normalizeChord(chord))
  if (parts.length === 1 && key.length === 1 && (parts[0] === 'ctrl' || parts[0] === 'alt')) {
    return `${parts[0] === 'ctrl' ? 'C' : 'M'}-${key}`
  }
  const mods = parts.map((p) => PRETTY[p] ?? p).join('')
  // Con ⌘ la letra va en mayúscula como en los menús de macOS; tras el prefijo la caja importa.
  const letter = key.length === 1 && !exact ? key.toUpperCase() : key
  return `${mods}${PRETTY[key] ?? letter}`
}

/** Etiqueta del prefijo configurado (`ctrl+a` → `C-a`). */
export function prefixLabel(prefix: Chord): string {
  return prettyChord(prefix)
}
