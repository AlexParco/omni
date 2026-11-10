// Broadcast real (§3.18) con dos Claude Code de verdad: mismo prompt, un worktree cada uno, tarjetas con
// diff y tests automáticos, elegir uno, merge squash en main y limpieza. Gasta uso: fuera de la suite.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = join(homedir(), 'private', 'omni-e2e-repo')
const git = (args) => execSync(`git -C ${JSON.stringify(REPO)} ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const MOD = { sessions: `import('/src/store/sessions.ts')`, ui: `import('/src/store/ui.ts')`, bc: `import('/src/store/broadcast.ts')` }
const PROMPT = 'Agrega a sum.js una función exportada mul(a, b) que multiplique y amplía el script test de package.json para que compruebe mul(2, 3) === 6. Corre npm test. No hagas commit.'

function resetRepo() {
  const root = git('rev-list --max-parents=0 HEAD')
  git('checkout -q main'); git(`reset -q --hard ${root}`); git('clean -qfd')
  for (const b of git('branch --list "omni/*"').split('\n').map((x) => x.trim()).filter(Boolean)) { try { git(`branch -D ${b}`) } catch {} }
  git('worktree prune')
}

export default async function (api, t) {
  const { press, evaluate, sleep, waitFor } = api
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

  await evaluate(`${MOD.bc}.then((m) => m.useBroadcast.getState().create({ prompt: ${JSON.stringify(PROMPT)}, agents: ['claude', 'claude'] }))`)
  const round = await evaluate(`${MOD.bc}.then((m) => m.useBroadcast.getState().rounds.find((r) => r.projectId === ${JSON.stringify(projectId)}))`)
  t.check('ronda con dos Claude Code, cada uno en su worktree', round && round.candidates.length === 2 && round.candidates.every((c) => c.sessionId && c.workspaceId), JSON.stringify(round?.candidates))
  const ids = JSON.stringify(round.candidates.map((c) => c.workspaceId))

  // Los dos trabajan solos (auto mode del usuario); se espera a que ambos tengan cambios y tests corridos.
  // Sondeo cada 3 s (no cada 50 ms): `worktree:status` fresco corre git; martillarlo no es uso real.
  let done = false
  for (const end = Date.now() + 8 * 60 * 1000; Date.now() < end && !done; await sleep(3000)) {
    done = await evaluate(`Promise.all(${ids}.map((id) => window.omni.invoke('worktree:status', id, true))).then((l) => l.every((s) => s.stat.files >= 2 && s.tests && s.tests.status !== 'running'))`)
  }
  const statuses = await evaluate(`Promise.all(${ids}.map((id) => window.omni.invoke('worktree:status', id, true).then((s) => ({ files: s.stat.files, tests: s.tests?.status ?? null }))))`)
  t.check('los dos agentes terminaron con cambios y tests automáticos', done, JSON.stringify(statuses))
  t.check('los tests de ambos candidatos pasaron', statuses.every((s) => s.tests === 'pass'), JSON.stringify(statuses))

  await press('cmd+4')
  t.check('⌘4 abre Broadcast con dos tarjetas', await waitFor(`document.querySelectorAll('.candidate').length === 2`, 5000))
  t.check('las tarjetas muestran diff y tests ok', await waitFor(`[...document.querySelectorAll('.candidate')].every((c) => /sum\\.js/.test(c.textContent) && /ok/.test(c.textContent))`, 15000), await evaluate(`[...document.querySelectorAll('.candidate')].map((c) => c.textContent.slice(0, 160)).join(' || ')`))
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/real-broadcast.png')
  await press('s'); await sleep(200)
  await press('shift+m')
  t.check('⇧M mergea el elegido', await waitFor(`${MOD.bc}.then((m) => m.useBroadcast.getState().rounds.find((r) => r.id === ${JSON.stringify(round.id)})?.state === 'merged')`, 30000), JSON.stringify(await evaluate(`${MOD.bc}.then((m) => m.useBroadcast.getState().error)`)))
  await sleep(1500)
  t.check('main tiene el squash y mul', /\(omni\)/.test(git('log --oneline -2')) && /mul/.test(readFileSync(join(REPO, 'sum.js'), 'utf8')), git('log --oneline -2'))
  t.check('npm test pasa en main', (() => { try { execSync('npm test', { cwd: REPO, stdio: 'pipe' }); return true } catch { return false } })())
  t.check('no quedan worktrees de la ronda', !/\[omni\//.test(git('worktree list')), git('worktree list'))
  t.check('las sesiones de la ronda se cerraron', await waitFor(`${MOD.sessions}.then((m) => !m.useSessions.getState().sessions.some((s) => ${JSON.stringify(round.candidates.map((c) => c.sessionId))}.includes(s.id)))`, 8000))

  await press('escape'); await sleep(200)
  await evaluate(`${MOD.bc}.then((m) => { const s = m.useBroadcast.getState(); m.useBroadcast.setState({ rounds: s.rounds.filter((r) => r.projectId !== ${JSON.stringify(projectId)}) }) })`)
  await sleep(500)
  await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(projectId)})`)
  await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().reloadProjects())`)
  resetRepo()
  t.check('repo de prueba restaurado', git('rev-parse --short HEAD') === rootSha)
}
