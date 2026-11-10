// Estado de un agente y sus señales (§3.14): el título que anuncia Claude Code (`✳` en reposo, spinner
// trabajando) manda sobre la ventana de salida; el sidebar y la franja solo marcan lo que hay que mirar,
// y la navegación separa el conteo (gris, junto al nombre) del atajo (tecla, a la derecha).
import { ensurePane, closePanes } from './_helpers.mjs'

const MOD = { sessions: `import('/src/store/sessions.ts')`, ui: `import('/src/store/ui.ts')` }

export default async function (api, t) {
  const { evaluate, sleep, waitFor } = api
  await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().setView('fleet'))`)
  await ensurePane(api)
  const shell = await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0])`)
  const id = JSON.stringify(shell.id)
  const write = (cmd) => evaluate(`window.omni.send('session:write', ${id}, ${JSON.stringify(cmd)})`)
  const tabRow = `[...document.querySelectorAll('.sidebar [role=option][data-level="1"]')].find((r) => r.querySelector('.row__label')?.textContent?.includes('Tarea e2e'))`
  const status = () => evaluate(`${MOD.sessions}.then((m) => m.sessionStatus(m.useSessions.getState(), ${id}))`)

  // A. Spinner en el título y silencio largo (una tool que tarda): sigue trabajando.
  await write("clear; printf '\\033]0;◐ Tarea e2e\\007'\r")
  await waitFor(`!!(${tabRow})`, 3000)
  await sleep(5500)
  t.check('con spinner en el título sigue trabajando aunque calle más de 4 s', (await status()) === 'working', await status())
  t.check('la fila del tab lleva el aro de trabajando', await evaluate(`!!(${tabRow})?.querySelector('.row__end .dot[data-status="working"]')`))
  t.check('la franja dice trabajando', await evaluate(`document.querySelector('.pane[data-focus="live"] .strip__status, .pane .strip__status')?.textContent ?? ''`) === 'trabajando')

  // B. Plegado, la cabecera del proyecto resume lo que esconde.
  const projectId = await evaluate(`${MOD.sessions}.then((m) => { const s = m.useSessions.getState(); return s.workspaces.find((w) => w.id === ${JSON.stringify(shell.workspaceId)})?.projectId })`)
  const header = `document.getElementById('row-p-${projectId}')`
  t.check('desplegado, la cabecera no repite el punto', await evaluate(`!(${header})?.querySelector('.row__end .dot')`))
  await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().setCollapsed(${JSON.stringify(projectId)}, true))`)
  t.check('plegado, la cabecera lleva el aro de trabajando', await waitFor(`!!(${header})?.querySelector('.row__end .dot[data-status="working"]')`, 2000))
  await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().setCollapsed(${JSON.stringify(projectId)}, false))`)
  await waitFor(`!!(${tabRow})`, 2000)

  // C. `✳` en el título: listo al toque, y la salida que siga (redibujos) no lo vuelve a "trabajando".
  await write("printf '\\033]0;✳ Tarea e2e\\007'; for i in 1 2 3; do echo redibujo; sleep 0.5; done\r")
  t.check('con ✳ en el título queda listo al toque', await waitFor(`${MOD.sessions}.then((m) => m.sessionStatus(m.useSessions.getState(), ${id}) === 'idle')`, 1500), await status())
  await sleep(800)
  t.check('la salida siguiente no lo marca trabajando', (await status()) === 'idle', await status())
  t.check('en reposo y visto, la fila no lleva punto', await evaluate(`!(${tabRow})?.querySelector('.dot')`))
  t.check('en reposo, la franja no lleva punto ni texto', await evaluate(`!document.querySelector('.pane .strip .dot') && !document.querySelector('.pane .strip .strip__status')`))

  // D. Navegación: el atajo siempre a la derecha como tecla; el conteo, en gris junto al nombre.
  const nav = await evaluate(`[...document.querySelectorAll('.sidebar__nav .nav-item')].map((n) => ({ label: n.querySelector('.nav-item__label')?.firstChild?.textContent ?? '', count: n.querySelector('.nav-item__label .nav-item__count')?.textContent ?? null, end: n.querySelector('.nav-item__end')?.textContent ?? null, endIsKey: !!n.querySelector('.nav-item__end .kbd'), badge: !!n.querySelector('.badge') }))`)
  t.check('cada entrada de la navegación termina en su atajo', nav.length === 4 && nav.every((n) => n.endIsKey && !n.badge), JSON.stringify(nav))
  t.check('ningún conteo va al final, donde va la tecla', nav.every((n) => n.count === null || /^\d+$/.test(n.count)), JSON.stringify(nav))

  await write("printf '\\033]0;zsh\\007'; clear\r")
  await sleep(300)
  await closePanes(api, 1)
}
