// Soltar un archivo sobre la terminal (una captura arrastrada desde el escritorio o el thumbnail de
// macOS) pega su ruta escapada como Terminal.app; Claude Code la reconoce y adjunta la imagen.
// CDP `Input.dispatchDragEvent` suelta un archivo real, con la misma ruta que daría Finder.
import { writeFileSync, mkdirSync } from 'node:fs'
import { ensurePane, closePanes } from './_helpers.mjs'

const DIR = '/tmp/omni-e2e-drop'
const FILE = `${DIR}/Screenshot 2026-10-16 at 10.06.10 AM.png`
const ESCAPED = '/tmp/omni-e2e-drop/Screenshot\\ 2026-10-16\\ at\\ 10.06.10\\ AM.png'

export default async function (api, t) {
  const { evaluate, waitFor, sleep, cdp } = api
  mkdirSync(DIR, { recursive: true })
  writeFileSync(FILE, Buffer.from('89504e470d0a1a0a', 'hex'))
  await ensurePane(api)
  const shell = await evaluate(`import('/src/store/sessions.ts').then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0])`)
  const box = await evaluate(`(() => { const r = (document.querySelector('.pane[data-focus="live"] .term-root') ?? document.querySelector('.pane .term-root')).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  const urlBefore = await evaluate('location.href')
  const data = { items: [], files: [FILE], dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data })
  const screen = `import('/src/panes/terminal/terminal-host.ts').then((m) => (m.screenLines(${JSON.stringify(shell.id)}, 40) ?? []).join('\\n'))`
  t.check('la ruta soltada aparece escapada en la línea de comando', await waitFor(`${screen}.then((s) => s.includes(${JSON.stringify(ESCAPED)}))`, 4000), (await evaluate(screen)).slice(-300))
  t.check('la ventana no navegó al archivo', (await evaluate('location.href')) === urlBefore)
  t.check('el foco queda en la terminal', await evaluate(`document.activeElement?.classList.contains('xterm-helper-textarea') ?? false`))
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/drop.png')

  // Fuera de una terminal (sidebar): nada se pega y la app sigue en su sitio.
  const side = await evaluate(`(() => { const r = document.querySelector('.sidebar').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.bottom - 120) } })()`)
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp('Input.dispatchDragEvent', { type, x: side.x, y: side.y, data })
  await sleep(800)
  t.check('soltar sobre el sidebar no reemplaza la app', (await evaluate('location.href')) === urlBefore && (await evaluate(`!!document.querySelector('.sidebar')`)))

  await evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, '\\x15')`)
  await sleep(200)
  await closePanes(api, 1)
}
