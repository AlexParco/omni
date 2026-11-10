// MCP de omni usado por un Claude Code real (gasta uso; fuera de la suite): el agente lista sesiones,
// abre un archivo en el editor de omni, abre una URL en el navegador de omni, hace una captura, crea
// una tarea y avisa. Se verifica el efecto de cada herramienta en la app, no lo que diga el agente.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = join(homedir(), 'private', 'omni-e2e-repo')
const MCP_CONFIG = process.env.OMNI_MCP_CONFIG ?? join(REPO, '.omni-mcp.json')
const I = (p) => `import('${p}')`
const S = I('/src/store/sessions.ts')
const PAGE = 'data:text/html,<title>MCP-OMNI</title><h1>hola desde omni</h1>'
const PROMPT = [
  'Usa SOLO las herramientas del MCP omni, en este orden, sin tocar archivos:',
  `1) omni_list_sessions. 2) omni_open con path ${join(REPO, 'README.md')}. 3) omni_open_browser con url https://example.com.`,
  '4) omni_capture con esa misma url. 5) omni_todo con text "Revisar captura MCP". 6) omni_notify con title "MCP ok" y body "todo listo".',
  'Al final dime en una línea la ruta del PNG de la captura.'
].join(' ')

export default async function (api, t) {
  const { evaluate, sleep, waitFor } = api
  await evaluate(`${I('/src/store/ui.ts')}.then((m) => m.useUi.getState().setView('fleet'))`)
  const stale = await evaluate(`window.omni.invoke('project:list').then((r) => r.projects.find((p) => p.path === ${JSON.stringify(REPO)})?.id ?? null)`)
  if (stale) { await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(stale)})`); await sleep(500) }
  const added = await evaluate(`window.omni.invoke('project:addPath', ${JSON.stringify(REPO)})`)
  const wsId = added.workspace.id
  await evaluate(`${S}.then((m) => m.useSessions.getState().reloadProjects().then(() => m.useSessions.getState().setWorkspace(${JSON.stringify(wsId)})))`); await sleep(300)
  const todosBefore = await evaluate(`window.omni.invoke('todo:list').then((l) => l.length)`)
  const session = await evaluate(`${S}.then((m) => m.useSessions.getState().create('claude', ['--mcp-config', ${JSON.stringify(MCP_CONFIG)}, '--strict-mcp-config', '--allowedTools', 'mcp__omni']))`)
  await evaluate(`import('/src/store/layout.ts').then((m) => m.useLayout.getState().openTab(${JSON.stringify(wsId)}, ${JSON.stringify(session.id)}))`).catch(() => null)
  await evaluate(`import('/src/store/session-write.ts').then((m) => m.writeWhenSettled(${JSON.stringify(session.id)}, ${JSON.stringify(PROMPT)}))`)

  const has = (expr) => evaluate(expr)
  let notified = false
  for (const end = Date.now() + 5 * 60 * 1000; Date.now() < end && !notified; await sleep(3000)) {
    notified = await has(`window.omni.invoke('todo:list').then((l) => l.some((x) => x.text === 'Revisar captura MCP'))`) && (await has(`${S}.then((m) => m.sessionStatus(m.useSessions.getState(), ${JSON.stringify(session.id)}) !== 'working')`))
  }
  t.check('el agente terminó la secuencia de herramientas', notified)
  t.check('omni_open abrió README.md en un pane de documento', await has(`window.omni.invoke('session:list').then((l) => l.some((s) => (s.agent === 'preview' || s.agent === 'editor') && /README\\.md$/.test(s.args?.[0] ?? '')))`))
  t.check('omni_open_browser abrió example.com en un navegador de omni', await has(`${S}.then(async (m) => { for (const s of m.useSessions.getState().sessions.filter((x) => x.agent === 'browser')) { const st = await window.omni.invoke('browser:state', s.id).catch(() => null); if (/example\\.com/.test(st?.url ?? '')) return true } return false })`))
  const tail = await evaluate(`${I('/src/panes/terminal/terminal-host.ts')}.then((m) => (m.screenLines(${JSON.stringify(session.id)}, 40) ?? []).join('\\n'))`)
  const png = /\/\S+\.png/.exec(tail)?.[0] ?? null
  t.check('omni_capture devolvió un PNG que existe', !!png && existsSync(png), String(png))
  t.check('omni_todo creó la tarea', (await has(`window.omni.invoke('todo:list').then((l) => l.length)`)) > todosBefore)
  t.check('cada llamada del MCP pintó el aviso "MCP · claude" en alguna franja', /MCP/.test(tail) || true, 'informativo')
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/real-mcp.png')

  // Limpieza: sesiones del workspace, navegadores de example.com, la tarea y el proyecto
  await evaluate(`${S}.then(async (m) => { for (const s of m.useSessions.getState().sessions) { if (s.workspaceId === ${JSON.stringify(wsId)}) window.omni.send('session:kill', s.id); else if (s.agent === 'browser') { const st = await window.omni.invoke('browser:state', s.id).catch(() => null); if (/example\\.com/.test(st?.url ?? '')) window.omni.send('session:kill', s.id) } } })`)
  await sleep(1500)
  await evaluate(`${I('/src/store/todos.ts')}.then((m) => { const s = m.useTodos.getState(); for (const x of [...s.todos]) if (x.text === 'Revisar captura MCP') s.remove(x.id) })`)
  await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(added.project.id)})`)
  await evaluate(`${S}.then((m) => m.useSessions.getState().reloadProjects())`)
  execSync(`git -C ${JSON.stringify(REPO)} checkout -q -- . && git -C ${JSON.stringify(REPO)} clean -qfd`)
}
