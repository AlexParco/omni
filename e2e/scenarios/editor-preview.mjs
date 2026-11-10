// Editor y vista previa (§3.19, §3.20): abrir un archivo del repo de prueba desde el quick open en el
// editor (split), editar en INSERT, guardar, cambios del agente contra la base, comentario al agente,
// árbol de archivos, alternar a la vista previa (Markdown) y cerrar un buffer sucio con confirmación.
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { ensurePane, closePanes } from './_helpers.mjs'

const REPO = join(homedir(), 'private', 'omni-e2e-repo')
const git = (args) => execSync(`git -C ${JSON.stringify(REPO)} ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const MOD = { sessions: `import('/src/store/sessions.ts')`, ui: `import('/src/store/ui.ts')`, docs: `import('/src/store/docs.ts')`, host: `import('/src/panes/terminal/terminal-host.ts')` }

export default async function (api, t) {
  const { press, type, evaluate, snapshot, sleep, waitFor } = api
  const rect = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })()`)
  const root = git('rev-list --max-parents=0 HEAD'); git('checkout -q main'); git(`reset -q --hard ${root}`); git('clean -qfd')
  await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().setView('fleet'))`)
  const stale = await evaluate(`window.omni.invoke('project:list').then((r) => r.projects.find((p) => p.path === ${JSON.stringify(REPO)})?.id ?? null)`)
  if (stale) { await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(stale)})`); await sleep(400) }
  const added = await evaluate(`window.omni.invoke('project:addPath', ${JSON.stringify(REPO)})`)
  const projectId = added.project.id
  await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().reloadProjects().then(() => m.useSessions.getState().setWorkspace(${JSON.stringify(added.workspace.id)})))`)
  await sleep(300)
  await ensurePane(api)
  const shellId = await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0]?.id)`)

  // Quick open: /sum.js + ⌘⏎ → editor en split
  await press('cmd+k'); await waitFor(`!!document.querySelector('.quickopen')`)
  await type('/sum.js')
  t.check('el quick open encuentra sum.js', await waitFor(`[...document.querySelectorAll('.quickopen__list .row')].some((r) => /^sum\\.js/.test(r.textContent.trim()))`, 5000))
  const idx = await evaluate(`[...document.querySelectorAll('.quickopen__list .row')].findIndex((r) => /^sum\\.js/.test(r.textContent.trim()))`)
  for (let i = 0; i < Math.max(0, idx); i++) await press('down')
  await press('cmd+enter')
  t.check('⌘⏎ abre el editor en un split', await waitFor(`!!document.querySelector('.pane .editor') && document.querySelectorAll('.pane').length === 2`, 6000), JSON.stringify(await snapshot()))
  const editorId = await evaluate(`document.querySelector('.pane .editor')?.dataset.sessionId ?? null`)
  t.check('la sesión del editor existe en main con args [ruta]', await evaluate(`window.omni.invoke('session:list').then((l) => { const s = l.find((x) => x.id === ${JSON.stringify(editorId)}); return !!s && s.agent === 'editor' && /sum\\.js$/.test(s.args?.[0] ?? '') })`))
  t.check('el buffer carga el archivo', await waitFor(`/export function sum/.test(document.querySelector('.pane .editor .cm-content')?.textContent ?? '')`, 4000))
  t.check('la franja dice sum.js y el sidebar lo lista con su icono', await evaluate(`/sum\\.js/.test(document.querySelector('.pane:has(.editor) .strip')?.textContent ?? '') && [...document.querySelectorAll('.sidebar .row')].some((r) => /sum\\.js/.test(r.textContent) && !!r.querySelector('svg'))`), await evaluate(`[...document.querySelectorAll('.sidebar .row')].map((r) => r.textContent.slice(0, 30)).filter((x) => /sum/.test(x)).join('|')`))
  t.check('el editor tiene el foco del teclado y modo NORMAL', await waitFor(`!!document.activeElement?.closest('.editor') && document.querySelector('.pane .editor')?.dataset.mode === 'NORMAL'`, 3000), JSON.stringify(await snapshot()))
  const bar = await rect('.editor__bar'); t.check('cabecera del editor de 28 px', bar && bar.h === 28, JSON.stringify(bar))

  // Editar en INSERT y guardar
  await press('G'); await press('o'); await sleep(80)
  t.check('o entra en INSERT', await waitFor(`document.querySelector('.pane .editor')?.dataset.mode === 'INSERT'`, 2000))
  await type('export const E2E = 1')
  await press('escape'); await sleep(100)
  t.check('Esc vuelve a NORMAL y el buffer está sucio', await waitFor(`document.querySelector('.pane .editor')?.dataset.mode === 'NORMAL' && document.querySelector('.pane .editor')?.dataset.dirty === 'true'`, 2000), JSON.stringify(await evaluate(`({ mode: document.querySelector('.pane .editor')?.dataset.mode, dirty: document.querySelector('.pane .editor')?.dataset.dirty })`)))
  await press('cmd+s')
  t.check('⌘S guarda en disco', await waitFor(`Promise.resolve(${JSON.stringify(readFileSync(join(REPO, 'sum.js'), 'utf8').includes('E2E'))})`, 10) || /E2E = 1/.test(readFileSync(join(REPO, 'sum.js'), 'utf8')) || (await sleep(800), /E2E = 1/.test(readFileSync(join(REPO, 'sum.js'), 'utf8'))), readFileSync(join(REPO, 'sum.js'), 'utf8').slice(-40))
  t.check('tras guardar el buffer queda limpio', await waitFor(`document.querySelector('.pane .editor')?.dataset.dirty !== 'true'`, 2000))
  t.check('el cambio contra la base se marca como hunk', await waitFor(`document.querySelectorAll('.pane .editor .cm-changedLine').length >= 1 && /1 cambio/.test(document.querySelector('.editor__bar')?.textContent ?? '')`, 4000), await evaluate(`document.querySelector('.editor__bar')?.textContent?.slice(0, 80)`))
  // Comentario al "agente" (el shell del workspace no es agente: va al portapapeles)
  await press(']'); await press('c'); await sleep(100)
  await press('C')
  t.check('C abre el compositor del hunk', await waitFor(`!!document.querySelector('.editor__composer')`, 2000))
  const lines = `[...document.querySelectorAll('.pane .editor .cm-content > .cm-line')].map((l) => l.textContent).join('\\n')`
  const before = await evaluate(lines)
  t.check('al abrir el compositor el foco está en su textarea, no en CodeMirror', await evaluate(`!!document.activeElement?.closest('.editor__composer')`), await evaluate(`document.activeElement?.className ?? ''`))
  await type('Mejor con validación')
  t.check('lo escrito en el compositor no toca el buffer ni dispara vim', (await evaluate(lines)) === before && !(await evaluate(`/yank|deleted/i.test(document.querySelector('.pane .editor .cm-vim-panel, .pane .editor .cm-panel')?.textContent ?? '')`)), JSON.stringify({ before, after: await evaluate(lines), panel: await evaluate(`document.querySelector('.pane .editor .cm-panels')?.textContent ?? ''`) }))
  await press('cmd+enter'); await sleep(500)
  const clip = execSync('pbpaste', { encoding: 'utf8' })
  t.check('el comentario lleva ruta:línea y texto (sin agente → portapapeles)', /sum\.js:\d+: Mejor con validación/.test(clip), clip.slice(0, 80))
  // Árbol
  await press('cmd+e')
  t.check('⌘E abre el árbol del workspace con sus archivos', await waitFor(`!!document.querySelector('.editor__tree') && /package\\.json/.test(document.querySelector('.editor__tree')?.textContent ?? '')`, 3000))
  const tree = await rect('.editor__tree'); t.check('árbol de 240 px', tree && tree.w === 240, JSON.stringify(tree))
  await press('escape'); await sleep(100)
  t.check('Esc cierra el árbol y devuelve el foco al buffer', await waitFor(`!document.querySelector('.editor__tree') && !!document.activeElement?.closest('.editor')`, 2000))

  // Vista previa del README: ⌘⇧V alterna editor ↔ preview
  await evaluate(`${MOD.docs}.then((m) => m.useDocs.getState().open(${JSON.stringify(added.workspace.id)}, ${JSON.stringify(join(REPO, 'README.md'))}, 'preview', 'tab'))`)
  t.check('se abre un pane de vista previa con el Markdown renderizado', await waitFor(`!!document.querySelector('.pane .preview') && !!document.querySelector('.pane .preview h1') && /omni e2e repo/.test(document.querySelector('.pane .preview')?.textContent ?? '')`, 6000), JSON.stringify(await snapshot()))
  t.check('la franja de la vista previa dice README.md y Markdown', await evaluate(`/README\\.md/.test(document.querySelector('.pane:has(.preview)')?.textContent ?? '') && /Markdown/.test(document.querySelector('.pane:has(.preview)')?.textContent ?? '')`))
  await press('cmd+shift+v')
  t.check('⌘⇧V abre el editor del mismo archivo al lado', await waitFor(`document.querySelectorAll('.pane .editor').length === 2 || [...document.querySelectorAll('.pane .editor')].some((e) => /README/.test(e.closest('.pane')?.textContent ?? ''))`, 5000), JSON.stringify(await snapshot()))
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/editor-preview.png')

  // Cerrar un buffer sucio pide confirmación
  await evaluate(`import('/src/panes/editor/editor-host.ts').then((m) => { const e = [...document.querySelectorAll('.pane .editor')].map((x) => x.dataset.sessionId).find((id) => id !== ${JSON.stringify(editorId)}); const h = m.getEditor(e); h?.focus() })`)
  await sleep(150)
  await press('G'); await press('o'); await type('sucio'); await press('escape'); await sleep(100)
  await press(await api.prefix()); await press('x')
  t.check('cerrar un editor sucio pide confirmación', await waitFor(`!!document.querySelector('.overlay .picker')`, 2000), JSON.stringify(await snapshot()))
  await evaluate(`import('/src/store/ui.ts').then((m) => m.useUi.getState().closeOverlay())`); await sleep(200)

  // Limpieza: matar docs y shell, quitar proyecto, reset repo
  await evaluate(`${MOD.sessions}.then((m) => { for (const s of m.useSessions.getState().sessions) if (s.agent === 'editor' || s.agent === 'preview') window.omni.send('session:kill', s.id) })`)
  await sleep(600)
  await evaluate(`${MOD.sessions}.then((m) => { const tab = import('/src/store/layout.ts').then((lm) => { const tb = lm.useLayout.getState().tabs.find((x) => lm.leaves(x.root).some((l) => l.sessionId === ${JSON.stringify(shellId)})); if (tb) m.useSessions.getState().activateTab(tb.id) }) })`)
  await sleep(300); await api.click('.pane'); await sleep(150)
  await closePanes(api, 1)
  await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(projectId)})`)
  await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().reloadProjects())`); await sleep(300)
  git('checkout -q main'); git(`reset -q --hard ${root}`); git('clean -qfd')
}
