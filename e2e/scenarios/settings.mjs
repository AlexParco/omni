// Ajustes (⌘,): cambiar el prefijo capturando teclas lo aplica al toque (el nuevo arma el split,
// el viejo ya no), se persiste en ~/.config/omni/settings.json y los hints lo reflejan.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensurePane, closePanes, assertQuiet, splitShell } from './_helpers.mjs'

const FILE = join(homedir(), '.config', 'omni', 'settings.json')
const readPrefix = () => {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')).prefix
  } catch {
    return null
  }
}

export default async function (api, t) {
  const { press, click, evaluate, snapshot, sleep, waitFor } = api
  await assertQuiet(api)
  const before = await evaluate(`window.omni.invoke('settings:get')`)
  const original = before.prefix
  // Los atajos propios del usuario (p. ej. split en `\\`) se apartan durante la prueba y vuelven al final.
  const originalKeys = before.keys ?? {}
  const originalLabel = `C-${original.split('+').pop()}`
  const panes0 = await ensurePane(api)
  let tabOpen = true

  try {
    await evaluate(`window.omni.invoke('settings:set', { keys: {} })`)
    // Abrir con ⌘, desde la terminal
    await press('cmd+,')
    await sleep(200)
    let s = await snapshot()
    const dialog = await evaluate(`document.querySelector('.dialog')?.getAttribute('aria-label') ?? null`)
    t.check('⌘, abre el panel de ajustes', s.overlay && dialog === 'Ajustes', `overlay=${s.overlay} dialog=${dialog}`)
    t.check('el panel muestra el prefijo actual', (await evaluate(`document.querySelector('.keycap__button')?.textContent`)) === originalLabel, await evaluate(`document.querySelector('.keycap__button')?.textContent`))

    // Capturar ctrl+b
    await click('.keycap__button')
    await sleep(100)
    t.check('al activar, pide la combinación', await evaluate(`!!document.querySelector('.keycap[data-capturing]')`))
    await press('cmd+b')
    await sleep(100)
    t.check('⌘ se rechaza con motivo', await evaluate(`document.querySelector('.keycap__error')?.textContent ?? null`) !== null, await evaluate(`document.querySelector('.keycap__error')?.textContent ?? ''`))
    await press('ctrl+b')
    t.check('ctrl+b queda como prefijo en el panel', await waitFor(`document.querySelector('.keycap__button')?.textContent === 'C-b'`), await evaluate(`document.querySelector('.keycap__button')?.textContent`))
    t.check('se persistió en settings.json', readPrefix() === 'ctrl+b', String(readPrefix()))

    // Esc cierra y devuelve el foco a la terminal
    await press('escape')
    await sleep(200)
    s = await snapshot()
    t.check('Esc cierra y vuelve a la terminal', !s.overlay && s.focus === 'terminal' && s.active.startsWith('TEXTAREA'), `${s.focus} ${s.active}`)
    const footer = await evaluate(`document.querySelector('.footer')?.textContent ?? ''`)
    t.check('el footer muestra C-b como prefijo', footer.includes('C-b') && !footer.includes(originalLabel + ' '), footer.slice(0, 80))

    // El nuevo prefijo manda; el viejo ya no
    await press('ctrl+b')
    await press('|')
    t.check('C-b | abre el launcher del split', await waitFor(`!!document.querySelector('.overlay')`))
    await api.type('Nueva terminal')
    await sleep(120)
    await press('enter')
    t.check('⏎ crea el pane', await waitFor(`document.querySelectorAll('.pane').length === ${panes0 + 1}`), `panes=${(await snapshot()).panes}`)
    if (original !== 'ctrl+b') {
      await press(original)
      await press('|')
      await sleep(500)
      s = await snapshot()
      t.check(`${originalLabel} | ya no hace nada`, s.panes === panes0 + 1 && !s.overlay, `panes=${s.panes}`)
    }

    // Hoja de atajos con el prefijo nuevo
    await press('cmd+/')
    await sleep(200)
    const sheet = await evaluate(`document.querySelector('.picker')?.textContent ?? ''`)
    t.check('la hoja de atajos usa C-b', sheet.includes('C-b') && !sheet.includes(originalLabel + ' '), sheet.slice(0, 60))
    await press('escape')
    await sleep(150)

    // Rebindar un atajo de la capa terminal: zoom pasa de z a m (quedan 2 panes para poder hacer zoom)
    await press('cmd+,')
    await sleep(200)
    await api.type('zoom del pane')
    await sleep(150)
    const zoomRows = await evaluate(`[...document.querySelectorAll('.field')].map((f) => f.querySelector('.field__label')?.textContent)`)
    t.check('el filtro deja solo las filas de zoom del pane', zoomRows.length > 0 && zoomRows.every((x) => /zoom del pane/i.test(x)), JSON.stringify(zoomRows))
    // La fila de la capa terminal es la última (orden global → list → terminal); clic real por coordenadas
    const last = await evaluate(`(() => { const caps = document.querySelectorAll('.keycap__button'); const el = caps[caps.length - 1]; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
    await api.clickAt(last[0], last[1])
    await sleep(100)
    await press('x')
    await sleep(100)
    t.check('un chord ya usado se rechaza nombrando al dueño', (await evaluate(`document.querySelector('.keycap__error')?.textContent ?? ''`)).includes('Cerrar el pane'), await evaluate(`document.querySelector('.keycap__error')?.textContent ?? ''`))
    await press('m')
    t.check('zoom queda en m y aparece el reset', await waitFor(`(() => { const caps = document.querySelectorAll('.keycap__button'); const el = caps[caps.length - 1]; return el?.textContent === 'm' && !!el.closest('.field')?.querySelector('[aria-label="Volver al atajo por defecto"]') })()`))
    t.check('se persistió en settings.json', JSON.stringify(JSON.parse(readFileSync(FILE, 'utf8')).keys) === JSON.stringify({ 'terminal:pane.zoom': ['m'] }), JSON.stringify(JSON.parse(readFileSync(FILE, 'utf8')).keys))
    await press('escape')
    await sleep(200)
    await press('ctrl+b')
    await press('m')
    t.check('C-b m hace zoom', await waitFor(`!!document.querySelector('.strip .badge')`), await evaluate(`document.querySelector('.strip .badge')?.textContent ?? 'sin badge'`))
    await press('ctrl+b')
    await press('z')
    await sleep(300)
    t.check('C-b z ya no hace nada', await evaluate(`!!document.querySelector('.strip .badge')`))
    await press('ctrl+b')
    await press('m')
    await waitFor(`!document.querySelector('.strip .badge')`)
    const footer2 = await evaluate(`document.querySelector('.footer')?.textContent ?? ''`)
    t.check('el footer muestra m para zoom', /m\s*zoom/.test(footer2), footer2.slice(0, 100))
    await closePanes(api, 2)
    tabOpen = false
  } finally {
    // Restaurar por IPC (prueba también ese camino) y dejar el tab del test cerrado
    await evaluate(`window.omni.invoke('settings:set', { prefix: ${JSON.stringify(original)}, keys: ${JSON.stringify(originalKeys)} })`)
    await waitFor(`document.querySelector('.footer')?.textContent.includes(${JSON.stringify(original === 'ctrl+a' ? 'C-a' : original)}) || true`)
    await sleep(200)
    const after = await evaluate(`window.omni.invoke('settings:get')`)
    t.check('restaurados el prefijo y los atajos del usuario', after.prefix === original && JSON.stringify(after.keys) === JSON.stringify(originalKeys), JSON.stringify(after.keys))
    if (tabOpen) await closePanes(api, (await snapshot()).panes)
  }
}
