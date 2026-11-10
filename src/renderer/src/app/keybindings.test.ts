import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { normalizeChord } from '@/core/keys/chord'
import { Keymap } from '@/core/keys/keymap'
import { applyKeybindings, BINDING_ROWS, DEFAULT_BINDINGS, bindingKey, defaultChords, effectiveChords, validateChordFor } from './keybindings'

describe('applyKeybindings', () => {
  it('con defaults reproduce la tabla y resuelve el prefijo', () => {
    const km = new Keymap()
    applyKeybindings(DEFAULT_SETTINGS, km)
    expect(km.resolve(['global'], 'cmd+t')).toBe('launcher.open')
    expect(km.resolve(['list'], 'j')).toBe('list.next')
    expect(km.resolve(['terminal'], 'z')).toBe('pane.zoom')
    expect(km.resolve(['terminal'], 'ctrl+a')).toBe('terminal.sendPrefix')
    expect(km.resolve(['global'], 'cmd+b')).toBe('sidebar.toggle')
    // ⌘K es el quick open; la paleta de comandos se movió a ⇧⌘P (ARCHITECTURE §3.11).
    expect(km.resolve(['global'], 'cmd+k')).toBe('quickopen.open')
    expect(km.resolve(['global'], 'shift+cmd+p')).toBe('palette.open')
    expect(km.resolve(['terminal'], '?')).toBe('palette.open')
  })

  it('⌘1 vuelve a la flota y ⌘2 queda libre; los tabs van en ⌥⌘N', () => {
    const km = new Keymap()
    applyKeybindings(DEFAULT_SETTINGS, km)
    expect(km.resolve(['global'], 'cmd+1')).toBe('fleet.open')
    expect(km.resolve(['global'], 'cmd+2')).toBeUndefined()
    expect(km.resolve(['global'], 'alt+cmd+3')).toBe('tab.go.3')
    expect(km.resolve(['terminal'], '3')).toBe('tab.go.3')
  })

  it('⌘3 abre Worktrees (§3.15) y la capa worktrees resuelve sus teclas sueltas', () => {
    const km = new Keymap()
    applyKeybindings(DEFAULT_SETTINGS, km)
    expect(km.resolve(['global'], 'cmd+3')).toBe('worktrees.open')
    expect(km.resolve(['worktrees', 'global'], 'j')).toBe('worktrees.next')
    expect(km.resolve(['worktrees', 'global'], 'up')).toBe('worktrees.prev')
    expect(km.resolve(['worktrees', 'global'], 'enter')).toBe('worktrees.enter')
    expect(km.resolve(['worktrees', 'global'], 'o')).toBe('worktree.enterAgent')
    expect(km.resolve(['worktrees', 'global'], 'n')).toBe('worktree.new')
    expect(km.resolve(['worktrees', 'global'], 'i')).toBe('worktree.fromIssue')
    expect(km.resolve(['worktrees', 'global'], 'r')).toBe('worktree.runTests')
    expect(km.resolve(['worktrees', 'global'], 'x')).toBe('worktree.discard')
    expect(km.resolve(['worktrees', 'global'], 'escape')).toBe('worktrees.back')
    // Las teclas de Worktrees no se cuelan en la lista ni en la revisión.
    expect(km.resolve(['list'], 'i')).toBeUndefined()
    expect(km.resolve(['review'], 'i')).toBeUndefined()
  })

  it('⌘D abre la revisión y la capa review resuelve hunks, archivos, líneas y acciones (§3.16)', () => {
    const km = new Keymap()
    applyKeybindings(DEFAULT_SETTINGS, km)
    expect(km.resolve(['global'], 'cmd+d')).toBe('review.open')
    expect(km.resolve(['review', 'global'], ']')).toBe('review.nextHunk')
    expect(km.resolve(['review', 'global'], '[')).toBe('review.prevHunk')
    expect(km.resolve(['review', 'global'], '}')).toBe('review.nextFile')
    expect(km.resolve(['review', 'global'], '{')).toBe('review.prevFile')
    expect(km.resolve(['review', 'global'], 'j')).toBe('review.nextLine')
    expect(km.resolve(['review', 'global'], 'up')).toBe('review.prevLine')
    expect(km.resolve(['review', 'global'], 'c')).toBe('review.comment')
    expect(km.resolve(['review', 'global'], 'shift+s')).toBe('review.send')
    expect(km.resolve(['review', 'global'], 'shift+m')).toBe('review.merge')
    expect(km.resolve(['review', 'global'], 'shift+x')).toBe('review.discard')
    expect(km.resolve(['review', 'global'], 'o')).toBe('review.editor')
    expect(km.resolve(['review', 'global'], 'r')).toBe('review.reload')
    expect(km.resolve(['review', 'global'], 'escape')).toBe('review.back')
    // Las teclas de la revisión no se cuelan en la lista ni en Worktrees.
    expect(km.resolve(['list'], ']')).toBeUndefined()
    expect(km.resolve(['worktrees'], 'c')).toBeUndefined()
  })

  it('⌘4 abre Broadcast (§3.18) y la capa broadcast resuelve rondas, tarjetas y acciones', () => {
    const km = new Keymap()
    applyKeybindings(DEFAULT_SETTINGS, km)
    expect(km.resolve(['global'], 'cmd+4')).toBe('broadcast.open')
    expect(km.resolve(['broadcast', 'global'], 'j')).toBe('broadcast.next')
    expect(km.resolve(['broadcast', 'global'], 'up')).toBe('broadcast.prev')
    expect(km.resolve(['broadcast', 'global'], 'h')).toBe('broadcast.left')
    expect(km.resolve(['broadcast', 'global'], 'right')).toBe('broadcast.right')
    expect(km.resolve(['broadcast', 'global'], 'enter')).toBe('broadcast.enter')
    expect(km.resolve(['broadcast', 'global'], 'd')).toBe('broadcast.diff')
    expect(km.resolve(['broadcast', 'global'], 'shift+d')).toBe('broadcast.diffBetween')
    expect(km.resolve(['broadcast', 'global'], 's')).toBe('broadcast.choose')
    expect(km.resolve(['broadcast', 'global'], 'x')).toBe('broadcast.discardCandidate')
    expect(km.resolve(['broadcast', 'global'], 'r')).toBe('broadcast.relaunch')
    expect(km.resolve(['broadcast', 'global'], 'p')).toBe('broadcast.prompt')
    expect(km.resolve(['broadcast', 'global'], 'shift+m')).toBe('broadcast.merge')
    expect(km.resolve(['broadcast', 'global'], 'shift+b')).toBe('broadcast.new')
    expect(km.resolve(['broadcast', 'global'], 'escape')).toBe('broadcast.back')
    // Las teclas de Broadcast no se cuelan en la lista ni en Worktrees.
    expect(km.resolve(['list'], 's')).toBeUndefined()
    expect(km.resolve(['worktrees'], 'shift+b')).toBeUndefined()
  })

  it('el prefijo configurado mueve terminal.sendPrefix', () => {
    const km = new Keymap()
    applyKeybindings({ ...DEFAULT_SETTINGS, prefix: 'ctrl+b' }, km)
    expect(km.resolve(['terminal'], 'ctrl+b')).toBe('terminal.sendPrefix')
    expect(km.resolve(['terminal'], 'ctrl+a')).toBeUndefined()
  })

  it('una pareja sobreescrita reemplaza todos sus chords por defecto', () => {
    const km = new Keymap()
    applyKeybindings({ ...DEFAULT_SETTINGS, keys: { [bindingKey('list', 'list.next')]: ['ctrl+n'] } }, km)
    expect(km.resolve(['list'], 'ctrl+n')).toBe('list.next')
    expect(km.resolve(['list'], 'j')).toBeUndefined()
    expect(km.resolve(['list'], 'down')).toBeUndefined()
    expect(km.resolve(['list'], 'k')).toBe('list.prev')
  })

  it('lista vacía deja el comando sin atajo; volver a aplicar limpia lo anterior', () => {
    const km = new Keymap()
    applyKeybindings({ ...DEFAULT_SETTINGS, keys: { [bindingKey('terminal', 'pane.zoom')]: [] } }, km)
    expect(km.resolve(['terminal'], 'z')).toBeUndefined()
    applyKeybindings(DEFAULT_SETTINGS, km)
    expect(km.resolve(['terminal'], 'z')).toBe('pane.zoom')
  })

  it('normaliza los chords del usuario', () => {
    const km = new Keymap()
    applyKeybindings({ ...DEFAULT_SETTINGS, keys: { [bindingKey('global', 'pane.zoom')]: ['shift+cmd+z'] } }, km)
    expect(km.resolve(['global'], 'cmd+shift+z')).toBe('pane.zoom')
  })
})

describe('dictado (§3.22)', () => {
  it('⌥Space dicta y ⌥⇧Space dicta eligiendo destino; valen con el teclado en la terminal (capa global)', () => {
    const km = new Keymap()
    applyKeybindings(DEFAULT_SETTINGS, km)
    expect(km.resolve(['global'], 'alt+space')).toBe('voice.dictate')
    expect(km.resolve(['global'], 'shift+alt+space')).toBe('voice.dictateChoose')
    expect(km.resolve(['global'], normalizeChord('alt+shift+space'))).toBe('voice.dictateChoose')
    // Space suelto sigue libre en la lista y en la terminal.
    expect(km.resolve(['list', 'global'], 'space')).toBeUndefined()
    expect(km.resolve(['terminal'], 'space')).toBeUndefined()
  })
})

describe('DEFAULT_BINDINGS', () => {
  it('ningún chord se repite dentro de una capa (los del navegador no chocan con los existentes)', () => {
    const seen = new Map<string, string>()
    for (const b of DEFAULT_BINDINGS) {
      const key = `${b.layer}:${normalizeChord(b.chord)}`
      expect(seen.get(key), `${key} ya lo usa ${seen.get(key)}`).toBeUndefined()
      seen.set(key, b.command)
    }
  })

  it('los atajos del navegador resuelven en su capa', () => {
    const km = new Keymap()
    applyKeybindings(DEFAULT_SETTINGS, km)
    expect(km.resolve(['global'], 'cmd+l')).toBe('browser.focusUrl')
    expect(km.resolve(['global'], 'cmd+shift+s')).toBe('browser.capture')
    expect(km.resolve(['global'], 'shift+cmd+b')).toBe('session.new.browser')
    expect(km.resolve(['global'], 'cmd+r')).toBe('browser.reload')
    expect(km.resolve(['global'], 'alt+cmd+left')).toBe('browser.back')
    expect(km.resolve(['global'], 'cmd+left')).toBeUndefined()
    expect(km.resolve(['global'], 'shift+cmd+m')).toBe('browser.mobile')
    // Recorte y dibujo son pasos de la captura (⌘⇧S), sin atajo propio.
    expect(km.resolve(['global'], 'alt+cmd+m')).toBeUndefined()
    expect(km.resolve(['global'], 'alt+cmd+i')).toBe('browser.devtools')
    expect(km.resolve(['global'], 'alt+cmd+j')).toBeUndefined()
    expect(km.resolve(['global'], 'shift+cmd+a')).toBeUndefined()
    expect(km.resolve(['terminal'], 'b')).toBe('session.new.browser')
    expect(km.resolve(['terminal'], 'f')).toBe('browser.element')
  })

  it('los atajos de la vista previa (§3.20) resuelven sin pisar la paleta ni pane.prev', () => {
    const km = new Keymap()
    applyKeybindings(DEFAULT_SETTINGS, km)
    expect(km.resolve(['global'], 'shift+cmd+v')).toBe('preview.toggle')
    expect(km.resolve(['global'], 'shift+cmd+p')).toBe('palette.open')
    expect(km.resolve(['global'], 'alt+cmd+[')).toBe('preview.back')
    expect(km.resolve(['global'], 'cmd+[')).toBe('pane.prev')
    expect(km.resolve(['global'], 'cmd+=')).toBe('preview.zoomIn')
    expect(km.resolve(['global'], 'cmd++')).toBe('preview.zoomIn')
    expect(km.resolve(['global'], 'cmd+-')).toBe('preview.zoomOut')
    expect(km.resolve(['global'], 'cmd+0')).toBe('preview.zoomReset')
    expect(km.resolve(['terminal'], '+')).toBe('preview.zoomIn')
    expect(km.resolve(['terminal'], '-')).toBe('preview.zoomOut')
    expect(km.resolve(['terminal'], '0')).toBe('preview.zoomReset')
    expect(km.resolve(['terminal'], '1')).toBe('tab.go.1')
  })

  it('los atajos del editor (§3.19) resuelven en global sin pisar los del navegador ni la revisión', () => {
    const km = new Keymap()
    applyKeybindings(DEFAULT_SETTINGS, km)
    expect(km.resolve(['global'], 'cmd+s')).toBe('editor.save')
    expect(km.resolve(['global'], 'cmd+e')).toBe('editor.tree.toggle')
    expect(km.resolve(['global'], 'alt+cmd+a')).toBe('editor.sendContext')
    // ⌘D es la revisión (desde un editor en un worktree abre su diff).
    expect(km.resolve(['global'], 'cmd+d')).toBe('review.open')
    // `]c [c A R C` viven en el modo NORMAL de vim dentro del editor, no en el keymap de omni.
    expect(km.resolve(['global'], 'a')).toBeUndefined()
    expect(km.resolve(['list'], 'cmd+s')).toBeUndefined()
  })

  it('la capa editorTree resuelve las teclas del árbol lateral y no se cuela en la lista', () => {
    const km = new Keymap()
    applyKeybindings(DEFAULT_SETTINGS, km)
    expect(km.resolve(['editorTree', 'global'], 'j')).toBe('editor.tree.next')
    expect(km.resolve(['editorTree', 'global'], 'up')).toBe('editor.tree.prev')
    expect(km.resolve(['editorTree', 'global'], 'enter')).toBe('editor.tree.enter')
    expect(km.resolve(['editorTree', 'global'], 'l')).toBe('editor.tree.enter')
    expect(km.resolve(['editorTree', 'global'], 'h')).toBe('editor.tree.up')
    expect(km.resolve(['editorTree', 'global'], 'backspace')).toBe('editor.tree.up')
    expect(km.resolve(['editorTree', 'global'], 'escape')).toBe('editor.tree.close')
    // ⌘ sigue siendo global dentro del árbol (⌘E lo cierra por el toggle).
    expect(km.resolve(['editorTree', 'global'], 'cmd+e')).toBe('editor.tree.toggle')
    expect(km.resolve(['list'], 'backspace')).toBeUndefined()
    expect(validateChordFor('editorTree', 'j')).toBeNull()
    expect(validateChordFor('editorTree', 'cmd+j')).not.toBeNull()
  })
})

describe('defaultChords / effectiveChords / BINDING_ROWS', () => {
  it('agrupa los chords de una pareja y no repite parejas', () => {
    expect(defaultChords('list', 'list.next', 'ctrl+a')).toEqual(['j', 'down'])
    expect(defaultChords('terminal', 'terminal.sendPrefix', 'ctrl+b')).toEqual(['ctrl+b'])
    expect(BINDING_ROWS.filter((r) => r.command === 'list.next')).toHaveLength(1)
  })
  it('effectiveChords prefiere lo del usuario', () => {
    expect(effectiveChords({ ...DEFAULT_SETTINGS, keys: { 'list:list.next': ['n'] } }, 'list', 'list.next')).toEqual(['n'])
    expect(effectiveChords(DEFAULT_SETTINGS, 'list', 'list.next')).toEqual(['j', 'down'])
  })
})

describe('validateChordFor', () => {
  it('global exige ⌘, las otras capas lo prohíben, Esc nunca', () => {
    expect(validateChordFor('global', 'cmd+n')).toBeNull()
    expect(validateChordFor('global', 'n')).not.toBeNull()
    expect(validateChordFor('list', 'cmd+n')).not.toBeNull()
    expect(validateChordFor('list', 'n')).toBeNull()
    expect(validateChordFor('terminal', 'shift+z')).toBeNull()
    expect(validateChordFor('terminal', 'escape')).not.toBeNull()
    expect(validateChordFor('worktrees', 'y')).toBeNull()
    expect(validateChordFor('worktrees', 'cmd+y')).not.toBeNull()
  })
})

describe('atajos con + como tecla', () => {
  it('⌘+ y + (tras el prefijo) resuelven al zoom de la vista previa, como llegan del teclado', async () => {
    const { chordOf } = await import('@/core/keys/chord')
    const km = new Keymap()
    applyKeybindings(DEFAULT_SETTINGS, km)
    // ⌘+ en un teclado US es ⇧= con `key: '+'`: el chord del evento es `cmd++`.
    const cmdPlus = chordOf({ key: '+', code: 'Equal', ctrlKey: false, altKey: false, shiftKey: true, metaKey: true } as KeyboardEvent)
    expect(cmdPlus).toBe('cmd++')
    expect(km.resolve(['global'], cmdPlus)).toBe('preview.zoomIn')
    expect(km.resolve(['terminal'], '+')).toBe('preview.zoomIn')
  })
})
