// Widget Puertos (§3.24) contra la app viva: dos servidores de prueba, uno levantado fuera de omni y otro
// desde un shell de omni. Se ven con su puerto y nombre; el de omni con el badge de su terminal. Se miden
// las columnas, se filtra, ⏎ abre (y reusa) el navegador, G entra a la terminal y X X detiene el servidor
// sin tocar el shell que lo lanzó. Los atajos del usuario no se asumen: el widget se abre por comando.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = '/tmp/omni-e2e-ports'
const SERVER = join(DIR, 'server.mjs')
const PORTS = `import('/src/store/ports.ts')`
const SESSIONS = `import('/src/store/sessions.ts')`
const run = (id) => `import('/src/core/commands/registry.ts').then((m) => m.commands.run(${JSON.stringify(id)}))`

const SOURCE = `import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>hola puertos</title><h1>hola puertos</h1>') })
server.listen(0, '127.0.0.1', () => { const port = server.address().port; console.log('  ➜  Local:   \\x1b[36mhttp://localhost:' + port + '/app/\\x1b[39m'); writeFileSync(process.argv[2], String(port)) })
`

/** Espera a que el servidor escriba su puerto en `file`. */
async function portFrom(file, sleep) {
  for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(50)
  return Number(readFileSync(file, 'utf8'))
}

export default async function (api, t) {
  const { evaluate, press, type, sleep, waitFor } = api
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  writeFileSync(SERVER, SOURCE)

  // A: fuera de omni (hijo de este proceso), en una carpeta: cuenta como servicio sin terminal de omni.
  const outside = spawn(process.execPath, [SERVER, join(DIR, 'a.port')], { cwd: DIR, stdio: 'ignore' })
  const portA = await portFrom(join(DIR, 'a.port'), sleep)

  // B: desde un shell de omni.
  // El shell se crea por el store (no con ⌘T): si la página de un navegador tiene el teclado, ⌘T le llega a ella.
  const shell = await evaluate(`${SESSIONS}.then(async (m) => { const info = await m.useSessions.getState().create('shell'); (await import('/src/store/layout.ts')).useLayout.getState().openTab(info.workspaceId, info.id); return info })`)
  await sleep(600)
  await evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, ${JSON.stringify(`cd ${DIR} && node server.mjs b.port\r`)})`)
  const portB = await portFrom(join(DIR, 'b.port'), sleep)
  const browsersBefore = await evaluate(`${SESSIONS}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'browser').map((x) => x.id))`)
  let opened = null

  try {
    await evaluate(run('ports.toggle'))
    t.check('el widget abre', await waitFor(`!!document.querySelector('.ports')`))
    const rowOf = (port) => `[...document.querySelectorAll('.ports .row')].find((r) => r.querySelector('.ports__port')?.textContent === '${port}')`
    t.check('aparecen los dos servidores', await waitFor(`!!(${rowOf(portA)}) && !!(${rowOf(portB)})`, 6000))
    await waitFor(`document.querySelector('.ports')?.getAnimations().length === 0`, 2000)

    const rows = await evaluate(`${PORTS}.then((m) => m.usePorts.getState().list.filter((p) => [${portA}, ${portB}].includes(p.ports[0])).map((p) => ({ port: p.ports[0], name: p.name, sessionId: p.sessionId, kind: p.kind })))`)
    const a = rows.find((r) => r.port === portA)
    const b = rows.find((r) => r.port === portB)
    t.check('el de fuera es un servicio sin terminal de omni', a?.kind === 'dev' && a.sessionId === null && a.name === 'node server.mjs', JSON.stringify(a))
    t.check('el del shell sabe de qué sesión salió', b?.sessionId === shell.id && b.name === 'node server.mjs', JSON.stringify(b))

    await evaluate(`${PORTS}.then((m) => m.usePorts.getState().setCursor(String(m.usePorts.getState().list.find((p) => p.ports[0] === ${portA}).pid)))`)
    await api.parkMouse()
    await sleep(120)
    const m = await evaluate(`(() => {
      const card = document.querySelector('.ports').getBoundingClientRect()
      const x = (el) => (el ? Math.round(el.getBoundingClientRect().x - card.x) : null)
      const rows = [...document.querySelectorAll('.ports .row')]
      const a = ${rowOf(portA)}
      const b = ${rowOf(portB)}
      return {
        title: document.querySelector('.widget__title')?.firstChild?.textContent,
        count: Number(document.querySelector('.widget__value')?.textContent),
        portX: new Set(rows.map((r) => x(r.querySelector('.ports__port')))).size,
        labelX: new Set(rows.map((r) => x(r.querySelector('.row__label')))).size,
        filterIconX: x(document.querySelector('.ports__filter svg')),
        firstPortX: x(rows[0]?.querySelector('.ports__port')),
        badgeB: b?.querySelector('.row__end .badge')?.textContent ?? null,
        badgeA: a?.querySelector('.row__end .badge')?.textContent ?? null,
        cursorActions: [...(a?.querySelectorAll('.row__actions button') ?? [])].map((x) => x.getAttribute('aria-label')),
        othersHidden: rows.filter((r) => !r.hasAttribute('data-cursor')).every((r) => getComputedStyle(r.querySelector('.row__actions')).display === 'none'),
        overflow: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length,
        overlaps: rows.slice(1).filter((r, i) => r.getBoundingClientRect().top < rows[i].getBoundingClientRect().bottom - 0.5).length,
        clipped: rows.filter((r) => r.scrollHeight > r.clientHeight + 1).length,
        twoLineHeight: Math.round((${rowOf(portA)})?.getBoundingClientRect().height ?? 0),
        secondA: a?.querySelectorAll('.row__line')[1]?.textContent ?? null,
        foot: [...document.querySelectorAll('.widget__foot .hint')].map((h) => h.textContent.trim()),
        footLines: new Set([...document.querySelectorAll('.widget__foot .hint')].map((h) => Math.round(h.getBoundingClientRect().top))).size,
        bordered: [...document.querySelectorAll('.ports button')].filter((b) => parseFloat(getComputedStyle(b).borderTopWidth) > 0).length,
        sidebar: [...document.querySelectorAll('.sidebar .nav-item')].find((n) => /Puertos/.test(n.textContent))?.textContent ?? null
      }
    })()`)
    const dump = JSON.stringify(m)
    t.check('cabecera: Puertos y el conteo de servicios', m.title?.trim() === 'Puertos' && m.count >= 2, dump)
    t.check('puertos y nombres en una sola columna cada uno', m.portX === 1 && m.labelX === 1, dump)
    t.check('la lupa del filtro cae en la columna de los puertos', m.filterIconX === m.firstPortX, dump)
    t.check('el del shell lleva el badge de su terminal; el de fuera no', !!m.badgeB && m.badgeA === null, dump)
    t.check('la fila con cursor muestra abrir, copiar y detener; las demás esconden sus acciones', m.cursorActions.length === 3 && /Abrir/.test(m.cursorActions[0]) && m.othersHidden, dump)
    t.check('ninguna fila se desborda ni pisa a la siguiente; la de dos líneas mide 57', m.overflow === 0 && m.overlaps === 0 && m.clipped === 0 && m.twoLineHeight === 57, dump)
    t.check('la segunda línea dice dónde corre', /omni-e2e-ports/.test(m.secondA ?? ''), dump)
    t.check('pie de atajos en una línea, sin bordes en botones', m.footLines === 1 && m.bordered === 0 && m.foot.length === 4, dump)
    t.check('el sidebar tiene Puertos con su conteo', /Puertos\s*\d+/.test(m.sidebar ?? ''), dump)

    // Como el "Active Workspace" de Orca: el del shell (workspace actual) va arriba bajo "En <proyecto>".
    const groupsOrder = await evaluate(`[...document.querySelectorAll('.ports__list > *')].map((el) => el.classList.contains('ports__group') ? 'G:' + el.querySelector('.ports__group-name').textContent : el.querySelector('.ports__port')?.textContent).filter(Boolean)`)
    const hereAt = groupsOrder.findIndex((x) => /^G:En /.test(x))
    const projectName = await evaluate(`${SESSIONS}.then((m) => { const s = m.useSessions.getState(); const w = s.workspaces.find((x) => x.id === s.currentWorkspaceId); return s.projects.find((p) => p.id === w.projectId).name })`)
    t.check('el servicio del proyecto actual va arriba, bajo En <proyecto>', hereAt === 0 && groupsOrder[0] === `G:En ${projectName}` && groupsOrder.indexOf(String(portB)) > hereAt && groupsOrder.indexOf(String(portB)) < groupsOrder.findIndex((x, i) => i > 0 && /^G:/.test(x)), JSON.stringify(groupsOrder.slice(0, 8)))

    // C copia la URL que el servidor anunció en su terminal (con su ruta), no la adivinada.
    await evaluate(`${PORTS}.then((m) => m.usePorts.getState().setCursor(String(m.usePorts.getState().list.find((p) => p.ports[0] === ${portB}).pid)))`)
    await sleep(80)
    await press('c')
    await waitFor(`/Copiado/.test(document.querySelector('.ports__notice')?.textContent ?? '')`, 3000)
    const copied = await evaluate(`document.querySelector('.ports__notice')?.textContent ?? ''`)
    t.check('C copia la URL anunciada en la terminal', copied === `Copiado http://localhost:${portB}/app/`, copied)

    // Filtrar por el puerto: con / el teclado va al campo y solo queda esa fila.
    await press('/')
    await type(String(portA))
    await sleep(150)
    const filtered = await evaluate(`[...document.querySelectorAll('.ports .row .ports__port')].map((p) => p.textContent)`)
    t.check('/ filtra por puerto', filtered.length === 1 && filtered[0] === String(portA), JSON.stringify(filtered))
    await press('escape')
    await sleep(100)
    t.check('Esc desde el filtro vuelve a la lista sin cerrar', (await evaluate(`!!document.querySelector('.ports') && document.activeElement?.classList.contains('ports')`)) === true)
    await evaluate(`${PORTS}.then((m) => m.usePorts.getState().setQuery(''))`)

    if (process.env.E2E_SHOTS) {
      await evaluate(`${PORTS}.then((m) => m.usePorts.getState().setCursor(String(m.usePorts.getState().list.find((p) => p.ports[0] === ${portB}).pid)))`)
      await api.parkMouse()
      await sleep(200)
      await api.screenshot(join(process.env.E2E_SHOTS, 'ports-widget.png'))
    }

    // G: entra a la terminal que levantó B.
    await evaluate(`${PORTS}.then((m) => m.usePorts.getState().setCursor(String(m.usePorts.getState().list.find((p) => p.ports[0] === ${portB}).pid)))`)
    await sleep(80)
    await press('g')
    await sleep(250)
    const focusedTerm = await evaluate(`(() => ({ overlay: !!document.querySelector('.ports'), term: document.activeElement?.classList.contains('xterm-helper-textarea') ?? false }))()`)
    const layoutFocus = await evaluate(`import('/src/store/layout.ts').then((l) => import('/src/store/sessions.ts').then((s) => l.focusedSessionId(l.useLayout.getState(), s.useSessions.getState().currentWorkspaceId)))`)
    t.check('G cierra el widget y entra a la terminal que lo levantó', !focusedTerm.overlay && focusedTerm.term && layoutFocus === shell.id, JSON.stringify({ ...focusedTerm, layoutFocus, shell: shell.id }))

    // ⏎: abre A en un navegador de omni y espera la página.
    await evaluate(run('ports.toggle'))
    await waitFor(`!!document.querySelector('.ports')`)
    await evaluate(`${PORTS}.then((m) => m.usePorts.getState().setCursor(String(m.usePorts.getState().list.find((p) => p.ports[0] === ${portA}).pid)))`)
    await sleep(80)
    await press('enter')
    const newBrowser = `${SESSIONS}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'browser' && !${JSON.stringify(browsersBefore)}.includes(x.id)).map((x) => x.id))`
    t.check('⏎ abre un navegador de omni', await waitFor(`${newBrowser}.then((ids) => ids.length === 1)`, 5000))
    opened = (await evaluate(newBrowser))[0]
    const loaded = await waitFor(`import('/src/store/browser.ts').then((m) => { const s = m.useBrowser.getState().states[${JSON.stringify(opened)}]; return !!s && s.url.includes(':${portA}') && /hola puertos/.test(s.title ?? '') })`, 8000)
    t.check('el navegador carga el servicio en localhost', loaded, JSON.stringify(await evaluate(`import('/src/store/browser.ts').then((m) => m.useBrowser.getState().states[${JSON.stringify(opened)}])`)))

    await evaluate(run('ports.toggle'))
    await waitFor(`!!document.querySelector('.ports')`)
    await evaluate(`${PORTS}.then((m) => m.usePorts.getState().setCursor(String(m.usePorts.getState().list.find((p) => p.ports[0] === ${portA}).pid)))`)
    await sleep(80)
    await press('enter')
    await sleep(500)
    t.check('⏎ otra vez reusa ese navegador en vez de abrir otro', (await evaluate(newBrowser)).length === 1 && !(await evaluate(`!!document.querySelector('.ports')`)))

    // X X: detiene B; el shell que lo lanzó sigue vivo.
    await evaluate(run('ports.toggle'))
    await waitFor(`!!document.querySelector('.ports')`)
    await evaluate(`${PORTS}.then((m) => m.usePorts.getState().setCursor(String(m.usePorts.getState().list.find((p) => p.ports[0] === ${portB}).pid)))`)
    await sleep(80)
    await press('x')
    await sleep(120)
    const armed = await evaluate(`(${rowOf(portB)})?.textContent ?? ''`)
    t.check('la primera X pide confirmar en la fila', /X otra vez para detener/.test(armed), armed)
    await press('x')
    t.check('la segunda X detiene el servidor y la fila se va', await waitFor(`!(${rowOf(portB)})`, 6000))
    const notice = await evaluate(`document.querySelector('.ports__notice')?.textContent ?? ''`)
    t.check('el pie avisa qué se detuvo', new RegExp(`Detenido :${portB}`).test(notice), notice)
    t.check('el shell que lo lanzó sigue vivo', await evaluate(`${SESSIONS}.then((m) => m.useSessions.getState().sessions.some((x) => x.id === ${JSON.stringify(shell.id)}))`))
    await press('escape')
    t.check('Esc cierra el widget', await waitFor(`!document.querySelector('.ports')`))
  } finally {
    outside.kill()
    await evaluate(`import('/src/store/ui.ts').then((m) => m.useUi.getState().overlay === 'ports' && m.useUi.getState().closeOverlay())`)
    for (const id of [opened, shell.id].filter(Boolean)) await evaluate(`${SESSIONS}.then((m) => m.useSessions.getState().kill(${JSON.stringify(id)}))`)
    await sleep(300)
    rmSync(DIR, { recursive: true, force: true })
  }
}
