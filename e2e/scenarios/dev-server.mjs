// Dev server desde la franja (§3.24): una terminal levanta un servidor que anuncia `Local: http://localhost:N/app/`;
// sin abrir el widget Puertos, la franja del pane ofrece `localhost:N` enseguida (refresco al ver la URL),
// prefijo w lo abre en el navegador de omni con la URL anunciada y la segunda vez reusa ese navegador.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = '/tmp/omni-e2e-devserver'
const SESSIONS = `import('/src/store/sessions.ts')`
const SOURCE = `import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>dev e2e</title><h1>dev e2e</h1>') })
server.listen(0, '127.0.0.1', () => { const port = server.address().port; writeFileSync(process.argv[2], String(port)); console.log('  ➜  Local:   http://localhost:' + port + '/app/') })
`

export default async function (api, t) {
  const { evaluate, press, sleep, waitFor } = api
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  writeFileSync(join(DIR, 'server.mjs'), SOURCE)
  await evaluate(`import('/src/store/ui.ts').then((m) => { m.useUi.getState().closeOverlay(); m.useUi.getState().setView('fleet') })`)
  const shell = await evaluate(`${SESSIONS}.then(async (m) => { const info = await m.useSessions.getState().create('shell'); (await import('/src/store/layout.ts')).useLayout.getState().openTab(info.workspaceId, info.id); return info })`)
  await sleep(600)
  await api.click('.pane')
  await sleep(150)
  const browsersBefore = await evaluate(`${SESSIONS}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'browser').length)`)
  await evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, ${JSON.stringify(`cd ${DIR} && node server.mjs port\r`)})`)
  for (let i = 0; i < 100 && !existsSync(join(DIR, 'port')); i++) await sleep(50)
  const port = Number(readFileSync(join(DIR, 'port'), 'utf8'))
  const link = `[...document.querySelectorAll('.pane .strip__link')].find((l) => l.textContent === 'localhost:${port}')`
  try {
    const t0 = Date.now()
    t.check('la franja ofrece el dev server sin abrir Puertos', await waitFor(`!!(${link})`, 6000), `${Date.now() - t0} ms`)
    t.check('aparece antes del sondeo de 10 s', Date.now() - t0 < 6000)
    if (process.env.E2E_SHOTS) await api.screenshot(join(process.env.E2E_SHOTS, 'dev-server-strip.png'))
    const geo = await evaluate(`(() => { const l = ${link}; const s = l.closest('.strip').getBoundingClientRect(); const r = l.getBoundingClientRect(); return { inside: r.top >= s.top && r.bottom <= s.bottom && r.right <= s.right } })()`)
    t.check('el enlace cabe en la franja', geo.inside, JSON.stringify(geo))

    await press(await api.prefix())
    await press('w')
    const url = `${SESSIONS}.then(async (m) => { const b = (await import('/src/store/browser.ts')).useBrowser.getState().states; return m.useSessions.getState().sessions.filter((x) => x.agent === 'browser').map((x) => b[x.id]?.url ?? '') })`
    t.check('prefijo w lo abre en el navegador de omni con la URL anunciada', await waitFor(`${url}.then((list) => list.some((u) => u === 'http://localhost:${port}/app/'))`, 8000), JSON.stringify(await evaluate(url)))
    const after = await evaluate(`${SESSIONS}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'browser').length)`)
    t.check('abrió un navegador', after === browsersBefore + 1, `${browsersBefore} → ${after}`)

    // Volver a la terminal y pedirlo otra vez: se reusa el navegador que ya lo muestra.
    await evaluate(`import('/src/store/layout.ts').then(async (l) => { const s = (await ${SESSIONS}).useSessions.getState(); const tab = l.useLayout.getState().tabs.find((t) => l.leaves(t.root).some((x) => x.sessionId === ${JSON.stringify(shell.id)})); s.activateTab(tab.id) })`)
    await sleep(300)
    await evaluate(`import('/src/core/commands/registry.ts').then((m) => m.commands.run('pane.openDevServer'))`)
    await sleep(800)
    const again = await evaluate(`${SESSIONS}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'browser').length)`)
    t.check('la segunda vez reusa el navegador', again === after, `${after} → ${again}`)
  } finally {
    await evaluate(`${SESSIONS}.then(async (m) => { const s = m.useSessions.getState(); const b = (await import('/src/store/browser.ts')).useBrowser.getState().states; s.sessions.filter((x) => x.agent === 'browser' && (b[x.id]?.url ?? '').includes(':${port}')).forEach((x) => s.kill(x.id)); s.kill(${JSON.stringify(shell.id)}) })`)
    await sleep(500)
    rmSync(DIR, { recursive: true, force: true })
  }
}
