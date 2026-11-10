// Widget de Tareas (§3.12) al estilo de macOS: material translúcido, cabecera con icono y pendientes en grande, campo
// de nueva tarea arriba en la columna de las casillas, grupos a dos bordes, acciones de la fila con
// cursor, casilla clicable y pie de atajos en una línea. Sin bordes en ningún botón.
const TODOS = `import('/src/store/todos.ts')`

export default async function (api, t) {
  const { evaluate, press, sleep, waitFor, click } = api
  const texts = ['Rediseño e2e uno', 'Rediseño e2e dos con un texto bastante más largo para ver el recorte y que se lea entero al poner el cursor encima, sin abrir nada más']
  await evaluate(`${TODOS}.then((m) => { const s = m.useTodos.getState(); for (const x of ${JSON.stringify(texts)}) s.add(x, null) })`)
  await evaluate(`import('/src/store/ui.ts').then((m) => m.useUi.getState().openOverlay('todo'))`)
  t.check('el widget abre', await waitFor(`!!document.querySelector('.todo')`))
  await evaluate(`${TODOS}.then((m) => { const s = m.useTodos.getState(); const x = s.todos.find((y) => y.text === ${JSON.stringify(texts[0])}); s.setCursor(x.id) })`)
  await waitFor(`document.querySelector('.todo')?.getAnimations().length === 0`, 2000)
  await sleep(100)
  const m = await evaluate(`(() => {
    const c = document.querySelector('.todo').getBoundingClientRect()
    const x = (e) => (e ? Math.round(e.getBoundingClientRect().x - c.x) : null)
    const q = (s) => document.querySelector('.todo ' + s)
    const cur = q('.row[data-cursor]')
    const foot = q('.todo__foot')
    return {
      title: q('.todo__title')?.firstChild?.textContent,
      count: q('.todo__count')?.textContent,
      radius: getComputedStyle(document.querySelector('.todo')).borderTopLeftRadius,
      blur: getComputedStyle(document.querySelector('.todo')).backdropFilter,
      pending: q('.todo__pending')?.textContent,
      headBorder: getComputedStyle(q('.todo__head')).borderBottomStyle,
      addFirst: q('.todo__add')?.nextElementSibling?.classList.contains('todo__list'),
      xPlus: x(q('.todo__add svg')), xInput: x(q('.todo__add input')), xBox: x(q('.row .checkbox')), xLabel: x(q('.row .row__label')),
      groups: [...document.querySelectorAll('.todo .todo__group')].map((g) => g.textContent.trim()),
      rowEndRight: Math.round(c.right - cur.getBoundingClientRect().right) - 12,
      actions: [...cur.querySelectorAll('.row__actions button')].map((b) => b.getAttribute('aria-label')),
      otherActionsHidden: [...document.querySelectorAll('.todo .row:not([data-cursor]) .row__actions')].every((a) => getComputedStyle(a).display === 'none'),
      footLines: new Set([...foot.querySelectorAll('.hint')].map((h) => Math.round(h.getBoundingClientRect().top))).size,
      footCut: foot.scrollWidth > foot.clientWidth,
      bordered: [...document.querySelectorAll('.todo button')].filter((b) => parseFloat(getComputedStyle(b).borderTopWidth) > 0).length,
      boxHit: (() => { const b = cur.querySelector('.checkbox').getBoundingClientRect(); const el = document.elementFromPoint(b.x - 6, b.y + 8); return el?.classList.contains('checkbox') })()
    }
  })()`)
  const dump = JSON.stringify(m)
  t.check('la cabecera dice Tareas y los pendientes de hoy, sin borde', m.title === 'Tareas' && /pendiente|nada pendiente/.test(m.pending) && m.headBorder === 'none', dump)
  t.check('estilo widget: esquinas de 22 px, material con blur y el número de pendientes en grande', m.radius === '22px' && /blur/.test(m.blur) && /^\d+$/.test(m.count ?? ''), dump)
  t.check('el campo de nueva tarea va arriba de la lista', m.addFirst === true, dump)
  t.check('columnas: + y casillas en 24, texto en 50', m.xPlus === 24 && m.xBox === 24 && m.xInput === 50 && m.xLabel === 50, dump)
  t.check('sin grupos Hoy ni Mañana: solo Hecho, plegable', m.groups.every((g) => /^Hecho/.test(g)), dump)
  t.check('la fila con cursor muestra lanzar y borrar', m.actions.length === 2 && /Lanzar/.test(m.actions[0]) && /Borrar/.test(m.actions[1]), dump)
  t.check('las demás filas no muestran acciones', m.otherActionsHidden, dump)
  t.check('el pie va en una línea sin recorte', m.footLines === 1 && !m.footCut, dump)
  t.check('ningún botón lleva borde', m.bordered === 0, dump)
  t.check('la casilla se puede clicar un poco por fuera', m.boxHit === true, dump)
  // clic en la casilla la marca hecha
  await click(`.todo .row[data-cursor] .checkbox`)
  t.check('clic en la casilla marca la tarea hecha', await waitFor(`${TODOS}.then((m) => m.useTodos.getState().todos.find((y) => y.text === ${JSON.stringify(texts[0])})?.done === true)`, 2000))
  // la tecla sigue funcionando: X la devuelve
  await evaluate(`${TODOS}.then((m) => { const s = m.useTodos.getState(); s.setCursor(s.todos.find((y) => y.text === ${JSON.stringify(texts[0])}).id) })`)
  await press('x')
  t.check('X la devuelve a pendiente', await waitFor(`${TODOS}.then((m) => m.useTodos.getState().todos.find((y) => y.text === ${JSON.stringify(texts[0])})?.done === false)`, 2000))
  // texto largo: la fila con cursor se despliega entera; la corta no cambia de alto
  const shortH = await evaluate(`Math.round(document.querySelector('.todo .row[data-cursor]').getBoundingClientRect().height)`)
  await evaluate(`${TODOS}.then((m) => { const s = m.useTodos.getState(); s.setCursor(s.todos.find((y) => y.text === ${JSON.stringify(texts[1])}).id) })`)
  await sleep(150)
  const w = await evaluate(`(() => {
    const cur = document.querySelector('.todo .row[data-cursor]')
    const r = cur.getBoundingClientRect()
    const lab = cur.querySelector('.row__label')
    const top = (s) => Math.round(cur.querySelector(s).getBoundingClientRect().top - r.top)
    const other = [...document.querySelectorAll('.todo .row:not([data-cursor])')].find((x) => x.textContent.includes(${JSON.stringify(texts[0])}))
    return {
      lines: Math.round(lab.getBoundingClientRect().height / 20),
      cut: lab.scrollWidth > lab.clientWidth || lab.scrollHeight > lab.clientHeight + 1,
      boxTop: top('.checkbox'), actTop: top('.row__actions'),
      otherH: Math.round(other.getBoundingClientRect().height),
      otherWrap: getComputedStyle(other.querySelector('.row__label')).whiteSpace
    }
  })()`)
  const wd = JSON.stringify({ shortH, ...w })
  t.check('la fila corta con cursor mide 36 (no salta)', shortH === 36, wd)
  t.check('la fila larga con cursor muestra el texto entero en varias líneas', w.lines >= 2 && !w.cut, wd)
  t.check('casilla y acciones alineadas a la primera línea', w.boxTop === 10 && w.actTop === 5, wd)
  t.check('las demás filas siguen en una línea', w.otherH === 36 && w.otherWrap === 'nowrap', wd)
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/todo-long.png')
  // limpieza
  await evaluate(`${TODOS}.then((m) => { const s = m.useTodos.getState(); for (const x of [...s.todos]) if (${JSON.stringify(texts)}.includes(x.text)) s.remove(x.id) })`)
  await press('escape'); await sleep(200)
}
