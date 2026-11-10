// Flujo real de worktrees y revisión (§3.15, §3.16): proyecto git → worktree con agente → cambio →
// tests automáticos → vista Worktrees → revisión con comentario enviado al agente → merge squash en
// main → limpieza. Usa el repo ~/private/omni-e2e-repo (se resetea al inicio y al final).
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { closePanes } from './_helpers.mjs'

const REPO = join(homedir(), 'private', 'omni-e2e-repo')
const git = (args) => execSync(`git -C ${JSON.stringify(REPO)} ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const MOD = { sessions: `import('/src/store/sessions.ts')`, ui: `import('/src/store/ui.ts')`, wt: `import('/src/store/worktrees.ts')`, review: `import('/src/store/review.ts')`, host: `import('/src/panes/terminal/terminal-host.ts')` }

function resetRepo() {
  const root = git('rev-list --max-parents=0 HEAD')
  try { git('merge --abort') } catch {}
  git('checkout -q main'); git(`reset -q --hard ${root}`); git('clean -qfd')
  for (const b of git('branch --list "omni/*"').split('\n').map((x) => x.trim()).filter(Boolean)) { try { git(`branch -D ${b}`) } catch {} }
  git('worktree prune')
}

export default async function (api, t) {
  const { press, type, evaluate, snapshot, sleep, waitFor } = api
  const rect = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })()`)
  const buffer = (id) => evaluate(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(id)})?.term; if (!term) return ''; const b = term.buffer.active; let all = ''; for (let i = 0; i <= b.baseY + b.cursorY; i++) all += (b.getLine(i)?.translateToString(true) ?? '') + '\\n'; return all })`)
  t.check('existe el repo de prueba', existsSync(join(REPO, '.git')), REPO)
  resetRepo()
  const rootSha = git('rev-parse --short HEAD')
  await evaluate(`Promise.all([${MOD.ui}]).then(([um]) => um.useUi.getState().setView('fleet'))`)

  // 1. Proyecto por ruta + comando de tests (si quedó de otra corrida, se quita primero: borra sus worktrees)
  const stale = await evaluate(`window.omni.invoke('project:list').then((r) => r.projects.find((p) => p.path === ${JSON.stringify(REPO)})?.id ?? null)`)
  if (stale) { await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(stale)})`); await sleep(500); resetRepo() }
  const added = await evaluate(`window.omni.invoke('project:addPath', ${JSON.stringify(REPO)})`)
  const projectId = added.project.id
  await evaluate(`window.omni.invoke('project:setTestCommand', ${JSON.stringify(projectId)}, 'npm test')`)
  await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().reloadProjects())`)
  t.check('el proyecto git se abre por ruta y aparece en el sidebar', await waitFor(`[...document.querySelectorAll('.sidebar [role=option][data-level="0"]')].some((r) => /omni-e2e-repo/.test(r.textContent))`, 4000))

  // 2. Worktree con un shell dentro (launcher)
  const ws = await evaluate(`${MOD.wt}.then((m) => m.useWorktrees.getState().create(${JSON.stringify(projectId)}, 'e2e-flow'))`)
  t.check('se crea el worktree e2e-flow (workspace kind worktree)', ws && ws.kind === 'worktree' && /e2e-flow$/.test(ws.path), JSON.stringify(ws))
  t.check('el worktree existe en git con rama omni/e2e-flow', /omni\/e2e-flow/.test(git('worktree list')), git('worktree list'))
  await evaluate(`${MOD.wt}.then((m) => m.useWorktrees.getState().launchIn(${JSON.stringify(ws?.id)}))`)
  t.check('lanzar en el worktree abre el launcher', await waitFor(`!!document.querySelector('.overlay .picker')`, 3000))
  await type('Nueva terminal'); await sleep(150); await press('enter')
  const shell = await evaluate(`${MOD.sessions}.then((m) => new Promise((res) => { const pick = () => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell' && x.workspaceId === ${JSON.stringify(ws?.id)})[0]; const s = pick(); if (s) return res(s); const t0 = Date.now(); const iv = setInterval(() => { const x = pick(); if (x || Date.now() - t0 > 5000) { clearInterval(iv); res(x ?? null) } }, 100) }))`)
  t.check('el shell se lanzó en el workspace del worktree', !!shell && shell.workspaceId === ws.id && shell.cwd === ws.path, JSON.stringify(shell && { ws: shell.workspaceId === ws.id, cwd: shell.cwd }))
  await sleep(800)

  // 3. Cambio en el worktree → tests automáticos
  await evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, "printf '\\\\nexport function mul(a, b) {\\\\n  return a * b\\\\n}\\\\n' >> sum.js && git status --short\\r")`)
  // El estado se cachea 5 s en main: se espera a que lo vea.
  t.check('el estado del worktree ve el cambio (sucio, 1 archivo)', await waitFor(`window.omni.invoke('worktree:status', ${JSON.stringify(ws.id)}, true).then((s) => s.dirty && s.stat.files === 1 && s.stat.additions >= 3)`, 9000), JSON.stringify((await evaluate(`window.omni.invoke('worktree:status', ${JSON.stringify(ws.id)})`)).stat))
  // Los shells no cuentan como agente (NON_CODING): los tests automáticos quedan cubiertos por unit tests; aquí se corren con R.

  // 4. Vista Worktrees
  await press('cmd+3')
  t.check('⌘3 abre Worktrees', await waitFor(`!!document.querySelector('.worktrees')`, 3000))
  await press('r')
  t.check('R corre los tests del worktree y pasan', await waitFor(`window.omni.invoke('worktree:status', ${JSON.stringify(ws.id)}).then((s) => s.tests?.status === 'pass')`, 25000), JSON.stringify((await evaluate(`window.omni.invoke('worktree:status', ${JSON.stringify(ws.id)})`)).tests))
  t.check('⌘3 abre Worktrees', await waitFor(`!!document.querySelector('.worktrees') && getComputedStyle(document.querySelector('.worktrees')).display !== 'none'`), JSON.stringify(await snapshot()))
  await evaluate(`${MOD.wt}.then((m) => m.useWorktrees.getState().setCursor(${JSON.stringify(ws.id)}))`); await sleep(300)
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/worktrees-view.png')
  const row = await rect('.worktrees__list .row[data-cursor]')
  t.check('la fila del worktree mide 82 px', row && row.h === 82, JSON.stringify(row))
  const rowText = await evaluate(`document.querySelector('.worktrees__list .row[data-cursor]')?.textContent ?? ''`)
  t.check('la fila dice rama, agente, cambios y tests ok', /omni\/e2e-flow/.test(rowText) && /archivo/.test(rowText) && /tests ok|ok/.test(rowText), rowText.slice(0, 140))
  t.check('el sidebar cuenta 1 worktree', await evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].some((n) => /Worktrees/.test(n.textContent) && /1/.test(n.textContent))`), await evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].map((n) => n.textContent.trim()).join(' | ')`))

  // 5. Revisión
  await press('enter')
  t.check('⏎ abre la revisión del worktree', await waitFor(`${MOD.ui}.then((m) => m.useUi.getState().view === 'review') && !!document.querySelector('.review__file')`, 6000), JSON.stringify(await snapshot()))
  t.check('el diff lista sum.js modificado con líneas añadidas', await evaluate(`(() => { const f = document.querySelector('.review__file[aria-label="sum.js"]'); return !!f && f.dataset.status === 'M' && f.querySelectorAll('.review__line[data-kind="add"]').length >= 3 })()`), await evaluate(`[...document.querySelectorAll('.review__file')].map((f) => f.getAttribute('aria-label') + ':' + f.dataset.status).join(',')`))
  const head = await evaluate(`document.querySelector('.review__head')?.textContent ?? ''`)
  t.check('la cabecera dice rama → base, archivos, +a −d y tests', /omni\/e2e-flow/.test(head) && /main/.test(head) && /archivo/.test(head) && /tests ok|ok/.test(head), head.slice(0, 160))
  const aside = await rect('.review__aside')
  t.check('aside de 280 px', aside && aside.w === 280, JSON.stringify(aside))
  await press(']'); await sleep(100)
  await press('j'); await sleep(100)
  t.check('hay una línea bajo el cursor con relleno y sin borde', await evaluate(`(() => { const l = document.querySelector('.review__line[data-cursor]'); if (!l) return false; const cs = getComputedStyle(l); return cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.borderStyle === 'none' && cs.outlineStyle === 'none' })()`))
  await press('c')
  t.check('C abre el compositor bajo la línea', await waitFor(`!!document.querySelector('.review__composer textarea, .review__composer .text-area, .review__composer')`, 2000))
  await type('Falta validar que sean números')
  await press('cmd+enter')
  t.check('⌘⏎ guarda el comentario', await waitFor(`document.querySelectorAll('.review__comment').length === 1`, 2000))
  t.check('el aside lista el comentario con archivo:línea', await evaluate(`/sum\\.js:\\d+/.test(document.querySelector('.review__comments')?.textContent ?? '')`), await evaluate(`document.querySelector('.review__comments')?.textContent?.slice(0, 80)`))
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/review-view.png')
  await press('shift+s')
  await sleep(1200)
  // Con un shell (no agente) los comentarios van al portapapeles y el pie lo dice (§3.16).
  const clip = execSync('pbpaste', { encoding: 'utf8' })
  t.check('⇧S sin agente copia los comentarios al portapapeles con archivo:línea', /Revisión de omni\/e2e-flow/.test(clip) && /sum\.js:\d+/.test(clip) && /Falta validar/.test(clip), clip.slice(0, 120))
  t.check('el pie avisa que se copió', await evaluate(`/portapapeles|copiad/i.test(document.querySelector('.review__foot')?.textContent ?? '')`), await evaluate(`document.querySelector('.review__foot')?.textContent?.slice(0, 120)`))
  t.check('los comentarios quedan marcados como enviados', await evaluate(`/enviado/.test(document.querySelector('.review__comments')?.textContent ?? '')`))

  // E copia la revisión entera como Markdown para un PR (resumen, comentarios y diff plegado).
  await press('e')
  await sleep(800)
  const md = execSync('pbpaste', { encoding: 'utf8' })
  t.check('E copia la revisión como Markdown para un PR', /^## Revisión de `omni\/e2e-flow`/.test(md) && /### Comentarios/.test(md) && /Falta validar/.test(md) && /<details><summary><code>sum\.js<\/code>/.test(md) && /```diff/.test(md), md.slice(0, 200))
  t.check('el pie dice que se copió como Markdown', await evaluate(`/Markdown/.test(document.querySelector('.review__foot')?.textContent ?? '')`), await evaluate(`document.querySelector('.review__foot')?.textContent?.slice(0, 120)`))

  // 6. Merge
  await press('shift+m')
  t.check('⇧M con el agente vivo pide confirmación', await waitFor(`!!document.querySelector('.overlay .picker')`, 2000))
  await press('enter')
  t.check('tras el merge se vuelve a Worktrees', await waitFor(`${MOD.ui}.then((m) => m.useUi.getState().view === 'worktrees')`, 15000), JSON.stringify(await snapshot()))
  await sleep(800)
  const log = git('log --oneline -3')
  t.check('main tiene el commit squash del worktree', /e2e-flow \(omni\)/.test(log) && !/wip \(omni\)/.test(log.split('\n')[0]) , log)
  t.check('sum.js en main trae la función nueva', /export function mul/.test(execSync(`cat ${JSON.stringify(join(REPO, 'sum.js'))}`, { encoding: 'utf8' })))
  t.check('el worktree y su rama desaparecieron', !/e2e-flow/.test(git('worktree list')) && !/omni\/e2e-flow/.test(git('branch --list "omni/*"')), git('worktree list'))
  t.check('el workspace del worktree ya no está en la app', await waitFor(`${MOD.sessions}.then((m) => !m.useSessions.getState().workspaces.some((w) => w.id === ${JSON.stringify(ws.id)}))`, 4000))
  t.check('la sesión del worktree se cerró', await waitFor(`${MOD.sessions}.then((m) => !m.useSessions.getState().sessions.some((s) => s.id === ${JSON.stringify(shell.id)}))`, 4000))
  t.check('la vista Worktrees queda vacía para ese proyecto', !(await evaluate(`/e2e-flow/.test(document.querySelector('.worktrees')?.textContent ?? '')`)))

  // 7. Limpieza
  await press('escape'); await sleep(200)
  await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(projectId)})`)
  await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().reloadProjects())`); await sleep(400)
  t.check('el proyecto de prueba se quitó de omni', !(await evaluate(`[...document.querySelectorAll('.sidebar [role=option][data-level="0"]')].some((r) => /omni-e2e-repo/.test(r.textContent))`)))
  resetRepo()
  t.check('el repo volvió a su commit inicial', git('rev-parse --short HEAD') === rootSha)
}
