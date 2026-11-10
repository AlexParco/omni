// Iconos de agente (ui/icons.tsx): cada agente lleva su logo real en un solo color, como Orca. En el
// launcher se mide que todos pinten a 16 × 16, centrados con su nombre, y que no quede ningún monograma.
const run = (id) => `import('/src/core/commands/registry.ts').then((m) => m.commands.run(${JSON.stringify(id)}))`

export default async function (api, t) {
  const { evaluate, sleep, waitFor, press } = api
  await evaluate(run('launcher.open'))
  t.check('el launcher abre', await waitFor(`!!document.querySelector('.overlay')`))
  await sleep(300)
  const icons = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.overlay [role="option"]')]
    const want = ['Claude Code', 'Codex', 'OpenCode', 'Goose', 'Hermes']
    return want.map((name) => {
      const row = rows.find((r) => r.textContent.trim().startsWith(name))
      const icon = row?.querySelector('.agent-icon')
      if (!icon) return { name, missing: true }
      const r = icon.getBoundingClientRect()
      const label = [...row.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === name)?.getBoundingClientRect()
      const cs = getComputedStyle(icon)
      return {
        name,
        tag: icon.tagName.toLowerCase(),
        w: Math.round(r.width), h: Math.round(r.height),
        centerGap: label ? Math.abs(Math.round((r.top + r.height / 2) - (label.top + label.height / 2))) : null,
        text: icon.textContent.trim(),
        mask: cs.maskImage || cs.webkitMaskImage,
        bg: cs.backgroundImage,
        color: cs.color
      }
    })
  })()`)
  const dump = JSON.stringify(icons)
  t.check('los cinco agentes tienen icono', icons.every((i) => !i.missing), dump)
  t.check('todos pintan a 16 × 16 y centrados con su nombre', icons.every((i) => i.w === 16 && i.h === 16 && i.centerGap !== null && i.centerGap <= 1), dump)
  t.check('ninguno es un monograma de letras', icons.every((i) => i.text === ''), dump)
  const by = Object.fromEntries(icons.map((i) => [i.name, i]))
  t.check('Codex y OpenCode son SVG en el color del texto', by.Codex?.tag === 'svg' && by.OpenCode?.tag === 'svg' && by.Codex.color === by.OpenCode.color, dump)
  t.check('Goose y Hermes son máscaras en el color del texto', /goose-mask/.test(by.Goose?.mask ?? '') && /hermes-mask/.test(by.Hermes?.mask ?? '') && by.Goose.color === by.Codex.color, dump)
  const loaded = await evaluate(`Promise.all(['goose-mask', 'hermes-mask'].map((n) => { const u = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules] } catch { return [] } }).map((r) => r.cssText).join(' ').match(new RegExp('url\\\\("?([^")]*' + n + '[^")]*)')); return u ? fetch(u[1]).then((r) => r.ok && r.headers.get('content-type')?.includes('image')) : false }))`)
  t.check('las dos imágenes cargan', loaded.every(Boolean), JSON.stringify(loaded))
  if (process.env.E2E_SHOTS) {
    await api.parkMouse()
    await api.screenshot(`${process.env.E2E_SHOTS}/agent-icons.png`)
  }
  await press('escape')
  t.check('Esc cierra el launcher', await waitFor(`!document.querySelector('.overlay')`))
}
