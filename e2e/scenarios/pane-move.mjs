// Mover panes de lugar (no solo el tamaño): con el teclado tras el prefijo (⌥h ⌥j ⌥k ⌥l) y
// arrastrando la franja de un pane sobre la mitad de otro, como en VS Code.
import { chordFor, closePanes, ensurePane, splitShell } from './_helpers.mjs'

const L = `import('/src/store/layout.ts')`
/** Árbol del tab activo como texto: `row(a,b)`, `col(a,b)` con los ids de sesión acortados. */
const shape = `${L}.then((m) => { const id = document.querySelector('.layout')?.dataset.tabId; const tab = m.useLayout.getState().tabs.find((x) => x.id === id); if (!tab) return null; const f = (n) => n.kind === 'leaf' ? n.sessionId.slice(0, 4) : n.dir + '(' + n.children.map(f).join(',') + ')'; return f(tab.root) })`
const paneRect = (i) => `(() => { const r = document.querySelectorAll('.pane')[${i}].getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`

export default async function (api, t) {
  const { evaluate, press, waitFor, sleep, cdp } = api
  await ensurePane(api)
  await splitShell(api)
  const [a, b] = (await evaluate(shape)).slice(4, -1).split(',')
  t.check('arranca lado a lado', (await evaluate(shape)) === `row(${a},${b})`, await evaluate(shape))

  // Teclado: el pane de la derecha (con foco) va abajo; no hay vecino abajo, así que pasa al borde inferior.
  await press(await api.prefix())
  await press(await chordFor(api, 'pane.move.down', 'terminal'))
  t.check('⌥j: de lado a lado pasa a uno encima del otro', await waitFor(`${shape}.then((s) => s === 'col(${a},${b})')`), await evaluate(shape))
  // Arriba: ahora sí hay vecino arriba, se intercambian.
  await press(await api.prefix())
  await press(await chordFor(api, 'pane.move.up', 'terminal'))
  t.check('⌥k: intercambia con el de arriba', await waitFor(`${shape}.then((s) => s === 'col(${b},${a})')`), await evaluate(shape))
  t.check('el foco sigue al pane movido', await evaluate(`${L}.then((m) => { const tab = m.useLayout.getState().tabs.find((x) => x.id === document.querySelector('.layout')?.dataset.tabId); return !!tab && m.leaves(tab.root).find((l) => l.id === tab.focusedPaneId)?.sessionId.startsWith('${b}') })`))

  // Arrastre: la franja del pane de arriba sobre la mitad derecha del de abajo.
  const top = await evaluate(paneRect(0))
  const bottom = await evaluate(paneRect(1))
  const from = { x: top.x + top.w / 2, y: top.y + 12 }
  const to = { x: bottom.x + bottom.w * 0.9, y: bottom.y + bottom.h / 2 }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 8; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8, button: 'left', buttons: 1 })
  await sleep(100)
  const zone = await evaluate(`(() => { const z = document.querySelector('.pane-drop'); const p = document.querySelectorAll('.pane')[1].getBoundingClientRect(); if (!z) return null; const r = z.getBoundingClientRect(); return { ok: Math.abs(r.right - p.right) < 2 && Math.abs(r.width - p.width / 2) < 2 && Math.abs(r.height - p.height) < 2 } })()`)
  t.check('mientras arrastra se marca la mitad derecha del destino', zone?.ok === true, JSON.stringify(zone))
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/pane-move-drag.png')
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 })
  t.check('al soltar quedan lado a lado en el orden del arrastre', await waitFor(`${shape}.then((s) => s === 'row(${a},${b})')`), await evaluate(shape))
  t.check('la zona desaparece', !(await evaluate(`!!document.querySelector('.pane-drop')`)))

  // Esc cancela: nada cambia.
  const p0 = await evaluate(paneRect(0))
  const p1 = await evaluate(paneRect(1))
  const s0 = { x: p0.x + p0.w / 2, y: p0.y + 12 }
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...s0, button: 'left', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p1.x + p1.w / 2, y: p1.y + p1.h * 0.9, button: 'left', buttons: 1 })
  await sleep(80)
  await press('escape')
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p1.x + p1.w / 2, y: p1.y + p1.h * 0.9, button: 'left', clickCount: 1 })
  await sleep(150)
  t.check('Esc cancela el arrastre', (await evaluate(shape)) === `row(${a},${b})`, await evaluate(shape))

  // Un clic suelto en la franja no mueve nada (solo enfoca).
  await api.click('.pane .strip__title')
  await sleep(150)
  t.check('un clic en la franja no mueve el pane', (await evaluate(shape)) === `row(${a},${b})`, await evaluate(shape))

  await api.click('.pane')
  await closePanes(api, 2)
}
