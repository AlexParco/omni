// Diálogo de confianza de Claude Code (§3.13): no suena BEL, se detecta por texto; la sesión queda
// como pregunta (punto en el sidebar) y teclear en la terminal limpia la atención, como con BEL.
import { ensurePane, closePanes } from './_helpers.mjs'

const MOD = { sessions: `import('/src/store/sessions.ts')`, ui: `import('/src/store/ui.ts')` }

export default async function (api, t) {
  const { press, click, evaluate, snapshot, sleep, waitFor } = api
  await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().setView('fleet'))`)
  await ensurePane(api)
  const shell = await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0])`)
  const dialog = "printf '\\n Accessing workspace:\\n\\n /tmp/omni-trust-e2e\\n\\n Quick safety check: Is this a project you created or one you trust?\\n\\n ❯ 1. Yes, proceed\\n   2. No, exit\\n'\r"
  await evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, ${JSON.stringify(dialog)})`)
  t.check('el diálogo de confianza marca atención sin BEL', await waitFor(`${MOD.sessions}.then((m) => !!m.useSessions.getState().attention[${JSON.stringify(shell.id)}])`, 5000))
  t.check('el sidebar muestra la sesión como pregunta', await waitFor(`!!document.querySelector('.sidebar .row[data-status="question"]')`, 3000))
  await click('.pane'); await sleep(150)
  t.check('foco en la terminal de la sesión', await waitFor(`${MOD.ui}.then((m) => m.useUi.getState().view === 'fleet' && m.useUi.getState().focus === 'terminal')`, 3000), JSON.stringify(await snapshot()))
  await press('ctrl+u')
  t.check('teclear en la terminal limpia la atención (como con BEL)', await waitFor(`${MOD.sessions}.then((m) => !m.useSessions.getState().attention[${JSON.stringify(shell.id)}])`, 3000))
  await closePanes(api, 1)
}
