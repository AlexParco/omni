import type { Settings } from '@shared/types'
import { normalizeChord, splitChord, type Chord } from '@/core/keys/chord'
import { keymap, Keymap, type Layer } from '@/core/keys/keymap'

/**
 * Tabla única de atajos por defecto. Capa `global` = ⌘, `list` = teclas sueltas en listas,
 * `terminal` = tecla posterior al prefijo (tabla de tmux, con hjkl además de flechas).
 * El usuario la sobreescribe por pareja (capa, comando) desde `⌘,` (`settings.keys`).
 */
export interface Binding {
  layer: Layer
  chord: Chord
  command: string
}

/** Marca para el chord que depende del prefijo configurado (`terminal.sendPrefix`). */
export const PREFIX_CHORD = '$prefix'

const b = (layer: Layer, chord: Chord, command: string): Binding => ({ layer, chord, command })

export const DEFAULT_BINDINGS: readonly Binding[] = [
  /* ---- global (⌘) ---- */
  b('global', 'cmd+t', 'launcher.open'),
  b('global', 'cmd+alt+t', 'session.new.claude'),
  b('global', 'cmd+k', 'quickopen.open'),
  b('global', 'cmd+shift+p', 'palette.open'),
  b('global', 'cmd+/', 'help.keys'),
  b('global', 'cmd+,', 'settings.open'),
  b('global', 'cmd+o', 'project.open'),
  b('global', 'cmd+shift+h', 'project.showHidden'),
  b('global', 'cmd+b', 'sidebar.toggle'),
  b('global', 'cmd+w', 'pane.close'),
  b('global', 'cmd+]', 'pane.next'),
  b('global', 'cmd+[', 'pane.prev'),
  b('global', 'cmd+}', 'tab.next'),
  b('global', 'cmd+{', 'tab.prev'),
  b('global', 'cmd+shift+enter', 'pane.zoom'),
  /* vistas: ⌘1 flota, ⌘3 Worktrees, ⌘4 Broadcast; los tabs pasan a ⌥⌘N (tras el prefijo siguen en 1–9) */
  b('global', 'cmd+1', 'fleet.open'),
  b('global', 'cmd+3', 'worktrees.open'),
  b('global', 'cmd+4', 'broadcast.open'),
  ...Array.from({ length: 9 }, (_, i) => b('global', `alt+cmd+${i + 1}`, `tab.go.${i + 1}`)),
  /* tareas (ARCHITECTURE §3.12) */
  b('global', 'cmd+shift+t', 'todo.toggle'),
  /* puertos (ARCHITECTURE §3.24): ⌥⌘P, P de puertos (⌘P suelto queda libre) */
  b('global', 'cmd+alt+p', 'ports.toggle'),
  /* uso por agente (ARCHITECTURE §3.25): ⌥⌘U, U de uso */
  b('global', 'cmd+alt+u', 'usage.toggle'),
  /* revisión (ARCHITECTURE §3.16): ⌘D abre el diff del worktree bajo el cursor o del pane con foco */
  b('global', 'cmd+d', 'review.open'),
  /* dictado (ARCHITECTURE §3.22): mantener ⌥Space graba y soltar envía; con ⇧ se elige el destino al soltar */
  b('global', 'alt+space', 'voice.dictate'),
  b('global', 'alt+shift+space', 'voice.dictateChoose'),
  /* navegador: ⌘ como en un navegador de verdad, con ⇧ o ⌥ donde ⌘ solo ya está tomado */
  b('global', 'cmd+shift+b', 'session.new.browser'),
  b('global', 'cmd+l', 'browser.focusUrl'),
  b('global', 'cmd+r', 'browser.reload'),
  b('global', 'cmd+alt+left', 'browser.back'),
  b('global', 'cmd+alt+right', 'browser.forward'),
  b('global', 'cmd+shift+m', 'browser.mobile'),
  b('global', 'cmd+shift+s', 'browser.capture'),
  b('global', 'cmd+alt+i', 'browser.devtools'),
  /* vista previa (ARCHITECTURE §3.20): ⌘⇧V alterna editor ↔ preview (⌘⇧P ya es la paleta); ⌥⌘[ vuelve en el historial (⌘[ es pane.prev) */
  b('global', 'cmd+shift+v', 'preview.toggle'),
  b('global', 'cmd+alt+[', 'preview.back'),
  b('global', 'cmd+=', 'preview.zoomIn'),
  b('global', 'cmd++', 'preview.zoomIn'),
  b('global', 'cmd+-', 'preview.zoomOut'),
  b('global', 'cmd+0', 'preview.zoomReset'),
  /* editor (ARCHITECTURE §3.19): ⌘S guarda, ⌘E árbol lateral, ⌥⌘A manda archivo y hunks al agente; ⌘D es `review.open` */
  b('global', 'cmd+s', 'editor.save'),
  b('global', 'cmd+e', 'editor.tree.toggle'),
  b('global', 'cmd+alt+a', 'editor.sendContext'),
  b('global', 'cmd+shift+d', 'editor.changesOnly'),
  /* servidor de lenguaje (ARCHITECTURE §3.19b), como en VS Code; en NORMAL también `gd` y `gr` (vim) */
  b('global', 'f12', 'editor.definition'),
  b('global', 'shift+f12', 'editor.references'),
  b('global', 'f2', 'editor.rename'),

  /* ---- lista ---- */
  b('list', 'j', 'list.next'),
  b('list', 'down', 'list.next'),
  b('list', 'k', 'list.prev'),
  b('list', 'up', 'list.prev'),
  b('list', 'enter', 'session.enter'),
  b('list', 'h', 'project.collapse'),
  b('list', 'left', 'project.collapse'),
  b('list', 'l', 'project.expand'),
  b('list', 'right', 'project.expand'),
  b('list', 'n', 'launcher.open'),
  b('list', 'o', 'project.open'),
  b('list', 'm', 'project.menu'),
  b('list', 'x', 'list.closeSession'),
  b('list', '?', 'help.keys'),

  /* ---- terminal, tras el prefijo (tmux) ---- */
  b('terminal', 'escape', 'session.leave'),
  b('terminal', PREFIX_CHORD, 'terminal.sendPrefix'),
  b('terminal', '|', 'pane.split.right'),
  b('terminal', '_', 'pane.split.down'),
  b('terminal', 'o', 'pane.next'),
  b('terminal', ';', 'pane.prev'),
  b('terminal', 'h', 'pane.left'),
  b('terminal', 'left', 'pane.left'),
  b('terminal', 'j', 'pane.down'),
  b('terminal', 'down', 'pane.down'),
  b('terminal', 'k', 'pane.up'),
  b('terminal', 'up', 'pane.up'),
  b('terminal', 'l', 'pane.right'),
  b('terminal', 'right', 'pane.right'),
  b('terminal', 'shift+h', 'pane.resize.left'),
  b('terminal', 'shift+j', 'pane.resize.down'),
  b('terminal', 'shift+k', 'pane.resize.up'),
  b('terminal', 'shift+l', 'pane.resize.right'),
  b('terminal', 'alt+h', 'pane.move.left'),
  b('terminal', 'alt+left', 'pane.move.left'),
  b('terminal', 'alt+j', 'pane.move.down'),
  b('terminal', 'alt+down', 'pane.move.down'),
  b('terminal', 'alt+k', 'pane.move.up'),
  b('terminal', 'alt+up', 'pane.move.up'),
  b('terminal', 'alt+l', 'pane.move.right'),
  b('terminal', 'alt+right', 'pane.move.right'),
  b('terminal', 'z', 'pane.zoom'),
  b('terminal', '}', 'pane.swap.next'),
  b('terminal', '{', 'pane.swap.prev'),
  b('terminal', '!', 'pane.break'),
  b('terminal', 'x', 'pane.close'),
  b('terminal', 'c', 'launcher.open'),
  b('terminal', 'b', 'session.new.browser'),
  b('terminal', 'f', 'browser.element'),
  b('terminal', 'w', 'pane.openDevServer'),
  b('terminal', 'a', 'pane.openArtifact'),
  b('terminal', 'n', 'tab.next'),
  b('terminal', 'p', 'tab.prev'),
  b('terminal', '&', 'tab.close'),
  ...Array.from({ length: 9 }, (_, i) => b('terminal', `${i + 1}`, `tab.go.${i + 1}`)),
  b('terminal', '?', 'palette.open'),
  /* vista previa: zoom de una imagen tras el prefijo */
  b('terminal', '+', 'preview.zoomIn'),
  b('terminal', '-', 'preview.zoomOut'),
  b('terminal', '0', 'preview.zoomReset'),

  /* ---- worktrees (ARCHITECTURE §3.15): teclas sueltas con la vista en pantalla ---- */
  b('worktrees', 'j', 'worktrees.next'),
  b('worktrees', 'down', 'worktrees.next'),
  b('worktrees', 'k', 'worktrees.prev'),
  b('worktrees', 'up', 'worktrees.prev'),
  b('worktrees', 'enter', 'worktrees.enter'),
  b('worktrees', 'o', 'worktree.enterAgent'),
  b('worktrees', 'n', 'worktree.new'),
  b('worktrees', 'i', 'worktree.fromIssue'),
  b('worktrees', 'r', 'worktree.runTests'),
  b('worktrees', 'x', 'worktree.discard'),
  b('worktrees', 'escape', 'worktrees.back'),

  /* ---- revisión (ARCHITECTURE §3.16): teclas sueltas con el diff de un worktree en pantalla ---- */
  b('review', ']', 'review.nextHunk'),
  b('review', '[', 'review.prevHunk'),
  b('review', '}', 'review.nextFile'),
  b('review', '{', 'review.prevFile'),
  b('review', 'j', 'review.nextLine'),
  b('review', 'down', 'review.nextLine'),
  b('review', 'k', 'review.prevLine'),
  b('review', 'up', 'review.prevLine'),
  b('review', 'c', 'review.comment'),
  b('review', 'shift+s', 'review.send'),
  b('review', 'e', 'review.export'),
  b('review', 'shift+m', 'review.merge'),
  b('review', 'shift+x', 'review.discard'),
  b('review', 'o', 'review.editor'),
  b('review', 'r', 'review.reload'),
  b('review', 'escape', 'review.back'),

  /* ---- broadcast (ARCHITECTURE §3.18): teclas sueltas con la vista en pantalla ---- */
  b('broadcast', 'j', 'broadcast.next'),
  b('broadcast', 'down', 'broadcast.next'),
  b('broadcast', 'k', 'broadcast.prev'),
  b('broadcast', 'up', 'broadcast.prev'),
  b('broadcast', 'h', 'broadcast.left'),
  b('broadcast', 'left', 'broadcast.left'),
  b('broadcast', 'l', 'broadcast.right'),
  b('broadcast', 'right', 'broadcast.right'),
  b('broadcast', 'enter', 'broadcast.enter'),
  b('broadcast', 'd', 'broadcast.diff'),
  b('broadcast', 'shift+d', 'broadcast.diffBetween'),
  b('broadcast', 's', 'broadcast.choose'),
  b('broadcast', 'x', 'broadcast.discardCandidate'),
  b('broadcast', 'r', 'broadcast.relaunch'),
  b('broadcast', 'p', 'broadcast.prompt'),
  b('broadcast', 'shift+m', 'broadcast.merge'),
  b('broadcast', 'shift+b', 'broadcast.new'),
  b('broadcast', 'escape', 'broadcast.back'),

  /* ---- árbol del editor (ARCHITECTURE §3.19): teclas sueltas con el foco en `.editor__tree` ---- */
  b('editorTree', 'j', 'editor.tree.next'),
  b('editorTree', 'down', 'editor.tree.next'),
  b('editorTree', 'k', 'editor.tree.prev'),
  b('editorTree', 'up', 'editor.tree.prev'),
  b('editorTree', 'enter', 'editor.tree.enter'),
  b('editorTree', 'l', 'editor.tree.enter'),
  b('editorTree', 'h', 'editor.tree.up'),
  b('editorTree', 'backspace', 'editor.tree.up'),
  b('editorTree', 'escape', 'editor.tree.close')
]

/** Clave de una pareja (capa, comando) en `settings.keys`. */
export const bindingKey = (layer: Layer, command: string): string => `${layer}:${command}`

/** Parejas (capa, comando) en orden de la tabla, sin repetir: las filas del panel de ajustes. */
export const BINDING_ROWS: ReadonlyArray<{ layer: Layer; command: string }> = DEFAULT_BINDINGS.filter(
  (x, i, all) => all.findIndex((y) => y.layer === x.layer && y.command === x.command) === i
).map(({ layer, command }) => ({ layer, command }))

/** Chords por defecto de una pareja, con el prefijo ya resuelto. */
export function defaultChords(layer: Layer, command: string, prefix: string): Chord[] {
  return DEFAULT_BINDINGS.filter((x) => x.layer === layer && x.command === command).map((x) => (x.chord === PREFIX_CHORD ? prefix : x.chord))
}

/** Chords vigentes de una pareja: los del usuario si los definió, si no los por defecto. */
export function effectiveChords(settings: Settings, layer: Layer, command: string): Chord[] {
  const own = settings.keys[bindingKey(layer, command)]
  return own ? own.map(normalizeChord) : defaultChords(layer, command, settings.prefix)
}

/** Reconstruye el keymap desde cero con defaults + sobreescrituras del usuario. */
export function applyKeybindings(settings: Settings, km: Keymap = keymap): void {
  km.clear()
  for (const { layer, command } of BINDING_ROWS) {
    for (const chord of effectiveChords(settings, layer, command)) km.bind(layer, chord, command)
  }
}

/**
 * Qué chords admite cada capa. `global` vale con cualquier foco, así que exige ⌘ para no robarle
 * teclas a la terminal; `list`, `terminal` y las capas de vista son teclas sueltas y ⌘ ahí chocaría con lo global.
 */
export function validateChordFor(layer: Layer, chord: Chord): string | null {
  const { mods: parts, key } = splitChord(normalizeChord(chord))
  if (key === 'escape') return 'Esc cancela la captura; no se puede asignar'
  if (layer === 'global' && !parts.includes('cmd')) return 'Los atajos globales llevan ⌘'
  if (layer !== 'global' && parts.includes('cmd')) return '⌘ es solo para los atajos globales'
  return null
}
