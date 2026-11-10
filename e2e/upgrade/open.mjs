// Paso 1 de `e2e/upgrade.sh`: con un daemon "viejo" (OMNI_TEST_BUILD=viejo) abre un shell y anota su id.
import { writeFileSync } from 'node:fs'

const SESSIONS = `import('/src/store/sessions.ts')`

export default async function (api, t) {
  const { evaluate, sleep } = api
  const shell = await evaluate(`${SESSIONS}.then(async (m) => { const info = await m.useSessions.getState().create('shell'); (await import('/src/store/layout.ts')).useLayout.getState().openTab(info.workspaceId, info.id); return info })`)
  await sleep(800)
  await evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, 'echo marca-de-antes\\r')`)
  await sleep(6000) // el daemon guarda la foto de pantalla cada 5 s
  t.check('shell abierto en el daemon viejo', !!shell.id, shell.id)
  t.check('sin aviso: app y daemon son del mismo build', !(await evaluate(`!!document.querySelector('.status-bar__notice')`)))
  writeFileSync(process.env.OMNI_UPGRADE_IDS, JSON.stringify({ shell: shell.id }))
}
