// Socket de control, CLI y MCP (§3.21): `omni list`, `omni send`, `omni notify`, `omni todo` contra la
// app viva, y el servidor MCP por stdio respondiendo initialize/tools/list/tools/call.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensurePane, closePanes } from './_helpers.mjs'

const OMNI = join(process.cwd(), 'bin', 'omni.mjs')
const MCP = join(process.cwd(), 'bin', 'omni-mcp.mjs')
const MOD = { host: `import('/src/panes/terminal/terminal-host.ts')` }
const cli = (...args) => { const r = spawnSync('node', [OMNI, ...args], { encoding: 'utf8' }); return { code: r.status, out: (r.stdout + r.stderr).trim() } }

export default async function (api, t) {
  const { evaluate, sleep, waitFor } = api
  t.check('el socket de control existe con permisos 600', existsSync(join(homedir(), '.config', 'omni', 'app.sock')) && /^srw-------/.test(execFileSync('ls', ['-la', join(homedir(), '.config', 'omni', 'app.sock')], { encoding: 'utf8' })), execFileSync('ls', ['-la', join(homedir(), '.config', 'omni', 'app.sock')], { encoding: 'utf8' }).slice(0, 12))
  await ensurePane(api)
  const shell = await evaluate(`import('/src/store/sessions.ts').then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0])`)
  const list = cli('list', '--json')
  t.check('omni list --json devuelve las sesiones incluido el shell de prueba', list.code === 0 && JSON.parse(list.out).result.some((s) => s.id === shell.id), list.out.slice(0, 120))
  const send = cli('send', shell.id, 'echo CONTROL-OK', '--submit')
  t.check('omni send escribe en la sesión', send.code === 0, send.out)
  t.check('la terminal ejecutó lo enviado', await waitFor(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(shell.id)})?.term; if (!term) return false; const b = term.buffer.active; let all = ''; for (let i = 0; i <= b.baseY + b.cursorY; i++) all += b.getLine(i)?.translateToString(true) ?? ''; return /CONTROL-OK/.test(all.replace(/echo CONTROL-OK/g, '')) })`, 5000))
  const bad = cli('send', 'no-existe-xyz', 'hola')
  t.check('omni send a una sesión desconocida falla con error humano', bad.code === 1 && /sesión|no/i.test(bad.out), bad.out.slice(0, 80))
  const notify = cli('notify', 'Build', 'todo verde')
  t.check('omni notify responde ok y la franja muestra el aviso CLI', notify.code === 0 && (await waitFor(`/todo verde|CLI/.test(document.querySelector('.pane[data-focus="live"] .strip, .pane .strip')?.textContent ?? '')`, 3000)), notify.out)
  const todo = cli('todo', 'Tarea desde la CLI')
  t.check('omni todo crea la tarea', todo.code === 0 && (await waitFor(`window.omni.invoke('todo:list').then((l) => l.some((x) => x.text === 'Tarea desde la CLI'))`, 3000)), todo.out)
  await evaluate(`import('/src/store/todos.ts').then((m) => { const s = m.useTodos.getState(); for (const x of [...s.todos]) if (x.text === 'Tarea desde la CLI') s.remove(x.id) })`); await sleep(400)
  // MCP por stdio
  const req = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
  const mcp = spawnSync('node', [MCP], { input: req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }) + req(2, 'tools/list', {}) + req(3, 'tools/call', { name: 'omni_list_sessions', arguments: {} }), encoding: 'utf8', timeout: 15000 })
  const lines = mcp.stdout.trim().split('\n').map((l) => JSON.parse(l))
  t.check('MCP initialize responde con serverInfo omni', lines[0]?.result?.serverInfo?.name === 'omni', JSON.stringify(lines[0]).slice(0, 120))
  t.check('MCP tools/list lista las 8 herramientas', lines[1]?.result?.tools?.length === 8, String(lines[1]?.result?.tools?.map((x) => x.name)))
  t.check('MCP tools/call omni_list_sessions devuelve texto con el shell', lines[2]?.result?.content?.[0]?.text?.includes(shell.id.slice(0, 8)), JSON.stringify(lines[2]).slice(0, 160))
  await closePanes(api, 1)
}
