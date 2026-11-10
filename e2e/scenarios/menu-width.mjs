// Menús (ListPicker sin filtro): tan anchos como su fila más larga. Ningún label se recorta, las notas
// van en una línea y el menú cabe en la ventana. La paleta y el launcher conservan su ancho fijo.
const MEASURE = `(() => { const p = document.querySelector('.picker'); if (!p) return null; const pb = p.getBoundingClientRect(); const rows = [...p.querySelectorAll('.picker__item')].map((it) => { const l = it.querySelector('.picker__label'); const h = it.querySelector('.picker__hint'); return { label: l?.textContent, cut: !!l && l.scrollWidth > l.clientWidth, wrapped: !!h && h.getBoundingClientRect().height > 18, out: !!h && h.getBoundingClientRect().right > it.getBoundingClientRect().right + 0.5 } }); return { w: Math.round(pb.width), inside: pb.left >= 0 && pb.right <= innerWidth, rows } })()`

export default async function (api, t) {
  const { evaluate, sleep, press } = api
  await evaluate(`Promise.all([import('/src/store/sessions.ts'), import('/src/store/ui.ts')]).then(([m, u]) => { const s = m.useSessions.getState(); m.useSessions.setState({ cursor: m.rowKey.project(s.projects[0].id) }); u.useUi.getState().openOverlay('projectMenu') })`)
  await sleep(400)
  const menu = await evaluate(MEASURE)
  t.check('el menú del proyecto se abre', !!menu && menu.rows.length > 3, JSON.stringify(menu?.rows.map((r) => r.label)))
  t.check('ningún label del menú se recorta', menu.rows.every((r) => !r.cut), JSON.stringify(menu.rows.filter((r) => r.cut)))
  t.check('las notas van en una línea y dentro de su fila', menu.rows.every((r) => !r.wrapped && !r.out), JSON.stringify(menu.rows.filter((r) => r.wrapped || r.out)))
  t.check('"Quitar proyecto" se lee completo', menu.rows.some((r) => r.label === 'Quitar proyecto' && !r.cut))
  t.check('el menú cabe en la ventana', menu.inside && menu.w >= 340, String(menu.w))
  await press('escape'); await sleep(300)
  await press('cmd+shift+p'); await sleep(400)
  const pal = await evaluate(MEASURE)
  t.check('la paleta conserva su ancho y no desborda', pal?.w === 460 && pal.rows.every((r) => !r.out), JSON.stringify({ w: pal?.w }))
  await press('escape'); await sleep(300)
}
