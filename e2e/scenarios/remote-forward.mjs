// Reenvío de puertos de un VPS (§3.26) con el ssh falso (`OMNI_SSH_BIN`, HOME aislado): una terminal remota
// levanta un servidor que anuncia `Local: http://localhost:N/app/`; la franja ofrece `localhost:N` y
// prefijo w reenvía el puerto por la conexión compartida (`ssh -O forward -L`) y abre la página en el
// navegador de omni. Con el ssh falso el "VPS" es este Mac: el puerto N ya está ocupado aquí, así que el
// reenvío cae en otro puerto local y omni lo avisa; la página igual carga por el túnel. Además, soltar
// un archivo sobre la terminal remota lo sube a `~/.omni/drops/` del host y pega esa ruta.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const S = `import('/src/store/sessions.ts')`
const SOURCE = `import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>vps e2e</title><h1>desde el vps</h1>') })
server.listen(0, '127.0.0.1', () => { const port = server.address().port; writeFileSync(process.argv[2], String(port)); console.log('  ➜  Local:   http://localhost:' + port + '/app/') })
`

export default async function (api, t) {
  const { evaluate, press, sleep, waitFor } = api
  const home = homedir()
  if (!home.startsWith('/tmp') && !home.includes('omni-')) {
    t.check('escenario remoto (requiere HOME aislado y OMNI_SSH_BIN)', true, `se salta: HOME=${home}`)
    return
  }
  const dir = join(home, 'e2e-forward')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'server.mjs'), SOURCE)
  const { host } = await evaluate(`window.omni.invoke('host:add', 'vps-fwd', 'vps-fwd')`)
  await evaluate(`window.omni.invoke('host:connect', ${JSON.stringify(host.id)})`)
  const project = await evaluate(`window.omni.invoke('project:create', 'Forward e2e')`)
  let shell = null
  let browserId = null
  try {
    const ws = await evaluate(`window.omni.invoke('project:addLocation', ${JSON.stringify(project.id)}, { path: ${JSON.stringify(dir)}, host: ${JSON.stringify(host.id)} })`)
    await evaluate(`${S}.then(async (m) => { await m.useSessions.getState().reloadProjects(); m.useSessions.getState().setWorkspace(${JSON.stringify(ws.id)}) })`)
    shell = await evaluate(`${S}.then(async (m) => { const info = await m.useSessions.getState().create('shell'); (await import('/src/store/layout.ts')).useLayout.getState().openTab(info.workspaceId, info.id); return info })`)
    t.check('la terminal es remota', shell?.remote === true, JSON.stringify(shell))
    await sleep(1500)
    await api.click('.pane')
    await sleep(150)

    // CLI `omni` en el host: el socket de control llega reenviado y `~/.omni/bin` está en el PATH de la terminal.
    for (let i = 0; i < 50 && !existsSync(join(home, '.omni', 'run', 'app.sock')); i++) await sleep(100)
    await evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, 'omni list' + String.fromCharCode(13))`)
    const cliScreen = () => evaluate(`import('/src/panes/terminal/terminal-host.ts').then((m) => (m.screenLines(${JSON.stringify(shell.id)}, 40) ?? []).join(' '))`)
    let cliOut = ''
    for (let i = 0; i < 50; i++) {
      cliOut = await cliScreen()
      if (cliOut.includes(shell.id.slice(0, 8) + '  ')) break
      await sleep(100)
    }
    t.check('omni list desde el VPS ve las sesiones de este omni', cliOut.includes(shell.id.slice(0, 8) + '  '), cliOut.slice(-300))
    await evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, 'clear' + String.fromCharCode(13))`)
    await sleep(300)
    await evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, ${JSON.stringify(`node server.mjs port\r`)})`)
    for (let i = 0; i < 100 && !existsSync(join(dir, 'port')); i++) await sleep(50)
    const port = Number(readFileSync(join(dir, 'port'), 'utf8'))
    t.check('la franja ofrece el servidor del VPS', await waitFor(`[...document.querySelectorAll('.pane .strip__link')].some((l) => l.textContent === 'localhost:${port}')`, 5000), await evaluate(`[...document.querySelectorAll('.pane .strip__link')].map((l) => l.textContent).join(',')`))

    await press(await api.prefix())
    await press('w')
    const opened = `${S}.then(async (m) => { const b = (await import('/src/store/browser.ts')).useBrowser.getState().states; const x = m.useSessions.getState().sessions.find((s) => s.agent === 'browser' && /^http:\\/\\/localhost:\\d+\\/app\\/$/.test(b[s.id]?.url ?? '')); return x ? { id: x.id, url: b[x.id].url, title: b[x.id].title } : null })`
    t.check('abre la página reenviada en el navegador de omni', await waitFor(`${opened}.then((x) => !!x)`, 10000), JSON.stringify(await evaluate(opened)))
    const result = await evaluate(opened)
    browserId = result?.id ?? null
    const localPort = Number(new URL(result.url).port)
    t.check('con el puerto ocupado en el Mac usa otro y lo avisa', localPort !== port && (await evaluate(`document.body.textContent.includes('se abrió en el ${localPort}')`)), `${port} → ${localPort}`)
    t.check('la página carga por el túnel', await waitFor(`${opened}.then((x) => x?.title === 'vps e2e')`, 8000), JSON.stringify(await evaluate(opened)))
    const res = await fetch(`http://127.0.0.1:${localPort}/app/`).then((r) => r.text()).catch((e) => String(e))
    t.check('el túnel responde desde fuera de omni', res.includes('desde el vps'), res.slice(0, 80))

    // Soltar un archivo del Mac sobre la terminal remota: se sube al host y se pega la ruta del host.
    const SID = JSON.stringify(shell.id)
    await evaluate(`import('/src/store/layout.ts').then(async (l) => { const s = (await import('/src/store/sessions.ts')).useSessions.getState(); const tab = l.useLayout.getState().tabs.find((x) => l.leaves(x.root).some((y) => y.sessionId === ${SID})); s.activateTab(tab.id) })`)
    await sleep(400)
    await evaluate(`window.omni.send('session:write', ${SID}, String.fromCharCode(3) + 'clear' + String.fromCharCode(13))`)
    await sleep(300)
    const local = join(dir, 'Captura vps.png')
    writeFileSync(local, Buffer.from('89504e470d0a1a0a', 'hex'))
    const box = await evaluate(`(() => { const r = document.querySelector('.pane .term-root').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    for (const type of ['dragEnter', 'dragOver', 'drop']) await api.cdp('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data: { items: [], files: [local], dragOperationsMask: 1 } })
    const screen = () => evaluate(`import('/src/panes/terminal/terminal-host.ts').then((m) => (m.screenLines(${SID}, 40) ?? []).join(' '))`)
    let text = ''
    for (let i = 0; i < 60; i++) {
      text = await screen()
      if (text.includes('/.omni/drops/')) break
      await sleep(100)
    }
    const found = text.match(/(\/\S+\/\.omni\/drops\/\d+-Captura)\\ vps\.png/)
    t.check('soltar sobre la terminal remota pega una ruta del host', !!found, text.slice(-200))
    const remotePath = found ? `${found[1]} vps.png` : ''
    t.check('el archivo está en el host con sus bytes', !!remotePath && existsSync(remotePath) && readFileSync(remotePath).toString('hex') === '89504e470d0a1a0a', remotePath)

    // Instalar dtach: el host falso (este Mac) no lo tiene y tiene brew. Se escribe el comando sin ⏎; la marca de
    // fin hace que omni vuelva a mirar el host. No se instala nada: se borra la línea y se imprime la marca a mano.
    const tools = await evaluate(`import('/src/store/hosts.ts').then((m) => m.useHosts.getState().status[${JSON.stringify(host.id)}]?.tools ?? null)`)
    if (tools && !tools.dtach && tools.dtachInstall) {
      await evaluate(`import('/src/store/sessions.ts').then((m) => m.useSessions.getState().setWorkspace(${JSON.stringify(ws.id)}))`)
      const before = await evaluate(`import('/src/store/sessions.ts').then((m) => m.useSessions.getState().sessions.map((x) => x.id))`)
      await evaluate(`import('/src/core/commands/registry.ts').then((m) => m.commands.run('host.installDtach'))`)
      const fresh = `import('/src/store/sessions.ts').then((m) => m.useSessions.getState().sessions.find((x) => x.remote && !${JSON.stringify(before)}.includes(x.id))?.id ?? null)`
      t.check('Instalar dtach abre una terminal en el servidor', await waitFor(fresh, 5000))
      const installId = await evaluate(fresh)
      const typed = () => evaluate(`import('/src/panes/terminal/terminal-host.ts').then((m) => (m.screenLines(${JSON.stringify(installId)}, 40) ?? []).join(' '))`)
      let line = ''
      for (let i = 0; i < 40 && !line.includes(tools.dtachInstall); i++) {
        await sleep(100)
        line = await typed()
      }
      t.check('con el comando del gestor escrito y sin ejecutar', line.includes(tools.dtachInstall) && line.includes('dtach instalado') && !line.includes('── dtach instalado ──'), line.slice(-200))
      await evaluate(`(async () => { const m = await import('/src/store/hosts.ts'); const st = m.useHosts.getState(); window.__rescans = 0; const orig = st.rescan; m.useHosts.setState({ rescan: async (id) => { window.__rescans++; return orig(id) } }) })()`)
      await evaluate(`window.omni.send('session:write', ${JSON.stringify(installId)}, String.fromCharCode(21) + "printf '\\\\n── %s ──\\\\n' 'dtach instalado'" + String.fromCharCode(13))`)
      t.check('la marca de fin hace que omni vuelva a mirar el host', await waitFor(`window.__rescans > 0`, 5000))
      await evaluate(`import('/src/store/sessions.ts').then((m) => m.useSessions.getState().kill(${JSON.stringify(installId)}))`)
    }
  } finally {
    await evaluate(`${S}.then((m) => { const s = m.useSessions.getState(); ${JSON.stringify([browserId, shell?.id].filter(Boolean))}.forEach((id) => s.kill(id)) })`).catch(() => undefined)
    await sleep(500)
    await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(project.id)}).then(() => window.omni.invoke('host:remove', ${JSON.stringify(host.id)})).then(() => ${S}).then((m) => m.useSessions.getState().reloadProjects())`).catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}
