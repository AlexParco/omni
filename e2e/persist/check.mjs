// Fase 2 de `pnpm e2e:persist`: tras cerrar y reabrir la app, todo sigue: sesión en el daemon,
// layout restaurado, historial repintado, terminal viva y navegador recreado con su URL.
import { readFileSync } from 'node:fs'
const { shell, browser } = JSON.parse(readFileSync(process.env.OMNI_PERSIST_IDS ?? '/tmp/omni-persist-ids.json', 'utf8'))
const H = `import('/src/panes/terminal/terminal-host.ts')`
export default async function (api, t) {
  const { evaluate, sleep, snapshot, waitFor, click } = api
  // Los navegadores se recrean en `state:load`, que el renderer pide al arrancar: se espera a que aparezcan.
  await waitFor(`window.omni.invoke('session:list').then((l) => l.some((s) => s.id === ${JSON.stringify(browser)}))`, 8000)
  const list = await evaluate(`window.omni.invoke('session:list').then((l) => l.map((s) => s.agent + ':' + s.id))`)
  t.check('el shell creado antes de cerrar sigue en el daemon', list.includes('shell:' + shell), JSON.stringify(list.map((x) => x.slice(0, 14))))
  t.check('el navegador se recreó con el mismo id', list.includes('browser:' + browser), '')
  const title = await evaluate(`import('/src/store/sessions.ts').then((m) => m.useSessions.getState().titles[${JSON.stringify(shell)}])`)
  t.check('el título del shell vuelve aunque el historial ya no lo traiga', title === 'tema-persiste', String(title))
  // El navegador se abrió con split (prefijo |): vuelve como segundo pane del mismo tab.
  t.check('el layout se restauró (split con shell y navegador)', await waitFor(`document.querySelectorAll('.pane').length >= 2`, 5000), JSON.stringify(await snapshot()))
  const bstate = await evaluate(`window.omni.invoke('browser:state', ${JSON.stringify(browser)})`)
  t.check('el navegador volvió a su URL', bstate.url.startsWith('data:text/html,<title>Persiste'), bstate.url.slice(0, 40))
  // Ir al tab del shell por su fila del sidebar
  const row = await evaluate(`Promise.all([import('/src/store/sessions.ts'), import('/src/store/layout.ts')]).then(([sm, lm]) => { const tab = lm.useLayout.getState().tabs.find((tb) => lm.leaves(tb.root).some((l) => l.sessionId === ${JSON.stringify(shell)})); if (tab) sm.useSessions.getState().activateTab(tab.id); return !!tab })`)
  t.check('el tab del shell existe', row)
  await sleep(400)
  await click('.pane')
  await sleep(1500)
  const buf = () => evaluate(`${H}.then((m) => { const term = m.getTerminal(${JSON.stringify(shell)})?.term; if (!term) return null; const b = term.buffer.active; const out = []; for (let i = 0; i <= b.cursorY; i++) out.push(b.getLine(i)?.translateToString(true) ?? ''); return out.join('|') })`)
  t.check('el historial se repintó (marcador de antes de cerrar)', String(await buf()).includes('PERSISTE-123'), String(await buf()).slice(-160))
  await api.type('echo VIVA-456\n')
  await sleep(700)
  t.check('la terminal restaurada responde', /VIVA-456/.test(String(await buf()).replace(/echo VIVA-456/g, '')), String(await buf()).slice(-100))
}
