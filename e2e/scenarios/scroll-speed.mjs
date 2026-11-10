// Velocidad del scroll de la terminal (Ajustes → Terminal): el ajuste llega a xterm como
// `scrollSensitivity`, se aplica en vivo a las terminales abiertas y multiplica lo que avanza cada rueda.
// Los eventos de rueda de CDP no son de trackpad, pero sirven para comparar 1× contra 4×.
import { ensurePane } from './_helpers.mjs'

const termOf = `(async () => {
  const { useSessions } = await import('/src/store/sessions.ts')
  const { useLayout, activeTabOf, leaves } = await import('/src/store/layout.ts')
  const { getTerminal } = await import('/src/panes/terminal/terminal-host.ts')
  const tab = activeTabOf(useLayout.getState(), useSessions.getState().currentWorkspaceId)
  const leaf = leaves(tab.root).find((l) => l.id === tab.focusedPaneId)
  const term = getTerminal(leaf.sessionId).term
  const r = term.element.querySelector('.xterm-screen').getBoundingClientRect()
  return { id: leaf.sessionId, y: term.buffer.active.viewportY, base: term.buffer.active.baseY, sens: term.options.scrollSensitivity, x: r.left + r.width / 2, cy: r.top + r.height / 2 }
})()`

export default async function (api, t) {
  const { evaluate, sleep, cdp, waitFor } = api
  const setSpeed = (v) => evaluate(`import('/src/store/settings.ts').then((m) => m.useSettings.getState().update({ terminalScrollSpeed: ${v} }))`)
  const original = await evaluate(`import('/src/store/settings.ts').then((m) => m.useSettings.getState().settings.terminalScrollSpeed)`)

  await ensurePane(api)
  const first = await evaluate(termOf)
  await evaluate(`window.omni.send('session:write', ${JSON.stringify(first.id)}, 'seq 1 4000\\r')`)
  t.check('hay scrollback', await waitFor(`${termOf.replace('return {', 'return term.buffer.active.baseY > 1000 || {')}.then((v) => v === true)`, 6000))

  // Cuántas líneas sube con 6 ruedas a una velocidad dada (desde el fondo).
  const linesAt = async (speed) => {
    await setSpeed(speed)
    await sleep(200)
    const s = await evaluate(termOf)
    await evaluate(`(async () => { const { getTerminal } = await import('/src/panes/terminal/terminal-host.ts'); getTerminal(${JSON.stringify(s.id)}).term.scrollToBottom() })()`)
    await sleep(150)
    const before = await evaluate(termOf)
    for (let i = 0; i < 6; i++) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: s.x, y: s.cy, deltaX: 0, deltaY: -100 })
      await sleep(40)
    }
    await sleep(500)
    const after = await evaluate(termOf)
    return { sens: after.sens, lines: before.y - after.y }
  }

  const slow = await linesAt(1)
  const fast = await linesAt(4)
  const dump = JSON.stringify({ slow, fast })
  t.check('el ajuste llega en vivo a la terminal abierta', slow.sens === 1 && fast.sens === 4, dump)
  t.check('a 4× avanza unas cuatro veces más que a 1×', slow.lines > 0 && fast.lines / slow.lines >= 3.5 && fast.lines / slow.lines <= 4.5, dump)

  // Ajustes muestra el selector con el valor actual.
  await evaluate(`import('/src/core/commands/registry.ts').then((m) => m.commands.run('settings.open'))`)
  t.check('Ajustes abre', await waitFor(`!!document.querySelector('[aria-label="Velocidad del scroll de la terminal"]')`))
  const shown = await evaluate(`(() => { const s = document.querySelector('[aria-label="Velocidad del scroll de la terminal"]'); return s.value ?? s.textContent })()`)
  t.check('el selector muestra 4×', /4/.test(String(shown)), String(shown))
  // Columna de la derecha alineada: el selector arranca y termina donde los de fuente, interlineado y grosor.
  const cols = await evaluate(`(() => ['Fuente de la terminal', 'Interlineado de la terminal', 'Grosor del texto de la terminal', 'Velocidad del scroll de la terminal'].map((l) => { const e = document.querySelector('[aria-label="' + l + '"]'); const r = (e.closest('.select') ?? e).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)] }))()`)
  t.check('selector alineado con los demás', cols.every((c) => c[0] === cols[0][0] && c[1] === cols[0][1]), JSON.stringify(cols))
  if (process.env.E2E_SHOTS) {
    await api.parkMouse()
    await api.screenshot(`${process.env.E2E_SHOTS}/scroll-speed-settings.png`)
  }
  await api.press('escape')
  await setSpeed(original)
}
