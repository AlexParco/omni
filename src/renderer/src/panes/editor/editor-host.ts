import { ChangeSet, Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, Text, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { autocompletion, completeAnyWord, completionKeymap } from '@codemirror/autocomplete'
import { lintGutter, nextDiagnostic, previousDiagnostic, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { getOriginalDoc, unifiedMergeView, updateOriginalDoc } from '@codemirror/merge'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, bracketMatching, defaultHighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { css } from '@codemirror/lang-css'
import { go } from '@codemirror/lang-go'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { yaml } from '@codemirror/lang-yaml'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { commands } from '@/core/commands/registry'
import type { CodeDiagnostic } from '@shared/types'
import { hunksOf, splitLines, type LineHunk } from '@/core/line-diff'
import { omni } from '@/lib/omni'
import { focusStays } from '@/panes/pane-focus'
import { useDocs } from '@/store/docs'
import { useLayout } from '@/store/layout'
import { writeToSession } from '@/store/session-write'
import { agentOf, useSessions, workspaceOf } from '@/store/sessions'
import { useUi } from '@/store/ui'
import type { PaneHandle } from '../types'
import { comparisonText, diagnosticRange, formatComment, formatContext, hunkAnchorLine, hunkAt, langOf, markSeen, nextHunkIndex, relPath, revertedText, visibleHunks, workspaceAgent, type LangId } from './editor-logic'
import { useEditor, type VimMode } from './editor-store'
import { connectLsp, hasLsp, lspDefinition, lspReferences, lspRename, onLspExit, releaseLsp, setLspHost } from './lsp'

/**
 * Instancias de CodeMirror por sesión de editor (ARCHITECTURE §3.19), imperativas como
 * `terminal-host.ts`: se crean una vez, se reparentan al hueco del pane que las muestre y
 * sobreviven a los re-render. El estado reactivo (sucio, modo, hunks, árbol, compositor) va a
 * `editor-store.ts`; el buffer solo vive aquí.
 */

/** Espera tras la última edición antes de recalcular los hunks contra la base. */
const DIFF_SETTLE_MS = 150
/** Líneas sin cambios que quedan a la vista alrededor de cada cambio con "solo cambios". */
const COLLAPSE_MARGIN = 3

interface Instance extends PaneHandle {
  id: string
  workspaceId: string
  path: string
  view: EditorView
  /** Contenedor propio; se reparenta al pane que lo muestre. */
  el: HTMLDivElement
  lang: Compartment
  /** Diff contra la base (`@codemirror/merge`); vacío si el archivo no tiene base en el repo. */
  merge: Compartment
  /** Texto tal como está en disco (última lectura o escritura): `dirty` = buffer ≠ esto. */
  savedText: string
  mtime: number
  baseLines: string[]
  baseText: string
  hasBase: boolean
  diffTimer: number
  /** Diagnósticos de tsc/eslint del último chequeo, ya con rangos del buffer de ese momento. */
  checkSeq: number
  /** Servidor de lenguaje (§3.19b): su extensión vive en este compartimento; vacío sin servidor. */
  lspCompartment: Compartment
  /** Id del servidor conectado, o `null`. */
  lspServer: string | null
  /** El servidor es de TypeScript: tsc sobra al guardar (sus errores ya llegan en vivo). */
  lspCoversTsc: boolean
  /** Último chequeo de herramientas (eslint, y tsc sin servidor). */
  toolDiagnostics: CodeDiagnostic[]
  toolNames: Array<'tsc' | 'eslint'>
  /** Errores en vivo del servidor de lenguaje, sobre el buffer actual. */
  lspDiagnostics: CodeDiagnostic[]
  /** Hueco del compositor (widget bajo el hunk), mientras está abierto. */
  composerEl: HTMLElement | null
}

const instances = new Map<string, Instance>()
let wired = false
/** Suscripciones IPC vivas, para soltarlas en HMR (`import.meta.hot.dispose`). */
let unsubscribe: Array<() => void> = []

/* ---------- decoraciones: compositor (el diff lo pinta @codemirror/merge) ---------- */

interface HunkView {
  hunks: LineHunk[]
  /** Compositor abierto: línea ancla (base 0) y su hueco DOM. */
  composer: { line: number; el: HTMLElement } | null
}

const setHunkView = StateEffect.define<HunkView>()

class ComposerWidget extends WidgetType {
  constructor(readonly el: HTMLElement) {
    super()
  }
  eq(other: ComposerWidget): boolean {
    return other.el === this.el
  }
  toDOM(): HTMLElement {
    return this.el
  }
  ignoreEvent(): boolean {
    return true
  }
}

/** El compositor de un comentario cuelga bajo la última línea del hunk (o la línea ancla de un borrado). */
function buildDecorations(state: EditorState, hv: HunkView): DecorationSet {
  if (!hv.composer) return Decoration.none
  const h = hv.hunks.find((x) => hunkAnchorLine(x, state.doc.lines) === hv.composer?.line)
  const after = h && h.end > h.start ? h.end - 1 : hv.composer.line
  const pos = after < state.doc.lines ? state.doc.line(after + 1).to : state.doc.length
  return Decoration.set([Decoration.widget({ widget: new ComposerWidget(hv.composer.el), block: true, side: 1 }).range(pos)])
}

const hunkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = tr.docChanged ? value.map(tr.changes) : value
    for (const e of tr.effects) if (e.is(setHunkView)) next = buildDecorations(tr.state, e.value)
    return next
  },
  provide: (f) => EditorView.decorations.from(f)
})

/**
 * Diff contra el texto de comparación (la base con lo aceptado aplicado): líneas añadidas con fondo,
 * bloques borrados encima con su resaltado de sintaxis, el cambio exacto dentro de la línea marcado
 * y una barra en el margen. Sin botones propios: aceptar y revertir son `A` y `R` (comandos).
 */
function mergeFor(original: string, changesOnly: boolean): Extension {
  return unifiedMergeView({
    original,
    gutter: true,
    mergeControls: false,
    highlightChanges: true,
    syntaxHighlightDeletions: true,
    collapseUnchanged: changesOnly ? { margin: COLLAPSE_MARGIN, minSize: COLLAPSE_MARGIN + 1 } : undefined
  })
}

/* ---------- tema y resaltado: todo por tokens de `tokens.css` ---------- */

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--bg-term)', color: 'var(--text)', fontSize: 'var(--editor-font-size, 13px)' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
    '.cm-content': { padding: '6px 0', caretColor: 'var(--text)' },
    '.cm-line': { padding: '0 10px 0 6px' },
    '.cm-gutters': { backgroundColor: 'var(--bg-term)', color: 'var(--text-4)', border: 'none' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 10px', minWidth: '34px' },
    '.cm-activeLine': { backgroundColor: 'var(--hover)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--surface-3)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '.cm-fat-cursor': { backgroundColor: 'var(--text)', color: 'var(--bg-term)' },
    '&:not(.cm-focused) .cm-fat-cursor': { backgroundColor: 'transparent', outline: '1px solid var(--text-3)', color: 'inherit' },
    '.cm-matchingBracket': { backgroundColor: 'var(--surface-2)' },
    // Diff (@codemirror/merge): añadido en verde suave, borrado en rojo suave, el cambio exacto subrayado.
    '.cm-changedLine': { backgroundColor: 'var(--diff-add-bg) !important' },
    '.cm-changedText': { background: 'none !important', textDecoration: 'underline 2px var(--diff-add-text)', textUnderlineOffset: '3px' },
    '.cm-deletedChunk': { backgroundColor: 'var(--diff-del-bg) !important', paddingLeft: '6px', color: 'var(--text-3)' },
    '.cm-deletedChunk .cm-deletedText': { background: 'none !important', textDecoration: 'line-through var(--diff-del-text)' },
    '.cm-changeGutter': { width: '4px', paddingLeft: '1px' },
    '.cm-changedLineGutter': { background: 'var(--diff-add-text) !important' },
    '.cm-deletedLineGutter': { background: 'var(--diff-del-text) !important' },
    '.cm-collapsedLines': { background: 'var(--surface) !important', color: 'var(--text-3) !important', fontFamily: 'var(--font)', fontSize: 'var(--fs-sm)', padding: '4px 10px' },
    '.cm-collapsedLines:hover': { color: 'var(--text) !important' },
    // Diagnósticos (@codemirror/lint): subrayado ondulado por severidad; la forma del margen también la dice.
    '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
    '.cm-lintRange-warning, .cm-lintRange-info, .cm-lintRange-hint': { backgroundImage: 'none', textDecoration: 'underline wavy var(--status-working)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
    '.cm-gutter-lint': { width: '14px' },
    '.cm-gutter-lint .cm-gutterElement': { padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center' },
    '.cm-lint-marker': { width: '8px', height: '8px', content: 'none' },
    '.cm-lint-marker-error': { content: 'none', borderRadius: '50%', backgroundColor: 'var(--danger)' },
    '.cm-lint-marker-warning, .cm-lint-marker-info': { content: 'none', backgroundColor: 'var(--status-working)', clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' },
    // Tooltips (errores y autocompletado): superficie de la paleta, sin bordes ni acentos laterales.
    '.cm-tooltip': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', border: 'none', borderRadius: '8px', boxShadow: 'var(--shadow)', overflow: 'hidden' },
    '.cm-tooltip-lint': { padding: '4px 0', maxWidth: '520px' },
    '.cm-diagnostic': { borderLeft: 'none', padding: '4px 12px', fontFamily: 'var(--font)', fontSize: 'var(--fs-sm)', whiteSpace: 'pre-wrap' },
    '.cm-diagnosticSeverity': { fontWeight: '600' },
    '.cm-diagnostic-error .cm-diagnosticSeverity': { color: 'var(--diff-del-text)' },
    '.cm-diagnostic-warning .cm-diagnosticSeverity, .cm-diagnostic-info .cm-diagnosticSeverity': { color: 'var(--status-working)' },
    '.cm-diagnosticSource': { color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 'var(--fs-xs)', opacity: '1' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', maxHeight: '220px', padding: '4px' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', borderRadius: '5px', color: 'var(--text-2)' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--surface-3)', color: 'var(--text)' },
    '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--text)', fontWeight: '600' },
    '.cm-completionDetail': { color: 'var(--text-3)', fontStyle: 'normal', marginLeft: '8px' },
    '.cm-completionIcon': { display: 'none' },
    // Servidor de lenguaje (§3.19b): tipos al pasar el mouse, firmas, renombrar y referencias.
    '.cm-tooltip.cm-lsp-hover-tooltip, .cm-tooltip .cm-lsp-signature-tooltip': { maxWidth: '560px' },
    '.cm-lsp-documentation': { padding: '6px 10px', fontFamily: 'var(--font)', fontSize: 'var(--fs-sm)', color: 'var(--text-2)', lineHeight: '1.45' },
    '.cm-lsp-documentation pre, .cm-lsp-documentation code': { fontFamily: 'var(--mono)', fontSize: 'var(--fs-xs)', color: 'var(--text)', whiteSpace: 'pre-wrap' },
    '.cm-lsp-documentation p, .cm-lsp-documentation pre': { margin: '2px 0' },
    '.cm-lsp-signature-tooltip': { padding: '4px 10px', borderRadius: '8px', fontSize: 'var(--fs-sm)' },
    '.cm-lsp-signature-tooltip .cm-lsp-signature': { fontFamily: 'var(--mono)', fontSize: 'var(--fs-xs)' },
    '.cm-lsp-signature-tooltip .cm-lsp-active-parameter': { color: 'var(--text)', fontWeight: '600' },
    '.cm-lsp-completion-documentation': { fontFamily: 'var(--font)', fontSize: 'var(--fs-sm)' },
    '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--border)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
    '.cm-panel.cm-lsp-rename-panel': { padding: '6px 10px', fontFamily: 'var(--font)', fontSize: 'var(--fs-sm)' },
    '.cm-panel.cm-lsp-rename-panel input': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '3px 6px', fontFamily: 'var(--mono)', fontSize: 'var(--fs-sm)', margin: '0 6px' },
    '.cm-panel.cm-lsp-rename-panel button': { backgroundColor: 'var(--surface-2)', color: 'var(--text-2)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '3px 8px', fontFamily: 'var(--font)', fontSize: 'var(--fs-xs)' },
    // Sin anillo de foco: la referencia elegida ya se marca con fondo (nada de marcos para selección).
    '.cm-lsp-reference-panel': { fontFamily: 'var(--mono)', fontSize: 'var(--fs-xs)', maxHeight: '160px', padding: '4px 6px', color: 'var(--text-2)', outline: 'none' },
    '.cm-lsp-reference-panel .cm-lsp-reference-file': { color: 'var(--text)', fontWeight: '600', padding: '4px 4px 2px' },
    '.cm-lsp-reference-panel .cm-lsp-reference': { padding: '1px 4px', borderRadius: '4px' },
    '.cm-lsp-reference-panel .cm-lsp-reference[aria-selected]': { backgroundColor: 'var(--surface-3)', color: 'var(--text)' },
    '.cm-lsp-reference-panel .cm-lsp-reference strong': { color: 'var(--text)', fontWeight: '600' },
    '.cm-lsp-reference-panel .cm-lsp-reference-line': { color: 'var(--text-4)', opacity: '1' }
  },
  { dark: true }
)

/**
 * Resaltado por clases (`tok-<tag>`), con los mismos tags que el estilo por defecto de CodeMirror
 * pero sin sus colores: los pone `editor.css` desde los tokens.
 */
const highlight = HighlightStyle.define(
  defaultHighlightStyle.specs.map((spec) => {
    const first = Array.isArray(spec.tag) ? spec.tag[0] : spec.tag
    return { tag: spec.tag, class: `tok-${String(first).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` }
  })
)

/** Textos que pintan merge, lint y autocomplete (CodeMirror los trae en inglés). */
const PHRASES: Record<string, string> = {
  '$ unchanged lines': '$ líneas sin cambios',
  Diagnostics: 'Errores',
  'No diagnostics': 'Sin errores',
  Completions: 'Sugerencias',
  close: 'cerrar',
  Accept: 'Aceptar',
  Reject: 'Revertir',
  'Revert this chunk': 'Revertir este bloque',
  // Servidor de lenguaje (§3.19b): renombrar y lista de referencias.
  'New name': 'Nombre nuevo',
  rename: 'renombrar',
  'Reference list': 'Referencias'
}

/**
 * Lenguajes sin sugerencias propias: completan con las palabras del archivo. Los demás (JS/TS,
 * Python, CSS, HTML, Go, Markdown) ya ofrecen variables del scope y snippets; sumarles las palabras
 * repetiría cada nombre en la lista.
 */
const WORDS_ONLY: ReadonlySet<LangId | null> = new Set<LangId | null>([null, 'json', 'yaml', 'rust'])
const anyWord = EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }])

function languageFor(id: LangId | null): Extension {
  return [languageSupport(id), WORDS_ONLY.has(id) ? anyWord : []]
}

function languageSupport(id: LangId | null): Extension {
  switch (id) {
    case 'javascript':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'typescript':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'json':
      return json()
    case 'markdown':
      return markdown()
    case 'css':
      return css()
    case 'html':
      return html()
    case 'python':
      return python()
    case 'go':
      return go()
    case 'rust':
      return rust()
    case 'yaml':
      return yaml()
    default:
      return []
  }
}

/* ---------- vim: teclas en NORMAL que son comandos de omni ---------- */

/** Teclas de NORMAL que son comandos de omni: `[tecla, acción vim, comandos a probar en orden]`. */
const VIM_KEYS: ReadonlyArray<[key: string, name: string, commandIds: string[]]> = [
  [']c', 'omniHunkNext', ['editor.hunk.next']],
  ['[c', 'omniHunkPrev', ['editor.hunk.prev']],
  ['A', 'omniHunkAccept', ['editor.hunk.accept']],
  // `R` prueba primero recargar (solo disponible si el archivo cambió en disco) y si no revierte el hunk.
  ['R', 'omniReloadOrRevert', ['editor.reload', 'editor.hunk.revert']],
  ['C', 'omniHunkComment', ['editor.hunk.comment']],
  [']d', 'omniDiagNext', ['editor.diagnostic.next']],
  ['[d', 'omniDiagPrev', ['editor.diagnostic.prev']],
  // Servidor de lenguaje (§3.19b): sin servidor caen a lo de vim (`gd` busca la declaración local).
  ['gd', 'omniDefinition', ['editor.definition']],
  ['gr', 'omniReferences', ['editor.references']]
]

/** `commands.run` ya es asíncrono; aquí se prueban en orden y se dice si alguno corrió. */
async function runFirst(ids: string[]): Promise<boolean> {
  for (const id of ids) if (await commands.run(id)) return true
  return false
}

/**
 * `]c [c A R C` en NORMAL llaman al registro de comandos (todo es un comando): la acción no tiene
 * lógica, solo despacha. Si ningún comando está disponible (no hay hunk bajo el cursor), la tecla
 * cae a lo que hace vim de fábrica (`A` append, `R` replace, `C` change): se quita el mapeo propio,
 * se vuelve a despachar la tecla y se restaura. Se definen una vez: `Vim` es global.
 */
function wireVim(): void {
  VIM_KEYS.forEach(([key, name, ids]) => {
    Vim.defineAction(name, (cm) => {
      void runFirst(ids).then((ran) => {
        if (ran) return
        Vim.unmap(key, 'normal')
        try {
          // `gd`, `]c`: se despachan tecla por tecla, como si el usuario las volviera a escribir.
          for (const k of key) Vim.handleKey(cm, k, 'mapping')
        } finally {
          Vim.mapCommand(key, 'action', name, {}, { context: 'normal' })
        }
      })
    })
    Vim.mapCommand(key, 'action', name, {}, { context: 'normal' })
  })
}

function unwireVim(): void {
  VIM_KEYS.forEach(([key]) => Vim.unmap(key, 'normal'))
}

function wireEvents(): void {
  if (wired) return
  wired = true
  wireVim()
  setLspHost({ diagnostics: onLspDiagnostics, display: displayPath })
  unsubscribe.push(onLspExit(onServerExit))
  // Un archivo vigilado cambió en disco: se recarga si el buffer está limpio; si no, aviso y `R`.
  unsubscribe.push(
    omni.on('file:changed', (workspaceId, path, mtime) => {
      instances.forEach((inst) => {
        if (inst.workspaceId !== workspaceId || inst.path !== path || mtime <= inst.mtime) return
        if (isDirty(inst)) {
          inst.mtime = mtime
          useEditor.getState().patch(inst.id, { changedOnDisk: true })
        } else void reloadDoc(inst.id)
      })
    })
  )
  unsubscribe.push(omni.on('session:exit', (id) => disposeEditor(id)))
}

// HMR: el módulo nuevo vuelve a suscribirse y a mapear vim; el viejo suelta lo suyo para no duplicar.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe.forEach((off) => off())
    unsubscribe = []
    if (wired) unwireVim()
    wired = false
  })
}

/* ---------- estado derivado del buffer ---------- */

const store = useEditor.getState

function isDirty(inst: Instance): boolean {
  const doc = inst.view.state.doc
  return doc.length !== inst.savedText.length || doc.toString() !== inst.savedText
}

function syncDirty(inst: Instance): void {
  const dirty = isDirty(inst)
  if (useDocs.getState().dirty[inst.id] === true !== dirty) useDocs.getState().setDirty(inst.id, dirty)
  syncTitle(inst, dirty)
}

/** Título de la sesión (franja y sidebar): ruta relativa, con `●` si está sucio. */
function syncTitle(inst: Instance, dirty: boolean): void {
  const ws = workspaceOf(useSessions.getState(), inst.workspaceId)
  const rel = ws ? relPath(ws.path, inst.path) : inst.path
  useSessions.getState().setTitle(inst.id, dirty ? `● ${rel}` : rel)
}

function currentLines(inst: Instance): string[] {
  return splitLines(inst.view.state.doc.toString())
}

function hunkView(inst: Instance, hunks: LineHunk[]): HunkView {
  const composer = store().docs[inst.id]?.composer
  return { hunks, composer: composer && inst.composerEl ? { line: composer.line, el: inst.composerEl } : null }
}

/**
 * Recalcula los hunks contra la base y filtra los vistos (son la fuente de verdad de `]c`, `A`, `R`,
 * `C` y `⌥⌘A`); el merge view compara contra la base con lo aceptado aplicado, así pinta lo mismo.
 */
function computeHunks(inst: Instance): void {
  clearTimeout(inst.diffTimer)
  const doc = store().docs[inst.id]
  if (!doc) return
  const lines = currentLines(inst)
  const all = inst.hasBase ? hunksOf(inst.baseLines, lines) : []
  const hunks = visibleHunks(all, lines, doc.seen)
  store().patch(inst.id, { hunks, lineCount: lines.length })
  const effects: StateEffect<unknown>[] = [setHunkView.of(hunkView(inst, hunks))]
  if (inst.hasBase) {
    const original = comparisonText(inst.baseText, inst.baseLines, lines, all, hunks)
    const current = getOriginalDoc(inst.view.state)
    if (current.toString() !== original) {
      const doc = Text.of(original.split('\n'))
      effects.push(updateOriginalDoc.of({ doc, changes: ChangeSet.of({ from: 0, to: current.length, insert: original }, current.length) }))
    }
  }
  inst.view.dispatch({ effects })
}

/** Monta o quita el diff según haya base, con o sin "solo cambios". */
function configureMerge(inst: Instance): void {
  const changesOnly = store().docs[inst.id]?.changesOnly === true
  inst.view.dispatch({ effects: inst.merge.reconfigure(inst.hasBase ? mergeFor(inst.baseText, changesOnly) : []) })
}

function scheduleHunks(inst: Instance): void {
  clearTimeout(inst.diffTimer)
  inst.diffTimer = window.setTimeout(() => computeHunks(inst), DIFF_SETTLE_MS)
}

/** Guarda la base del repo (`null`: archivo nuevo o sin repo, sin diff). */
function setBase(inst: Instance, base: string | null): void {
  inst.hasBase = base !== null
  inst.baseText = base ?? ''
  inst.baseLines = base === null ? [] : splitLines(base)
}

function cursorLine(inst: Instance): number {
  return inst.view.state.doc.lineAt(inst.view.state.selection.main.head).number - 1
}

/** Hunk visible bajo el cursor, o `null`. */
function hunkUnderCursor(inst: Instance): LineHunk | null {
  const doc = store().docs[inst.id]
  if (!doc) return null
  const i = hunkAt(doc.hunks, cursorLine(inst), inst.view.state.doc.lines)
  return i === null ? null : doc.hunks[i]
}

/* ---------- ciclo de vida ---------- */

function onFocusChange(inst: Instance, focused: boolean): void {
  if (focused) {
    useUi.getState().setFocus('terminal')
    useLayout.getState().focusSession(inst.id)
    useSessions.getState().syncCursor(inst.id)
    return
  }
  // Mismo criterio que el textarea de xterm, un tick después: si el foco siguió dentro de un pane
  // (este editor, su árbol o su compositor incluidos) o fue a un overlay, no pasa nada; si el pane
  // murió, la intención sigue en `terminal` y el vecino la toma.
  setTimeout(() => {
    const active = document.activeElement
    if (focusStays(active)) return
    if (!inst.el.isConnected) return
    useUi.getState().setFocus('list')
  }, 0)
}

function buildView(inst: Pick<Instance, 'id'>, lang: Compartment, merge: Compartment, lsp: Compartment, onUpdate: (u: { docChanged: boolean; selectionSet: boolean; focusChanged: boolean; hasFocus: boolean }) => void): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        // vim va antes que cualquier otro keymap (así lo pide @replit/codemirror-vim).
        vim(),
        lintGutter(),
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        indentUnit.of('  '),
        lang.of([]),
        merge.of([]),
        lsp.of([]),
        syntaxHighlighting(highlight),
        hunkField,
        // Autocompletado en INSERT: lo que ofrezca el lenguaje (snippets, palabras clave) más las
        // palabras del archivo. ⏎ acepta, ↑↓ eligen, Esc cierra; su keymap va antes que el resto.
        autocompletion({ icons: false }),
        Prec.high(keymap.of(completionKeymap)),
        EditorState.phrases.of(PHRASES),
        theme,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => onUpdate({ docChanged: u.docChanged, selectionSet: u.selectionSet, focusChanged: u.focusChanged, hasFocus: u.view.hasFocus })),
        EditorView.contentAttributes.of({ 'data-editor-id': inst.id, 'aria-label': 'Editor' })
      ]
    })
  })
}

/** Lee el archivo y su base, los mete al buffer y arranca la vigilancia. */
async function load(inst: Instance): Promise<void> {
  try {
    const [file, base] = await Promise.all([omni.invoke('file:read', inst.workspaceId, inst.path), omni.invoke('git:fileAtBase', inst.workspaceId, inst.path).catch((): string | null => null)])
    if (instances.get(inst.id) !== inst) return
    inst.savedText = file.text
    inst.mtime = file.mtime
    setBase(inst, base)
    inst.view.dispatch({ changes: { from: 0, to: inst.view.state.doc.length, insert: file.text }, selection: { anchor: 0 } })
    inst.view.dispatch({ effects: inst.lang.reconfigure(languageFor(langOf(inst.path).id)) })
    store().patch(inst.id, { loaded: true, error: null, base })
    configureMerge(inst)
    computeHunks(inst)
    syncDirty(inst)
    // El servidor primero: si es de TypeScript, el chequeo de herramientas ya no corre tsc.
    await attachLsp(inst)
    void checkDiagnostics(inst.id)
    void omni.invoke('file:watch', inst.workspaceId, inst.path).catch(() => undefined)
  } catch (e) {
    if (instances.get(inst.id) !== inst) return
    store().patch(inst.id, { loaded: true, error: errorText(e) })
  }
}

/** Crea (una sola vez) el editor de una sesión, desacoplado del DOM. */
export function ensureEditor(id: string, workspaceId: string, path: string): Instance {
  const existing = instances.get(id)
  if (existing) return existing
  wireEvents()
  store().ensure(id, workspaceId, path)
  const el = document.createElement('div')
  el.className = 'editor-root'
  const compartment = new Compartment()
  const mergeCompartment = new Compartment()
  const lspCompartment = new Compartment()
  let inst: Instance | null = null
  const view = buildView({ id }, compartment, mergeCompartment, lspCompartment, (u) => {
    if (!inst) return
    if (u.docChanged) {
      syncDirty(inst)
      scheduleHunks(inst)
    }
    if (u.docChanged || u.selectionSet) {
      const line = cursorLine(inst)
      if (store().docs[id]?.line !== line) store().patch(id, { line })
    }
    if (u.focusChanged) onFocusChange(inst, u.hasFocus)
  })
  el.appendChild(view.dom)
  inst = {
    id,
    workspaceId,
    path,
    view,
    el,
    lang: compartment,
    merge: mergeCompartment,
    savedText: '',
    mtime: 0,
    baseLines: [],
    baseText: '',
    hasBase: false,
    diffTimer: 0,
    checkSeq: 0,
    lspCompartment,
    lspServer: null,
    lspCoversTsc: false,
    toolDiagnostics: [],
    toolNames: [],
    lspDiagnostics: [],
    composerEl: null,
    focus() {
      // El árbol o el compositor ya tienen el teclado dentro de este pane: no se les quita.
      const root = el.closest('.editor')
      if (root?.contains(document.activeElement) && document.activeElement !== root) return
      const tree = root?.querySelector<HTMLElement>('.editor__tree')
      const composer = inst?.composerEl?.querySelector<HTMLElement>('textarea')
      if (composer) composer.focus()
      else if (tree) tree.focus()
      else view.focus()
    },
    blur() {
      const root = el.closest('.editor')
      const active = document.activeElement
      if (active instanceof HTMLElement && root?.contains(active)) active.blur()
    },
    fit: () => view.requestMeasure(),
    dispose() {
      clearTimeout(inst?.diffTimer)
      if (inst?.lspServer) releaseLsp(id, inst.lspServer)
      view.destroy()
      el.remove()
      instances.delete(id)
    }
  }
  const cm = getCM(view)
  cm?.on('vim-mode-change', (e: { mode: string }) => {
    const mode = e.mode.toUpperCase()
    store().patch(id, { mode: (mode === 'INSERT' || mode === 'VISUAL' || mode === 'REPLACE' ? mode : 'NORMAL') as VimMode })
  })
  instances.set(id, inst)
  syncTitle(inst, false)
  void load(inst)
  return inst
}

/** Monta el editor dentro de `parent` (reparenta: no se pierde el buffer ni el historial). */
export function attachEditor(id: string, workspaceId: string, path: string, parent: HTMLElement): Instance {
  const inst = ensureEditor(id, workspaceId, path)
  parent.appendChild(inst.el)
  inst.fit()
  return inst
}

export function detachEditor(id: string): void {
  instances.get(id)?.el.remove()
}

export function disposeEditor(id: string): void {
  const inst = instances.get(id)
  if (!inst) return
  void omni.invoke('file:unwatch', inst.workspaceId, inst.path).catch(() => undefined)
  inst.dispose()
  store().remove(id)
  useDocs.getState().setDirty(id, false)
}

export function getEditor(id: string): PaneHandle | undefined {
  return instances.get(id)
}

/* ---------- acciones (las llaman los comandos `editor.*`) ---------- */

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/**
 * `⌘S`. Si el archivo cambió en disco mientras el buffer estaba sucio, no se pisa a ciegas: abre el
 * overlay `confirmOverwriteDoc` (Sobrescribir / Recargar / Cancelar) y devuelve `false`; con `force`
 * escribe igual.
 */
export async function saveDoc(id: string, force = false): Promise<boolean> {
  const inst = instances.get(id)
  if (!inst) return false
  if (store().docs[id]?.changedOnDisk && !force) {
    useDocs.getState().askOverwrite(id)
    return false
  }
  const text = inst.view.state.doc.toString()
  try {
    const { mtime } = await omni.invoke('file:write', inst.workspaceId, inst.path, text)
    inst.savedText = text
    inst.mtime = mtime
    store().patch(id, { changedOnDisk: false })
    syncDirty(inst)
    store().notify(id, 'Guardado')
    void checkDiagnostics(id)
    return true
  } catch (e) {
    store().notify(id, `No se pudo guardar: ${errorText(e)}`)
    return false
  }
}

/** Vuelve a leer el archivo (y la base) conservando la línea del cursor. */
export async function reloadDoc(id: string): Promise<void> {
  const inst = instances.get(id)
  if (!inst) return
  const line = cursorLine(inst)
  try {
    const [file, base] = await Promise.all([omni.invoke('file:read', inst.workspaceId, inst.path), omni.invoke('git:fileAtBase', inst.workspaceId, inst.path).catch((): string | null => null)])
    if (instances.get(id) !== inst) return
    inst.savedText = file.text
    inst.mtime = file.mtime
    setBase(inst, base)
    inst.view.dispatch({ changes: { from: 0, to: inst.view.state.doc.length, insert: file.text } })
    const target = inst.view.state.doc.line(Math.min(line + 1, inst.view.state.doc.lines))
    inst.view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true })
    store().patch(id, { changedOnDisk: false, error: null, base })
    configureMerge(inst)
    computeHunks(inst)
    syncDirty(inst)
    void checkDiagnostics(id)
    store().notify(id, 'Recargado desde disco')
  } catch (e) {
    store().notify(id, `No se pudo recargar: ${errorText(e)}`)
  }
}

export function gotoHunk(id: string, delta: 1 | -1): void {
  const inst = instances.get(id)
  const doc = store().docs[id]
  if (!inst || !doc) return
  const lines = inst.view.state.doc.lines
  const i = nextHunkIndex(doc.hunks, cursorLine(inst), lines, delta)
  if (i === null) return
  const pos = inst.view.state.doc.line(hunkAnchorLine(doc.hunks[i], lines) + 1).from
  inst.view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
}

/** `A`: el hunk bajo el cursor deja de pintarse hasta que su texto vuelva a cambiar. */
export function acceptHunk(id: string): void {
  const inst = instances.get(id)
  if (!inst) return
  // Los hunks se recalculan con retardo tras editar: aquí se quieren al día antes de decidir.
  computeHunks(inst)
  const doc = store().docs[id]
  const hunk = hunkUnderCursor(inst)
  if (!doc || !hunk) return
  store().patch(id, { seen: markSeen(hunk, currentLines(inst), doc.seen) })
  computeHunks(inst)
  store().notify(id, 'Cambio aceptado')
}

/**
 * `R`: reemplaza el hunk bajo el cursor por el texto de la base. Con el buffer limpio se guarda al
 * toque; si ya tenía cambios sin guardar, no se escribe nada en disco (sería guardar lo demás sin
 * que el usuario lo pidiera) y la franja lo dice.
 */
export async function revertHunk(id: string): Promise<void> {
  const inst = instances.get(id)
  if (!inst) return
  computeHunks(inst)
  const hunk = hunkUnderCursor(inst)
  if (!hunk) return
  const wasDirty = isDirty(inst)
  const text = inst.view.state.doc.toString()
  const next = revertedText(text, inst.baseLines, hunk)
  const anchor = hunkAnchorLine(hunk, Math.max(1, splitLines(next).length))
  inst.view.dispatch({ changes: { from: 0, to: text.length, insert: next } })
  const target = inst.view.state.doc.line(Math.min(anchor + 1, inst.view.state.doc.lines))
  inst.view.dispatch({ selection: EditorSelection.cursor(target.from), scrollIntoView: true })
  computeHunks(inst)
  if (wasDirty) store().notify(id, 'Cambio revertido sin guardar (⌘S)')
  else if (await saveDoc(id)) store().notify(id, 'Cambio revertido y guardado')
}

/** `C`: abre el compositor bajo el hunk del cursor. */
export function openComposer(id: string): void {
  const inst = instances.get(id)
  if (!inst) return
  computeHunks(inst)
  const doc = store().docs[id]
  const hunk = hunkUnderCursor(inst)
  if (!doc || !hunk) return
  const line = hunkAnchorLine(hunk, inst.view.state.doc.lines)
  if (doc.composer?.line === line) return
  const el = document.createElement('div')
  el.className = 'editor__composer-slot'
  inst.composerEl = el
  store().patch(id, { composer: { line, text: '', el } })
  inst.view.dispatch({ effects: setHunkView.of(hunkView(inst, doc.hunks)) })
}

export function setComposerText(id: string, text: string): void {
  const doc = store().docs[id]
  if (doc?.composer) store().patch(id, { composer: { ...doc.composer, text } })
}

export function cancelComposer(id: string): void {
  const inst = instances.get(id)
  const doc = store().docs[id]
  if (!inst || !doc?.composer) return
  inst.composerEl = null
  store().patch(id, { composer: null })
  inst.view.dispatch({ effects: setHunkView.of(hunkView(inst, doc.hunks)) })
  inst.view.focus()
}

/** Nombre visible del agente del workspace, o `null` sin agente. */
function agentFor(inst: Instance): { id: string; name: string } | null {
  const s = useSessions.getState()
  const agent = workspaceAgent(s.sessions, inst.workspaceId)
  return agent ? { id: agent.id, name: agentOf(s, agent.agent)?.name ?? agent.agent } : null
}

async function deliver(inst: Instance, text: string, submit: boolean, what: string): Promise<void> {
  const agent = agentFor(inst)
  if (agent) {
    writeToSession(agent.id, text, submit)
    store().notify(inst.id, `${what} a ${agent.name}`)
  } else {
    await navigator.clipboard.writeText(text)
    store().notify(inst.id, 'Sin agente en el workspace: copiado al portapapeles')
  }
}

/** `⌘⏎` en el compositor: `ruta:línea: texto` al agente del workspace (o al portapapeles). */
export async function submitComposer(id: string): Promise<void> {
  const inst = instances.get(id)
  const doc = store().docs[id]
  if (!inst || !doc?.composer) return
  const text = doc.composer.text.trim()
  if (text === '') return cancelComposer(id)
  const ws = workspaceOf(useSessions.getState(), inst.workspaceId)
  const rel = ws ? relPath(ws.path, inst.path) : inst.path
  const line = doc.composer.line
  cancelComposer(id)
  await deliver(inst, formatComment(rel, line + 1, text), true, 'Comentario enviado')
}

/** `⌥⌘A`: el archivo y sus hunks actuales como contexto, sin ⏎ (el usuario sigue escribiendo). */
export async function sendContext(id: string): Promise<void> {
  const inst = instances.get(id)
  const doc = store().docs[id]
  if (!inst || !doc) return
  if (doc.hunks.length === 0 && doc.diagnostics.length === 0) return store().notify(id, 'Sin cambios ni errores que mandar')
  const ws = workspaceOf(useSessions.getState(), inst.workspaceId)
  const rel = ws ? relPath(ws.path, inst.path) : inst.path
  await deliver(inst, formatContext(rel, doc.hunks, currentLines(inst), inst.baseLines, doc.diagnostics), false, 'Contexto enviado')
}

/* ---------- diagnósticos (tsc, eslint) y "solo cambios" ---------- */

/** Pasa un diagnóstico de main al formato de CodeMirror, con el rango sobre el buffer actual. */
function toCmDiagnostic(state: EditorState, starts: number[], text: string, d: CodeDiagnostic): Diagnostic {
  const { from, to } = diagnosticRange(starts, text, d)
  return {
    from: Math.min(from, state.doc.length),
    to: Math.min(to, state.doc.length),
    severity: d.severity,
    message: d.message,
    source: d.code ? `${d.source} ${d.code}` : d.source,
    // La severidad va escrita, no solo en color: "error · mensaje" / "aviso · mensaje".
    renderMessage: () => {
      const el = document.createElement('span')
      const label = document.createElement('span')
      label.className = 'cm-diagnosticSeverity'
      label.textContent = d.severity === 'error' ? 'error' : 'aviso'
      el.append(label, ` · ${d.message}`)
      return el
    }
  }
}

/**
 * Pinta juntos los errores del servidor de lenguaje (en vivo) y los del último chequeo de
 * herramientas, y los publica para la cabecera, `]d` y `⌥⌘A`.
 */
function renderDiagnostics(inst: Instance): void {
  const state = inst.view.state
  const text = state.doc.toString()
  const starts: number[] = []
  for (let i = 1; i <= state.doc.lines; i++) starts.push(state.doc.line(i).from)
  const all = [...inst.lspDiagnostics, ...inst.toolDiagnostics].sort((a, b) => a.line - b.line || a.col - b.col)
  inst.view.dispatch(setDiagnostics(state, all.map((d) => toCmDiagnostic(state, starts, text, d))))
  store().patch(inst.id, { diagnostics: all, diagnosticTools: inst.toolNames })
}

/**
 * Corre las herramientas del proyecto sobre el archivo (en disco: se llama al abrir, recargar y
 * guardar): eslint siempre, tsc solo si no hay servidor de TypeScript (sus errores ya llegan en vivo).
 * Una respuesta vieja (otro chequeo empezó después) se descarta. Sin herramientas no pasa nada.
 */
export async function checkDiagnostics(id: string): Promise<void> {
  const inst = instances.get(id)
  if (!inst) return
  const seq = ++inst.checkSeq
  store().patch(id, { checking: true })
  try {
    const skip: Array<'tsc' | 'eslint'> = inst.lspCoversTsc ? ['tsc'] : []
    const { diagnostics, tools } = await omni.invoke('diagnostics:check', inst.workspaceId, inst.path, skip)
    if (instances.get(id) !== inst || inst.checkSeq !== seq) return
    inst.toolDiagnostics = diagnostics
    inst.toolNames = tools
    store().patch(id, { checking: false })
    renderDiagnostics(inst)
  } catch {
    if (instances.get(id) === inst && inst.checkSeq === seq) store().patch(id, { checking: false })
  }
}

/* ---------- servidor de lenguaje (§3.19b) ---------- */

/** Conecta el editor al servidor de su lenguaje si el proyecto tiene uno; sin servidor no cambia nada. */
async function attachLsp(inst: Instance): Promise<void> {
  if (inst.lspServer) return
  try {
    const lsp = await connectLsp(inst.id, inst.workspaceId, inst.path)
    if (!lsp || instances.get(inst.id) !== inst) {
      if (lsp) releaseLsp(inst.id, lsp.info.id)
      return
    }
    inst.lspServer = lsp.info.id
    inst.lspCoversTsc = lsp.info.kind === 'typescript' || lsp.info.kind === 'tsgo'
    inst.view.dispatch({ effects: inst.lspCompartment.reconfigure(lsp.extension) })
    store().patch(inst.id, { lsp: { name: lsp.info.name, state: 'ready', error: null } })
  } catch (e) {
    // Servidor roto o binario ausente: el editor sigue con tsc/eslint al guardar.
    if (instances.get(inst.id) === inst) store().patch(inst.id, { lsp: { name: 'Servidor de lenguaje', state: 'error', error: errorText(e) } })
  }
}

function instanceOfView(view: EditorView): Instance | undefined {
  for (const inst of instances.values()) if (inst.view === view) return inst
  return undefined
}

function onLspDiagnostics(view: EditorView, diagnostics: CodeDiagnostic[]): void {
  const inst = instanceOfView(view)
  if (!inst) return
  inst.lspDiagnostics = diagnostics.map((d) => ({ ...d, path: inst.path }))
  renderDiagnostics(inst)
}

/** El servidor murió: sus editores vuelven a tsc/eslint al guardar y la cabecera dice por qué. */
function onServerExit(serverId: string, error: string | null): void {
  instances.forEach((inst) => {
    if (inst.lspServer !== serverId) return
    inst.lspServer = null
    inst.lspCoversTsc = false
    inst.lspDiagnostics = []
    inst.view.dispatch({ effects: inst.lspCompartment.reconfigure([]) })
    const name = store().docs[inst.id]?.lsp?.name ?? 'Servidor de lenguaje'
    store().patch(inst.id, { lsp: error ? { name, state: 'error', error } : null })
    renderDiagnostics(inst)
    void checkDiagnostics(inst.id)
  })
}

/**
 * Ir a definición o referencias en otro archivo: se abre (o se enfoca) su editor a la derecha y se
 * espera a que tenga el texto, para que el salto caiga en la posición correcta.
 */
async function displayPath(workspaceId: string, path: string): Promise<EditorView | null> {
  const open = [...instances.values()].find((i) => i.workspaceId === workspaceId && i.path === path)
  // `open` enfoca el editor si ya estaba abierto; si no, lo abre a la derecha.
  const info = await useDocs
    .getState()
    .open(workspaceId, path, 'editor', 'split-right')
    .catch(() => null)
  const id = info?.id ?? open?.id
  if (!id) return null
  for (let i = 0; i < 100; i++) {
    const inst = instances.get(id)
    if (inst && store().docs[id]?.loaded) return inst.view
    await new Promise((r) => setTimeout(r, 50))
  }
  return instances.get(id)?.view ?? null
}

/** Hay servidor conectado en este editor (los comandos `gd`, `gr`, F2 solo se ofrecen entonces). */
export function editorHasLsp(id: string): boolean {
  const inst = instances.get(id)
  return !!inst && hasLsp(inst.view)
}

export function gotoDefinition(id: string): void {
  const inst = instances.get(id)
  if (inst && !lspDefinition(inst.view)) store().notify(id, 'El servidor no sabe ir a la definición')
}

export function showReferences(id: string): void {
  const inst = instances.get(id)
  if (inst) lspReferences(inst.view)
}

export function renameAtCursor(id: string): void {
  const inst = instances.get(id)
  if (inst) lspRename(inst.view)
}

/**
 * `]d` / `[d`: al error siguiente o anterior (con vuelta), con su mensaje en un tooltip. CodeMirror
 * selecciona el rango del error y vim lo tomaría como VISUAL: se deja solo el cursor al inicio (el
 * tooltip sigue mientras el cursor esté dentro del rango).
 */
export function gotoDiagnostic(id: string, delta: 1 | -1): void {
  const inst = instances.get(id)
  if (!inst) return
  const moved = delta === 1 ? nextDiagnostic(inst.view) : previousDiagnostic(inst.view)
  if (!moved) return
  inst.view.dispatch({ selection: EditorSelection.cursor(inst.view.state.selection.main.from) })
  const cm = getCM(inst.view)
  // Con `state.vim` presente, `cm` es el CodeMirrorV que pide `exitVisualMode` (el tipo no lo deduce).
  if (cm?.state.vim?.visualMode) Vim.exitVisualMode(cm as Parameters<typeof Vim.exitVisualMode>[0])
}

/** Pliega o despliega las partes sin cambios del diff (quedan 3 líneas alrededor de cada cambio). */
export function toggleChangesOnly(id: string): void {
  const inst = instances.get(id)
  const doc = store().docs[id]
  if (!inst || !doc) return
  store().patch(id, { changesOnly: !doc.changesOnly })
  configureMerge(inst)
  computeHunks(inst)
}

/* ---------- árbol de archivos (⌘E) ---------- */

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

async function loadTree(inst: Instance, dir: string): Promise<void> {
  const prev = store().docs[inst.id]?.tree
  store().patch(inst.id, { tree: { dir, entries: prev?.dir === dir ? prev.entries : [], cursor: 0, loading: true } })
  try {
    const { entries, truncated } = await omni.invoke('files:tree', inst.workspaceId, dir)
    if (store().docs[inst.id]?.tree?.dir !== dir) return
    // El cursor arranca sobre el archivo abierto si está en este directorio.
    const rows = treeRows(inst, dir, entries)
    const own = rows.findIndex((r) => r.path === inst.path)
    store().patch(inst.id, { tree: { dir, entries, cursor: Math.max(0, own), loading: false } })
    if (truncated) store().notify(inst.id, 'Carpeta muy grande: la lista se cortó')
  } catch (e) {
    store().patch(inst.id, { tree: { dir, entries: [], cursor: 0, loading: false } })
    store().notify(inst.id, `No se pudo listar: ${errorText(e)}`)
  }
}

export interface TreeRow {
  key: string
  name: string
  path: string
  dir: boolean
  /** Fila `..` (directorio padre). */
  up?: boolean
}

/** Filas del árbol: `..` si no es la raíz del workspace, luego las entradas (carpetas primero, como las da main). */
export function treeRows(inst: Pick<Instance, 'workspaceId'>, dir: string, entries: { name: string; path: string; dir: boolean }[]): TreeRow[] {
  const ws = workspaceOf(useSessions.getState(), inst.workspaceId)
  const root = ws?.path ?? '/'
  const rows: TreeRow[] = []
  if (dir !== root && dir.startsWith(root)) rows.push({ key: '..', name: '..', path: dirname(dir), dir: true, up: true })
  entries.forEach((e) => rows.push({ key: e.path, name: e.name, path: e.path, dir: e.dir }))
  return rows
}

export function toggleTree(id: string): void {
  const inst = instances.get(id)
  const doc = store().docs[id]
  if (!inst || !doc) return
  if (doc.tree) return closeTree(id)
  void loadTree(inst, dirname(inst.path))
}

export function closeTree(id: string): void {
  const inst = instances.get(id)
  if (!inst || !store().docs[id]?.tree) return
  store().patch(id, { tree: null })
  inst.view.focus()
}

export function treeMove(id: string, delta: number): void {
  const inst = instances.get(id)
  const tree = store().docs[id]?.tree
  if (!inst || !tree) return
  const n = treeRows(inst, tree.dir, tree.entries).length
  if (n === 0) return
  store().patch(id, { tree: { ...tree, cursor: (tree.cursor + delta + n) % n } })
}

export function treeSetCursor(id: string, cursor: number): void {
  const tree = store().docs[id]?.tree
  if (tree) store().patch(id, { tree: { ...tree, cursor } })
}

/** `⏎`: entra a la carpeta, o abre el archivo en este pane (un editor nuevo al lado y este se cierra). */
export function treeEnter(id: string): void {
  const inst = instances.get(id)
  const tree = store().docs[id]?.tree
  if (!inst || !tree) return
  const row = treeRows(inst, tree.dir, tree.entries)[tree.cursor]
  if (!row) return
  if (row.dir) return void loadTree(inst, row.path)
  if (row.path === inst.path) return closeTree(id)
  closeTree(id)
  void useDocs
    .getState()
    .open(inst.workspaceId, row.path, 'editor', 'split-right')
    .then((info) => {
      if (info && info.id !== id) useDocs.getState().closeIfClean(id)
    })
}

/** `h` / `⌫`: sube al directorio padre. */
export function treeUp(id: string): void {
  const inst = instances.get(id)
  const tree = store().docs[id]?.tree
  if (!inst || !tree) return
  const ws = workspaceOf(useSessions.getState(), inst.workspaceId)
  if (tree.dir === (ws?.path ?? '/')) return
  void loadTree(inst, dirname(tree.dir))
}
