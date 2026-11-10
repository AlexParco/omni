// Contextos WebGL de las terminales: Chromium mantiene unos 16 vivos por ventana y, al pasarse, mata el
// más viejo (su canvas queda blanco con una carita). Solo la terminal montada usa WebGL; la oculta lo
// suelta, y al volver a mostrarse pinta con un contexto nuevo.
import { ensurePane, closePanes } from './_helpers.mjs'

const MOD = { sessions: `import('/src/store/sessions.ts')`, host: `import('/src/panes/terminal/terminal-host.ts')`, layout: `import('/src/store/layout.ts')` }
const TABS = 20

const newestShell = `${MOD.sessions}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0]?.id)`
/** Terminales con renderer WebGL en este momento (montadas o no). */
const webglCount = `Promise.all([${MOD.sessions}, ${MOD.host}]).then(([s, h]) => s.useSessions.getState().sessions.filter((x) => h.getTerminal(x.id)?.webgl).length)`
/** Algún canvas WebGL en pantalla perdió su contexto (lo que Chromium pinta con la carita). */
const lostOnScreen = `[...document.querySelectorAll('.pane canvas')].some((c) => c.getContext('webgl2')?.isContextLost?.() === true)`

export default async function (api, t) {
  const { evaluate, waitFor, sleep } = api
  const ids = []
  let maxWebgl = 0
  for (let i = 0; i < TABS; i++) {
    await ensurePane(api)
    ids.push(await evaluate(newestShell))
    maxWebgl = Math.max(maxWebgl, await evaluate(webglCount))
  }
  const panes = await evaluate(`document.querySelectorAll('.pane').length`)
  t.check(`con ${TABS} tabs de terminal, solo las visibles tienen WebGL`, maxWebgl <= panes, `máximo ${maxWebgl} con ${panes} panes en pantalla`)
  t.check('ningún canvas en pantalla perdió su contexto', !(await evaluate(lostOnScreen)))

  // Volver al primer tab: su terminal se monta con un contexto nuevo y vivo.
  const first = JSON.stringify(ids[0])
  await evaluate(`${MOD.layout}.then((m) => m.useLayout.getState().focusSession(${first}))`)
  await sleep(500)
  t.check('la primera terminal vuelve con WebGL', await waitFor(`${MOD.host}.then((m) => !!m.getTerminal(${first})?.webgl)`, 3000))
  t.check('y su canvas no está perdido', !(await evaluate(lostOnScreen)))

  // Pérdida forzada (GPU reiniciada): la terminal cae al renderer DOM y sigue mostrando texto.
  await evaluate(`window.omni.send('session:write', ${first}, "echo WEBGL-PERDIDO-OK\\r")`)
  await sleep(300)
  await evaluate(`[...document.querySelectorAll('.pane canvas')].map((c) => c.getContext('webgl2')).find(Boolean)?.getExtension('WEBGL_lose_context')?.loseContext()`)
  // xterm espera ~3 s a que Chromium restaure el contexto antes de darlo por perdido.
  t.check('al perder el contexto, la terminal suelta WebGL', await waitFor(`${MOD.host}.then((m) => !m.getTerminal(${first})?.webgl)`, 10000))
  t.check('y pinta el texto con el renderer DOM', await waitFor(`!!document.querySelector('.pane .xterm-rows') && /WEBGL-PERDIDO-OK/.test(document.querySelector('.pane .xterm-rows').textContent)`, 3000))
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/webgl-lost.png')

  // Limpieza: cerrar los tabs de prueba (cada uno queda enfocado al cerrarse el anterior).
  for (const id of ids) {
    await evaluate(`${MOD.layout}.then((m) => m.useLayout.getState().focusSession(${JSON.stringify(id)}))`)
    await sleep(150)
    await api.click('.pane')
    await closePanes(api, 1)
  }
}
