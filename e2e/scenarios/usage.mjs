// Widget Uso (§3.25) contra la app viva. Primero con los datos reales (logs locales y topes del plan en
// vivo con el login de cada CLI): abre por comando, mide y pinta. Luego con un reporte inyectado para
// medir el diseño en los tres niveles (normal, alto, lleno) y los agentes sin datos. Se abre por comando y
// por el costo del pie; R vuelve a medir; Esc cierra.
const USAGE = `import('/src/store/usage.ts')`
const run = (id) => `import('/src/core/commands/registry.ts').then((m) => m.commands.run(${JSON.stringify(id)}))`

const H = 3_600_000
const FAKE = (now) => ({
  at: now,
  todayUsd: 23.73,
  agents: [
    { agent: 'claude', found: true, today: { usd: 18.6, tokens: 3_200_000 }, plan: 'Max 20x', limitsAt: now, stale: false, limitsError: null, limits: [
      { id: 'session', label: '5 h', usedPercent: 62, windowMinutes: 300, resetsAt: now + 1.67 * H },
      { id: 'weekly', label: 'Semana', usedPercent: 24, windowMinutes: 10080, resetsAt: now + 70 * H },
      { id: 'model:fable', label: 'Fable', usedPercent: 97, windowMinutes: 10080, resetsAt: now + 70 * H }
    ] },
    { agent: 'codex', found: true, today: { usd: 4.9, tokens: 410_000 }, plan: 'Plus', limitsAt: now - 3.5 * H, stale: true, limitsError: 'Sin conexión con OpenAI', limits: [
      { id: 'session', label: '5 h', usedPercent: 15, windowMinutes: 300, resetsAt: now + 3.2 * H },
      { id: 'weekly', label: 'Semana', usedPercent: 83, windowMinutes: 10080, resetsAt: now + 100 * H }
    ] },
    { agent: 'opencode', found: true, today: { usd: 0.23, tokens: 18_000 }, plan: null, limitsAt: null, stale: false, limitsError: null, limits: [] },
    { agent: 'goose', found: false, today: null, plan: null, limitsAt: null, stale: false, limitsError: null, limits: [] },
    { agent: 'hermes', found: true, today: { usd: 0, tokens: 0 }, plan: null, limitsAt: null, stale: false, limitsError: null, limits: [] }
  ]
})

export default async function (api, t) {
  const { evaluate, press, sleep, waitFor, click } = api

  // 1. Datos reales.
  await evaluate(run('usage.toggle'))
  t.check('el widget abre', await waitFor(`!!document.querySelector('.usage')`))
  t.check('mide con los datos reales', await waitFor(`${USAGE}.then((m) => !!m.useUsage.getState().report && !m.useUsage.getState().loading)`, 15000))
  const real = await evaluate(`${USAGE}.then((m) => m.useUsage.getState().report.agents.map((a) => ({ agent: a.agent, found: a.found, limits: a.limits.length, plan: a.plan, error: a.limitsError })))`)
  t.check('el reporte trae los cinco agentes en orden', real.map((a) => a.agent).join() === 'claude,codex,opencode,goose,hermes', JSON.stringify(real))
  const cards = await evaluate(`[...document.querySelectorAll('.usage__agent')].map((c) => c.dataset.agent)`)
  t.check('pinta una tarjeta por agente con rastro', cards.length === real.filter((a) => a.found).length, JSON.stringify(cards))
  const leak = await evaluate(`document.querySelector('.usage').textContent`)
  t.check('nada que parezca un token en pantalla', !/Bearer|sk-|eyJ[a-zA-Z0-9]{20}/.test(leak))
  t.check('el título del diálogo dice lo de hoy', /^Uso de los agentes, \$\d+\.\d\d hoy$/.test(await evaluate(`document.querySelector('.usage').getAttribute('aria-label')`)))

  // 2. Reporte inyectado: niveles y ausentes.
  await evaluate(`${USAGE}.then((m) => m.useUsage.setState({ report: ${JSON.stringify(FAKE(Date.now()))}, loading: false }))`)
  // La barra anima su ancho 0,3 s: se mide cuando terminó.
  await sleep(500)
  await api.parkMouse()
  const m = await evaluate(`(() => {
    const card = document.querySelector('.usage').getBoundingClientRect()
    const x = (el) => (el ? Math.round(el.getBoundingClientRect().x - card.x) : null)
    const q = (s) => [...document.querySelectorAll('.usage ' + s)]
    const limits = q('.usage__limit')
    const col = (s) => new Set(limits.map((l) => x(l.querySelector(s))))
    const right = (s) => new Set(limits.map((l) => Math.round(l.querySelector(s).getBoundingClientRect().right - card.x)))
    return {
      value: document.querySelector('.widget__value')?.textContent,
      names: q('.usage__name').map((n) => n.textContent),
      nameX: new Set(q('.usage__name').map(x)).size,
      labelX: col('.usage__label').size, meterX: col('.meter').size, pctRight: right('.usage__pct').size, resetRight: right('.usage__reset').size,
      labelAlignsName: x(limits[0]?.querySelector('.usage__label')) === x(q('.usage__name')[0]),
      metaAlignsName: x(q('.usage__meta')[0]) === x(q('.usage__name')[0]),
      levels: limits.map((l) => l.dataset.level + ':' + l.querySelector('.usage__pct').textContent),
      meters: q('.meter').map((mt) => mt.getAttribute('role') + ':' + mt.getAttribute('aria-valuenow')),
      fullColor: getComputedStyle(limits.find((l) => l.dataset.level === 'full').querySelector('.meter__fill')).backgroundColor,
      okColor: getComputedStyle(limits.find((l) => l.dataset.level === 'ok').querySelector('.meter__fill')).backgroundColor,
      fableFill: Math.round(limits.find((l) => /Fable/.test(l.textContent)).querySelector('.meter__fill').getBoundingClientRect().width / limits.find((l) => /Fable/.test(l.textContent)).querySelector('.meter').getBoundingClientRect().width * 100),
      resets: limits.map((l) => l.querySelector('.usage__reset').textContent),
      stale: q('[data-agent="codex"] .usage__meta')[0]?.textContent,
      missing: q('.usage__missing')[0]?.textContent,
      overflow: q('.usage__agent').filter((c) => c.scrollWidth > c.clientWidth + 1).length + limits.filter((l) => l.scrollWidth > l.clientWidth + 1).length,
      bordered: q('.usage__agent').filter((c) => parseFloat(getComputedStyle(c).borderTopWidth) > 0 || getComputedStyle(c).boxShadow !== 'none').length,
      gaps: q('.usage__agent').slice(1).map((c, i) => Math.round(c.getBoundingClientRect().top - q('.usage__agent')[i].getBoundingClientRect().bottom)),
      idle: (() => { const c = document.querySelector('.usage__agent[data-agent="hermes"]'); return c && { idle: c.hasAttribute('data-idle'), h: Math.round(c.getBoundingClientRect().height), right: c.querySelector('.usage__today').textContent, meta: !!c.querySelector('.usage__meta') } })(),
      footLines: new Set([...document.querySelectorAll('.widget__foot > *')].map((h) => Math.round(h.getBoundingClientRect().top))).size
    }
  })()`)
  const dump = JSON.stringify(m)
  t.check('cabecera con el total de hoy', m.value === '$23.73', dump)
  t.check('nombres en una columna y topes alineados con ellos', m.nameX === 1 && m.labelAlignsName && m.metaAlignsName, dump)
  t.check('etiqueta, barra, % y reinicio en columnas iguales entre agentes', m.labelX === 1 && m.meterX === 1 && m.pctRight === 1 && m.resetRight === 1, dump)
  t.check('niveles: normal, alto desde 80 y lleno desde 95, con el % escrito', m.levels.join() === 'ok:62%,ok:24%,full:97%,ok:15%,high:83%', dump)
  t.check('las barras son meters accesibles con su valor', m.meters.every((x) => x.startsWith('meter:')) && m.meters.includes('meter:97'), dump)
  t.check('la barra llena se pinta en otro color y al ancho del %', m.fullColor !== m.okColor && Math.abs(m.fableFill - 97) <= 1, dump)
  t.check('reinicio: horas que faltan o día de la semana', /^1h 4\dm$/.test(m.resets[0]) && /^(dom|lun|mar|mié|jue|vie|sáb) \d+:\d\d$/.test(m.resets[1]), dump)
  t.check('Codex dice que sus topes son viejos', /410k tokens hoy · topes de hace 3h/.test(m.stale ?? ''), dump)
  t.check('Goose va aparte como sin datos', /Sin datos en esta máquina\s*Goose/.test(m.missing ?? ''), dump)
  t.check('nada se desborda, sin bordes, aire de 8 entre tarjetas', m.overflow === 0 && m.bordered === 0 && m.gaps.every((g) => g === 8), dump)
  t.check('pie en una línea', m.footLines === 1, dump)
  t.check('un agente sin uso hoy queda en una línea que lo dice', m.idle?.idle && m.idle.h === 44 && m.idle.right === 'sin uso hoy' && !m.idle.meta, dump)
  if (process.env.E2E_SHOTS) await api.screenshot(`${process.env.E2E_SHOTS}/usage-widget.png`)

  // 3. Teclas y pie.
  await press('j')
  await sleep(150)
  t.check('J desplaza la lista', (await evaluate(`document.querySelector('.usage__list').scrollTop`)) > 0)
  await press('r')
  t.check('R vuelve a medir', await waitFor(`${USAGE}.then((m) => m.useUsage.getState().loading)`, 1000) || (await evaluate(`${USAGE}.then((m) => m.useUsage.getState().report.todayUsd !== 23.73)`)))
  await waitFor(`${USAGE}.then((m) => !m.useUsage.getState().loading)`, 15000)
  await press('escape')
  t.check('Esc cierra', await waitFor(`!document.querySelector('.usage')`))
  const hasCost = await evaluate(`!!document.querySelector('.status-bar__cost')`)
  if (hasCost) {
    await click('.status-bar__cost')
    t.check('el costo del pie abre el widget', await waitFor(`!!document.querySelector('.usage')`))
    await press('escape')
    await waitFor(`!document.querySelector('.usage')`)
  }
}
