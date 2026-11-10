// Icono vivo del agente: el tab muestra lo que corre AHORA en la terminal (proceso en primer plano).
// Un binario llamado `claude` (un C mínimo que duerme; una copia de `sleep` la mata macOS) lanzado en un shell pasa el icono a Claude; al
// salir con Ctrl-C el shell vuelve al primer plano y el icono vuelve a terminal. Mismo camino que
// "salí de Claude Code y el tab seguía con el asterisco".
import { ensurePane, closePanes } from './_helpers.mjs'

const MOD = { sessions: `import('/src/store/sessions.ts')` }
const FAKE_DIR = '/tmp/omni-e2e-fake-agent'

export default async function (api, t) {
  const { evaluate, waitFor, sleep } = api
  await ensurePane(api)
  const shell = await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0])`)
  const id = JSON.stringify(shell.id)
  const live = `document.querySelector('.pane[data-focus="live"]') ?? document.querySelector('.pane')`
  const claudeIcons = `[document.querySelector('.tabs .tab[data-active] .agent-icon--claude'), (${live})?.querySelector('.strip .agent-icon--claude'), document.querySelector('.sidebar .row[data-level="1"][data-active] .agent-icon--claude')]`

  t.check('el shell recién abierto muestra el icono de terminal', await waitFor(`${claudeIcons}.every((x) => !x)`, 3000))
  const cmd = `mkdir -p ${FAKE_DIR} && printf '#include <unistd.h>\\nint main(void){sleep(60);return 0;}\\n' > ${FAKE_DIR}/a.c && cc -o ${FAKE_DIR}/claude ${FAKE_DIR}/a.c && ${FAKE_DIR}/claude\r`
  await evaluate(`window.omni.send('session:write', ${id}, ${JSON.stringify(cmd)})`)
  t.check('main reporta `claude` en primer plano', await waitFor(`${MOD.sessions}.then((m) => m.useSessions.getState().foreground[${id}] === 'claude')`, 6000), JSON.stringify(await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().foreground)`)))
  t.check('tab, franja y sidebar pasan al asterisco de Claude', await waitFor(`${claudeIcons}.every(Boolean)`, 3000), JSON.stringify(await evaluate(`${claudeIcons}.map(Boolean)`)))
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/agent-live.png')

  await evaluate(`window.omni.send('session:write', ${id}, '\\x03')`)
  t.check('al salir el shell vuelve al primer plano', await waitFor(`${MOD.sessions}.then((m) => m.useSessions.getState().foreground[${id}] === 'zsh' || m.useSessions.getState().foreground[${id}] === '-zsh')`, 6000))
  t.check('tab, franja y sidebar vuelven al icono de terminal', await waitFor(`${claudeIcons}.every((x) => !x) && !!(${live})?.querySelector('.strip svg.lucide-terminal')`, 3000), JSON.stringify(await evaluate(`${claudeIcons}.map(Boolean)`)))
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/agent-exited.png')
  await evaluate(`window.omni.send('session:write', ${id}, 'rm -rf ${FAKE_DIR}; clear\\r')`)
  await sleep(300)
  await closePanes(api, 1)
}
