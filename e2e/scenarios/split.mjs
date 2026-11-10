// Split universal: prefijo + `|` (derecha) o `_` (abajo) abre el launcher con destino, el carácter
// del atajo no se cuela en el buscador, Esc devuelve el foco a la terminal y ⏎ crea el pane.
// No hay otra forma de splitear (ni ⌘D ni `%`/`"`), y el footer lo refleja.
import { chordFor, ensurePane, closePanes, assertQuiet } from './_helpers.mjs'

export default async function (api, t) {
  const { press, snapshot, sleep, waitFor, evaluate } = api
  await assertQuiet(api)
  const panes0 = await ensurePane(api)
  let s = await snapshot()
  t.check('foco en terminal tras clic en pane', s.focus === 'terminal' && s.active.startsWith('TEXTAREA'), s.active)
  const footer = await evaluate(`document.querySelector('.footer')?.textContent ?? ''`)
  const right = await chordFor(api, 'pane.split.right', 'terminal')
  const down = await chordFor(api, 'pane.split.down', 'terminal')
  t.check('el footer muestra los atajos vigentes de split', footer.includes(`${right} split →`) && footer.includes(`${down} split ↓`) && !footer.includes('%'), footer.slice(0, 90))
  // Pie sobrio: teclas sin caja, pocos atajos y ninguno se sale de la fila.
  const pie = await evaluate(`(() => { const f = document.querySelector('.footer'); const fr = f.getBoundingClientRect(); const hints = [...f.querySelectorAll('.hint')]; return { count: hints.length, boxed: hints.filter((h) => !h.dataset.on && getComputedStyle(h.querySelector('.kbd')).backgroundColor !== 'rgba(0, 0, 0, 0)').length, out: hints.filter((h) => h.getBoundingClientRect().right > fr.right).length } })()`)
  t.check('el pie de la terminal es corto, sin cajas y no se desborda', pie.count <= 9 && pie.boxed === 0 && pie.out === 0, JSON.stringify(pie))

  // prefijo _ → launcher abajo, input vacío
  await press(await api.prefix())
  await press(down)
  await sleep(150)
  s = await snapshot()
  t.check('prefijo _ abre launcher abajo', s.overlay && s.placeholder === 'Abrir abajo', `placeholder=${s.placeholder}`)
  t.check('el guion bajo no se cuela en el input', s.inputValue === '', JSON.stringify(s.inputValue))
  await press('escape')
  await sleep(150)
  s = await snapshot()
  t.check('Esc cierra y devuelve el foco a la terminal', !s.overlay && s.focus === 'terminal' && s.active.startsWith('TEXTAREA'), `focus=${s.focus} active=${s.active}`)

  // prefijo | → launcher derecha, ⏎ elige "Nueva terminal" → pane nuevo
  await press(await api.prefix())
  await press(right)
  await sleep(150)
  s = await snapshot()
  t.check('prefijo | abre launcher derecha', s.overlay && s.placeholder === 'Abrir a la derecha' && s.inputValue === '', `${s.placeholder} ${JSON.stringify(s.inputValue)}`)
  await api.type('Nueva terminal')
  await sleep(120)
  await press('enter')
  t.check('⏎ crea pane a la derecha', await waitFor(`document.querySelectorAll('.pane').length === ${panes0 + 1}`), `panes=${(await snapshot()).panes}`)
  s = await snapshot()
  t.check('el pane nuevo toma el foco', !s.overlay && s.focus === 'terminal' && s.active.startsWith('TEXTAREA'), `focus=${s.focus} active=${s.active}`)

  // Tamaño desde el teclado, como tmux: el foco está en el pane nuevo (derecha). Un solo prefijo y ⇧H tres
  // veces mueven el borde a la izquierda tres pasos (repeat-time); pasada la ventana, ⇧H va a la terminal.
  const widths = () => evaluate(`[...document.querySelectorAll('.pane')].slice(-2).map((p) => Math.round(p.getBoundingClientRect().width))`)
  const [l0, r0] = await widths()
  await press(await api.prefix())
  for (let i = 0; i < 3; i++) {
    await press('shift+h')
    await sleep(120)
  }
  await sleep(300)
  const [l1, r1] = await widths()
  const step = (l0 + r0) * 0.05
  t.check('prefijo ⇧H ⇧H ⇧H mueve el borde 3 pasos a la izquierda con un solo prefijo', Math.abs(l0 - l1 - 3 * step) < step / 2 && r1 > r0, `${l0}|${r0} → ${l1}|${r1}`)
  await press(await api.prefix())
  await press('shift+l')
  await sleep(300)
  const [l2] = await widths()
  t.check('prefijo ⇧L lo devuelve un paso a la derecha', Math.abs(l2 - l1 - step) < step / 2, `${l1} → ${l2}`)
  await sleep(800)
  await press('shift+h')
  await sleep(300)
  const [l3] = await widths()
  t.check('pasada la ventana, ⇧H ya no cambia el tamaño', l3 === l2, `${l2} → ${l3}`)
  await press('backspace').catch(() => undefined)
  const footer2 = await evaluate(`document.querySelector('.footer')?.textContent ?? ''`)
  t.check('el pie muestra el atajo de tamaño', /tamaño/.test(footer2), footer2.slice(0, 160))

  // Los atajos viejos ya no existen
  await press('cmd+d')
  await sleep(200)
  s = await snapshot()
  t.check('⌘D ya no abre nada', !s.overlay && s.panes === panes0 + 1, `overlay=${s.overlay} panes=${s.panes}`)
  await press(await api.prefix())
  await press('%')
  await sleep(200)
  s = await snapshot()
  t.check('prefijo % ya no abre nada', !s.overlay && s.panes === panes0 + 1, `overlay=${s.overlay} panes=${s.panes}`)

  await closePanes(api, 2)
  s = await snapshot()
  t.check('limpieza: el tab del test se cerró', !s.overlay, `overlay=${s.overlay}`)
}
