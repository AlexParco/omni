// Editor con @codemirror/merge, lint y autocomplete (§3.19): diff contra la base pintado por merge
// (líneas cambiadas, bloque borrado, marca exacta del cambio, barra en el margen), `A` acepta y deja
// de pintarse, "Solo cambios" pliega lo demás, tsc del proyecto subraya el error con su marca en el
// margen, `]d` salta a él con su mensaje, `⌥⌘A` lo manda como contexto y el autocompletado ofrece
// palabras del archivo en INSERT. Repo de prueba en ~/private/omni-e2e-repo.
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = join(homedir(), 'private', 'omni-e2e-repo')
const OMNI = resolve(import.meta.dirname, '..', '..')
const git = (args) => execSync(`git -C ${JSON.stringify(REPO)} ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const MOD = { sessions: `import('/src/store/sessions.ts')`, ui: `import('/src/store/ui.ts')`, docs: `import('/src/store/docs.ts')`, editor: `import('/src/panes/editor/editor-store.ts')` }

// 12 líneas sin cambios entre los dos cambios: "Solo cambios" tiene algo que plegar.
const FILLER = Array.from({ length: 12 }, (_, i) => `export const F${i} = ${i}`)
const BASE = ['export function total(items: number[]): number {', '  let acc = 0', '  for (const x of items) acc += x', '  return acc', '}', '', ...FILLER, 'export const LIMITE = 10', 'export const NOMBRE = "calc"', ''].join('\n')
// Cambia una línea (acc → suma), borra NOMBRE y agrega una línea con un error de tipos.
const CHANGED = ['export function total(items: number[]): number {', '  let suma = 0', '  for (const x of items) suma += x', '  return suma', '}', '', ...FILLER, 'export const LIMITE = 10', 'export const malo: number = "texto"', ''].join('\n')
/** Línea (base 1) del error de tipos en CHANGED. */
const ERROR_LINE = 8 + FILLER.length

export default async function (api, t) {
  const { press, type, evaluate, snapshot, sleep, waitFor } = api
  // Repo limpio en su commit raíz + calc.ts y un tsconfig commiteados como base; tsc del proyecto = el de omni.
  const root = git('rev-list --max-parents=0 HEAD'); git('checkout -q main'); git(`reset -q --hard ${root}`); git('clean -qfdx')
  writeFileSync(join(REPO, 'calc.ts'), BASE)
  writeFileSync(join(REPO, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022' }, include: ['*.ts'] }))
  git('add calc.ts tsconfig.json'); git('-c user.email=e2e@omni -c user.name=e2e commit -q -m "e2e calc"')
  mkdirSync(join(REPO, 'node_modules', '.bin'), { recursive: true })
  // El shim de pnpm resuelve rutas desde su carpeta: un symlink lo rompe. Un shim propio que delega sí sirve.
  writeFileSync(join(REPO, 'node_modules', '.bin', 'tsc'), `#!/bin/sh\nexec ${JSON.stringify(join(OMNI, 'node_modules', '.bin', 'tsc'))} "$@"\n`, { mode: 0o755 })
  writeFileSync(join(REPO, 'calc.ts'), CHANGED)

  await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().setView('fleet'))`)
  const stale = await evaluate(`window.omni.invoke('project:list').then((r) => r.projects.find((p) => p.path === ${JSON.stringify(REPO)})?.id ?? null)`)
  if (stale) { await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(stale)})`); await sleep(400) }
  const added = await evaluate(`window.omni.invoke('project:addPath', ${JSON.stringify(REPO)})`)
  await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().reloadProjects().then(() => m.useSessions.getState().setWorkspace(${JSON.stringify(added.workspace.id)})))`)
  await sleep(300)
  await evaluate(`${MOD.docs}.then((m) => m.useDocs.getState().open(${JSON.stringify(added.workspace.id)}, ${JSON.stringify(join(REPO, 'calc.ts'))}, 'editor', 'tab'))`)
  t.check('calc.ts abre en el editor', await waitFor(`/export function total/.test(document.querySelector('.pane .editor .cm-content')?.textContent ?? '')`, 6000), JSON.stringify(await snapshot()))
  const editorId = await evaluate(`document.querySelector('.pane .editor')?.dataset.sessionId ?? null`)
  const docState = (expr) => evaluate(`${MOD.editor}.then((m) => { const d = m.useEditor.getState().docs[${JSON.stringify(editorId)}]; return ${expr} })`)

  // Diff pintado por @codemirror/merge
  t.check('merge pinta las líneas cambiadas', await waitFor(`document.querySelectorAll('.pane .editor .cm-changedLine').length >= 3`, 4000), String(await evaluate(`document.querySelectorAll('.pane .editor .cm-changedLine').length`)))
  t.check('el bloque borrado se ve encima, con el texto de la base', await evaluate(`[...document.querySelectorAll('.pane .editor .cm-deletedChunk')].some((c) => /acc/.test(c.textContent) && /NOMBRE/.test(document.querySelector('.pane .editor .cm-content').textContent + [...document.querySelectorAll('.pane .editor .cm-deletedChunk')].map((x) => x.textContent).join('')))`), await evaluate(`[...document.querySelectorAll('.pane .editor .cm-deletedChunk')].map((c) => c.textContent).join(' | ')`))
  t.check('el cambio exacto dentro de la línea se marca', await evaluate(`[...document.querySelectorAll('.pane .editor .cm-changedText')].some((e) => /suma/.test(e.textContent))`))
  t.check('barra del diff en el margen', await evaluate(`document.querySelectorAll('.pane .editor .cm-changedLineGutter').length >= 3`))
  const hunks0 = await docState('d.hunks.length')
  t.check('la cabecera cuenta los cambios', hunks0 >= 2 && new RegExp(`${hunks0} cambios`).test(await evaluate(`document.querySelector('.editor__bar')?.textContent ?? ''`)), String(hunks0))

  // A acepta el primer cambio: deja de pintarse
  await evaluate(`document.querySelector('.pane .editor .cm-content')?.focus()`)
  await press('g'); await press('g'); await sleep(100)
  await press(']'); await press('c'); await sleep(100)
  const before = await evaluate(`document.querySelectorAll('.pane .editor .cm-changedLine').length`)
  await press('A'); await sleep(300)
  t.check('A acepta el cambio: un hunk menos y merge deja de pintarlo', (await docState('d.hunks.length')) === hunks0 - 1 && (await evaluate(`document.querySelectorAll('.pane .editor .cm-changedLine').length`)) < before, JSON.stringify({ hunks: await docState('d.hunks.length'), lines: await evaluate(`document.querySelectorAll('.pane .editor .cm-changedLine').length`) }))
  t.check('A no entró a INSERT (no es el append de vim)', (await evaluate(`document.querySelector('.pane .editor')?.dataset.mode`)) === 'NORMAL')

  // Solo cambios
  await press('cmd+shift+d')
  t.check('Solo cambios pliega lo que no cambió', (await waitFor(`/\\d+ líneas sin cambios/.test(document.querySelector('.pane .editor .cm-collapsedLines')?.textContent ?? '')`, 1500)) && (await docState('d.changesOnly')) === true && !/F6 = 6/.test(await evaluate(`document.querySelector('.pane .editor .cm-content')?.textContent ?? ''`)), JSON.stringify({ on: await docState('d.changesOnly'), focus: await evaluate(`document.activeElement?.className ?? ''`), mode: await evaluate(`document.querySelector('.pane .editor')?.dataset.mode`), collapsed: await evaluate(`[...document.querySelectorAll('.pane .editor .cm-collapsedLines')].map((c) => c.textContent)`) }))
  if (process.env.E2E_SHOTS) await api.screenshot(`${process.env.E2E_SHOTS}/editor-collapsed.png`)
  t.check('el botón Solo cambios queda encendido', await evaluate(`[...document.querySelectorAll('.editor__actions .btn')].some((b) => /Solo cambios/.test(b.textContent) && b.dataset.on === 'true')`))
  await press('cmd+shift+d')
  t.check('otra vez muestra el archivo entero', (await docState('d.changesOnly')) === false && (await evaluate(`document.querySelectorAll('.pane .editor .cm-collapsedLines').length`)) === 0)
  t.check('alternar Solo cambios no toca el buffer', (await docState('d.lineCount')) === ERROR_LINE && /malo: number/.test(await evaluate(`document.querySelector('.pane .editor .cm-content')?.textContent ?? ''`)), JSON.stringify({ lines: await docState('d.lineCount'), text: (await evaluate(`document.querySelector('.pane .editor .cm-content')?.textContent ?? ''`)).slice(0, 120) }))

  // Diagnósticos de tsc
  t.check('tsc del proyecto corre y la cabecera dice 1 error', await waitFor(`/1 error/.test(document.querySelector('.editor__diagnostics')?.textContent ?? '')`, 15000), JSON.stringify(await docState('({ tools: d.diagnosticTools, n: d.diagnostics.length, checking: d.checking })')))
  t.check('el error se subraya en su línea y tiene marca redonda en el margen', await evaluate(`[...document.querySelectorAll('.pane .editor .cm-lintRange-error')].some((e) => /malo/.test(e.textContent)) && !!document.querySelector('.pane .editor .cm-lint-marker-error')`), await evaluate(`[...document.querySelectorAll('.pane .editor .cm-lintRange-error')].map((e) => e.textContent).join('|')`))
  await press('g'); await press('g'); await sleep(80)
  await press(']'); await press('d'); await sleep(400)
  t.check(']d lleva el cursor a la línea del error', (await docState('d.line')) === ERROR_LINE - 1, String(await docState('d.line')))
  t.check(']d muestra el mensaje con su herramienta y código', await waitFor(`/TS2322/.test(document.querySelector('.cm-tooltip-lint')?.textContent ?? '') && /error/.test(document.querySelector('.cm-tooltip-lint')?.textContent ?? '')`, 2000), await evaluate(`document.querySelector('.cm-tooltip-lint')?.textContent ?? 'sin tooltip'`))
  t.check(']d deja el cursor en NORMAL (sin selección visual)', (await evaluate(`document.querySelector('.pane .editor')?.dataset.mode`)) === 'NORMAL', await evaluate(`document.querySelector('.pane .editor')?.dataset.mode`))
  if (process.env.E2E_SHOTS) await api.screenshot(`${process.env.E2E_SHOTS}/editor-lint.png`)
  await press('escape'); await sleep(100)

  // ⌥⌘A con los errores (sin agente en el workspace → portapapeles)
  await press('cmd+alt+a'); await sleep(400)
  const clip = execSync('pbpaste', { encoding: 'utf8' })
  t.check('⌥⌘A manda los cambios y el error con archivo:línea:col y [tsc TS2322]', new RegExp(`calc\\.ts:${ERROR_LINE}:\\d+: \\[tsc TS2322\\]`).test(clip) && /@@/.test(clip), clip)

  // Autocompletado con palabras del archivo
  await press('G'); await press('o'); await sleep(100)
  await type('const z = LIM'); await sleep(400)
  t.check('en INSERT se ofrecen nombres del archivo, sin repetir', await waitFor(`[...document.querySelectorAll('.cm-tooltip-autocomplete li')].filter((li) => li.textContent.startsWith('LIMITE')).length === 1`, 2000), await evaluate(`document.querySelector('.cm-tooltip-autocomplete')?.textContent ?? 'sin lista'`))
  if (process.env.E2E_SHOTS) await api.screenshot(`${process.env.E2E_SHOTS}/editor-complete.png`)
  await press('enter'); await sleep(150)
  t.check('⏎ acepta la sugerencia sin partir la línea', await evaluate(`[...document.querySelectorAll('.pane .editor .cm-content > .cm-line')].some((l) => l.textContent === 'const z = LIMITE')`), await evaluate(`[...document.querySelectorAll('.pane .editor .cm-content > .cm-line')].slice(-3).map((l) => l.textContent).join(' ⏎ ')`))
  await press('escape'); await sleep(100)
  // Deshace lo escrito y cierra sin guardar.
  await press('u'); await sleep(150)

  // Limpieza: cerrar el editor (descartando si quedó sucio), quitar el proyecto, repo a su raíz.
  await evaluate(`window.omni.send('session:kill', ${JSON.stringify(editorId)})`)
  await sleep(300)
  const proj = await evaluate(`window.omni.invoke('project:list').then((r) => r.projects.find((p) => p.path === ${JSON.stringify(REPO)})?.id ?? null)`)
  if (proj) await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(proj)})`)
  git(`reset -q --hard ${root}`); git('clean -qfdx')
  t.check('el repo de prueba volvió a su commit inicial', git('rev-parse HEAD') === root && !existsSync(join(REPO, 'calc.ts')) && readFileSync(join(REPO, 'sum.js'), 'utf8').length > 0)
}
