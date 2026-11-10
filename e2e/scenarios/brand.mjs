// Logo de omni (ARCHITECTURE §3.7, design/brand): `OmniMark` en la cabecera de la ventana, con el sidebar
// visible y oculto (14 px, corte chico, centrado con el nombre), y en la pantalla vacía del workspace
// (56 px, dibujo maestro, en --surface-3, centrado sobre el título).
const run = (id) => `import('/src/core/commands/registry.ts').then((m) => m.commands.run(${JSON.stringify(id)}))`

const measureHead = `(() => {
  const name = document.querySelector('.window-head__name')
  const mark = name?.querySelector('svg.omni-mark')
  if (!name || !mark) return null
  const m = mark.getBoundingClientRect()
  const range = document.createRange()
  const text = [...name.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim() === 'omni')
  if (!text) return { noText: true }
  range.selectNodeContents(text)
  const t = range.getBoundingClientRect()
  return {
    w: Math.round(m.width), h: Math.round(m.height),
    centerGap: Math.abs((m.top + m.height / 2) - (t.top + t.height / 2)),
    gap: Math.round(t.left - m.right),
    small: mark.querySelector('path').getAttribute('d').startsWith('M108'),
    sameColor: getComputedStyle(mark).color === getComputedStyle(name).color,
    hidden: mark.getAttribute('aria-hidden')
  }
})()`

export default async function (api, t) {
  const { evaluate, sleep, waitFor } = api
  const shot = async (name) => {
    if (!process.env.E2E_SHOTS) return
    await api.parkMouse()
    await api.screenshot(`${process.env.E2E_SHOTS}/${name}.png`)
  }

  // 1. Cabecera con el sidebar visible.
  if (await evaluate(`(async () => (await import('/src/store/ui.ts')).useUi.getState().sidebarCollapsed)()`)) await evaluate(run('sidebar.toggle'))
  await sleep(300)
  let head = await evaluate(measureHead)
  let dump = JSON.stringify(head)
  t.check('la cabecera lleva el logo', head !== null && !head.noText, dump)
  t.check('logo de 14 × 14 con el corte chico', head?.w === 14 && head?.h === 14 && head?.small === true, dump)
  t.check('centrado con "omni" y separado 6 px', head?.centerGap <= 1 && head?.gap === 6, dump)
  t.check('en el color del nombre y decorativo', head?.sameColor === true && head?.hidden === 'true', dump)
  await shot('brand-head')

  // 2. Cabecera con el sidebar oculto (vive en la fila de tabs).
  await evaluate(run('sidebar.toggle'))
  await sleep(400)
  head = await evaluate(measureHead)
  dump = JSON.stringify(head)
  t.check('sin sidebar la cabecera también lleva el logo', head?.w === 14 && head?.centerGap <= 1, dump)
  await shot('brand-head-collapsed')
  await evaluate(run('sidebar.toggle'))
  await sleep(300)

  // 3. Pantalla vacía: sin workspace actual se ve el estado vacío de omni.
  const prev = await evaluate(`(async () => { const { useSessions } = await import('/src/store/sessions.ts'); const id = useSessions.getState().currentWorkspaceId; useSessions.setState({ currentWorkspaceId: null }); return id })()`)
  t.check('aparece el estado vacío', await waitFor(`!!document.querySelector('.main .empty')`))
  const empty = await evaluate(`(() => {
    const icon = document.querySelector('.main .empty__icon svg.omni-mark')
    const title = document.querySelector('.main .empty__title')
    if (!icon || !title) return null
    const i = icon.getBoundingClientRect(), ti = title.getBoundingClientRect()
    const range = document.createRange(); range.selectNodeContents(title); const tt = range.getBoundingClientRect()
    const css = getComputedStyle(document.documentElement)
    const probe = document.createElement('span'); probe.style.color = css.getPropertyValue('--surface-3'); document.body.append(probe)
    const want = getComputedStyle(probe).color; probe.remove()
    return {
      w: Math.round(i.width), h: Math.round(i.height),
      master: icon.querySelector('path').getAttribute('d').startsWith('M115'),
      above: i.bottom <= ti.top,
      centerGap: Math.abs((i.left + i.width / 2) - (tt.left + tt.width / 2)),
      color: getComputedStyle(icon).color === want
    }
  })()`)
  dump = JSON.stringify(empty)
  t.check('logo de 56 × 56 con el dibujo maestro', empty?.w === 56 && empty?.h === 56 && empty?.master === true, dump)
  t.check('arriba del título y centrado con él', empty?.above === true && empty?.centerGap <= 1, dump)
  t.check('en --surface-3, discreto', empty?.color === true, dump)
  await shot('brand-empty')
  await evaluate(`(async () => { const { useSessions } = await import('/src/store/sessions.ts'); useSessions.setState({ currentWorkspaceId: ${JSON.stringify(prev)} }) })()`)
  // El workspace puede no tener tabs (dev sin daemon): basta con que vuelva a ser el actual.
  const back = await evaluate(`(async () => (await import('/src/store/sessions.ts')).useSessions.getState().currentWorkspaceId)()`)
  t.check('vuelve al workspace', back === prev, JSON.stringify({ back, prev }))
}
