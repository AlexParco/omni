import type { JSX } from 'react'
import { prettyChord, prettyKey } from '@/core/keys/chord'
import { keymap, type Layer } from '@/core/keys/keymap'
import { Hint } from '@/ui/Hint'
import { useEditor } from '@/panes/editor/editor-store'
import { useBrowser } from '@/store/browser'
import { focusedSessionId, useLayout } from '@/store/layout'
import { useSessions } from '@/store/sessions'
import { usePrefixLabel, useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { StatusBar } from './TitleBar'

/** Qué comandos resume cada hint; las teclas salen del keymap vigente, nunca a mano. */
const HINTS: Record<Layer, Array<{ commands: string[]; label: string }>> = {
  global: [],
  worktrees: [
    { commands: ['worktrees.next', 'worktrees.prev'], label: 'moverse' },
    { commands: ['worktrees.enter'], label: 'revisar' },
    { commands: ['worktree.enterAgent'], label: 'agente' },
    { commands: ['worktree.new'], label: 'nuevo' },
    { commands: ['worktree.fromIssue'], label: 'desde issue' },
    { commands: ['worktree.runTests'], label: 'tests' },
    { commands: ['worktree.discard'], label: 'descartar' },
    { commands: ['worktrees.back'], label: 'volver' }
  ],
  review: [
    { commands: ['review.nextHunk', 'review.prevHunk'], label: 'hunk' },
    { commands: ['review.nextFile', 'review.prevFile'], label: 'archivo' },
    { commands: ['review.nextLine', 'review.prevLine'], label: 'línea' },
    { commands: ['review.comment'], label: 'comentar' },
    { commands: ['review.send'], label: 'enviar' },
    { commands: ['review.export'], label: 'copiar para PR' },
    { commands: ['review.merge'], label: 'merge' },
    { commands: ['review.back'], label: 'volver' }
  ],
  broadcast: [
    { commands: ['broadcast.left', 'broadcast.right'], label: 'comparar' },
    { commands: ['broadcast.next', 'broadcast.prev'], label: 'rondas' },
    { commands: ['broadcast.diff'], label: 'diff' },
    { commands: ['broadcast.enter'], label: 'abrir agente' },
    { commands: ['broadcast.choose'], label: 'elegir' },
    { commands: ['broadcast.discardCandidate'], label: 'descartar' },
    { commands: ['broadcast.merge'], label: 'merge y limpiar' },
    { commands: ['broadcast.new'], label: 'nueva ronda' },
    { commands: ['broadcast.back'], label: 'volver' }
  ],
  editorTree: [
    { commands: ['editor.tree.next', 'editor.tree.prev'], label: 'moverse' },
    { commands: ['editor.tree.enter'], label: 'abrir' },
    { commands: ['editor.tree.up'], label: 'subir' },
    { commands: ['editor.tree.close'], label: 'cerrar árbol' }
  ],
  list: [
    { commands: ['list.next', 'list.prev'], label: 'moverse' },
    { commands: ['session.enter'], label: 'entrar' },
    { commands: ['launcher.open'], label: 'nuevo agente' },
    { commands: ['project.open'], label: 'abrir proyecto' },
    { commands: ['project.menu'], label: 'menú' },
    { commands: ['list.closeSession'], label: 'cerrar tab' }
  ],
  // Solo lo de todos los días; el resto (tab nuevo, navegador, tabs, literal) está en "atajos".
  terminal: [
    { commands: ['pane.split.right'], label: 'split →' },
    { commands: ['pane.split.down'], label: 'split ↓' },
    { commands: ['pane.left', 'pane.down', 'pane.up', 'pane.right'], label: 'panes' },
    { commands: ['pane.zoom'], label: 'zoom' },
    { commands: ['pane.resize.left', 'pane.resize.down', 'pane.resize.up', 'pane.resize.right'], label: 'tamaño' },
    { commands: ['pane.close'], label: 'cerrar' },
    { commands: ['session.leave'], label: 'lista' }
  ]
}

/** Con un navegador bajo el teclado: tras el prefijo, el modo elemento; con ⌘, la captura. */
const BROWSER_HINTS: Array<{ layer: Layer; commands: string[]; label: string }> = [
  { layer: 'terminal', commands: ['browser.element'], label: 'modo elemento' },
  { layer: 'global', commands: ['browser.capture'], label: 'captura' },
  { layer: 'global', commands: ['browser.focusUrl'], label: 'URL' }
]

/**
 * Con un editor bajo el teclado (§3.19): las teclas de NORMAL viven en vim (fijas) y las de ⌘ en el
 * keymap. Con el árbol lateral abierto mandan las de la capa `editorTree`.
 */
const EDITOR_VIM_HINTS = [
  { kbd: ']c [c', label: 'hunk' },
  { kbd: 'A', label: 'aceptar' },
  { kbd: 'R', label: 'revertir' },
  { kbd: 'C', label: 'comentar' }
] as const
const EDITOR_HINTS: Array<{ layer: Layer; commands: string[]; label: string }> = [
  { layer: 'global', commands: ['editor.tree.toggle'], label: 'árbol' },
  { layer: 'global', commands: ['editor.save'], label: 'guardar' },
  { layer: 'global', commands: ['editor.sendContext'], label: 'al agente' }
]

/** Hints fijos de los modos del navegador: las teclas las decide el modo, no el keymap. */
const MODE_HINTS = {
  element: [
    { kbd: 'a–z', label: 'elegir' },
    { kbd: '⏎', label: 'enviar al agente' },
    { kbd: 'Esc', label: 'salir' }
  ],
  // Paso 1 de la captura: recortar.
  area: [
    { kbd: 'H J K L', label: 'mover' },
    { kbd: '⇧', label: 'redimensionar' },
    { kbd: '⏎', label: 'recortar' },
    { kbd: '⇧⏎', label: 'toda la página' },
    { kbd: 'Esc', label: 'cancelar' }
  ],
  // Paso 2: dibujar encima (opcional) y seguir al envío.
  markup: [
    { kbd: 'P H A R O T E', label: 'herramienta' },
    { kbd: '⌘Z', label: 'deshacer' },
    { kbd: '⌘⏎', label: 'siguiente' },
    { kbd: 'Esc', label: 'cancelar' }
  ]
} as const

/** Primer chord de cada comando en la capa, pegados: `J K`, `h j k l`. Vacío si ninguno tiene atajo. */
function keysFor(layer: Layer, commands: string[]): string {
  return commands
    .map((id) => keymap.chordsFor(id).find((c) => c.layer === layer)?.chord)
    .filter((c): c is string => !!c)
    .map((c) => (layer === 'terminal' ? prettyKey(c) : prettyChord(c)))
    .join(' ')
    // `⇧h ⇧j ⇧k ⇧l` → `⇧H J K L`: el modificador común una sola vez.
    // Con ⇧ la letra va en mayúscula, como en el teclado.
    .replace(/^(⇧)(\S)((?: ⇧\S)+)$/, (_m, mod: string, first: string, rest: string) => `${mod}${first}${rest.replaceAll(` ${mod}`, ' ')}`.toUpperCase())
}

/**
 * Hints de teclado según el foco. Es la única "ayuda" visible siempre.
 * En terminal la tabla va tras el prefijo: el badge del prefijo se enciende mientras está armado.
 * Con un navegador bajo el teclado se suman sus atajos, y en modo elemento, área o markup solo se ve el modo.
 * Se vuelve a pintar cuando cambian los ajustes de teclado (el keymap se reconstruye antes).
 */
export function Footer(): JSX.Element {
  const focus = useUi((s) => s.focus)
  const view = useUi((s) => s.view)
  const armed = useUi((s) => s.prefixArmed)
  const prefixLabel = usePrefixLabel()
  useSettings((s) => s.settings.prefix)
  useSettings((s) => s.settings.keys)
  const mode = useBrowser((s) => s.browserMode)
  const browserFocused = useSessions((s) => {
    const ws = s.currentWorkspaceId
    const id = ws ? focusedSessionId(useLayout.getState(), ws) : null
    return id !== null && s.sessions.find((x) => x.id === id)?.agent === 'browser'
  })
  const editorId = useSessions((s) => {
    const ws = s.currentWorkspaceId
    const id = ws ? focusedSessionId(useLayout.getState(), ws) : null
    return id !== null && s.sessions.find((x) => x.id === id)?.agent === 'editor' ? id : null
  })
  const editorTreeOpen = useEditor((s) => editorId !== null && s.docs[editorId]?.tree != null)
  useLayout((s) => s.activeTab)
  useLayout((s) => s.tabs)
  const globalKey = (id: string): string | undefined => keymap.chordsFor(id).find((c) => c.layer === 'global')?.chord

  if (mode) {
    return (
      <footer className="footer" data-mode={mode}>
        {MODE_HINTS[mode].map(({ kbd, label }) => (
          <Hint quiet key={label} kbd={kbd}>
            {label}
          </Hint>
        ))}
      </footer>
    )
  }

  return (
    <footer className="footer">
      {focus === 'terminal' && (
        <span className="footer__prefix" aria-live="polite">
          <Hint quiet kbd={prefixLabel} on={armed}>
            {armed ? 'esperando tecla' : 'prefijo'}
          </Hint>
        </span>
      )}
      {HINTS[focus === 'terminal' && editorTreeOpen ? 'editorTree' : focus === 'list' && view !== 'fleet' ? view : focus].map(({ commands, label }) => {
        // Con la lista enfocada y una vista propia (worktrees, revisión, broadcast) mandan sus teclas sueltas;
        // con el árbol de un editor abierto, las suyas.
        const layer: Layer = focus === 'terminal' && editorTreeOpen ? 'editorTree' : focus === 'list' && view !== 'fleet' ? view : focus
        const keys = keysFor(layer, commands)
        return keys ? (
          <Hint quiet key={label} kbd={keys}>
            {label}
          </Hint>
        ) : null
      })}
      {focus === 'terminal' &&
        browserFocused &&
        BROWSER_HINTS.map(({ layer, commands, label }) => {
          const keys = keysFor(layer, commands)
          return keys ? (
            <Hint quiet key={label} kbd={keys}>
              {label}
            </Hint>
          ) : null
        })}
      {focus === 'terminal' &&
        editorId !== null &&
        !editorTreeOpen &&
        EDITOR_VIM_HINTS.map(({ kbd, label }) => (
          <Hint quiet key={label} kbd={kbd}>
            {label}
          </Hint>
        ))}
      {focus === 'terminal' &&
        editorId !== null &&
        EDITOR_HINTS.map(({ layer, commands, label }) => {
          const keys = keysFor(layer, commands)
          return keys ? (
            <Hint quiet key={label} kbd={keys}>
              {label}
            </Hint>
          ) : null
        })}
      {focus === 'list' && globalKey('palette.open') && <Hint quiet kbd={prettyChord(globalKey('palette.open') ?? '')}>comandos</Hint>}
      <span className="footer__right">
        <StatusBar />
        {globalKey('help.keys') && <Hint quiet kbd={prettyChord(globalKey('help.keys') ?? '')}>atajos</Hint>}
      </span>
    </footer>
  )
}
