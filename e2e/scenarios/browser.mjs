// Navegador embebido: abrir desde el launcher, navegar por la barra, DevTools, perfiles, cookies, viewport, captura (recortar → dibujar → enviar o copiar la imagen) a disco y
// ruta escrita en la terminal vecina, cierre. La vista nativa no sale en el DOM del renderer:
// lo que la página pintó se comprueba con la captura (PNG) y con el estado que publica main.
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chordFor, ensurePane, closePanes, assertQuiet } from './_helpers.mjs'

const CAPTURES = join(homedir(), '.config', 'omni', 'captures')
const newestCapture = (since) => {
  try {
    return readdirSync(CAPTURES)
      .filter((f) => f.endsWith('.png'))
      .map((f) => join(CAPTURES, f))
      .filter((p) => statSync(p).mtimeMs >= since)
      .sort()
      .pop()
  } catch {
    return undefined
  }
}

// Módulos del renderer en dev (Vite sirve /src/...): mismas instancias que usa la app.
const MOD = {
  sessions: `import('/src/store/sessions.ts')`,
  browser: `import('/src/store/browser.ts')`,
  host: `import('/src/panes/terminal/terminal-host.ts')`
}

export default async function (api, t) {
  const { press, type, evaluate, snapshot, sleep, waitFor } = api
  await assertQuiet(api)
  const tabs0 = (await snapshot()).tabs
  await ensurePane(api) // shell del test: destino de la captura
  const shellId = await evaluate(`${MOD.sessions}.then((m) => { const s = m.useSessions.getState(); return s.sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null })`)
  t.check('hay un shell de prueba', !!shellId)

  // Navegador en split a la derecha desde el launcher
  await press(await api.prefix())
  await press(await chordFor(api, 'pane.split.right', 'terminal'))
  await waitFor(`!!document.querySelector('.overlay')`)
  await type('Naveg')
  await sleep(150)
  await press('enter')
  t.check('el launcher crea un pane de navegador', await waitFor(`!!document.querySelector('.pane .browser')`))
  await sleep(500)
  let s = await snapshot()
  t.check('el pane del navegador tiene el foco del layout', await evaluate(`document.querySelector('.pane:has(.browser)')?.dataset.focus !== 'none'`), await evaluate(`document.querySelector('.pane:has(.browser)')?.dataset.focus`))
  const blankTitles = await evaluate(`JSON.stringify({ strip: document.querySelector('.pane:has(.browser) .strip__title')?.textContent, rows: [...document.querySelectorAll('.sidebar .row__label')].map((e) => e.textContent) })`)
  t.check('la franja y el sidebar dicen Navegador', JSON.parse(blankTitles).strip === 'Navegador' && JSON.parse(blankTitles).rows.includes('Navegador'), blankTitles)
  // El más reciente: corridas anteriores pueden haber dejado otro navegador vivo.
  const browserId = await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'browser').sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null)`)
  t.check('main registró la sesión browser', !!browserId)

  // ⌘L → barra de URL; navegar a una página con título y consola
  await press('cmd+l')
  await sleep(150)
  t.check('⌘L enfoca la barra de URL', (await snapshot()).active.startsWith('INPUT'), (await snapshot()).active)
  await type('data:text/html,<title>Hola omni</title><body style="background:rgb(27,67,50);color:white;font:40px sans-serif;padding:40px">omni browser ok <button id="go" style="font:24px sans-serif;padding:8px 16px">Ir</button></body><script>console.log("uno");console.warn("dos");document.getElementById("go").setAttribute("data-x", String.fromCharCode(27)+"[201~echo PWNED"+String.fromCharCode(13))</script>')
  await press('enter')
  t.check('la franja muestra el título de la página', await waitFor(`document.querySelector('.pane:has(.browser) .strip__title')?.textContent === 'Hola omni'`, 5000), await evaluate(`document.querySelector('.pane:has(.browser) .strip__title')?.textContent`))
  await waitFor(`window.omni.invoke('browser:state', ${JSON.stringify(browserId)}).then((s) => !s.loading)`, 4000)
  const state = await evaluate(`window.omni.invoke('browser:state', ${JSON.stringify(browserId)})`)
  t.check('main publica estado: url data: y sin carga', state.url.startsWith('data:') && !state.loading, JSON.stringify({ url: state.url.slice(0, 30), loading: state.loading, title: state.title }))

  // DevTools acopladas (⌥⌘I): reemplazan a la consola propia
  await press('cmd+alt+i')
  t.check('⌥⌘I abre las DevTools acopladas (hueco bajo la página y estado de main)', await waitFor(`!!document.querySelector('.browser__devtools') && !!document.querySelector('.browser[data-devtools]')`, 4000) && (await evaluate(`window.omni.invoke('browser:state', ${JSON.stringify(browserId)})`)).devtools === true, JSON.stringify(await evaluate(`({ hole: !!document.querySelector('.browser__devtools'), attr: !!document.querySelector('.browser[data-devtools]') })`)))
  await sleep(800)
  const dtTargets = await fetch('http://127.0.0.1:9229/json').then((r) => r.json()).then((l) => l.filter((x) => String(x.url).startsWith('devtools://')).length).catch(() => -1)
  t.check('existe un webContents de DevTools (target devtools://)', dtTargets >= 1, `targets devtools=${dtTargets}`)
  const dtRect = await evaluate(`JSON.stringify(document.querySelector('.browser__devtools')?.getBoundingClientRect() ?? null)`)
  t.check('el hueco de DevTools tiene tamaño', dtRect !== 'null' && JSON.parse(dtRect).height > 100, dtRect.slice(0, 80))
  t.check('ya no existe la consola propia', !(await evaluate(`!!document.querySelector('.console, .console__list, .console-drawer, .browser__console')`)))
  await press('cmd+alt+i')
  t.check('⌥⌘I cierra las DevTools', await waitFor(`!document.querySelector('.browser__devtools')`, 4000))
  const tail = await evaluate(`window.omni.invoke('browser:consoleTail', ${JSON.stringify(browserId)}, 20)`)
  t.check('main conserva el tail de consola para el adjunto', Array.isArray(tail) && tail.some((l) => /uno/.test(l)) && tail.some((l) => /^warn/.test(l) && /dos/.test(l)), JSON.stringify(tail).slice(0, 120))

  // Menú … de la cabecera: perfil, cookies, viewport, ajustes
  await evaluate(`import('/src/core/commands/registry.ts').then((m) => m.commands.run('browser.menu'))`)
  await sleep(300)
  const menuItems = await evaluate(`[...document.querySelectorAll('.picker__label')].map((e) => e.textContent)`)
  t.check('el menú del navegador ofrece perfil, cookies, viewport y ajustes', /Perfil/.test(menuItems.join('|')) && /cookies/i.test(menuItems.join('|')) && /viewport/i.test(menuItems.join('|')) && /Ajustes/.test(menuItems.join('|')), JSON.stringify(menuItems))
  await press('escape')
  await sleep(200)
  t.check('Esc cierra el menú', !(await evaluate(`!!document.querySelector('.overlay')`)))

  // Perfiles, cookies desde archivo, viewport y borrar datos (todo por IPC: el menú solo los invoca)
  const profile = await evaluate(`window.omni.invoke('browser:profileCreate', 'omni-e2e')`)
  t.check('se crea un perfil', !!profile?.id && profile.name === 'omni-e2e', JSON.stringify(profile))
  await evaluate(`window.omni.invoke('browser:profileSet', ${JSON.stringify(browserId)}, ${JSON.stringify(profile?.id ?? '')})`)
  await sleep(1200)
  const stProf = await evaluate(`window.omni.invoke('browser:state', ${JSON.stringify(browserId)})`)
  t.check('la vista se recreó en el perfil nuevo con la misma URL', stProf.profileId === profile?.id && stProf.url.startsWith('data:'), JSON.stringify({ p: stProf.profileId, url: stProf.url.slice(0, 30) }))
  t.check('tras cambiar de perfil el pane sigue mostrando el título', await waitFor(`document.querySelector('.pane:has(.browser) .strip__title')?.textContent === 'Hola omni'`, 4000))
  const cookieFile = join(tmpdir(), 'omni-e2e-cookies.txt')
  writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t' + Math.floor(Date.now() / 1000 + 3600) + '\tomni_e2e\tvalor1\n#HttpOnly_example.com\tFALSE\t/\tFALSE\t0\tomni_sess\tvalor2\n.example.com\tTRUE\t/\tFALSE\t1\tcaducada\tx\n')
  const imp = await evaluate(`window.omni.invoke('browser:importCookies', ${JSON.stringify(browserId)}, 'file', ${JSON.stringify(cookieFile)})`)
  t.check('importar cookies desde archivo cuenta 2 importadas y 1 caducada saltada', imp?.imported === 2 && imp?.skipped === 1 && /Google/.test(imp?.note ?? ''), JSON.stringify(imp))
  const impBad = await evaluate(`window.omni.invoke('browser:importCookies', ${JSON.stringify(browserId)}, 'file', '/no/existe.txt').then(() => 'ok', (e) => String(e.message ?? e))`)
  t.check('un archivo que no existe da un error humano', /no existe|No such|encontr/i.test(impBad), impBad.slice(0, 80))
  await evaluate(`window.omni.invoke('browser:viewport', ${JSON.stringify(browserId)}, { id: 'iphone-14', name: 'iPhone 14', width: 390, height: 844, mobile: true })`)
  await sleep(600)
  const stVp = await evaluate(`window.omni.invoke('browser:state', ${JSON.stringify(browserId)})`)
  const viewRect = await evaluate(`JSON.stringify((() => { const r = document.querySelector('.pane:has(.browser) .browser__view').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] })())`)
  t.check('el preset iPhone 14 fija el hueco a 390 × 844 y main lo publica', stVp.viewport?.id === 'iphone-14' && viewRect === '[390,844]', `${JSON.stringify(stVp.viewport)} hueco=${viewRect}`)
  await evaluate(`window.omni.invoke('browser:viewport', ${JSON.stringify(browserId)}, null)`)
  await sleep(400)
  t.check('null vuelve a responsive', (await evaluate(`window.omni.invoke('browser:state', ${JSON.stringify(browserId)})`)).viewport === null)
  const cleared = await evaluate(`window.omni.invoke('browser:clearData', ${JSON.stringify(browserId)}).then(() => 'ok', (e) => String(e))`)
  t.check('borrar datos del perfil no falla', cleared === 'ok', cleared)
  await evaluate(`window.omni.invoke('browser:profileSet', ${JSON.stringify(browserId)}, 'default')`)
  await sleep(1500)
  const del = await evaluate(`window.omni.invoke('browser:profileDelete', ${JSON.stringify(profile?.id ?? '')}).then(() => 'ok', (e) => String(e))`)
  t.check('el perfil de prueba se borra', del === 'ok' && !(await evaluate(`window.omni.invoke('browser:profiles')`)).some((p) => p.id === profile?.id), del)
  const delBuiltin = await evaluate(`window.omni.invoke('browser:profileDelete', 'default').then(() => 'ok', (e) => 'error')`)
  t.check('el perfil por defecto no se puede borrar', delBuiltin === 'error')

  // Captura (⌘⇧S), un solo flujo: recortar → dibujar (opcional) → "Enviar al agente" (enviar o copiar la imagen).
  // Solo con la ventana visible pinta la vista nativa; tapada, main responde error y no se abre nada.
  const visible = await evaluate(`document.visibilityState === 'visible'`)
  const drag = async (rect, from, to) => {
    const [rx, ry, rw, rh] = rect
    const x0 = rx + rw * from, y0 = ry + rh * from, x1 = rx + rw * to, y1 = ry + rh * to
    await api.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 })
    await api.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 8; i++) await api.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 8, y: y0 + ((y1 - y0) * i) / 8, button: 'left', buttons: 1 })
    await api.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 })
    await sleep(250)
  }
  const rectOf = (sel) => evaluate(`(() => { const c = document.querySelector(${JSON.stringify(sel)}); if (!c) return null; const r = c.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] })()`)
  const subtitle = () => evaluate(`document.querySelector('.dialog[aria-label="Enviar al agente"] .dialog__subtitle')?.textContent ?? ''`)
  const since = Date.now() - 1000
  let dialogOpen = false
  if (visible) {
    await press('cmd+shift+s')
    t.check('⌘⇧S abre el paso de recorte con su barra', await waitFor(`!!document.querySelector('.area .area__bar')`, 5000), JSON.stringify(await snapshot()))
    t.check('el pie del recorte ofrece recortar y toda la página', /recortar/.test(await evaluate(`document.querySelector('.footer')?.textContent ?? ''`)) && /toda la página/.test(await evaluate(`document.querySelector('.footer')?.textContent ?? ''`)))
    const bar = await evaluate(`(() => { const b = document.querySelector('.area__bar .toolbar').getBoundingClientRect(); const a = document.querySelector('.area').getBoundingClientRect(); return { inside: b.left >= a.left && b.right <= a.right && b.bottom <= a.bottom, labels: [...document.querySelectorAll('.area__bar .btn')].map((x) => x.textContent) } })()`)
    t.check('la barra del recorte entra en el hueco y tiene Cancelar, Toda la página y Recortar', bar.inside && /Cancelar/.test(bar.labels.join()) && /Toda la página/.test(bar.labels.join()) && /Recortar/.test(bar.labels.join()), JSON.stringify(bar))
    const area = await rectOf('.area')
    await drag(area, 0.2, 0.5)
    t.check('soltar el arrastre recorta y pasa al dibujo', await waitFor(`!!document.querySelector('.markup canvas') && !document.querySelector('.area')`, 5000))
    // El lienzo es el recorte (30 % del hueco por lado), no la página entera.
    const canvasRect = await rectOf('.markup canvas')
    const natural = await evaluate(`(() => { const i = document.querySelector('.markup__shot'); return [i.naturalWidth, i.naturalHeight] })()`)
    const dpr = await evaluate('window.devicePixelRatio')
    t.check('el fondo del dibujo es solo el recorte', Math.abs(natural[0] / dpr - area[2] * 0.3) < 4 && Math.abs(natural[1] / dpr - area[3] * 0.3) < 4, JSON.stringify({ natural, dpr, area }))
    t.check('el pie del dibujo dice siguiente', /siguiente/.test(await evaluate(`document.querySelector('.footer')?.textContent ?? ''`)))
    await drag(canvasRect, 0.2, 0.8)
    await press('cmd+enter')
    t.check('⌘⏎ en el dibujo abre Enviar al agente', await waitFor(`!!document.querySelector('.dialog[aria-label="Enviar al agente"]')`, 6000))
    t.check('el diálogo la describe como captura con dibujo', /captura con dibujo/.test(await subtitle()), await subtitle())
    const actions = await evaluate(`[...document.querySelectorAll('.send__actions .btn')].map((b) => b.textContent)`)
    t.check('el diálogo ofrece Copiar texto, Copiar imagen y Enviar', /Copiar texto/.test(actions.join()) && /Copiar imagen/.test(actions.join()) && /Enviar/.test(actions.join()), JSON.stringify(actions))
    await press('shift+cmd+c')
    t.check('⌘⇧C copia la imagen y cierra el diálogo', await waitFor(`!document.querySelector('.dialog')`, 3000))
    const notice = await evaluate(`document.querySelector('.pane:has(.browser) .strip')?.textContent ?? ''`)
    t.check('la franja avisa que la imagen se copió', /Imagen copiada/.test(notice), notice.slice(0, 80))
    t.check('el portapapeles tiene una imagen PNG', /PNGf/.test(execFileSync('osascript', ['-e', 'clipboard info']).toString()))
    await sleep(300)

    // Segunda vuelta: la página entera (⇧⏎), sin dibujar (⌘⏎), y enviar al shell vecino.
    await press('cmd+shift+s')
    await waitFor(`!!document.querySelector('.area')`, 5000)
    await press('shift+enter')
    t.check('⇧⏎ usa la página entera y pasa al dibujo', await waitFor(`!!document.querySelector('.markup canvas') && !document.querySelector('.area')`, 5000))
    await press('cmd+enter')
    dialogOpen = await waitFor(`!!document.querySelector('.dialog[aria-label="Enviar al agente"]')`, 6000)
    t.check('sin dibujar, ⌘⏎ abre el diálogo igual', dialogOpen)
    const png = newestCapture(since)
    t.check('la captura dejó un PNG en ~/.config/omni/captures', !!png && statSync(png).size > 500, png ? `${png} (${statSync(png).size} bytes)` : 'sin archivo')
    const meta = await subtitle()
    t.check('el diálogo la describe como captura con su tamaño', /^captura · \d+×\d+$/.test(meta), meta)
    // El destino por defecto prefiere agentes (un Codex del usuario ganaría): se elige el shell del test.
    t.check('el shell del test aparece como destino', await evaluate(`!!document.querySelector('#send-target-${shellId}')`))
    await api.click(`#send-target-${shellId}`)
    await sleep(150)
    await type('Revisa esto')
    await press('cmd+enter')
    t.check('⌘⏎ cierra el diálogo', await waitFor(`!document.querySelector('.dialog[aria-label="Enviar al agente"]')`))
    // El paquete se arma async (tail de consola) y se pega al soltar el prompt: se espera a que llegue.
    await waitFor(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(shellId)})?.term; if (!term) return false; const b = term.buffer.active; let all = ''; for (let i = 0; i <= b.baseY + b.cursorY; i++) all += b.getLine(i)?.translateToString(true) ?? ''; return all.includes(${JSON.stringify(png ?? '∅')}) })`, 5000)
    const line = await evaluate(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(shellId)})?.term; if (!term) return null; const b = term.buffer.active; const out = []; for (let i = 0; i <= b.baseY + b.cursorY; i++) out.push(b.getLine(i)?.translateToString(true) ?? ''); return out.join('\\n') })`)
    const flat = String(line).replace(/\n/g, '')
    t.check('el paquete llegó al shell: mensaje y ruta del PNG', !!png && flat.includes('Revisa esto') && flat.includes('Imagen:') && /\/captures\/omni-\d{8}-\d{6}(-\d+)?\.png/.test(flat), JSON.stringify({ msg: flat.includes('Revisa esto'), img: flat.includes('Imagen:'), png: /\/captures\/omni-/.test(flat), len: flat.length, head: flat.slice(0, 160) }))
    await press('ctrl+c')
    await sleep(200)
  } else {
    t.log('ventana tapada (visibilityState=hidden): la captura no se puede comprobar; main debe responder con error y no dejar archivo')
    t.check('ventana tapada: no queda un PNG vacío ni diálogo', !newestCapture(since) && !dialogOpen, dialogOpen ? 'diálogo abierto' : 'sin diálogo')
    if (dialogOpen) { await press('escape'); await sleep(200) }
  }

  // Modo elemento desde la página: prefijo f → letras; `a` elige el botón → diálogo con selector → ⌘⏎
  if (visible) {
    await evaluate(`${MOD.browser}.then((m) => (m.useBrowser.getState().focusView(${JSON.stringify(browserId)}), true))`)
    await sleep(300)
    const inView = await api.pressInView(await api.prefix(), 'Hola omni')
    if (inView === null) await press(await api.prefix())
    await sleep(150)
    await press('f')
    t.check('prefijo f entra al modo elemento (pie con "elegir")', await waitFor(`/elegir/.test(document.querySelector('.footer')?.textContent ?? '')`, 3000), (await evaluate(`document.querySelector('.footer')?.textContent ?? ''`)).slice(0, 120))
    await sleep(300)
    if (inView !== null) await api.pressInView('a', 'Hola omni')
    else await press('a')
    await sleep(400)
    t.check('la letra a elige el botón (el modo sigue activo, pie con "enviar")', /enviar al agente/.test(await evaluate(`document.querySelector('.footer')?.textContent ?? ''`)) && !(await evaluate(`!!document.querySelector('.dialog')`)), (await evaluate(`document.querySelector('.footer')?.textContent ?? ''`)).slice(0, 80))
    if (inView !== null) await api.pressInView('enter', 'Hola omni')
    else await press('enter')
    t.check('⏎ con el elegido abre el diálogo', await waitFor(`!!document.querySelector('.dialog[aria-label="Enviar al agente"]')`, 5000))
    const meta2 = await evaluate(`document.querySelector('.dialog[aria-label="Enviar al agente"] .dialog__subtitle')?.textContent ?? ''`)
    t.check('el diálogo muestra el selector del elemento', /#go|button/.test(meta2), meta2)
    await api.click(`#send-target-${shellId}`)
    await sleep(150)
    await press('cmd+enter')
    await waitFor(`!document.querySelector('.dialog[aria-label="Enviar al agente"]')`)
    await sleep(800)
    const line2 = await evaluate(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(shellId)})?.term; if (!term) return null; const b = term.buffer.active; const out = []; for (let i = 0; i <= b.baseY + b.cursorY; i++) out.push(b.getLine(i)?.translateToString(true) ?? ''); return out.join('') })`)
    t.check('el paquete del elemento llegó al shell (Elemento: y html)', /Elemento:/.test(String(line2)) && /```html/.test(String(line2)), String(line2).slice(-200))
    // Inyección (A1): el atributo malicioso no debe cerrar el paste ni ejecutar nada
    const lines2 = await evaluate(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(shellId)})?.term; if (!term) return []; const b = term.buffer.active; const out = []; for (let i = 0; i <= b.baseY + b.cursorY; i++) out.push(b.getLine(i)?.translateToString(true) ?? ''); return out })`)
    t.check('el HTML malicioso no ejecutó nada en el shell (ninguna línea es solo PWNED)', Array.isArray(lines2) && !lines2.some((l) => l.trim() === 'PWNED'), JSON.stringify(lines2.filter((l) => /PWNED/.test(l)).map((l) => l.slice(0, 60))))
    await press('ctrl+c')
    await sleep(200)
    t.check('el modo elemento quedó apagado', !/elegir/.test(await evaluate(`document.querySelector('.footer')?.textContent ?? ''`)))
  }

  // Zoom desde la página con el prefijo, dos veces seguidas y sin clic: la página recupera el teclado
  await evaluate(`${MOD.browser}.then((m) => (m.useBrowser.getState().focusView(${JSON.stringify(browserId)}), true))`)
  await sleep(300)
  const viaView = await api.pressInView(await api.prefix(), 'Hola omni')
  if (viaView === null) t.log('sin target CDP de la vista: el prefijo se manda al renderer')
  else await sleep(150)
  if (viaView === null) await press(await api.prefix())
  await press('z')
  t.check('prefijo z desde la página hace zoom', await waitFor(`!!document.querySelector('.pane:has(.browser) .strip .badge')`), await evaluate(`document.querySelector('.pane:has(.browser) .strip .badge')?.textContent ?? 'sin badge'`))
  await sleep(400)
  const focusedAfterZoom = await evaluate(`import('/src/store/browser.ts').then((m) => !!m.useBrowser.getState().focused[${JSON.stringify(browserId)}])`).catch(() => null)
  t.log('la página tiene el teclado tras el zoom:', focusedAfterZoom)
  if (viaView !== null) { await api.pressInView(await api.prefix(), 'Hola omni'); await sleep(150) } else await press(await api.prefix())
  await press('z')
  t.check('prefijo z otra vez deshace el zoom sin clic', await waitFor(`!document.querySelector('.pane:has(.browser) .strip .badge')`), await evaluate(`document.querySelector('.pane:has(.browser) .strip .badge')?.textContent ?? 'sin badge'`))

  // file:// no entra ni por IPC (will-navigate no cubre loadURL programático): el estado no cambia
  await evaluate(`window.omni.invoke('browser:navigate', ${JSON.stringify(browserId)}, 'file:///etc/hosts')`)
  await sleep(600)
  const afterFile = await evaluate(`window.omni.invoke('browser:state', ${JSON.stringify(browserId)})`)
  t.check('file:// se rechaza: la URL sigue siendo la data:', afterFile.url.startsWith('data:'), afterFile.url.slice(0, 40))

  // Recarga del renderer: la vista vive en main; el pane remontado recupera estado (título, barra)
  await evaluate(`(setTimeout(() => location.reload(), 50), true)`)
  await sleep(3500)
  // Tras recargar cada sesión queda en su propio tab y el renderer arranca en modo lista: se entra
  // al tab del navegador por su fila del sidebar (clic = entrar), como haría el usuario.
  // Fila de PANE (nivel 2) con el título: una fila de tab vieja con el mismo nombre entraría a otro tab.
  const browserRow = await evaluate(`[...document.querySelectorAll('.sidebar [role=option][data-level="2"]')].filter((r) => r.querySelector('.row__label')?.textContent === 'Hola omni').at(-1)?.id ?? null`)
  t.check('tras recargar, el navegador sigue en el sidebar con su título', !!browserRow, String(browserRow))
  if (browserRow) {
    await api.click('#' + browserRow)
    await sleep(500)
  }
  const paneSel = `.pane:has(.browser[data-session-id="${browserId}"])`
  t.check('tras recargar, el pane del navegador vuelve', await waitFor(`!!document.querySelector('${paneSel}')`, 4000))
  t.check('tras recargar, la franja conserva el título de la página', await waitFor(`document.querySelector('${paneSel} .strip__title')?.textContent === 'Hola omni'`, 4000), await evaluate(`document.querySelector('${paneSel} .strip__title')?.textContent`))
  t.check('tras recargar, la barra muestra la URL', (await evaluate(`document.querySelector('${paneSel} .url-input')?.value ?? ''`)).startsWith('data:'), await evaluate(`(document.querySelector('${paneSel} .url-input')?.value ?? '').slice(0, 30)`))
  t.check('el comando browser.navigate existe', await evaluate(`import('/src/core/commands/registry.ts').then((m) => !!m.commands.get('browser.navigate'))`))

  // Cerrar: navegador (sin confirm) y luego el shell del test
  await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().kill(${JSON.stringify(browserId)}))`)
  t.check('kill cierra el pane del navegador', await waitFor(`!document.querySelector('.pane .browser')`))
  await sleep(400)
  s = await snapshot()
  // Se entró al tab desde la lista (clic = entrar, el foco sigue en la lista): al morir el navegador
  // el shell vecino sigue en pantalla y el foco queda donde estaba (lista) o en la terminal, sin overlay.
  t.check('al cerrarse el navegador, el shell vecino sigue en pantalla sin overlay', !s.overlay && (s.panes === 0 || s.panes === 1) && (s.focus === 'list' || s.active.startsWith('TEXTAREA')), `${s.focus} ${s.active} panes=${s.panes}`)
  // Volver al tab del shell del test (tras la recarga quedó en su propio tab) para limpiarlo
  await evaluate(`Promise.all([${MOD.sessions}, import('/src/store/layout.ts')]).then(([sm, lm]) => { const tab = lm.useLayout.getState().tabs.find((tb) => lm.leaves(tb.root).some((l) => l.sessionId === ${JSON.stringify(shellId)})); if (tab) sm.useSessions.getState().activateTab(tab.id); return !!tab })`)
  await sleep(300)
  await api.click('.pane')
  await sleep(200)
  // la ruta quedó escrita en el prompt: limpiarla antes de cerrar para no ejecutar nada
  await press('ctrl+c')
  await sleep(200)
  await closePanes(api, 1)
  t.check('limpieza: el shell del test se cerró', await waitFor(`!document.querySelector('.pane .browser')`), `tabs=${(await snapshot()).tabs}`)
}
