// Paso 2 de `e2e/upgrade.sh`: la app es de otro build y conserva el daemon viejo (como la empaquetada).
// El pie avisa, "Actualizar terminales" pide confirmar, reemplaza el daemon y la sesión vuelve con su id.
import { readFileSync } from 'node:fs'

const SESSIONS = `import('/src/store/sessions.ts')`

export default async function (api, t) {
  const { evaluate, press, sleep, waitFor } = api
  const { shell } = JSON.parse(readFileSync(process.env.OMNI_UPGRADE_IDS, 'utf8'))
  const has = `${SESSIONS}.then((m) => m.useSessions.getState().sessions.some((x) => x.id === ${JSON.stringify(shell)}))`
  t.check('la sesión sigue viva en el daemon viejo', await waitFor(has, 5000))
  t.check('main sabe que el daemon es de otro build', (await evaluate(`window.omni.invoke('daemon:status')`)).outdated === true)
  t.check('el pie ofrece Actualizar terminales', await waitFor(`document.querySelector('.status-bar__notice')?.textContent === 'Actualizar terminales'`, 3000))

  await evaluate(`document.querySelector('.status-bar__notice').click()`)
  t.check('pide confirmar', await waitFor(`document.querySelector('.picker__title')?.textContent === '¿Actualizar las terminales?'`, 2000), await evaluate(`document.querySelector('.picker')?.textContent ?? 'sin picker'`))
  t.check('dice cuántas terminales reabre', await evaluate(`[...document.querySelectorAll('.picker [role=option]')][0]?.textContent?.startsWith('Reabrir 1 terminal')`), await evaluate(`document.querySelector('.picker [role=option]')?.textContent ?? ''`))
  await press('enter')

  // Main reemplaza el daemon, revive y recarga la ventana: se espera a que el renderer nuevo esté listo.
  await sleep(2000)
  t.check('tras recargar, la sesión vuelve con su mismo id', await waitFor(`${SESSIONS}.then((m) => m.useSessions.getState().ready).then((r) => r && ${has})`, 20000))
  t.check('el daemon ya es de este build', await waitFor(`window.omni.invoke('daemon:status').then((s) => s.outdated === false)`, 5000))
  t.check('el aviso del pie se fue', await waitFor(`!document.querySelector('.status-bar__notice')`, 3000))
  const history = await evaluate(`window.omni.invoke('session:history', ${JSON.stringify(shell)})`)
  t.check('la pantalla de antes vuelve con su separador', history.includes('marca-de-antes') && history.includes('sesión restaurada'), history.slice(-300))
  t.check('el aviso dice que se actualizaron', await waitFor(`document.body.textContent.includes('Terminales actualizadas')`, 5000))
}
