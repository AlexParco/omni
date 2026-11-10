// Flujo real (gasta uso; fuera de la suite): tarea ⇧⌘T → "Claude Code" en el launcher → el agente recibe
// el texto de la tarea como primer prompt y edita → el archivo se abre en el editor con el cambio como
// hunk → `C` comenta al agente → el agente aplica el comentario → el editor recarga solo el archivo.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = join(homedir(), 'private', 'omni-e2e-repo')
const git = (args) => execSync(`git -C ${JSON.stringify(REPO)} ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const I = (p) => `import('${p}')`
const S = I('/src/store/sessions.ts')
const TASK = 'Agrega a sum.js una función exportada mul(a, b) que multiplique. Solo eso, no toques nada más ni hagas commit.'

function resetRepo() {
  const root = git('rev-list --max-parents=0 HEAD')
  git('checkout -q main'); git(`reset -q --hard ${root}`); git('clean -qfd')
}

export default async function (api, t) {
  const { press, type, evaluate, sleep, waitFor, snapshot } = api
  resetRepo()
  await evaluate(`${I('/src/store/ui.ts')}.then((m) => m.useUi.getState().setView('fleet'))`)
  const stale = await evaluate(`window.omni.invoke('project:list').then((r) => r.projects.find((p) => p.path === ${JSON.stringify(REPO)})?.id ?? null)`)
  if (stale) { await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(stale)})`); await sleep(500); resetRepo() }
  const added = await evaluate(`window.omni.invoke('project:addPath', ${JSON.stringify(REPO)})`)
  const projectId = added.project.id
  const wsId = added.workspace.id
  await evaluate(`${S}.then((m) => m.useSessions.getState().reloadProjects().then(() => m.useSessions.getState().setWorkspace(${JSON.stringify(wsId)})))`); await sleep(300)

  // 1. Tarea → launcher → Claude Code
  const todo = await evaluate(`${I('/src/store/todos.ts')}.then((m) => m.useTodos.getState().add(${JSON.stringify(TASK)}, ${JSON.stringify(projectId)}))`)
  t.check('tarea creada en el proyecto', !!todo?.id, JSON.stringify(todo))
  await evaluate(`${I('/src/store/todos.ts')}.then((m) => m.useTodos.getState().launch(${JSON.stringify(todo.id)}))`)
  t.check('lanzar la tarea abre el launcher', await waitFor(`!!document.querySelector('.overlay .picker')`, 3000))
  await type('Claude Code'); await sleep(200); await press('enter')
  const linked = await waitFor(`${I('/src/store/todos.ts')}.then((m) => !!m.useTodos.getState().todos.find((x) => x.id === ${JSON.stringify(todo.id)})?.sessionId)`, 8000)
  const sid = await evaluate(`${I('/src/store/todos.ts')}.then((m) => m.useTodos.getState().todos.find((x) => x.id === ${JSON.stringify(todo.id)})?.sessionId ?? null)`)
  t.check('la tarea quedó vinculada a la sesión de Claude Code', linked && !!sid, String(sid))
  t.check('la sesión es Claude Code en el repo de prueba', await evaluate(`${S}.then((m) => { const s = m.useSessions.getState().sessions.find((x) => x.id === ${JSON.stringify(sid)}); return s?.agent === 'claude' && s.workspaceId === ${JSON.stringify(wsId)} })`))

  // 2. El agente recibe la tarea como primer prompt y edita (sondeo cada 3 s)
  let edited = false
  for (const end = Date.now() + 4 * 60 * 1000; Date.now() < end && !edited; await sleep(3000)) edited = /function mul/.test(readFileSync(join(REPO, 'sum.js'), 'utf8'))
  t.check('el agente editó sum.js con la tarea como prompt', edited, readFileSync(join(REPO, 'sum.js'), 'utf8'))
  // Que termine de hablar antes de seguir
  for (let i = 0; i < 20 && (await evaluate(`${S}.then((m) => m.sessionStatus(m.useSessions.getState(), ${JSON.stringify(sid)}))`)) === 'working'; i++) await sleep(3000)

  // 3. Editor: sum.js con el cambio como hunk
  await evaluate(`${I('/src/store/docs.ts')}.then((m) => m.useDocs.getState().open(${JSON.stringify(wsId)}, ${JSON.stringify(join(REPO, 'sum.js'))}, 'editor', 'tab'))`)
  t.check('sum.js abre en el editor con el cambio del agente como hunk', await waitFor(`document.querySelectorAll('.pane .editor .cm-changedLine').length >= 1`, 8000), JSON.stringify(await snapshot()))
  const editorId = await evaluate(`document.querySelector('.pane .editor')?.dataset.sessionId ?? null`)
  await evaluate(`${I('/src/panes/editor/editor-host.ts')}.then((m) => m.getEditor(${JSON.stringify(editorId)})?.focus())`); await sleep(200)
  await press('g'); await press('g'); await press(']'); await press('c'); await sleep(150)
  await press('C')
  t.check('C abre el compositor sobre el hunk', await waitFor(`!!document.querySelector('.editor__composer')`, 3000))
  await type('Agrega un comentario JSDoc de una línea encima de mul. Solo eso.')
  await press('cmd+enter')
  t.check('el comentario va al agente del workspace (no al portapapeles)', await waitFor(`!/portapapeles/i.test(document.querySelector('.editor')?.textContent ?? '')`, 2000))

  // 4. El agente aplica el comentario y el editor (limpio) recarga solo
  let applied = false
  for (const end = Date.now() + 4 * 60 * 1000; Date.now() < end && !applied; await sleep(3000)) applied = /\/\*\*[\s\S]*function mul/.test(readFileSync(join(REPO, 'sum.js'), 'utf8'))
  t.check('el agente aplicó el comentario (JSDoc sobre mul)', applied, readFileSync(join(REPO, 'sum.js'), 'utf8'))
  t.check('el editor recargó el archivo cambiado en disco', await waitFor(`/\\/\\*\\*/.test(document.querySelector('.pane .editor .cm-content')?.textContent ?? '')`, 8000))
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/real-todo-editor.png')

  // Limpieza
  await evaluate(`${S}.then((m) => { for (const s of m.useSessions.getState().sessions) if (s.workspaceId === ${JSON.stringify(wsId)}) window.omni.send('session:kill', s.id) })`); await sleep(1500)
  await evaluate(`${I('/src/store/todos.ts')}.then((m) => m.useTodos.getState().remove(${JSON.stringify(todo.id)}))`)
  await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(projectId)})`)
  await evaluate(`${S}.then((m) => m.useSessions.getState().reloadProjects())`)
  resetRepo()
  t.check('repo de prueba restaurado', git('status --short') === '')
}
