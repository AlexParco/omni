// Proceso de una página caído (§3.9): Chromium dejaría una carita gris tapando el pane (y lo que esté
// debajo). Se tumba con `Page.crash` por CDP sobre la vista: main la recarga sola, la franja avisa y
// la página vuelve a su URL.
import { ensurePane, closePanes, assertQuiet } from './_helpers.mjs'

const PORT = process.env.OMNI_CDP_PORT ?? '9229'
const B = `import('/src/store/browser.ts')`
const S = `import('/src/store/sessions.ts')`

async function crashView(match) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const view = targets.find((t) => t.type === 'page' && (t.title ?? '').includes(match))
  if (!view) return false
  const ws = new WebSocket(view.webSocketDebuggerUrl)
  await new Promise((ok, bad) => {
    ws.onopen = ok
    ws.onerror = bad
  })
  ws.send(JSON.stringify({ id: 1, method: 'Page.crash' }))
  await new Promise((r) => setTimeout(r, 300))
  ws.close()
  return true
}

export default async function (api, t) {
  const { evaluate, press, type, sleep, waitFor } = api
  await assertQuiet(api)
  await ensurePane(api)
  await press(await api.prefix()); await press('|'); await waitFor(`!!document.querySelector('.overlay')`); await type('Naveg'); await sleep(150); await press('enter')
  await waitFor(`!!document.querySelector('.pane .browser')`)
  const id = await evaluate(`${S}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'browser').sort((a, b) => b.createdAt - a.createdAt)[0]?.id)`)
  const url = 'data:text/html,<title>Pagina que se cae</title><h1>hola</h1>'
  await evaluate(`window.omni.invoke('browser:navigate', ${JSON.stringify(id)}, ${JSON.stringify(url)})`)
  t.check('la página carga', await waitFor(`window.omni.invoke('browser:state', ${JSON.stringify(id)}).then((s) => s.title === 'Pagina que se cae')`, 6000))

  t.check('se pudo tumbar el proceso de la página', await crashView('Pagina que se cae'))
  t.check('la franja avisa que se cayó y se recargó', await waitFor(`${B}.then((m) => /se cerró inesperadamente/.test(m.useBrowser.getState().notices[${JSON.stringify(id)}] ?? ''))`, 5000))
  t.check('la página vuelve sola (mismo título y URL)', await waitFor(`window.omni.invoke('browser:state', ${JSON.stringify(id)}).then((s) => s.title === 'Pagina que se cae' && s.url.startsWith('data:text/html'))`, 8000))
  t.check('y responde: se puede volver a tumbar y recargar', await crashView('Pagina que se cae') && (await waitFor(`window.omni.invoke('browser:state', ${JSON.stringify(id)}).then((s) => s.title === 'Pagina que se cae' && !s.loading)`, 8000)))

  await evaluate(`${S}.then((m) => m.useSessions.getState().kill(${JSON.stringify(id)}))`)
  await sleep(400)
  await closePanes(api, 1)
}
