// Addons de terminal como Orca: el daemon (o main con OMNI_DAEMON=0) guarda un espejo headless y al
// recargar el renderer la xterm se repinta con el estado serializado (incluida la pantalla alterna de
// una TUI); imágenes SIXEL en línea; ligaduras cargadas sin error.
import { ensurePane, closePanes } from './_helpers.mjs'

const MOD = { sessions: `import('/src/store/sessions.ts')`, host: `import('/src/panes/terminal/terminal-host.ts')` }

export default async function (api, t) {
  const { evaluate, waitFor, sleep } = api
  await ensurePane(api)
  const shell = await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0])`)
  const id = JSON.stringify(shell.id)
  const write = (s) => evaluate(`window.omni.send('session:write', ${id}, ${JSON.stringify(s)})`)
  const screen = `${MOD.host}.then((m) => { const term = m.getTerminal(${id})?.term; if (!term) return null; const b = term.buffer.active; const out = []; for (let i = 0; i < term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? ''); return { type: b.type, text: out.join('\\n') } })`

  // SIXEL: un bloque rojo de 6x6. El addon de imágenes lo pinta en su capa propia.
  await write(`printf '\\033Pq#0;2;100;0;0#0~~~~~~\\033\\\\'; echo\r`)
  t.check('la imagen SIXEL llega a la capa de imágenes', await waitFor(`${MOD.host}.then((m) => { const term = m.getTerminal(${id})?.term; const store = term?._addonManager?._addons?.find((a) => a.instance && '_storage' in a.instance)?.instance?._storage; return !!store && (store._images?.size ?? 0) > 0 })`, 5000))
  t.check('el addon de ligaduras quedó cargado', await evaluate(`${MOD.host}.then((m) => !!m.getTerminal(${id})?.term?._addonManager?._addons?.some((a) => a.instance && typeof a.instance._characterJoinerId === 'number'))`))

  // TUI a pantalla completa: pasa a la pantalla alterna y se queda ahí.
  await write(`printf '\\033[?1049h\\033[2J\\033[HTUI-ALTERNA-OK\\n'; sleep 60\r`)
  t.check('la TUI está en pantalla alterna', await waitFor(`${screen}.then((s) => s?.type === 'alternate' && /TUI-ALTERNA-OK/.test(s.text))`, 5000), JSON.stringify(await evaluate(screen)))
  await sleep(500)

  // Recarga del renderer: la sesión sigue viva y la xterm nueva se arma desde `session:history`.
  await evaluate(`location.reload()`).catch(() => {})
  await sleep(5000)
  await waitFor(`!!document.querySelector('.pane')`, 15000)
  const after = await evaluate(screen)
  t.check('tras recargar, la xterm vuelve en pantalla alterna con la TUI tal cual', after?.type === 'alternate' && /TUI-ALTERNA-OK/.test(after.text), JSON.stringify(after))
  const history = await evaluate(`window.omni.invoke('session:history', ${id})`)
  // Serializado: pantalla normal + alterna, no los bytes crudos (la secuencia SIXEL ya no viaja).
  t.check('session:history es el estado serializado, no la salida cruda', history.includes('\x1b[?1049h') && !history.includes('\x1bPq'), `${history.length} chars`)
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/addons-reload.png')

  await write('\x03')
  await write(`printf '\\033[?1049l'\r`)
  t.check('al salir la TUI vuelve la pantalla normal', await waitFor(`${screen}.then((s) => s?.type === 'normal')`, 5000))
  await write('clear\r')
  await sleep(300)
  await closePanes(api, 1)
}
