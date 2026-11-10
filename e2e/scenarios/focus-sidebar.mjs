// Foco de terminales y sidebar: la fila activa es siempre el tab en pantalla, el cursor sigue al
// foco, cambiar de proyecto/tab/pane por clic, teclado o sidebar deja un único activo coherente.
// Un tab con split lista sus panes (filas de nivel 2): el pane con foco también va activo y el
// cursor cae sobre su fila, no sobre la del tab.
// Necesita dos proyectos registrados: omni y otro cualquiera (`OMNI_E2E_OTHER`, o el primero que no sea omni);
// crea sus tabs y los cierra al final.
import { closePanes, assertQuiet, splitShell } from './_helpers.mjs'

const SIDEBAR = `[...document.querySelectorAll('.sidebar [role=option]')].map((r) => ({
  id: r.id, level: r.dataset.level, cursor: !!r.dataset.cursor, active: !!r.dataset.active,
  label: (() => { const l = r.querySelector('.row__label'); if (!l) return ''; const c = l.cloneNode(true); c.querySelectorAll('.row__count').forEach((x) => x.remove()); return c.textContent.trim() })()
}))`
const TABBAR = `[...document.querySelectorAll('.tabs .tab:not(.tab--action)')].map((t) => ({ active: !!t.dataset.active, label: t.querySelector('.tab__label')?.textContent ?? '' }))`
const WS = `document.querySelector('.tabs__end')?.title ?? document.querySelector('.empty')?.textContent ?? null`
const PANES = `[...document.querySelectorAll('.pane')].map((p) => p.dataset.focus)`

export default async function (api, t) {
  const { press, click, evaluate, snapshot, sleep, waitFor } = api
  const state = async () => ({
    ...(await snapshot()),
    rows: await evaluate(SIDEBAR),
    tabbar: await evaluate(TABBAR),
    ws: await evaluate(WS),
    paneFocus: await evaluate(PANES)
  })
  const projectRow = (rows, name) => rows.find((r) => r.level === '0' && r.label === name)
  const tabsUnder = (rows, name) => {
    const i = rows.findIndex((r) => r.level === '0' && r.label === name)
    const out = []
    // Solo tabs (nivel 1): las filas de pane (nivel 2) cuelgan de un tab con split y no cuentan en la barra.
    for (let j = i + 1; j < rows.length && rows[j].level !== '0'; j++) if (rows[j].level === '1') out.push(rows[j])
    return out
  }
  // Activos a nivel tab: las filas de pane (nivel 2) se miran aparte.
  const actives = (rows) => rows.filter((r) => r.active && r.level !== '2')
  const cursorOf = (rows) => rows.find((r) => r.cursor)
  const panesOf = (rows, tabRow) => {
    const i = rows.findIndex((r) => r.id === tabRow.id)
    const out = []
    for (let j = i + 1; j < rows.length && rows[j].level === '2'; j++) out.push(rows[j])
    return out
  }
  // El cursor está "en T2" si está en su fila o en la de uno de sus panes.
  const cursorOnTab = (rows, tabRow) => {
    const cur = cursorOf(rows)
    return cur?.id === tabRow.id || panesOf(rows, tabRow).some((r) => r.id === cur?.id)
  }
  const describe = (rows) => rows.map((r) => `${'  '.repeat(+r.level)}${r.cursor ? '>' : ' '}${r.active ? '*' : ' '}${r.label}`).join(' | ')
  const newTab = async () => {
    const before = (await snapshot()).tabs
    await press('cmd+t')
    await sleep(150)
    await api.type('Nueva terminal')
    await sleep(120)
    await press('enter')
    await waitFor(`document.querySelectorAll('.tabs .tab:not(.tab--action)').length === ${before + 1}`)
    await sleep(400)
  }

  await assertQuiet(api)
  let s = await state()
  const OTHER = process.env.OMNI_E2E_OTHER ?? s.rows.find((r) => r.level === '0' && r.label && r.label !== 'omni')?.label
  if (!projectRow(s.rows, 'omni') || !OTHER || !projectRow(s.rows, OTHER)) {
    t.check('hay dos proyectos en el sidebar (omni y otro)', false, describe(s.rows))
    return
  }
  const omniTabs0 = tabsUnder(s.rows, 'omni').length
  const otherTabs0 = tabsUnder(s.rows, OTHER).length

  // A. clic en proyecto omni → cursor ahí, foco lista, workspace omni en pantalla
  await click('#' + projectRow(s.rows, 'omni').id)
  await sleep(200)
  s = await state()
  t.check('clic en proyecto: cursor en el proyecto y foco en lista', cursorOf(s.rows)?.label === 'omni' && s.focus === 'list', describe(s.rows))
  t.check('clic en proyecto: workspace omni en pantalla', String(s.ws).includes('omni'), String(s.ws))

  // B. ⌘T ⏎ → T1 en omni
  await newTab()
  s = await state()
  let omniTabs = tabsUnder(s.rows, 'omni')
  const T1 = omniTabs[omniTabs.length - 1]
  t.check('T1: foco en terminal', s.focus === 'terminal' && s.active.startsWith('TEXTAREA'), `${s.focus} ${s.active}`)
  t.check('T1: única fila activa y con cursor', actives(s.rows).length === 1 && T1.active && T1.cursor, describe(s.rows))

  // C. ⌘T ⏎ → T2 en omni
  await newTab()
  s = await state()
  omniTabs = tabsUnder(s.rows, 'omni')
  const T2 = omniTabs[omniTabs.length - 1]
  t.check('T2: activa y con cursor, T1 ya no', actives(s.rows).length === 1 && T2.active && T2.cursor && !omniTabs.find((r) => r.id === T1.id)?.active, describe(s.rows))
  t.check('T2: barra de tabs con el último activo', s.tabbar.length === omniTabs0 + 2 && s.tabbar[s.tabbar.length - 1].active, JSON.stringify(s.tabbar))

  // D. ⌘1… volver a T1 por teclado (índice de T1 dentro de la barra)
  const idxT1 = omniTabs.findIndex((r) => r.id === T1.id) + 1
  await press(`alt+cmd+${idxT1}`)
  await sleep(250)
  s = await state()
  t.check('⌥⌘n: fila activa y cursor saltan a T1', cursorOf(s.rows)?.id === T1.id && actives(s.rows).length === 1 && actives(s.rows)[0].id === T1.id, describe(s.rows))
  t.check('⌥⌘n: foco sigue en terminal', s.focus === 'terminal' && s.active.startsWith('TEXTAREA'), `${s.focus} ${s.active}`)

  // E. clic en el otro proyecto → ningún tab de omni queda activo
  await click('#' + projectRow(s.rows, OTHER).id)
  await sleep(250)
  s = await state()
  t.check(`clic en ${OTHER}: cursor en ${OTHER}, foco lista`, cursorOf(s.rows)?.label === OTHER && s.focus === 'list', describe(s.rows))
  t.check(`clic en ${OTHER}: workspace ${OTHER} en pantalla`, String(s.ws).includes(OTHER), String(s.ws))
  t.check(`clic en ${OTHER}: los tabs de omni no se marcan activos`, actives(s.rows).every((r) => tabsUnder(s.rows, OTHER).some((a) => a.id === r.id)), describe(s.rows))

  // F. ⌘T ⏎ → A1 en el otro proyecto
  await newTab()
  s = await state()
  const A1 = tabsUnder(s.rows, OTHER)[tabsUnder(s.rows, OTHER).length - 1]
  t.check('A1: única activa, con cursor, foco terminal', actives(s.rows).length === 1 && A1?.active && A1?.cursor && s.focus === 'terminal', describe(s.rows))

  // G. clic en la fila de T2 (otro proyecto) desde la terminal del otro proyecto
  await click('#' + T2.id)
  await sleep(400)
  s = await state()
  t.check('clic fila T2: workspace omni en pantalla', String(s.ws).includes('omni'), String(s.ws))
  t.check('clic fila T2: única activa = T2, cursor T2', actives(s.rows).length === 1 && actives(s.rows)[0].id === T2.id && cursorOf(s.rows)?.id === T2.id, describe(s.rows))
  t.check('clic fila T2: terminal con foco real', s.focus === 'terminal' && s.active.startsWith('TEXTAREA') && s.paneFocus.includes('live'), `${s.focus} ${s.active} panes=${JSON.stringify(s.paneFocus)}`)
  t.check('clic fila T2: barra de tabs coincide', s.tabbar.filter((x) => x.active).length === 1 && s.tabbar[omniTabs.findIndex((r) => r.id === T2.id)]?.active, JSON.stringify(s.tabbar))

  // H. split en T2 y clic entre panes: la fila activa no cambia
  await splitShell(api)
  await click('.pane:nth-of-type(1), .pane')
  await sleep(200)
  s = await state()
  t.check('split: clic en pane 1 → sigue T2 activa, un solo pane live', actives(s.rows).length === 1 && actives(s.rows)[0].id === T2.id && s.paneFocus.filter((f) => f === 'live').length === 1, `${describe(s.rows)} panes=${JSON.stringify(s.paneFocus)}`)
  t.check('split: T2 lista dos panes y el primero va activo y con cursor', panesOf(s.rows, T2).length === 2 && panesOf(s.rows, T2)[0].active && panesOf(s.rows, T2)[0].cursor && !panesOf(s.rows, T2)[1].active, describe(s.rows))
  const p2 = await evaluate(`(() => { const p = document.querySelectorAll('.pane')[1]; if (!p) return null; const r = p.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
  if (p2) {
    if (process.env.E2E_DEBUG) await evaluate(`(() => { window.__log = []; const push = (k) => window.__log.push(k + ' | active=' + (document.activeElement?.tagName ?? '') + ' ui=' + document.querySelector('.app').dataset.focus + ' panes=' + [...document.querySelectorAll('.pane')].map((p) => p.dataset.focus)); document.addEventListener('mousedown', (e) => push('mousedown@' + e.target.className + ' at ' + e.clientX + ',' + e.clientY + ' prevented=' + e.defaultPrevented), true); document.addEventListener('focusout', (e) => push('focusout ' + e.target.tagName + ' → ' + (e.relatedTarget?.tagName ?? 'null')), true); document.addEventListener('focusin', (e) => push('focusin ' + e.target.tagName), true); window.__p2 = ${JSON.stringify(p2)}; window.__el = document.elementFromPoint(${p2[0]}, ${p2[1]})?.className; return true })()`)
    await api.clickAt(p2[0], p2[1])
    await sleep(250)
    if (process.env.E2E_DEBUG) { t.log('p2', JSON.stringify(p2), 'elementFromPoint', await evaluate('window.__el'), 'viewport', await evaluate('[innerWidth, innerHeight]'), 'panes', await evaluate(`[...document.querySelectorAll('.pane')].map((p) => { const r = p.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.width), p.style.flexBasis || p.style.flex || '-'] })`)); if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/overflow.png') }
    s = await state()
    t.check('split: clic en pane 2 → sigue T2 activa, el live cambia', actives(s.rows).length === 1 && actives(s.rows)[0].id === T2.id && s.paneFocus[1] === 'live' && s.paneFocus[0] !== 'live' && s.focus === 'terminal', `${describe(s.rows)} panes=${JSON.stringify(s.paneFocus)} focus=${s.focus} active=${s.active}`)
    t.check('split: clic en pane 2 → su fila va activa y con cursor, la del pane 1 no', panesOf(s.rows, T2)[1]?.active && panesOf(s.rows, T2)[1]?.cursor && !panesOf(s.rows, T2)[0]?.active, describe(s.rows))
  }

  // H2. Validación de layout del sidebar con el bloque anidado (proyecto → tab → panes): medidas del DOM
  const geo = await evaluate(`[...document.querySelectorAll('.sidebar [role=option]')].map((r) => { const rb = r.getBoundingClientRect(); const l = r.querySelector('.row__label')?.getBoundingClientRect(); const d = r.querySelector('.row__end .dot')?.getBoundingClientRect(); return { level: r.dataset.level, top: Math.round(rb.top), bottom: Math.round(rb.bottom), textX: l ? Math.round(l.left) : null, dotRight: d ? Math.round(d.right) : null, hasActions: !!r.querySelector('.row__actions'), cursor: !!r.dataset.cursor } })`)
  const textAt = (lv) => Math.min(...geo.filter((g) => g.level === String(lv) && g.textX !== null).map((g) => g.textX))
  t.check('layout: texto nivel 1 a la derecha del nivel 0, y nivel 2 a la derecha del nivel 1', textAt(1) > textAt(0) && textAt(2) > textAt(1), `l0=${textAt(0)} l1=${textAt(1)} l2=${textAt(2)}`)
  const dotXs = geo.filter((g) => g.dotRight !== null && !(g.hasActions && g.cursor)).map((g) => g.dotRight)
  t.check('layout: los puntos de estado comparten columna', dotXs.length > 2 && Math.max(...dotXs) - Math.min(...dotXs) <= 1, JSON.stringify(dotXs))
  const gaps = geo.slice(1).map((g, i) => g.top - geo[i].bottom)
  t.check('layout: aire entre filas (≥2px)', gaps.every((x) => x >= 2), JSON.stringify(gaps))
  t.check('layout: las filas de pane muestran su punto de estado', geo.filter((g) => g.level === '2').every((g) => g.dotRight !== null), JSON.stringify(geo.filter((g) => g.level === '2')))

  // I. C-a Esc → lista con cursor en T2 (Esc pelado es del TUI del agente); J mueve; ⏎ en A1 entra al otro proyecto
  await press(await api.prefix())
  await press('escape')
  await sleep(200)
  s = await state()
  t.check('prefijo Esc: foco lista, cursor en el tab en pantalla (T2 o su pane con foco)', s.focus === 'list' && cursorOnTab(s.rows, T2) && s.active === 'BODY.', `${s.focus} ${s.active} ${describe(s.rows)}`)
  t.check('prefijo Esc: T2 sigue como activa (en pantalla)', actives(s.rows).length === 1 && actives(s.rows)[0].id === T2.id, describe(s.rows))
  // bajar hasta A1
  let guard = 0
  while (cursorOf((await state()).rows)?.id !== A1.id && guard++ < 14) await press('j')
  s = await state()
  // Modelo: el cursor manda lo que se ve (como el clic en proyecto): al pasar por A1, el otro proyecto entra en pantalla.
  t.check(`J hasta A1: ${OTHER} en pantalla y A1 única activa, foco sigue en lista`, cursorOf(s.rows)?.id === A1.id && actives(s.rows).length === 1 && actives(s.rows)[0].id === A1.id && String(s.ws).includes(OTHER) && s.focus === 'list', `${describe(s.rows)} ws=${s.ws} focus=${s.focus}`)
  await press('enter')
  await sleep(400)
  s = await state()
  t.check(`⏎ en A1: workspace ${OTHER}, A1 única activa, foco terminal`, String(s.ws).includes(OTHER) && actives(s.rows).length === 1 && actives(s.rows)[0].id === A1.id && s.focus === 'terminal' && s.active.startsWith('TEXTAREA'), `${describe(s.rows)} ws=${s.ws} focus=${s.focus}`)

  // J. cerrar el tab del otro proyecto desde la terminal → el otro proyecto sin tabs, foco lista, cursor en el otro proyecto
  await closePanes(api, 1)
  await sleep(300)
  s = await state()
  if (otherTabs0 === 0) {
    t.check(`cerrar último tab de ${OTHER}: ninguna fila activa, cursor en proyecto ${OTHER}`, actives(s.rows).length === 0 && cursorOf(s.rows)?.label === OTHER, describe(s.rows))
    t.check(`cerrar último tab de ${OTHER}: foco en lista`, s.focus === 'list', `${s.focus} ${s.active}`)
  } else {
    const otherRows = tabsUnder(s.rows, OTHER)
    t.check(`cerrar A1 con otros tabs en ${OTHER}: otro tab de ${OTHER} queda activo y con cursor`, actives(s.rows).length === 1 && otherRows.some((r) => r.active && r.cursor), describe(s.rows))
    // El tab vecino puede ser un navegador: ahí el foco DOM vive en su raíz `.browser`, no en un textarea.
    t.check(`cerrar A1 con otros tabs en ${OTHER}: foco sigue en un pane`, s.focus === 'terminal' && (s.active.startsWith('TEXTAREA') || s.active.includes('browser')), `${s.focus} ${s.active}`)
  }

  // K. limpieza: cerrar T2 (2 panes) y T1
  await click('#' + T2.id)
  await sleep(300)
  await closePanes(api, 2)
  await sleep(300)
  s = await state()
  const t1row = s.rows.find((r) => r.id === T1.id)
  t.check('cerrar T2: T1 queda activa, con cursor y foco en terminal', t1row?.active && t1row?.cursor && s.focus === 'terminal' && s.active.startsWith('TEXTAREA'), `${describe(s.rows)} focus=${s.focus} active=${s.active}`)
  await closePanes(api, 1)
  await sleep(300)
  s = await state()
  t.check(`limpieza: omni y ${OTHER} como al inicio`, tabsUnder(s.rows, 'omni').length === omniTabs0 && tabsUnder(s.rows, OTHER).length === otherTabs0, describe(s.rows))
}
