import { useEffect } from 'react'
import { commands } from '@/core/commands/registry'
import { chordOf, isModifierOnly } from '@/core/keys/chord'
import { keymap, type Layer } from '@/core/keys/keymap'
import { browserIdAt } from '@/panes/browser/browser-host'
import { armBrowserPrefix, isBlank, refocusBrowserAfterCommand, takeBrowserPrefix, useBrowser } from '@/store/browser'
import { currentPrefix } from '@/store/settings'
import { useUi } from '@/store/ui'

/** Comando que abre cada overlay: repetir su atajo con el overlay abierto lo cierra (toggle). */
const OPENER: Record<string, string> = { palette: 'palette.open', quickopen: 'quickopen.open', launcher: 'launcher.open', keys: 'help.keys', settings: 'settings.open', todo: 'todo.toggle', ports: 'ports.toggle', usage: 'usage.toggle' }

/** La tecla cayó en el textarea de xterm: su propio handler arma y resuelve el prefijo. */
const inXterm = (e: KeyboardEvent): boolean => e.target instanceof HTMLElement && e.target.closest('.term-root') !== null
/** Campo de texto del renderer (barra de URL, filtros): las teclas sueltas son texto, no atajos. */
const inEditable = (e: KeyboardEvent): boolean => e.target instanceof HTMLElement && e.target.closest('input, textarea') !== null && !inXterm(e)
/** El árbol lateral de un editor (⌘E, §3.19) tiene el foco DOM: sus teclas sueltas van a la capa `editorTree`. */
const inEditorTree = (e: KeyboardEvent): boolean => e.target instanceof HTMLElement && e.target.closest('.editor__tree') !== null
/** Dentro de un campo de texto, ⌘ + flechas (y la edición básica) son del campo, no de la app. */
const EDIT_CHORDS = new Set(['cmd+left', 'cmd+right', 'cmd+up', 'cmd+down', 'cmd+backspace', 'cmd+a', 'cmd+z', 'shift+cmd+z', 'cmd+x', 'cmd+c', 'cmd+v'])

/**
 * Despachador de teclado de la app. Escucha en fase de captura para ganarle a xterm.
 * Con overlay abierto solo atiende el toggle de su propio atajo: el resto lo maneja el overlay.
 * Con foco en terminal solo aplica la capa `global` (⌘); el resto lo procesa xterm y su prefijo.
 * Con una vista propia en pantalla (Worktrees, revisión, broadcast), las teclas sueltas van a su capa en vez de `list`.
 * Con el teclado en un pane de navegador (su raíz o su barra) no hay xterm: el prefijo se arma aquí,
 * y también llega aquí la tecla posterior a un prefijo que la página reenvió (`browser:key`).
 */
export function useKeyboard(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const { overlay, focus, view, closeOverlay } = useUi.getState()
      const chord = chordOf(e)
      if (isModifierOnly(chord)) return
      if (overlay) {
        // La hoja de atajos también se abre con `?` desde la lista, así que ahí vale esa capa.
        const layers: Layer[] = overlay === 'keys' ? ['global', 'list'] : ['global']
        const opener = OPENER[overlay]
        // Overlays sin atajo propio (confirmKill, projectMenu) no se cierran con teclas sueltas:
        // sin esta guarda `undefined === undefined` y cualquier tecla no mapeada (⏎ incluido) los cerraba.
        if (opener && keymap.resolve(layers, chord) === opener) {
          e.preventDefault()
          e.stopPropagation()
          closeOverlay()
        }
        return
      }
      // Modo elemento del navegador: las teclas sueltas son suyas (letras eligen, ⏎ envía, Esc sale) y
      // no llegan a otro atajo; las de ⌘ siguen su camino normal (⌘W, ⌘K, ⌘Q no se bloquean). En modo
      // área o markup el lienzo atiende las suyas y el resto de teclas sueltas se ignora.
      const mode = useBrowser.getState().browserMode
      const withCmd = chord.split('+').includes('cmd')
      if (mode === 'element' && !withCmd) {
        e.preventDefault()
        e.stopPropagation()
        useBrowser.getState().elementKey(chord)
        return
      }
      if ((mode === 'area' || mode === 'markup') && !withCmd) return
      // Prefijo armado desde el navegador: esta es su tecla, se resuelve contra la capa `terminal`
      // aunque el foco DOM haya vuelto a una terminal (xterm no la ve: estamos en fase de captura).
      if (takeBrowserPrefix()) {
        e.preventDefault()
        e.stopPropagation()
        const id = keymap.resolve(['terminal'], chord)
        if (id) void commands.run(id).then(refocusBrowserAfterCommand)
        else {
          // Tecla sin comando con el teclado parado en la raíz de un navegador: la página lo recupera.
          const browserId = browserIdAt(e.target)
          if (browserId && !isBlank(useBrowser.getState().states[browserId])) useBrowser.getState().focusView(browserId)
        }
        return
      }
      if (focus === 'terminal' && !inXterm(e) && !inEditable(e) && chord === currentPrefix()) {
        e.preventDefault()
        e.stopPropagation()
        armBrowserPrefix()
        return
      }
      if (inEditable(e) && EDIT_CHORDS.has(chord)) return
      // Con una vista propia en pantalla las teclas sueltas son suyas, no de la lista; ⌘ sigue siendo global.
      const layers: Layer[] = inEditorTree(e) ? ['editorTree', 'global'] : focus === 'terminal' || inEditable(e) ? ['global'] : view === 'worktrees' ? ['worktrees', 'global'] : view === 'review' ? ['review', 'global'] : view === 'broadcast' ? ['broadcast', 'global'] : ['list', 'global']
      const id = keymap.resolve(layers, chord)
      if (!id) return
      e.preventDefault()
      e.stopPropagation()
      void commands.run(id)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
