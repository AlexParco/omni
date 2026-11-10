// Artifacts de Claude en el navegador de omni: una terminal imprime un enlace de artifact (como hace Claude
// Code al publicar uno); la franja ofrece "artifact" y prefijo a lo abre en un navegador de omni (partición
// persistente: el login de claude.ai se conserva). La segunda vez reusa ese navegador.
const SESSIONS = `import('/src/store/sessions.ts')`
const URL = 'https://claude.ai/code/artifact/e2e-omni-0000'

export default async function (api, t) {
  const { evaluate, press, sleep, waitFor } = api
  await evaluate(`import('/src/store/ui.ts').then((m) => { m.useUi.getState().closeOverlay(); m.useUi.getState().setView('fleet') })`)
  const shell = await evaluate(`${SESSIONS}.then(async (m) => { const info = await m.useSessions.getState().create('shell'); (await import('/src/store/layout.ts')).useLayout.getState().openTab(info.workspaceId, info.id); return info })`)
  await sleep(600)
  await api.click('.pane')
  await sleep(150)
  const browsers = () => evaluate(`${SESSIONS}.then(async (m) => { const b = (await import('/src/store/browser.ts')).useBrowser.getState().states; return m.useSessions.getState().sessions.filter((x) => x.agent === 'browser').map((x) => ({ id: x.id, url: b[x.id]?.url ?? '' })) })`)
  const before = (await browsers()).length
  let opened = []
  try {
    await evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, ${JSON.stringify(`printf 'Publiqué el artifact: ${URL}\\n'\r`)})`)
    t.check('la franja ofrece el artifact', await waitFor(`[...document.querySelectorAll('.pane .strip__link')].some((l) => l.textContent === 'artifact')`, 4000))
    await press(await api.prefix())
    await press('a')
    t.check('prefijo a lo abre en el navegador de omni', await waitFor(`${SESSIONS}.then(async (m) => { const b = (await import('/src/store/browser.ts')).useBrowser.getState().states; return m.useSessions.getState().sessions.some((x) => x.agent === 'browser' && (b[x.id]?.url ?? '').startsWith(${JSON.stringify(URL)})) })`, 8000), JSON.stringify(await browsers()))
    opened = (await browsers()).filter((b) => b.url.startsWith(URL))
    t.check('abrió un solo navegador', (await browsers()).length === before + 1)
    await evaluate(`import('/src/store/layout.ts').then(async (l) => { const s = (await ${SESSIONS}).useSessions.getState(); const tab = l.useLayout.getState().tabs.find((t) => l.leaves(t.root).some((x) => x.sessionId === ${JSON.stringify(shell.id)})); s.activateTab(tab.id) })`)
    await sleep(300)
    await evaluate(`import('/src/core/commands/registry.ts').then((m) => m.commands.run('pane.openArtifact'))`)
    await sleep(800)
    t.check('la segunda vez reusa el navegador', (await browsers()).length === before + 1)
  } finally {
    await evaluate(`${SESSIONS}.then((m) => { const s = m.useSessions.getState(); ${JSON.stringify(opened.map((b) => b.id))}.forEach((id) => s.kill(id)); s.kill(${JSON.stringify(shell.id)}) })`)
    await sleep(400)
  }
}
