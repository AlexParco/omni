// Flujo real de Broadcast (§3.18): una ronda con dos "agentes" (shells, cuyo prompt es un comando que
// modifica el worktree), tarjetas con diff, elegir uno, merge del elegido en main y limpieza del resto.
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = join(homedir(), 'private', 'omni-e2e-repo')
const git = (args) => execSync(`git -C ${JSON.stringify(REPO)} ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const MOD = { sessions: `import('/src/store/sessions.ts')`, ui: `import('/src/store/ui.ts')`, bc: `import('/src/store/broadcast.ts')` }

function resetRepo() {
  const root = git('rev-list --max-parents=0 HEAD')
  try { git('merge --abort') } catch {}
  git('checkout -q main'); git(`reset -q --hard ${root}`); git('clean -qfd')
  for (const b of git('branch --list "omni/*"').split('\n').map((x) => x.trim()).filter(Boolean)) { try { git(`branch -D ${b}`) } catch {} }
  git('worktree prune')
}

export default async function (api, t) {
  const { press, evaluate, snapshot, sleep, waitFor } = api
  const rect = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })()`)
  resetRepo()
  const rootSha = git('rev-parse --short HEAD')
  await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().setView('fleet'))`)
  const stale = await evaluate(`window.omni.invoke('project:list').then((r) => r.projects.find((p) => p.path === ${JSON.stringify(REPO)})?.id ?? null)`)
  if (stale) { await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(stale)})`); await sleep(500); resetRepo() }
  const added = await evaluate(`window.omni.invoke('project:addPath', ${JSON.stringify(REPO)})`)
  const projectId = added.project.id
  await evaluate(`window.omni.invoke('project:setTestCommand', ${JSON.stringify(projectId)}, 'npm test')`)
  await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().reloadProjects().then(() => m.useSessions.getState().setWorkspace(${JSON.stringify(added.workspace.id)})))`)
  await sleep(300)

  // Ronda: dos shells cuyo "prompt" escribe un archivo distinto en cada worktree
  const roundsBefore = await evaluate(`${MOD.bc}.then((m) => m.useBroadcast.getState().rounds.length)`)
  await evaluate(`${MOD.bc}.then((m) => m.useBroadcast.getState().create({ prompt: "printf 'nota de broadcast\\\\n' >> notes.md", agents: ['shell', 'shell'] }))`)
  t.check('la ronda se crea con dos candidatos', await waitFor(`${MOD.bc}.then((m) => m.useBroadcast.getState().rounds.length === ${roundsBefore + 1} && m.useBroadcast.getState().rounds[0].candidates.length === 2)`, 15000), JSON.stringify(await evaluate(`${MOD.bc}.then((m) => m.useBroadcast.getState().rounds.map((r) => r.candidates.length))`)))
  const round = await evaluate(`${MOD.bc}.then((m) => m.useBroadcast.getState().rounds.find((r) => r.projectId === ${JSON.stringify(projectId)}))`)
  t.check('cada candidato tiene worktree y sesión', round.candidates.every((c) => c.workspaceId && c.sessionId), JSON.stringify(round.candidates))
  t.check('git tiene los dos worktrees de la ronda', git('worktree list').split('\n').filter((l) => /\[omni\//.test(l)).length === 2, git('worktree list'))
  // El prompt se escribe cuando el prompt del shell está listo (writeWhenSettled); esperamos al diff
  t.check('los dos worktrees muestran cambios (notes.md)', await waitFor(`Promise.all(${JSON.stringify(round.candidates.map((c) => c.workspaceId))}.map((id) => window.omni.invoke('worktree:status', id, true))).then((l) => l.every((s) => s.stat.files === 1))`, 25000), JSON.stringify(await evaluate(`Promise.all(${JSON.stringify(round.candidates.map((c) => c.workspaceId))}.map((id) => window.omni.invoke('worktree:status', id, true).then((s) => s.stat)))`)))

  // Vista ⌘4
  await press('cmd+4')
  t.check('⌘4 abre Broadcast', await waitFor(`!!document.querySelector('.broadcast') && getComputedStyle(document.querySelector('.broadcast')).display !== 'none'`), JSON.stringify(await snapshot()))
  const nav = await rect('.broadcast__nav'); t.check('nav de rondas de 260 px', nav && nav.w === 260, JSON.stringify(nav))
  const nb = await rect('.broadcast__new'); t.check('el botón Nueva ronda va en una sola línea', nb && nb.h < 44, JSON.stringify(nb))
  t.check('la ronda aparece en la lista con sus agentes', await evaluate(`/2 agentes/.test(document.querySelector('.broadcast__rounds')?.textContent ?? '')`), await evaluate(`document.querySelector('.broadcast__rounds')?.textContent?.slice(0, 120)`))
  t.check('hay dos tarjetas', await waitFor(`document.querySelectorAll('.candidate').length === 2`, 4000))
  t.check('las tarjetas muestran el diff (notes.md +1)', await waitFor(`[...document.querySelectorAll('.candidate')].every((c) => /notes\\.md/.test(c.textContent) && /\\+1/.test(c.textContent))`, 15000), await evaluate(`[...document.querySelectorAll('.candidate')].map((c) => c.textContent.slice(0, 100)).join(' || ')`))
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/broadcast-view.png')
  t.check('la tarjeta bajo el cursor lleva relleno sin borde', await evaluate(`(() => { const c = document.querySelector('.candidate[data-cursor]'); if (!c) return false; const cs = getComputedStyle(c); return cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.borderStyle === 'none' })()`))
  await press('l'); await sleep(100)
  t.check('L mueve el cursor a la segunda tarjeta', (await evaluate(`${MOD.bc}.then((m) => m.useBroadcast.getState().cursor.candidate)`)) === 1)
  await press('s'); await sleep(200)
  t.check('S marca la tarjeta como elegida', await evaluate(`!!document.querySelector('.candidate[data-chosen]') && /elegido/.test(document.querySelector('.candidate[data-chosen]')?.textContent ?? '')`))
  const chosenWs = round.candidates[1].workspaceId
  const chosenBranch = `omni/${(await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().workspaces.find((w) => w.id === ${JSON.stringify(chosenWs)})?.name)`))}`

  // Merge del elegido
  await press('shift+m')
  t.check('⇧M mergea el elegido y marca la ronda', await waitFor(`${MOD.bc}.then((m) => m.useBroadcast.getState().rounds.find((r) => r.id === ${JSON.stringify(round.id)})?.state === 'merged')`, 20000), JSON.stringify(await evaluate(`${MOD.bc}.then((m) => ({ st: m.useBroadcast.getState().rounds.find((r) => r.id === ${JSON.stringify(round.id)})?.state, err: m.useBroadcast.getState().error }))`)))
  await sleep(1000)
  const log = git('log --oneline -3')
  t.check('main recibió el commit squash del elegido', /\(omni\)/.test(log) && /nota de broadcast/.test(execSync(`cat ${JSON.stringify(join(REPO, 'notes.md'))}`, { encoding: 'utf8' })), log)
  t.check('los worktrees de la ronda se limpiaron', await waitFor(`Promise.resolve(${JSON.stringify(git('worktree list'))})`, 100) !== null && !/omni\//.test(git('worktree list')), git('worktree list'))
  t.check('las sesiones de la ronda se cerraron', await waitFor(`${MOD.sessions}.then((m) => !m.useSessions.getState().sessions.some((s) => ${JSON.stringify(round.candidates.map((c) => c.sessionId))}.includes(s.id)))`, 6000))
  t.check('la ronda queda listada como mergeada', await evaluate(`/mergeada/.test(document.querySelector('.broadcast__rounds')?.textContent ?? '')`), await evaluate(`document.querySelector('.broadcast__rounds')?.textContent?.slice(0, 100)`))

  // Limpieza
  await press('escape'); await sleep(200)
  await evaluate(`${MOD.bc}.then((m) => { const s = m.useBroadcast.getState(); m.useBroadcast.setState({ rounds: s.rounds.filter((r) => r.projectId !== ${JSON.stringify(projectId)}) }) })`)
  await sleep(500)
  await evaluate(`window.omni.invoke('broadcast:save', (await ${MOD.bc}).useBroadcast.getState().rounds)`).catch(() => null)
  await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(projectId)})`)
  await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().reloadProjects())`); await sleep(300)
  resetRepo()
  t.check('el repo volvió a su commit inicial', git('rev-parse --short HEAD') === rootSha)
}
