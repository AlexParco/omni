// "Terminó" con omni en segundo plano (§3.14): el pane de la sesión está en pantalla y con el foco, el
// usuario se va a otra app y el agente termina. Antes, cada salida marcaba el pane como visto aunque la
// ventana no fuera la activa, la sesión nunca quedaba "sin leer" y no salía la notificación. El harness
// emula el foco del documento, así que la ventana en segundo plano se simula como lo avisa main
// (`window:focus(false)` → `ui.windowFocused`).
const SESSIONS = `import('/src/store/sessions.ts')`
const UI = `import('/src/store/ui.ts')`

export default async function (api, t) {
  const { evaluate, sleep, waitFor } = api
  const shell = await evaluate(`${SESSIONS}.then(async (m) => { const info = await m.useSessions.getState().create('shell'); (await import('/src/store/layout.ts')).useLayout.getState().openTab(info.workspaceId, info.id); return info })`)
  const unread = `${SESSIONS}.then((m) => m.useSessions.getState().unread[${JSON.stringify(shell.id)}] === true)`
  const write = (text) => evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, ${JSON.stringify(text)})`)
  try {
    // Partir con la ventana "al frente" aunque el usuario esté en otra app (main avisa los blur reales).
    await evaluate(`${UI}.then((m) => m.useUi.getState().setWindowFocused(true))`)
    await sleep(1500)
    const onScreen = await evaluate(`${SESSIONS}.then((s) => import('/src/store/layout.ts').then((l) => l.focusedSessionId(l.useLayout.getState(), s.useSessions.getState().currentWorkspaceId)))`)
    t.check('la terminal de prueba está en pantalla y con el foco', onScreen === shell.id, JSON.stringify({ onScreen, shell: shell.id }))

    // Con la ventana activa, terminar no deja "sin leer": el usuario lo está viendo.
    await write('sleep 1; echo listo-1\r')
    await sleep(6500)
    t.check('con la ventana activa no queda sin leer', !(await evaluate(unread)))

    // La ventana pasa a segundo plano. Un redibujo instantáneo (lo que hace Claude Code al perder el foco)
    // no es trabajo: no deja "sin leer" ni dispara "terminó" (bug de notificaciones sin fin).
    await evaluate(`${UI}.then((m) => m.useUi.getState().setWindowFocused(false))`)
    await write('printf "\\033[2Jredibujo\\n"\r')
    await sleep(6000)
    t.check('en segundo plano, un redibujo instantáneo no queda sin leer', !(await evaluate(unread)))

    // Trabajo de verdad (más de MIN_WORK_MS de salida) que termina en segundo plano.
    await write('echo empieza; sleep 2; echo listo-2\r')
    t.check('en segundo plano, al terminar queda sin leer (dispara "terminó")', await waitFor(unread, 9000))

    // Al volver a la ventana, el pane en pantalla cuenta como visto y el aviso se retira.
    await evaluate(`${UI}.then((m) => m.useUi.getState().setWindowFocused(true))`)
    t.check('al volver a omni se marca visto', await waitFor(`${SESSIONS}.then((m) => m.useSessions.getState().unread[${JSON.stringify(shell.id)}] !== true)`, 2000))

    // Texto del aviso con una pantalla como la de Claude Code: lo que dijo el agente, no su barra de
    // estado (`-- INSERT -- ⏵⏵ auto mode on…`), y el proyecto como subtítulo.
    await write("clear; printf '⏺ Update(src/app.ts)\\n  ⎿  Updated src/app.ts\\n⏺ Listo: agregué la validación y los tests pasan.\\n╭────────╮\\n│ >      │\\n╰────────╯\\n  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)\\n'\r")
    await waitFor(`import('/src/panes/terminal/terminal-host.ts').then((m) => (m.screenLines(${JSON.stringify(shell.id)}, 80) ?? []).some((l) => l.startsWith('⏺ Listo')))`, 5000)
    const text = await evaluate(`(async () => {
      const { notifyBody, notifyPlace } = await import('/src/store/notify.ts')
      const { screenLines } = await import('/src/panes/terminal/terminal-host.ts')
      const s = (await ${SESSIONS}).useSessions.getState()
      const session = s.sessions.find((x) => x.id === ${JSON.stringify(shell.id)})
      const project = s.projects.find((p) => p.id === s.workspaces.find((w) => w.id === session.workspaceId)?.projectId)?.name
      return { body: notifyBody('claude', '', screenLines(session.id, 80)), place: notifyPlace(s, session.workspaceId), project }
    })()`)
    t.check('el cuerpo es lo que dijo el agente', text.body === 'Listo: agregué la validación y los tests pasan.', JSON.stringify(text))
    t.check('el subtítulo es el proyecto', text.place !== '' && text.place === text.project, JSON.stringify(text))
  } finally {
    await evaluate(`${UI}.then((m) => m.useUi.getState().setWindowFocused(true))`)
    await evaluate(`${SESSIONS}.then((m) => m.useSessions.getState().kill(${JSON.stringify(shell.id)}))`)
    await sleep(300)
  }
}
