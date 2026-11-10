// Achicar la ventana con un split abierto: nada se desborda y las terminales se reajustan.
// Regresión del grid sin `minmax(0, 1fr)`: el canvas de xterm fijaba el ancho mínimo de la app.
import { ensurePane, closePanes, assertQuiet, splitShell } from './_helpers.mjs'

const GEOMETRY = `({
  vp: [innerWidth, innerHeight],
  appW: document.querySelector('.app').scrollWidth,
  docW: document.documentElement.scrollWidth,
  panes: [...document.querySelectorAll('.pane')].map((p) => { const r = p.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.right)] }),
  xterm: [...document.querySelectorAll('.pane .xterm')].map((x) => Math.round(x.getBoundingClientRect().width))
})`

export default async function (api, t) {
  const { press, evaluate, sleep, waitFor, setViewport } = api
  await assertQuiet(api)
  const panes0 = await ensurePane(api)
  await splitShell(api)

  const g0 = await evaluate(GEOMETRY)
  t.check('con dos panes nada se desborda', g0.docW <= g0.vp[0] && g0.panes.every(([, r]) => r <= g0.vp[0] + 1), JSON.stringify(g0))

  // Ventana a 2/3 del ancho actual
  const narrow = Math.round(g0.vp[0] * 0.66)
  await setViewport(narrow, g0.vp[1])
  await sleep(700)
  const g1 = await evaluate(GEOMETRY)
  t.check('tras achicar: viewport cambió', g1.vp[0] === narrow, JSON.stringify(g1.vp))
  t.check('tras achicar: la app no se desborda', g1.docW <= g1.vp[0] && g1.appW <= g1.vp[0], `docW=${g1.docW} appW=${g1.appW} vp=${g1.vp[0]}`)
  t.check('tras achicar: los dos panes caben en pantalla', g1.panes.every(([, r]) => r <= g1.vp[0] + 1), JSON.stringify(g1.panes))
  t.check('tras achicar: xterm se reajustó', g1.xterm.every((w, i) => w < g0.xterm[i]), `antes=${g0.xterm} después=${g1.xterm}`)

  await setViewport(null)
  await sleep(700)
  const g2 = await evaluate(GEOMETRY)
  t.check('al restaurar: todo vuelve a caber', g2.docW <= g2.vp[0] && g2.panes.every(([, r]) => r <= g2.vp[0] + 1), JSON.stringify(g2))

  await closePanes(api, 2)
}
