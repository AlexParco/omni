// Ajustes → Notificaciones (§3.14): dos interruptores (pregunta, termina) que escriben
// `settings.notifications` (all / questions / done / off) y "Probar", que pide a main un aviso de
// ejemplo y dice el resultado. Se mide que los interruptores se alineen con el resto de controles.
const SETTINGS = `import('/src/store/settings.ts')`
const current = `${SETTINGS}.then((m) => m.useSettings.getState().settings.notifications)`
const ASK = 'Avisar cuando un agente pregunta'
const DONE = 'Avisar cuando un agente termina'
const sw = (label) => `document.querySelector('[role="switch"][aria-label="${label}"]')`

export default async function (api, t) {
  const { evaluate, sleep, waitFor, press } = api
  const original = await evaluate(current)
  const set = (v) => evaluate(`${SETTINGS}.then((m) => m.useSettings.getState().update({ notifications: '${v}' }))`)
  try {
    await set('all')
    await evaluate(`import('/src/core/commands/registry.ts').then((m) => m.commands.run('settings.open'))`)
    t.check('Ajustes abre con los dos interruptores', await waitFor(`!!${sw(ASK)} && !!${sw(DONE)}`))
    await evaluate(`${sw(DONE)}.scrollIntoView({ block: 'center' })`)
    await sleep(200)

    const state = () => evaluate(`[${sw(ASK)}.getAttribute('aria-checked'), ${sw(DONE)}.getAttribute('aria-checked')].join(',')`)
    t.check('con "all" los dos encendidos', (await state()) === 'true,true', await state())

    // Clic: apagar "termina" → questions; apagar "pregunta" → off; encender "termina" → done.
    await evaluate(`${sw(DONE)}.click()`)
    t.check('apagar "termina" deja solo preguntas', await waitFor(`${current}.then((v) => v === 'questions')`), await evaluate(current))
    await evaluate(`${sw(ASK)}.click()`)
    t.check('apagar también "pregunta" deja off', await waitFor(`${current}.then((v) => v === 'off')`), await evaluate(current))
    await evaluate(`${sw(DONE)}.click()`)
    t.check('encender solo "termina" deja done', await waitFor(`${current}.then((v) => v === 'done')`), await evaluate(current))
    t.check('los interruptores reflejan done', (await state()) === 'false,true', await state())

    // Teclado: con el foco en el interruptor, Espacio lo cambia.
    await evaluate(`${sw(ASK)}.focus()`)
    await press('space')
    t.check('Espacio enciende "pregunta" (all)', await waitFor(`${current}.then((v) => v === 'all')`), await evaluate(current))

    // Medidas: 32 × 18, centrados con su etiqueta y con el borde derecho alineado al de los selects.
    const m = await evaluate(`(() => {
      const r = (el) => el.getBoundingClientRect()
      const s = r(${sw(ASK)}), d = r(${sw(DONE)})
      const sel = document.querySelector('[aria-label="Velocidad del scroll de la terminal"]')
      const selR = r(sel.closest('.select') ?? sel)
      const field = ${sw(ASK)}.closest('.field'), label = r(field.querySelector('.field__label')), text = r(field.querySelector('.field__text'))
      const btn = [...document.querySelectorAll('.field')].find((f) => f.textContent.includes('Probar notificación'))?.querySelector('button')
      return { w: Math.round(s.width), h: Math.round(s.height), right: Math.round(s.right), dRight: Math.round(d.right), selRight: Math.round(selR.right), centerGap: Math.abs((s.top + s.height / 2) - (text.top + text.height / 2)), btnRight: btn ? Math.round(r(btn).right) : null, labelTop: Math.round(label.top) }
    })()`)
    const dump = JSON.stringify(m)
    t.check('interruptor de 32 × 18', m.w === 32 && m.h === 18, dump)
    t.check('alineados a la derecha con los selects y el botón', m.right === m.selRight && m.dRight === m.selRight && m.btnRight === m.selRight, dump)
    t.check('centrados con el texto de su fila', m.centerGap <= 1, dump)

    // Probar: en dev Electron no está registrado en macOS; lo que importa es que responde con un texto útil.
    const before = await evaluate(`[...document.querySelectorAll('.field')].find((f) => f.textContent.includes('Probar notificación')).querySelector('.field__desc').textContent`)
    await evaluate(`[...document.querySelectorAll('.field')].find((f) => f.textContent.includes('Probar notificación')).querySelector('button').click()`)
    const after = `[...document.querySelectorAll('.field')].find((f) => f.textContent.includes('Probar notificación')).querySelector('.field__desc').textContent`
    t.check('Probar responde con el resultado y dónde activarlo', await waitFor(`${after}.includes('Ajustes del Sistema')`, 6000), `${before} → ${await evaluate(after)}`)

    if (process.env.E2E_SHOTS) {
      await api.parkMouse()
      await api.screenshot(`${process.env.E2E_SHOTS}/settings-notifications.png`)
    }
    await press('escape')
  } finally {
    await set(original)
  }
}
