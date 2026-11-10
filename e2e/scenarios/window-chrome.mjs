// Cabecera de la ventana (macOS, titleBarStyle hiddenInset): sin barra de título aparte. Con el
// sidebar visible, `[toggle] omni` vive en la cabecera del sidebar y los tabs suben a la fila del
// semáforo; con el sidebar oculto, la cabecera abre la fila de tabs. Las vistas sin tabs (Worktrees)
// recuperan una fila superior. Todo a 40 px y centrado con el semáforo (y = 20).
import { ensurePane, closePanes } from './_helpers.mjs'

const box = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), cy: Math.round(b.top + b.height / 2), r: Math.round(b.right) } })()`

export default async function (api, t) {
  const { evaluate, press, sleep, click, waitFor } = api
  await ensurePane(api)
  await sleep(400)
  if (await evaluate(`!document.querySelector('.sidebar')`)) { await press('cmd+b'); await sleep(400) }

  const btn = await evaluate(box('.sidebar__head .icon-btn'))
  const name = await evaluate(box('.window-head__name'))
  const tabs = await evaluate(box('.main > .tabs'))
  const pane = await evaluate(box('.pane'))
  t.check('sin barra de título con el sidebar visible', !(await evaluate(`!!document.querySelector('.titlebar')`)))
  t.check('el botón del sidebar deja libre el semáforo y queda centrado con él', btn && btn.x >= 76 && btn.cy === 20, JSON.stringify(btn))
  t.check('el nombre va a la derecha del botón, en la misma línea', name && btn && name.x >= btn.r && name.cy === 20, JSON.stringify(name))
  t.check('los tabs suben a la fila del semáforo', tabs && tabs.y === 0 && tabs.h === 40, JSON.stringify(tabs))
  t.check('la terminal empieza justo bajo los tabs', pane && pane.y <= 44, JSON.stringify(pane))
  t.check('los contadores ya no se pintan', !(await evaluate(`/\\d+ proyectos? ·/.test(document.body.innerText)`)))

  await press('cmd+b'); await sleep(400)
  const cBtn = await evaluate(box('.main > .tabs .icon-btn'))
  const cTab = await evaluate(box('.main > .tabs .tab'))
  t.check('sidebar oculto: sin barra aparte en la flota', !(await evaluate(`!!document.querySelector('.titlebar')`)))
  t.check('sidebar oculto: la cabecera abre la fila de tabs tras el semáforo', cBtn && cBtn.x >= 76 && cBtn.cy === 20, JSON.stringify(cBtn))
  t.check('sidebar oculto: el primer tab va después de la cabecera', cTab && cBtn && cTab.x > cBtn.r, JSON.stringify(cTab))

  await press('cmd+3'); await sleep(400)
  const bar = await evaluate(box('.titlebar'))
  t.check('vista sin tabs (Worktrees): vuelve la fila superior de 40 px', bar && bar.y === 0 && bar.h === 40, JSON.stringify(bar))
  await press('cmd+1'); await sleep(300)
  await press('cmd+b'); await sleep(400)
  t.check('⌘B devuelve el sidebar', await evaluate(`!!document.querySelector('.sidebar')`))
  t.check('el sidebar ya no lista Flota, Ajustes ni Atajos', await evaluate(`![...document.querySelectorAll('.sidebar .nav-item')].some((n) => /^(Flota|Ajustes|Atajos)/.test(n.textContent.trim()))`), await evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].map((n) => n.textContent.trim()).join(' | ')`))
  const gear = await evaluate(`(() => { const b = document.querySelector('.sidebar__head .window-head__end .icon-btn[aria-label="Ajustes"]'); const h = document.querySelector('.sidebar__head'); if (!b || !h) return null; const r = b.getBoundingClientRect(); const hr = h.getBoundingClientRect(); return { right: Math.round(hr.right - r.right), cy: Math.round(r.y + r.height / 2 - (hr.y + hr.height / 2)) } })()`)
  t.check('el engranaje de Ajustes va al borde derecho de la cabecera, centrado en la fila', !!gear && gear.right >= 8 && gear.right <= 16 && Math.abs(gear.cy) <= 1, JSON.stringify(gear))
  await click('.sidebar__head .window-head__end .icon-btn'); await sleep(300)
  t.check('el engranaje abre Ajustes (con los atajos dentro)', await waitFor(`!!document.querySelector('[role="dialog"]') && /Ajustes/.test(document.querySelector('[role="dialog"]')?.textContent ?? '') && /Atajos|Terminal/.test(document.querySelector('[role="dialog"]')?.textContent ?? '')`, 2000))
  await press('escape'); await sleep(200)
  t.check('el sidebar no tiene botón "Nuevo agente" al pie (se lanza con ⌘T o N)', await evaluate(`![...document.querySelectorAll('.sidebar button')].some((b) => /^\\s*\\S*\\s*Nuevo agente/.test(b.textContent) && !b.getAttribute('aria-label'))`), await evaluate(`[...document.querySelectorAll('.sidebar button')].map((b) => b.textContent.trim()).filter((x) => /Nuevo/.test(x)).join(' | ')`))
  await closePanes(api, 1)
}
