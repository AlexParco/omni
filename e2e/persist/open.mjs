// Fase 1 de `pnpm e2e:persist`: abre un shell con un marcador y un navegador, y anota sus ids.
import { writeFileSync } from 'node:fs'
import { ensurePane } from '../scenarios/_helpers.mjs'
const S = `import('/src/store/sessions.ts')`
export default async function (api, t) {
  const { evaluate, type, press, sleep, waitFor } = api
  // HOME nuevo: el daemon arranca de cero y la app tarda en restaurar; ⌘T antes de eso se pierde.
  await waitFor(`${S}.then((m) => m.useSessions.getState().ready)`, 20000)
  await ensurePane(api)
  // Título por OSC (como el tema que escribe Claude Code) y luego más salida que el historial del daemon
  // (512 KB): al reabrir, la repetición ya no trae ese OSC y el nombre solo puede venir de state.json.
  await type("printf '\\033]0;tema-persiste\\007'; head -c 700000 /dev/zero | tr '\\0' 'x'; echo\n")
  await sleep(2500)
  await type('clear; echo PERSISTE-123\n')
  await sleep(600)
  const shell = await evaluate(`${S}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0]?.id)`)
  await press(await api.prefix()); await press('|'); await waitFor(`!!document.querySelector('.overlay')`); await type('Naveg'); await sleep(100); await press('enter')
  await waitFor(`!!document.querySelector('.pane .browser')`); await sleep(400)
  const browser = await evaluate(`${S}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'browser').sort((a, b) => b.createdAt - a.createdAt)[0]?.id)`)
  await evaluate(`window.omni.invoke('browser:navigate', ${JSON.stringify(browser)}, 'data:text/html,<title>Persiste</title>ok')`)
  await waitFor(`document.querySelector('.pane:has(.browser) .strip__title')?.textContent === 'Persiste'`, 5000)
  await sleep(1200) // debounce de state:save
  t.check('shell y navegador creados', !!shell && !!browser, `${shell} ${browser}`)
  const title = await evaluate(`${S}.then((m) => m.useSessions.getState().titles[${JSON.stringify(shell)}])`)
  t.check('el shell tiene su título OSC antes de cerrar', title === 'tema-persiste', String(title))
  writeFileSync(process.env.OMNI_PERSIST_IDS ?? '/tmp/omni-persist-ids.json', JSON.stringify({ shell, browser }))
}
