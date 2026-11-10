// Cerrar un pane cuyo proceso está trabajando pide confirmación: ⏎ mata, Esc cancela y
// ninguna otra tecla cierra el diálogo por accidente.
import { ensurePane, closePanes, confirmKillIfShell, assertQuiet, splitShell } from './_helpers.mjs'

export default async function (api, t) {
  const { press, type, snapshot, sleep, waitFor } = api
  await assertQuiet(api)
  const panes0 = await ensurePane(api)

  // Terminal nueva con salida continua → estado "trabajando"
  await splitShell(api)
  await type('while true; do echo omni-e2e; sleep 0.3; done\n')
  await sleep(800)

  // Solo se manda C-a x con el teclado en una terminal: en la lista, `x` cerraría el tab bajo el cursor.
  if ((await snapshot()).focus !== 'terminal') throw new Error('el teclado no está en la terminal: no se manda x')
  await press(await api.prefix())
  await press('x')
  await sleep(200)
  let s = await snapshot()
  t.check('prefijo x sobre proceso trabajando pide confirmación', s.overlay && s.active.includes('picker'), `overlay=${s.overlay} active=${s.active}`)
  if (!s.overlay) return

  // Teclas sueltas no cierran el diálogo
  await press('j')
  await press('a')
  await sleep(100)
  s = await snapshot()
  t.check('teclas sueltas no cierran el confirm', s.overlay, `overlay=${s.overlay}`)

  // Esc cancela y el pane sigue
  await press('escape')
  await sleep(200)
  s = await snapshot()
  t.check('Esc cancela: el pane sigue y la terminal recupera el foco', !s.overlay && s.panes === panes0 + 1 && s.active.startsWith('TEXTAREA'), `panes=${s.panes} active=${s.active}`)

  // ⏎ confirma y el pane se va
  if ((await snapshot()).focus !== 'terminal') throw new Error('el teclado no está en la terminal: no se manda x')
  await press(await api.prefix())
  await press('x')
  await sleep(200)
  s = await snapshot()
  t.check('vuelve a pedir confirmación', s.overlay, `overlay=${s.overlay}`)
  if (!s.overlay) return
  await confirmKillIfShell(api)
  t.check('⏎ mata el proceso y cierra el pane', await waitFor(`document.querySelectorAll('.pane').length === ${panes0}`), `panes=${(await snapshot()).panes}`)
  s = await snapshot()
  t.check('tras cerrar, el foco vuelve a una terminal', s.focus === 'terminal' && s.active.startsWith('TEXTAREA'), `focus=${s.focus} active=${s.active}`)

  if (s.panes > panes0) await closePanes(api, s.panes - panes0)
  await closePanes(api, 1) // el tab del test
}
