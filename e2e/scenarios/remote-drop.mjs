// Terminal remota cuyo ssh se cae con la app abierta (tapa cerrada, cambio de red) en un host SIN dtach
// (§3.26). Requiere el daemon real (sin OMNI_DAEMON=0), el ssh falso (`OMNI_SSH_BIN`), HOME aislado y
// `FAKE_SSH_DROP_FILE=$HOME/ssh-drop`: mientras ese archivo existe, el ssh falso mata el comando remoto
// y sale con 255. La sesión no debe perderse: queda huérfana en el daemon y omni la revive sola con el
// mismo id en cuanto el host responde, con su pantalla de antes y una terminal que vuelve a responder.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const S = `import('/src/store/sessions.ts')`
const L = `import('/src/store/layout.ts')`

export default async function (api, t) {
  const { evaluate, sleep, waitFor } = api
  const home = homedir()
  const dropFile = join(home, 'ssh-drop')
  const daemon = await evaluate(`window.omni.invoke('daemon:status').then((s) => s, () => null)`)
  if ((!home.startsWith('/tmp') && !home.includes('omni-')) || process.env.FAKE_SSH_DROP_FILE !== dropFile || !daemon) {
    t.check('escenario de corte remoto (requiere HOME aislado, daemon real, OMNI_SSH_BIN y FAKE_SSH_DROP_FILE=$HOME/ssh-drop)', true, `se salta: HOME=${home}`)
    return
  }
  rmSync(dropFile, { force: true })
  const dir = join(home, 'e2e-drop')
  mkdirSync(dir, { recursive: true })
  const { host } = await evaluate(`window.omni.invoke('host:add', 'vps-drop', 'vps-drop')`)
  const status = await evaluate(`window.omni.invoke('host:connect', ${JSON.stringify(host.id)})`)
  t.check('el host falso no tiene dtach (como el VPS del usuario)', status?.tools?.dtach === false, JSON.stringify(status?.tools))
  const project = await evaluate(`window.omni.invoke('project:create', 'Corte e2e')`)
  let shell = null
  try {
    const ws = await evaluate(`window.omni.invoke('project:addLocation', ${JSON.stringify(project.id)}, { path: ${JSON.stringify(dir)}, host: ${JSON.stringify(host.id)} })`)
    await evaluate(`${S}.then(async (m) => { await m.useSessions.getState().reloadProjects(); m.useSessions.getState().setWorkspace(${JSON.stringify(ws.id)}) })`)
    shell = await evaluate(`${S}.then(async (m) => { const info = await m.useSessions.getState().create('shell'); (await ${L}).useLayout.getState().openTab(info.workspaceId, info.id); return info })`)
    t.check('la terminal es remota', shell?.remote === true, JSON.stringify(shell))
    const id = JSON.stringify(shell.id)
    const screen = () => evaluate(`import('/src/panes/terminal/terminal-host.ts').then((m) => (m.screenLines(${id}, 60) ?? []).join(' '))`)
    const write = (text) => evaluate(`window.omni.send('session:write', ${id}, ${JSON.stringify(text)} + String.fromCharCode(13))`)
    await sleep(1500)
    await write('echo ANTES-DEL-CORTE')
    t.check('la terminal remota responde', await waitFor(`import('/src/panes/terminal/terminal-host.ts').then((m) => ((m.screenLines(${id}, 60) ?? []).join(' ').match(/ANTES-DEL-CORTE/g) ?? []).length >= 2)`, 5000), (await screen()).slice(-120))
    // Sin esperar la foto periódica del daemon: la pantalla del corte se guarda al caer el ssh.

    // Corte: el ssh sale con 255 y el comando remoto muere (sin dtach no queda nada en el host).
    writeFileSync(dropFile, '')
    const gone = await waitFor(`window.omni.invoke('session:list').then((l) => !l.some((s) => s.id === ${id}))`, 5000)
    t.check('al caer el ssh la sesión sale del daemon', gone)
    rmSync(dropFile, { force: true })

    // Vuelta: omni la revive sola (primer intento a los 3 s) con el mismo id y en un tab.
    const back = await waitFor(`window.omni.invoke('session:list').then((l) => l.some((s) => s.id === ${id}))`, 15000)
    t.check('al volver la conexión la terminal se revive sola con el mismo id', back)
    t.check('y tiene su tab de nuevo', await waitFor(`${L}.then((m) => m.useLayout.getState().tabs.some((tb) => m.leaves(tb.root).some((l) => l.sessionId === ${id})))`, 5000))
    await sleep(1500)
    t.check('la pantalla de antes del corte se repinta', (await screen()).includes('ANTES-DEL-CORTE'), (await screen()).slice(-160))
    await write('echo DESPUES-DEL-CORTE')
    // Dos veces: el comando escrito y su salida (si solo se viera el eco, el shell no estaría corriendo).
    t.check('la terminal revivida responde', await waitFor(`import('/src/panes/terminal/terminal-host.ts').then((m) => ((m.screenLines(${id}, 60) ?? []).join(' ').match(/DESPUES-DEL-CORTE/g) ?? []).length >= 2)`, 8000), (await screen()).slice(-160))
  } finally {
    rmSync(dropFile, { force: true })
    if (shell) await evaluate(`${S}.then((m) => m.useSessions.getState().kill(${JSON.stringify(shell.id)}))`).catch(() => undefined)
    await sleep(500)
    await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(project.id)}).then(() => window.omni.invoke('host:remove', ${JSON.stringify(host.id)})).then(() => ${S}).then((m) => m.useSessions.getState().reloadProjects())`).catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
    t.check('limpieza: sin archivo de corte', !existsSync(dropFile))
  }
}
