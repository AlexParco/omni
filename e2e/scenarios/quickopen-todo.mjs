// Quick open unificado (⌘K, canvas 05) y To-do widget (⇧⌘T, canvas 09b): prefijos, grupos, acciones
// sobre la terminal con foco, detalle del agente; tareas: crear, hecha, borrar, deshacer,
// persistencia por IPC y conteo en el sidebar. Medidas del DOM contra la spec (§3.11, §3.12).
import { ensurePane, closePanes } from './_helpers.mjs'

const MOD = { host: `import('/src/panes/terminal/terminal-host.ts')`, sessions: `import('/src/store/sessions.ts')` }

export default async function (api, t) {
  const { press, type, evaluate, snapshot, sleep, waitFor } = api
  const rect = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })()`)
  const groups = () => evaluate(`[...document.querySelectorAll('.quickopen__group')].map((e) => e.textContent.trim())`)
  const labels = () => evaluate(`[...document.querySelectorAll('.quickopen__list .row__label')].map((e) => e.textContent.trim())`)
  const buffer = (id) => evaluate(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(id)})?.term; if (!term) return ''; const b = term.buffer.active; let all = ''; for (let i = 0; i <= b.baseY + b.cursorY; i++) all += b.getLine(i)?.translateToString(true) ?? ''; return all })`)

  await ensurePane(api)
  const shellId = await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0]?.id)`)
  t.check('hay un shell de prueba', !!shellId)

  // --- Quick open
  await press('cmd+k')
  t.check('⌘K abre el quick open', await waitFor(`!!document.querySelector('.quickopen')`), JSON.stringify(await snapshot()))
  const panel = await rect('.quickopen')
  t.check('panel de 720 × 480 a 110 px del borde superior', panel && panel.w === 720 && panel.h === 480 && Math.abs(panel.y - 110) <= 2, JSON.stringify(panel))
  const win = await evaluate(`innerWidth`)
  t.check('panel centrado', panel && Math.abs(panel.x + panel.w / 2 - win / 2) <= 2, `x=${panel?.x} w=${panel?.w} win=${win}`)
  t.check('el campo tiene el foco', (await snapshot()).active.startsWith('INPUT'), (await snapshot()).active)
  t.check('sin consulta: grupos Agentes y Comandos, sin Archivos', (await groups()).some((g) => /Agentes/.test(g)) && (await groups()).some((g) => /Comandos/.test(g)) && !(await groups()).some((g) => /Archivos/.test(g)), JSON.stringify(await groups()))
  const detail = await rect('.quickopen__detail')
  t.check('panel de detalle de 230 px', detail && detail.w === 230, JSON.stringify(detail))
  await type(':zoom')
  await sleep(150)
  t.check('prefijo : filtra a comandos y encuentra zoom', (await groups()).length === 1 && /Comandos/.test((await groups())[0]) && (await labels()).some((l) => /zoom/i.test(l)), JSON.stringify({ g: await groups(), l: (await labels()).slice(0, 4) }))
  t.check('la coincidencia se resalta con mark sin fondo', await evaluate(`(() => { const m = document.querySelector('.quickopen__list mark'); if (!m) return false; const cs = getComputedStyle(m); return cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.fontWeight !== '400' })()`))
  const active = await evaluate(`[...document.querySelectorAll('.quickopen__list .row[data-cursor], .quickopen__list [role=option][data-cursor], .quickopen__list .row[data-active]')].map((e) => e.textContent.trim())[0] ?? null`)
  t.check('hay una fila activa con relleno, sin borde', await evaluate(`(() => { const r = document.querySelector('.quickopen__list .row[data-cursor], .quickopen__list .row[data-active]'); if (!r) return false; const cs = getComputedStyle(r); return cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.borderStyle === 'none' && cs.outlineStyle === 'none' })()`), String(active))
  await press('escape')
  t.check('Esc cierra el quick open', await waitFor(`!document.querySelector('.quickopen')`))
  t.check('tras cerrar, el foco vuelve a la terminal', await waitFor(`document.activeElement?.tagName === 'TEXTAREA'`), (await snapshot()).active)

  // Archivos: /package → package.json del workspace; ⏎ escribe la ruta en la terminal con foco
  await press('cmd+k')
  await waitFor(`!!document.querySelector('.quickopen')`)
  await type('/package.json')
  const hasFile = await waitFor(`[...document.querySelectorAll('.quickopen__list .row')].some((r) => /package\\.json/.test(r.textContent))`, 5000)
  t.check('prefijo / busca archivos del workspace (package.json)', hasFile, JSON.stringify((await labels()).slice(0, 4)))
  const fileRow = await evaluate(`[...document.querySelectorAll('.quickopen__list .row')].findIndex((r) => /^package\\.json/.test(r.textContent.trim()))`)
  for (let i = 0; i < Math.max(0, fileRow); i++) await press('down')
  await press('enter')
  t.check('⏎ cierra el quick open', await waitFor(`!document.querySelector('.quickopen')`))
  t.check('la ruta del archivo quedó escrita en la terminal con foco', await waitFor(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(shellId)})?.term; if (!term) return false; const b = term.buffer.active; let all = ''; for (let i = 0; i <= b.baseY + b.cursorY; i++) all += b.getLine(i)?.translateToString(true) ?? ''; return /package\\.json/.test(all) })`, 3000), (await buffer(shellId)).slice(-80))
  await press('ctrl+u')

  // Agentes: @ lista el shell del test con su estado; el detalle muestra cwd
  await press('cmd+k')
  await waitFor(`!!document.querySelector('.quickopen')`)
  await type('@')
  await sleep(150)
  t.check('prefijo @ lista solo agentes', (await groups()).length === 1 && /Agentes/.test((await groups())[0]), JSON.stringify(await groups()))
  const detailText = await evaluate(`document.querySelector('.quickopen__detail')?.textContent ?? ''`)
  t.check('el detalle del agente activo muestra cwd y estado', /cwd/.test(detailText) && /(pregunta|trabajando|listo)/.test(detailText), detailText.slice(0, 120))
  await press('tab')
  await sleep(100)
  t.check('Tab rota el tipo y reescribe el prefijo', (await evaluate(`document.querySelector('.quickopen input')?.value ?? ''`)) !== '@', await evaluate(`document.querySelector('.quickopen input')?.value`))
  await press('escape')
  await waitFor(`!document.querySelector('.quickopen')`)

  // La paleta sigue en ⇧⌘P
  await press('cmd+shift+p')
  t.check('⇧⌘P abre la paleta de comandos', await waitFor(`!!document.querySelector('.overlay .picker')`), JSON.stringify(await snapshot()))
  await press('escape')
  await waitFor(`!document.querySelector('.overlay')`)

  // --- To-do widget
  // Atajo vigente de Tareas (el usuario puede haberlo cambiado en Ajustes; por defecto ⇧⌘T).
  const todoKey = await evaluate(`import('/src/core/keys/keymap.ts').then((m) => m.keymap.chordsFor('todo.toggle').find((c) => c.layer === 'global')?.chord ?? 'cmd+shift+t')`)
  await press(todoKey)
  t.check('el atajo de Tareas abre el widget', await waitFor(`!!document.querySelector('.todo')`), JSON.stringify(await snapshot()))
  // El widget entra con un zoom leve: se mide cuando terminó.
  await waitFor(`document.querySelector('.todo')?.getAnimations().length === 0`, 2000)
  const card = await rect('.todo')
  t.check('modal de 400 × 560 al centro de la ventana, con velo detrás', card && card.w === 400 && card.h === 560 && Math.abs(card.x + card.w / 2 - win / 2) <= 2 && Math.abs(card.y + card.h / 2 - (await evaluate('innerHeight')) / 2) <= 2 && (await evaluate(`getComputedStyle(document.querySelector('.todo-overlay')).backgroundColor !== 'rgba(0, 0, 0, 0)'`)), JSON.stringify(card))
  t.check('la tarjeta no lleva borde', await evaluate(`getComputedStyle(document.querySelector('.todo')).borderStyle === 'none'`))
  const before = await evaluate(`window.omni.invoke('todo:list').then((l) => l.filter((x) => x.text === 'Probar omni e2e').length)`)
  await press('a')
  t.check('A enfoca el campo de nueva tarea', await waitFor(`document.activeElement?.tagName === 'INPUT'`), (await snapshot()).active)
  await type('Probar omni e2e')
  await press('enter')
  t.check('⏎ crea la tarea en Hoy', await waitFor(`[...document.querySelectorAll('.todo .row')].some((r) => /Probar omni e2e/.test(r.textContent))`), JSON.stringify(await evaluate(`[...document.querySelectorAll('.todo .row__label')].map((e) => e.textContent)`)))
  await press('escape')
  await sleep(100)
  t.check('Esc desde el campo vuelve a la lista (el widget sigue)', (await evaluate(`!!document.querySelector('.todo')`)) && (await snapshot()).active !== 'INPUT', (await snapshot()).active)
  const row = await rect(`.todo .row`)
  t.check('filas de 36 px', row && row.h === 36, JSON.stringify(row))
  const box = await rect('.todo .row .checkbox, .todo .row [data-state]')
  t.check('casilla de 16 px alineada a 24 px del borde del widget', box && box.w === 16 && box.h === 16 && Math.abs(box.x - card.x - 24) <= 1, JSON.stringify(box))
  await sleep(500)
  const after = await evaluate(`window.omni.invoke('todo:list').then((l) => l.filter((x) => x.text === 'Probar omni e2e').length)`)
  t.check('la tarea se persistió por IPC', after === before + 1, `antes=${before} ahora=${after}`)
  t.check('el sidebar cuenta la tarea pendiente en Tareas', await waitFor(`[...document.querySelectorAll('.sidebar .nav-item')].some((n) => /Tareas/.test(n.textContent) && /\\d/.test(n.textContent))`, 2000), await evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].map((n) => n.textContent.trim()).join(' | ')`))
  // cursor sobre la tarea nueva
  await evaluate(`import('/src/store/todos.ts').then((m) => { const s = m.useTodos.getState(); const t = s.todos.find((x) => x.text === 'Probar omni e2e'); if (t) s.setCursor(t.id) })`)
  await press('x')
  t.check('X la marca hecha (fila tachada, grupo Hecho)', await waitFor(`[...document.querySelectorAll('.todo .row')].some((r) => /Probar omni e2e/.test(r.textContent) && r.dataset.status === 'done')`) || await waitFor(`/Hecho/.test(document.querySelector('.todo')?.textContent ?? '')`), JSON.stringify(await evaluate(`[...document.querySelectorAll('.todo .row')].map((r) => r.dataset.status ?? '-')`)))
  await evaluate(`import('/src/store/todos.ts').then((m) => { const s = m.useTodos.getState(); const t = s.todos.find((x) => x.text === 'Probar omni e2e'); if (t) { s.toggleDone(t.id); s.setCursor(t.id) } })`)
  t.check('la lista no separa Hoy ni Mañana: una sola lista de pendientes', !(await evaluate(`/\\b(Hoy|Mañana)\\b/.test(document.querySelector('.todo__list')?.textContent ?? '')`)), await evaluate(`document.querySelector('.todo__list')?.textContent?.slice(0, 120)`))
  await evaluate(`import('/src/store/todos.ts').then((m) => { const s = m.useTodos.getState(); const t = s.todos.find((x) => x.text === 'Probar omni e2e'); if (t) s.setCursor(t.id) })`)
  await press('d')
  t.check('D la borra', await waitFor(`![...document.querySelectorAll('.todo .row')].some((r) => /Probar omni e2e/.test(r.textContent))`))
  await press('cmd+z')
  t.check('⌘Z la devuelve', await waitFor(`[...document.querySelectorAll('.todo .row')].some((r) => /Probar omni e2e/.test(r.textContent))`))
  // ⏎ sobre la tarea: abre el launcher en el workspace de la tarea; un shell no se vincula
  const wsBefore = await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().currentWorkspaceId)`)
  await evaluate(`import('/src/store/todos.ts').then((m) => { const s = m.useTodos.getState(); const t = s.todos.find((x) => x.text === 'Probar omni e2e'); if (t) s.setCursor(t.id) })`)
  await press('enter')
  t.check('⏎ sobre la tarea abre el launcher y cierra el widget', await waitFor(`!!document.querySelector('.overlay .picker') && !document.querySelector('.todo')`, 3000), JSON.stringify(await snapshot()))
  t.check('el launcher apunta al workspace del proyecto de la tarea', (await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().currentWorkspaceId)`)) === wsBefore, '')
  t.check('la espera de lanzamiento lleva tarea y workspace', await evaluate(`import('/src/store/todos.ts').then((m) => { const p = m.useTodos.getState().pendingLaunch; return !!p && p.workspaceId === ${JSON.stringify(wsBefore)} })`))
  await type('Nueva terminal')
  await sleep(120)
  const tabsBefore = (await snapshot()).tabs
  await press('enter')
  t.check('el launcher crea el shell en un tab nuevo', await waitFor(`document.querySelectorAll('.tabs .tab:not(.tab--action)').length === ${tabsBefore + 1}`, 4000))
  await sleep(600)
  t.check('un shell no queda vinculado a la tarea ni recibe su texto', await evaluate(`import('/src/store/todos.ts').then((m) => { const s = m.useTodos.getState(); const t = s.todos.find((x) => x.text === 'Probar omni e2e'); return !!t && t.sessionId === null && s.pendingLaunch === null })`))
  const newShell = await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0]?.id)`)
  await sleep(800)
  t.check('la terminal nueva no recibió el texto de la tarea', !/Probar omni e2e/.test(await buffer(newShell)), (await buffer(newShell)).slice(-60))
  await closePanes(api, 1)
  await press(todoKey)
  await waitFor(`!!document.querySelector('.todo')`)
  await evaluate(`import('/src/store/todos.ts').then((m) => { const s = m.useTodos.getState(); for (const t of [...s.todos]) if (t.text === 'Probar omni e2e') s.remove(t.id) })`)
  await sleep(500)
  t.check('limpieza: la tarea de prueba ya no está persistida', (await evaluate(`window.omni.invoke('todo:list').then((l) => l.filter((x) => x.text === 'Probar omni e2e').length)`)) === 0)
  await press('escape')
  t.check('Esc cierra el widget', await waitFor(`!document.querySelector('.todo')`))
  t.check('tras cerrar, el foco vuelve a la terminal', await waitFor(`document.activeElement?.tagName === 'TEXTAREA'`), (await snapshot()).active)

  await closePanes(api, 1)
}
