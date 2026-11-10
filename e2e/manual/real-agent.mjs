// Flujo real con Claude Code de verdad (gasta uso de la cuenta: NO va en la suite; correr a mano con
// `node e2e/cdp.mjs e2e/manual/real-agent.mjs`). Proyecto por ruta → worktree → Claude Code con el MCP
// de omni por `--mcp-config` → prompt con tarea → omni marca cada permiso como pregunta y el script lo acepta en el pane
// (tecla 1, como el usuario) → tests automáticos al
// callarse → ⌘3 → revisión → merge squash en main → limpieza. Deja el rastro en el log del runner.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = join(homedir(), 'private', 'omni-e2e-repo')
const MCP_CONFIG = process.env.OMNI_MCP_CONFIG ?? join(REPO, '.omni-mcp.json')
const git = (args) => execSync(`git -C ${JSON.stringify(REPO)} ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const MOD = { sessions: `import('/src/store/sessions.ts')`, ui: `import('/src/store/ui.ts')`, wt: `import('/src/store/worktrees.ts')`, write: `import('/src/store/session-write.ts')`, host: `import('/src/panes/terminal/terminal-host.ts')` }
const PROMPT = 'Agrega a sum.js una función exportada mul(a, b) que multiplique, y en package.json amplía el script test para que también compruebe mul(2, 3) === 6. Corre npm test. No hagas commit. Al terminar, usa la herramienta omni_notify del MCP omni con título "mul lista" y cuerpo "tests en verde".'

function resetRepo() {
  const root = git('rev-list --max-parents=0 HEAD')
  try { git('merge --abort') } catch {}
  git('checkout -q main'); git(`reset -q --hard ${root}`); git('clean -qfd')
  for (const b of git('branch --list "omni/*"').split('\n').map((x) => x.trim()).filter(Boolean)) { try { git(`branch -D ${b}`) } catch {} }
  git('worktree prune')
}

export default async function (api, t) {
  const { press, evaluate, snapshot, sleep, waitFor } = api
  t.check('hay archivo de config MCP para el agente', existsSync(MCP_CONFIG), MCP_CONFIG)
  // Reanudar: si una corrida anterior dejó Claude Code esperando la confianza y el usuario ya la aceptó
  // en el pane, se reutilizan proyecto, worktree y sesión en vez de crearlos de nuevo.
  await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().setView('fleet'))`)
  const stale = await evaluate(`window.omni.invoke('project:list').then((r) => r.projects.find((p) => p.path === ${JSON.stringify(REPO)})?.id ?? null)`)
  let resumed = null
  if (stale) {
    resumed = await evaluate(`${MOD.sessions}.then((m) => { const s = m.useSessions.getState(); const ws = s.workspaces.find((w) => w.projectId === ${JSON.stringify(stale)} && w.name === 'agent-flow'); const sess = ws && s.sessions.find((x) => x.workspaceId === ws.id && x.agent === 'claude'); return ws && sess ? { ws, sess } : null })`)
  }
  let projectId, ws, session, rootSha
  if (resumed) {
    projectId = stale; ws = resumed.ws; session = resumed.sess
    rootSha = git('rev-parse --short HEAD')
    t.check('reanudando con la sesión de Claude Code que ya estaba abierta', true, session.id)
  } else {
    resetRepo()
    rootSha = git('rev-parse --short HEAD')
    if (stale) { await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(stale)})`); await sleep(500); resetRepo() }
    const added = await evaluate(`window.omni.invoke('project:addPath', ${JSON.stringify(REPO)})`)
    projectId = added.project.id
    await evaluate(`window.omni.invoke('project:setTestCommand', ${JSON.stringify(projectId)}, 'npm test')`)
    await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().reloadProjects())`); await sleep(300)
    ws = await evaluate(`${MOD.wt}.then((m) => m.useWorktrees.getState().create(${JSON.stringify(projectId)}, 'agent-flow'))`)
    t.check('worktree agent-flow creado', ws && ws.kind === 'worktree', JSON.stringify(ws))
    await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().setWorkspace(${JSON.stringify(ws.id)}))`); await sleep(200)
    // Claude Code real con el MCP de omni (sin tocar la config del usuario: `--mcp-config` + `--strict-mcp-config`)
    session = await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().create('claude', ['--permission-mode', 'default', '--mcp-config', ${JSON.stringify(MCP_CONFIG)}, '--strict-mcp-config']))`)
    t.check('Claude Code se lanzó en el worktree', !!session && session.agent === 'claude' && session.workspaceId === ws.id, JSON.stringify(session))
    await evaluate(`import('/src/store/layout.ts').then((m) => m.useLayout.getState().openTab(${JSON.stringify(ws.id)}, ${JSON.stringify(session.id)}))`).catch(() => null)
  }
  const sid = session.id
  const tail = () => evaluate(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(sid)})?.term; if (!term) return ''; const b = term.buffer.active; const out = []; for (let i = Math.max(0, b.baseY + b.cursorY - 14); i <= b.baseY + b.cursorY; i++) out.push(b.getLine(i)?.translateToString(true) ?? ''); return out.join('\\n') })`)
  const screen = () => evaluate(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(sid)})?.term; if (!term) return ''; const b = term.buffer.active; const out = []; for (let i = Math.max(0, b.baseY + b.cursorY - 24); i <= b.baseY + b.cursorY; i++) out.push(b.getLine(i)?.translateToString(true) ?? ''); return out.join('\\n') })`)
  const lastLines = async () => (await screen()).split('\n').filter((l) => l.trim()).slice(-10).join(' | ').slice(0, 600)
  // Primera pantalla: el "Quick safety check" de Claude Code (carpeta nueva) o el prompt listo.
  const first = await waitFor(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(sid)})?.term; if (!term) return false; const b = term.buffer.active; let all = ''; for (let i = 0; i <= b.baseY + b.cursorY; i++) all += (b.getLine(i)?.translateToString(true) ?? '') + '\\n'; return /one you trust|No, exit|\\? for shortcuts|Try "|Tips for getting started/.test(all) })`, 30000)
  t.check('Claude Code pintó su primera pantalla', first, await lastLines())
  if (/one you trust|No, exit/.test(await screen())) {
    // El worktree es del repo de prueba que este mismo script creó (sum.js, package.json, README.md):
    // la confianza se acepta SOLO en este sandbox. En el producto el diálogo nunca se responde solo (§3.13).
    t.check('omni marcó la confianza como pregunta (sin responderla)', await waitFor(`${MOD.sessions}.then((m) => !!m.useSessions.getState().attention[${JSON.stringify(sid)}])`, 5000))
    // La opción por defecto es "No, exit": se baja a "Yes" y se confirma solo si el cursor quedó ahí.
    await evaluate(`window.omni.send('session:write', ${JSON.stringify(sid)}, '\\x1b[B')`); await sleep(400)
    const onYes = /❯\s*(1\.\s*)?Yes/.test(await screen())
    t.check('el cursor quedó en "Yes, I trust this folder"', onYes, await lastLines())
    if (onYes) await evaluate(`window.omni.send('session:write', ${JSON.stringify(sid)}, '\\r')`)
    t.check('tras aceptar aparece el prompt de Claude Code', await waitFor(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(sid)})?.term; if (!term) return false; const b = term.buffer.active; let all = ''; for (let i = Math.max(0, b.baseY + b.cursorY - 30); i <= b.baseY + b.cursorY; i++) all += (b.getLine(i)?.translateToString(true) ?? '') + '\\n'; return !/one you trust/.test(all) && /\\? for shortcuts|Try "|Tips for getting started|›/.test(all) })`, 30000), await lastLines())
  }
  await sleep(1500)
  await evaluate(`${MOD.write}.then((m) => m.writeWhenSettled(${JSON.stringify(sid)}, ${JSON.stringify(PROMPT)}))`)
  t.check('el prompt llegó a la terminal', await waitFor(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(sid)})?.term; if (!term) return false; const b = term.buffer.active; let all = ''; for (let i = 0; i <= b.baseY + b.cursorY; i++) all += b.getLine(i)?.translateToString(true) ?? ''; return /mul\\(a, b\\)/.test(all) })`, 60000), await tail())

  // Bucle de supervisión: acepta en el pane cada pregunta que omni detecta (tecla 1, "Yes" de Claude Code)
  // hasta que el agente se calle con cambios y tests
  const status = () => evaluate(`${MOD.sessions}.then((m) => { const s = m.useSessions.getState(); return { st: m.sessionStatus(s, ${JSON.stringify(sid)}), att: !!s.attention[${JSON.stringify(sid)}], alive: s.sessions.some((x) => x.id === ${JSON.stringify(sid)}) } })`)
  const started = Date.now()
  let answers = 0
  let lastIdle = null
  let done = false
  const events = []
  while (Date.now() - started < 10 * 60 * 1000) {
    await sleep(2000)
    const s = await status()
    if (!s.alive) { events.push('la sesión murió'); break }
    if (s.att || s.st === 'question') {
      events.push(`pregunta #${answers + 1}: ${(await lastLines()).slice(0, 160)}`)
      if (answers === 0) if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/real-agent-question.png')
      // Igual que si el usuario tecleara en el pane: la tecla llega a la PTY y la atención se limpia.
      await evaluate(`Promise.all([${MOD.write}, ${MOD.sessions}]).then(([w, m]) => { w.writeToSession(${JSON.stringify(sid)}, '1', false); m.useSessions.getState().clearAttention(${JSON.stringify(sid)}) })`)
      answers++
      await sleep(1500)
      lastIdle = null
      continue
    }
    if (s.st === 'working') { lastIdle = null; continue }
    lastIdle ??= Date.now()
    if (Date.now() - lastIdle > 25000) {
      const wst = await evaluate(`window.omni.invoke('worktree:status', ${JSON.stringify(ws.id)}, true)`)
      if (wst.stat.files > 0 && wst.tests && wst.tests.status !== 'running') { done = true; break }
      if (Date.now() - lastIdle > 90000) { events.push('callado 90 s sin tests: ' + JSON.stringify(wst)); break }
    }
  }
  t.check('el agente terminó con cambios en el worktree y tests corridos solos', done, events.join(' | ') + '\n' + (await tail()))
  const wst = await evaluate(`window.omni.invoke('worktree:status', ${JSON.stringify(ws.id)}, true)`)
  t.check('los tests automáticos pasaron', wst.tests?.status === 'pass', JSON.stringify(wst.tests))
  t.check('mul existe en el worktree', /mul/.test(readFileSync(join(ws.path, 'sum.js'), 'utf8')))
  // Con Claude Code en "auto mode" (clasificador de permisos del usuario) no hay preguntas: se informa, no se exige.
  // `--permission-mode default` fuerza las preguntas aunque el usuario tenga auto mode: omni debe detectarlas.
  t.check('el agente pidió permisos, omni los marcó como pregunta y se aceptaron en el pane', answers >= 1, `${answers} · ${events.join(' | ') || 'sin preguntas'}`)
  const notified = await evaluate(`window.omni.invoke('todo:list').then(() => true)`)
  const usedMcp = await evaluate(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(sid)})?.term; if (!term) return false; const b = term.buffer.active; let all = ''; for (let i = 0; i <= b.baseY + b.cursorY; i++) all += b.getLine(i)?.translateToString(true) ?? ''; return /Called omni|omni_notify \\(MCP\\)|omni - omni_notify/.test(all) })`) && notified
  t.check('llamada al MCP de omni (la decide el modelo: informativo)', true, usedMcp ? 'el agente llamó a omni_notify' : 'el agente no llamó al MCP esta vez')
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/real-agent-done.png')

  // Revisión y merge
  await press('cmd+3')
  t.check('⌘3 abre Worktrees', await waitFor(`!!document.querySelector('.worktrees')`, 3000))
  await evaluate(`${MOD.wt}.then((m) => m.useWorktrees.getState().setCursor(${JSON.stringify(ws.id)}))`); await sleep(300)
  await press('enter')
  t.check('⏎ abre la revisión con hunks', await waitFor(`${MOD.ui}.then((m) => m.useUi.getState().view === 'review') && document.querySelectorAll('.review__file').length >= 1`, 8000), JSON.stringify(await snapshot()))
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/real-agent-review.png')
  await press('shift+m')
  t.check('⇧M con el agente vivo pide confirmación', await waitFor(`!!document.querySelector('.overlay .picker')`, 2000))
  await press('enter')
  t.check('tras el merge se vuelve a Worktrees', await waitFor(`${MOD.ui}.then((m) => m.useUi.getState().view === 'worktrees')`, 20000), JSON.stringify(await snapshot()))
  await sleep(1000)
  const log = git('log --oneline -3')
  t.check('main tiene el commit squash del agente', /agent-flow \(omni\)/.test(log), log)
  t.check('sum.js en main trae mul', /mul/.test(readFileSync(join(REPO, 'sum.js'), 'utf8')))
  t.check('npm test pasa en main', (() => { try { execSync('npm test', { cwd: REPO, stdio: 'pipe' }); return true } catch { return false } })())
  t.check('la sesión del agente se cerró', await waitFor(`${MOD.sessions}.then((m) => !m.useSessions.getState().sessions.some((s) => s.id === ${JSON.stringify(sid)}))`, 6000))

  // Limpieza
  await press('escape'); await sleep(200)
  await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(projectId)})`)
  await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().reloadProjects())`); await sleep(300)
  resetRepo()
  t.check('el repo volvió a su commit inicial', git('rev-parse --short HEAD') === rootSha)
}
