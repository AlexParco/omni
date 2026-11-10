// Recorrido de capturas para revisión de diseño (solo lectura: abre y cierra overlays y vistas).
const UI = `import('/src/store/ui.ts')`
export default async function (api, t) {
  const { evaluate, sleep, screenshot, parkMouse } = api
  const dir = process.env.E2E_SHOTS
  const shot = async (n) => { await parkMouse(); await sleep(350); await screenshot(`${dir}/${n}.png`) }
  await evaluate(`${UI}.then((m) => { m.useUi.getState().closeOverlay(); m.useUi.getState().setView('fleet') })`)
  await shot('01-fleet')
  await evaluate(`${UI}.then((m) => m.useUi.getState().setFocus('list'))`); await shot('02-fleet-list')
  for (const v of ['worktrees', 'review', 'broadcast']) {
    await evaluate(`${UI}.then((m) => m.useUi.getState().setView('${v}'))`); await shot(`10-view-${v}`)
  }
  await evaluate(`${UI}.then((m) => m.useUi.getState().setView('fleet'))`)
  for (const o of ['palette', 'launcher', 'quickopen', 'settings', 'keys', 'todo', 'projectMenu', 'broadcastNew']) {
    await evaluate(`${UI}.then((m) => m.useUi.getState().openOverlay('${o}'))`); await shot(`20-ov-${o}`)
    await evaluate(`${UI}.then((m) => m.useUi.getState().closeOverlay())`); await sleep(150)
  }
  t.check('tour', true)
}
