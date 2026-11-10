// Fuente de la terminal (Ajustes → Terminal): por defecto como Orca (Menlo, interlineado 1.0, peso
// 500), con respaldo de Nerd Fonts; cambiarla en Ajustes se aplica en vivo a las terminales, y solo a
// ellas (el editor sigue con Geist Mono). Mide la celda de xterm: con 1.0 la fila mide lo que la fuente, no 25 % más.
import { ensurePane, closePanes } from './_helpers.mjs'

const MOD = { settings: `import('/src/store/settings.ts')`, host: `import('/src/panes/terminal/terminal-host.ts')`, sessions: `import('/src/store/sessions.ts')` }

export default async function (api, t) {
  const { evaluate, sleep, waitFor } = api
  const original = await evaluate(`${MOD.settings}.then((m) => { const s = m.useSettings.getState().settings; return { terminalFont: s.terminalFont, terminalLineHeight: s.terminalLineHeight, terminalFontWeight: s.terminalFontWeight } })`)
  await evaluate(`${MOD.settings}.then((m) => m.useSettings.getState().update({ terminalFont: 'menlo', terminalLineHeight: 1, terminalFontWeight: 500 }))`)
  await ensurePane(api)
  const sid = await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0]?.id)`)
  const opts = (expr) => evaluate(`${MOD.host}.then((m) => { const term = m.getTerminal(${JSON.stringify(sid)})?.term; return term ? ${expr} : null })`)
  const cell = () => opts(`(() => { const d = term._core._renderService.dimensions.css.cell; return { w: Math.round(d.width * 100) / 100, h: Math.round(d.height * 100) / 100 } })()`)
  await sleep(300)
  const o = await opts(`({ family: term.options.fontFamily, lh: term.options.lineHeight, w: term.options.fontWeight, wb: term.options.fontWeightBold, size: term.options.fontSize })`)
  t.check('la terminal usa Menlo con respaldo de Nerd Fonts, interlineado 1 y peso 500/700', /^"Menlo"/.test(o?.family ?? '') && /Nerd Font/.test(o.family) && o.lh === 1 && o.w === 500 && o.wb === 700, JSON.stringify(o))
  t.check('la medición distingue una fuente instalada (Menlo) de una que no existe', await evaluate(`import('/src/lib/fonts.ts').then((m) => m.fontInstalled('Menlo') && !m.fontInstalled('Fuente Que No Existe') && !m.fontInstalled('SF Mono'))`))
  const tight = await cell()
  t.check('con interlineado 1 la fila mide como la fuente (≤ 1.3 × tamaño)', !!tight && tight.h <= o.size * 1.3, JSON.stringify({ tight, size: o.size }))

  await evaluate(`window.omni.send('session:write', ${JSON.stringify(sid)}, "clear; printf 'omni  Menlo 1.0  =>  !=  0O 1lI  {}[]()  \\\\033[1mnegrita\\\\033[0m  \\\\033[32mverde\\\\033[0m\\\\n'; ls -la /etc | head -12\\r")`)
  const printed = `${MOD.host}.then((m) => { const b = m.getTerminal(${JSON.stringify(sid)})?.term.buffer.active; if (!b) return false; let text = ''; for (let i = 0; i < b.length; i++) text += b.getLine(i)?.translateToString(true) + '\\n'; return /private\\/etc/.test(text) })`
  await waitFor(printed, 5000); await sleep(200)
  if (process.env.E2E_SHOTS) await api.screenshot(`${process.env.E2E_SHOTS}/term-new.png`)

  t.check('el editor no cambia: sigue con Geist Mono (la fuente es solo de la terminal)', await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--mono').includes('Geist Mono')`))
  // Lo de antes (Geist Mono, 1.3, 400), para comparar: la fila crece
  await evaluate(`${MOD.settings}.then((m) => m.useSettings.getState().update({ terminalFont: 'geist-mono', terminalLineHeight: 1.3, terminalFontWeight: 400 }))`)
  t.check('cambiar la fuente en Ajustes se aplica en vivo', await waitFor(`${MOD.host}.then((m) => /^"Geist Mono"/.test(m.getTerminal(${JSON.stringify(sid)})?.term.options.fontFamily ?? '') && m.getTerminal(${JSON.stringify(sid)})?.term.options.lineHeight === 1.3)`, 2000))
  await sleep(400)
  const loose = await cell()
  t.check('con interlineado 1.3 la fila es más alta', !!loose && loose.h > tight.h, JSON.stringify({ tight, loose }))
  if (process.env.E2E_SHOTS) await api.screenshot(`${process.env.E2E_SHOTS}/term-old.png`)

  // Ajustes lista las fuentes instaladas
  await evaluate(`import('/src/store/ui.ts').then((m) => m.useUi.getState().openOverlay('settings'))`)
  t.check('Ajustes muestra Fuente, Interlineado y Grosor', await waitFor(`['Fuente', 'Interlineado', 'Grosor'].every((l) => [...document.querySelectorAll('.field')].some((f) => f.textContent.startsWith(l)))`, 2000))
  const fonts = await evaluate(`[...document.querySelectorAll('select[aria-label="Fuente de la terminal"] option')].map((o) => o.textContent)`)
  t.check('la lista de fuentes trae Menlo primero y Geist Mono, sin SF Mono', fonts[0] === 'Menlo' && fonts.includes('Geist Mono') && !fonts.includes('SF Mono'), JSON.stringify(fonts))
  if (process.env.E2E_SHOTS) await api.screenshot(`${process.env.E2E_SHOTS}/settings-font.png`)
  await api.press('escape'); await sleep(200)

  // Limpieza: ajustes como estaban y el pane cerrado
  await evaluate(`${MOD.settings}.then((m) => m.useSettings.getState().update(${JSON.stringify(original)}))`)
  await api.click('.pane'); await sleep(150)
  await closePanes(api, 1)
}
