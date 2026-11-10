// Pasos compartidos entre escenarios. Ningún escenario asume estado previo: se apoya en esto.

/**
 * Atajo vigente de un comando en una capa (`terminal`, `global`…), con los cambios del usuario en Ajustes:
 * los escenarios no asumen los atajos por defecto (`|` para dividir puede ser `\` en la máquina de quien prueba).
 */
export async function chordFor(api, commandId, layer) {
  const chord = await api.evaluate(`import('/src/core/keys/keymap.ts').then((m) => m.keymap.chordsFor(${JSON.stringify(commandId)}).find((c) => c.layer === ${JSON.stringify(layer)})?.chord ?? null)`)
  if (!chord) throw new Error(`sin atajo para ${commandId} en ${layer}`)
  return chord
}

/**
 * Abre un tab nuevo con un shell para el test (nunca se usa un tab del usuario), lo enfoca con un
 * clic y devuelve cuántos panes hay en pantalla (1). Al final el escenario lo cierra con `closePanes`.
 */
export async function ensurePane(api) {
  const { press, click, snapshot, waitFor, sleep } = api
  const tabs = (await snapshot()).tabs
  await press('cmd+t')
  await sleep(150)
  // El launcher ordena por uso reciente: sin filtro, ⏎ abriría el último agente del usuario (p. ej. Codex).
  await api.type('Nueva terminal')
  await sleep(120)
  await press('enter')
  await waitFor(`document.querySelectorAll('.tabs .tab:not(.tab--action)').length === ${tabs + 1}`)
  await sleep(400)
  await click('.pane')
  await sleep(150)
  return (await snapshot()).panes
}

/** Cierra `n` panes con C-a x desde la terminal con foco; si pregunta (proceso trabajando), confirma. */
export async function closePanes(api, n) {
  const { press, evaluate, snapshot, waitFor, sleep } = api
  for (let i = 0; i < n; i++) {
    const { panes: before, tabs: tabsBefore } = await snapshot()
    // Solo se cierran shells: nunca un agente del usuario que estuviera abierto antes del test.
    // Se reconoce por el icono de la franja (el título OSC lo cambia cualquier comando).
    const live = `(document.querySelector('.pane[data-focus="live"]') ?? document.querySelector('.pane'))`
    if (!(await evaluate(`!!${live}`))) throw new Error('closePanes: no hay ningún pane en pantalla')
    const title = await evaluate(`${live}?.querySelector('.strip__title')?.textContent ?? ''`)
    const isShell = await evaluate(`!!${live}?.querySelector('.strip svg.lucide-terminal')`)
    if (!isShell && !isShellTitle(title)) throw new Error(`closePanes se negó a cerrar "${title}"`)
    // El prefijo es configurable (⌘,): se usa el vigente, no uno fijo.
    await press(await api.prefix())
    await press('x')
    // O aparece el confirm (proceso "trabajando") o el pane ya se fue: esperar a cualquiera de los dos.
    await waitFor(`!!document.querySelector('.overlay') || document.querySelectorAll('.pane').length !== ${before}`)
    if ((await snapshot()).overlay) {
      await confirmKillIfShell(api, isShell)
      await waitFor(`!document.querySelector('.overlay')`)
    }
    // Cerrar el último pane de un tab muestra otro tab: el conteo de panes no baja, el de tabs sí.
    if (process.env.E2E_DEBUG) console.log('      closePanes', JSON.stringify({ title, before, tabsBefore, after: await snapshot(), overlay: await evaluate(`document.querySelector('.overlay')?.textContent?.slice(0, 40) ?? null`) }))
    const ok = await waitFor(`document.querySelectorAll('.pane').length === ${before - 1} || document.querySelectorAll('.tabs .tab:not(.tab--action)').length < ${tabsBefore}`)
    if (!ok) throw new Error(`closePanes: el pane "${title}" no se cerró`)
    await sleep(200)
  }
}

/** Es un shell (no un agente del usuario) a juzgar por su título. */
export const isShellTitle = (title) => /@|Terminal|zsh|bash|omni-e2e/.test(title)

/** Con el confirm de matar abierto: ⏎ solo si la víctima es un shell; si no, Esc y error. */
export async function confirmKillIfShell(api, knownShell = false) {
  const { press, evaluate } = api
  const victim = await evaluate(`document.querySelector('.picker__title')?.textContent ?? ''`)
  if (!knownShell && !isShellTitle(victim)) {
    await press('escape')
    throw new Error(`confirm de matar sobre "${victim}": no es un shell, cancelado`)
  }
  await press('enter')
}

/** Guarda de arranque: el foco debe estar en una terminal o en la lista sin overlay, y nada debe cambiar sin que lo haga el test. */
export async function assertQuiet(api) {
  const a = await api.snapshot()
  await api.sleep(1500)
  const b = await api.snapshot()
  if (a.overlay || b.overlay) throw new Error('hay un overlay abierto: ¿alguien está usando la app?')
  if (a.panes !== b.panes || a.tabs !== b.tabs) throw new Error('la app cambió sola en 1.5 s: ¿alguien está usando la app? No se corre el escenario')
}

/** Split con una terminal: prefijo + el atajo vigente del split (`|` por defecto) abre el launcher con destino y ⏎ elige "Nueva terminal". */
export async function splitShell(api, command = 'pane.split.right') {
  const { press, waitFor, snapshot, sleep } = api
  const before = (await snapshot()).panes
  await press(await api.prefix())
  await press(await chordFor(api, command, 'terminal'))
  if (!(await waitFor(`!!document.querySelector('.overlay')`))) throw new Error('el split no abrió el launcher')
  await api.type('Nueva terminal')
  await sleep(120)
  await press('enter')
  if (!(await waitFor(`document.querySelectorAll('.pane').length === ${before + 1}`))) throw new Error('el split no creó el pane')
  await sleep(300)
}
