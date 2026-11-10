// Subcarpetas, proyectos ocultos, abrir proyecto por ruta, proyectos de 0/1/varias ubicaciones y ancho
// del sidebar (ARCHITECTURE §3.5c, §3.11). Arma un monorepo de prueba en el home (`~/.omni-e2e-<pid>`),
// lo abre escribiendo la ruta en el quick open, registra `apps/web` como carpeta, lanza una terminal ahí,
// lo oculta y lo vuelve a mostrar; luego crea un proyecto vacío con "Nuevo proyecto", le suma dos
// ubicaciones, las mueve y las quita; y arrastra el borde del sidebar. Al final quita los proyectos y
// borra la carpeta: la app queda como estaba.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertQuiet, closePanes, ensurePane } from './_helpers.mjs'

const MOD = { sessions: `import('/src/store/sessions.ts')`, ui: `import('/src/store/ui.ts')`, cmd: `import('/src/core/commands/registry.ts')`, hosts: `import('/src/store/hosts.ts')` }
const SHOTS = process.env.E2E_SHOTS ?? null

export default async function (api, t) {
  const { evaluate, press, type, sleep, waitFor, click, cdp } = api
  await assertQuiet(api)

  const dirName = `.omni-e2e-${process.pid}`
  const root = join(homedir(), dirName, 'mono')
  for (const d of ['apps/web/src', 'apps/docs', 'api', 'node_modules/x']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, 'apps/web/package.json'), '{}')
  writeFileSync(join(root, 'api/go.mod'), 'module api')
  const run = (id) => evaluate(`${MOD.cmd}.then((m) => m.commands.run(${JSON.stringify(id)}))`)
  // `folders`: las ubicaciones del proyecto que no son la raíz del monorepo.
  const state = () => evaluate(`${MOD.sessions}.then((m) => { const s = m.useSessions.getState(); const p = s.projects.find((x) => x.locations.some((l) => l.path === ${JSON.stringify(root)})); return { project: p ? { id: p.id, hidden: !!p.hidden } : null, current: s.workspaces.find((w) => w.id === s.currentWorkspaceId) ?? null, kinds: s.workspaces.filter((w) => w.projectId === p?.id).map((w) => w.kind), folders: s.workspaces.filter((w) => w.projectId === p?.id && w.kind === 'folder' && w.path !== ${JSON.stringify(root)}).map((w) => ({ id: w.id, name: w.name, path: w.path })) } })`)
  // Por la ruta (va en el title de la fila): puede haber otro proyecto que también se llame `mono`.
  const rowOf = `[...document.querySelectorAll('.sidebar .row[data-level="0"]')].find((r) => (r.getAttribute('title') ?? '').includes(${JSON.stringify(`${dirName}/mono `)}))`

  try {
    // A. Abrir por ruta desde el quick open: ~/… sugiere carpetas, Tab completa, ⏎ abre como proyecto.
    await press('cmd+k')
    t.check('el quick open se abre', await waitFor(`!!document.querySelector('.quickopen')`))
    await type(`~/${dirName}/mo`)
    t.check('una ruta lista la carpeta en el grupo Carpetas', await waitFor(`[...document.querySelectorAll('.quickopen__list [role=group]')].some((g) => g.getAttribute('aria-label') === 'Carpetas' && g.textContent.includes('mono'))`, 3000), await evaluate(`document.querySelector('.quickopen__list')?.textContent`))
    t.check('con una ruta no se listan comandos ni agentes', await evaluate(`[...document.querySelectorAll('.quickopen__list [role=group]')].every((g) => g.getAttribute('aria-label') === 'Carpetas')`))
    if (SHOTS) await api.screenshot(join(SHOTS, 'quickopen-path.png'))
    await press('tab')
    t.check('Tab completa la ruta con la carpeta', await waitFor(`document.querySelector('.quickopen input')?.value === ${JSON.stringify(`~/${dirName}/mono/`)}`), await evaluate(`document.querySelector('.quickopen input')?.value`))
    // Volver a la carpeta misma (sin la barra final): la sugerencia vuelve a ser `mono` y solo ella.
    await evaluate(`import('/src/store/quickopen.ts').then((m) => m.useQuickOpen.getState().setQuery(${JSON.stringify(`~/${dirName}/mono`)}))`)
    await waitFor(`document.querySelectorAll('.quickopen__list [role=option]').length === 1 && document.querySelector('.quickopen__list')?.textContent?.includes('mono')`)
    await press('enter')
    t.check('⏎ abre la carpeta como proyecto', await waitFor(`${MOD.sessions}.then((m) => m.useSessions.getState().projects.some((p) => p.locations[0]?.path === ${JSON.stringify(root)}))`, 4000))
    t.check('con una sola ubicación es `local`: sin fila propia', JSON.stringify((await state()).kinds) === '["local"]', JSON.stringify(await state()))
    t.check('el proyecto queda en el sidebar', await waitFor(`!!${rowOf}`))
    const s1 = await state()
    t.check('y es el workspace actual', s1.current?.path === root, JSON.stringify(s1.current))

    // B. Agregar carpeta: subproyectos primero, sin node_modules; elegir `apps/web`.
    await run('project.addFolder')
    t.check('el selector de carpetas se abre', await waitFor(`!!document.querySelector('.picker') && /Agregar subcarpeta de mono/.test(document.querySelector('.picker__input input')?.placeholder ?? '')`))
    await waitFor(`!document.querySelector('.picker')?.textContent?.includes('Buscando')`)
    const options = await evaluate(`[...document.querySelectorAll('.picker [role=option]')].map((o) => o.textContent)`)
    t.check('los subproyectos van primero con su manifiesto', /^api.*go\.mod/.test(options[0] ?? '') && /^apps\/web.*package\.json/.test(options[1] ?? ''), JSON.stringify(options))
    t.check('node_modules no se ofrece', !options.some((o) => o.includes('node_modules')), JSON.stringify(options))
    if (SHOTS) await api.screenshot(join(SHOTS, 'folder-picker.png'))
    await type('web')
    await sleep(150)
    await press('enter')
    t.check('la carpeta se registra', await waitFor(`${MOD.sessions}.then((m) => m.useSessions.getState().workspaces.some((w) => w.kind === 'folder' && w.path === ${JSON.stringify(join(root, 'apps/web'))}))`, 3000))
    const s2 = await state()
    const web = s2.folders[0]
    t.check('la subcarpeta pasa a ser el workspace actual', s2.current?.id === web?.id, JSON.stringify(s2.current))
    t.check('la fila de la carpeta se ve con su ruta relativa', await waitFor(`[...document.querySelectorAll('.sidebar .folder .row')].some((r) => r.querySelector('.row__label')?.textContent === 'web' && r.querySelector('.row__meta')?.textContent === 'apps/web')`))
    t.check('con dos ubicaciones las dos son `folder`', JSON.stringify(s2.kinds) === '["folder","folder"]', JSON.stringify(s2.kinds))
    t.check('la primera ubicación (mono) también tiene su fila, con la carpeta que la contiene', await waitFor(`[...document.querySelectorAll('.sidebar .folder .row')].some((r) => r.querySelector('.row__label')?.textContent === 'mono' && (r.querySelector('.row__meta')?.textContent ?? '').endsWith(${JSON.stringify(dirName)}))`), await evaluate(`[...document.querySelectorAll('.sidebar .folder > .row')].map((r) => r.textContent)`))

    // C. Una terminal lanzada ahí arranca en la subcarpeta.
    await ensurePane(api)
    const cwd = await evaluate(`${MOD.sessions}.then((m) => { const s = m.useSessions.getState(); return s.sessions.filter((x) => x.workspaceId === ${JSON.stringify(web?.id)}).map((x) => x.cwd) })`)
    t.check('la sesión nueva corre en apps/web', cwd.length === 1 && cwd[0] === join(root, 'apps/web'), JSON.stringify(cwd))

    // D. Layout del bloque proyecto → carpeta → tab, medido en el DOM.
    await press('escape')
    await sleep(200)
    const geo = await evaluate(`(() => {
      const group = ${rowOf}?.closest('.sidebar__group'); if (!group) return null
      const pick = (r) => { const b = r.getBoundingClientRect(); const l = r.querySelector('.row__label')?.getBoundingClientRect(); const d = r.querySelector('.row__end .dot')?.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), right: Math.round(b.right), textX: l ? Math.round(l.left) : null, dotRight: d ? Math.round(d.right) : null, scroll: r.scrollWidth - r.clientWidth } }
      const folders = [...group.querySelectorAll('.folder')]
      const webFolder = folders.find((f) => f.querySelector('.row__label')?.textContent === 'web')
      const inFolder = webFolder ? webFolder.querySelectorAll('[role=option]') : []
      return { project: pick(group.querySelector('.row[data-level="0"]')), locations: folders.map((f) => pick(f.querySelector('.row'))), folder: inFolder[0] ? pick(inFolder[0]) : null, tab: inFolder[1] ? pick(inFolder[1]) : null, sidebarRight: Math.round(document.querySelector('.sidebar').getBoundingClientRect().right) }
    })()`)
    t.check('las filas de ubicación arrancan en la misma columna', geo && geo.locations.length === 2 && geo.locations.every((l) => l.textX === geo.locations[0].textX), JSON.stringify(geo))
    t.check('ninguna ubicación se desborda', geo && geo.locations.every((l) => l.scroll <= 0 && l.right <= geo.sidebarRight), JSON.stringify(geo))
    t.check('la carpeta arranca a la derecha del proyecto', geo && geo.folder.textX > geo.project.textX, JSON.stringify(geo))
    t.check('el tab no arranca antes que la carpeta', geo && geo.tab && geo.tab.textX >= geo.folder.textX, JSON.stringify(geo))
    t.check('carpeta y tab no se pisan', geo && geo.tab && geo.tab.top >= geo.folder.bottom, JSON.stringify(geo))
    // Solo lleva punto la fila que tiene algo que mirar: la carpeta y el proyecto desplegado no repiten el de su tab.
    t.check('la carpeta y el proyecto desplegado no repiten el punto de su tab', geo && geo.folder.dotRight === null && geo.project.dotRight === null, JSON.stringify(geo))
    t.check('nada se desborda en la fila de la carpeta', geo && geo.folder.scroll <= 0 && geo.folder.right <= geo.sidebarRight, JSON.stringify(geo))
    if (SHOTS) await api.screenshot(join(SHOTS, 'folders-sidebar.png'))

    // E. Quitar la carpeta con una sesión viva: pide confirmar; Esc no toca nada, confirmar la cierra y la quita.
    await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().setCursor(m.rowKey.workspace(${JSON.stringify(web?.id)})))`)
    await run('project.removeFolder')
    t.check('con sesiones vivas pide confirmar', await waitFor(`/¿Quitar web del proyecto\?/.test(document.querySelector('.picker__title')?.textContent ?? '')`, 2000), await evaluate(`document.querySelector('.picker__title')?.textContent`))
    const confirmItems = await evaluate(`[...document.querySelectorAll('.picker [role=option]')].map((o) => o.textContent)`)
    t.check('la confirmación dice cuántas cierra', confirmItems[0]?.startsWith('Cerrar 1 sesión y quitar la carpeta'), JSON.stringify(confirmItems))
    if (SHOTS) await api.screenshot(join(SHOTS, 'confirm-remove-location.png'))
    await press('escape')
    await waitFor(`!document.querySelector('.overlay')`)
    t.check('Esc no quita nada', (await state()).folders.length === 1)
    await run('project.removeFolder')
    await waitFor(`!!document.querySelector('.picker')`)
    await press('enter')
    t.check('al confirmar se cierra la sesión y la carpeta se quita', await waitFor(`${MOD.sessions}.then((m) => !m.useSessions.getState().workspaces.some((w) => w.kind === 'folder' && w.projectId === ${JSON.stringify(s1.project?.id)}))`))
    t.check('y su sesión ya no está', await waitFor(`${MOD.sessions}.then((m) => !m.useSessions.getState().sessions.some((x) => x.workspaceId === ${JSON.stringify(web?.id)}))`, 3000))
    t.check('el destino vuelve al proyecto', (await state()).current?.path === root)
    t.check('con una sola ubicación otra vez compacto (local)', JSON.stringify((await state()).kinds) === '["local"]', JSON.stringify(await state()))

    // F. Ocultar: sale del sidebar y de pantalla; ⇧⌘H lo muestra con su marca; otra vez lo esconde.
    await run('project.hide')
    t.check('ocultar lo saca del sidebar', await waitFor(`!${rowOf}`))
    t.check('y la flota deja de mostrarlo', (await state()).current?.path !== root)
    await press('cmd+shift+h')
    t.check('⇧⌘H lo vuelve a mostrar', await waitFor(`!!${rowOf}`))
    t.check('con la marca de oculto', await evaluate(`!!${rowOf}?.querySelector('.sidebar__hidden-mark')`))
    t.check('y el botón para volver a esconderlos', await evaluate(`!!document.querySelector('.sidebar__section [aria-label="Volver a esconder los ocultos"]')`))
    if (SHOTS) await api.screenshot(join(SHOTS, 'hidden-shown.png'))
    await press('cmd+shift+h')
    t.check('⇧⌘H otra vez lo esconde', await waitFor(`!${rowOf}`))
    const persisted = await evaluate(`window.omni.invoke('project:list').then((r) => r.projects.find((p) => p.locations[0]?.path === ${JSON.stringify(root)})?.hidden === true)`)
    t.check('main guarda el oculto', persisted)

    // H. "Nuevo proyecto": solo un nombre; vacío muestra una pista; luego 1 y 2 ubicaciones, moverlas y quitarlas.
    const pathA = join(homedir(), dirName, 'grupo-a')
    const pathB = join(homedir(), dirName, 'grupo-b')
    mkdirSync(pathA, { recursive: true })
    mkdirSync(pathB, { recursive: true })
    await run('project.new')
    t.check('el diálogo Nuevo proyecto se abre', await waitFor(`document.querySelector('.dialog')?.textContent.includes('Nuevo proyecto') && document.activeElement === document.querySelector('.hosts-dialog input')`, 3000))
    await type('Grupo e2e')
    await sleep(100)
    if (SHOTS) await api.screenshot(join(SHOTS, 'project-new.png'))
    await press('enter')
    t.check('crear no abre nada más: el proyecto queda vacío', await waitFor(`!document.querySelector('.overlay')`, 3000))
    const group = await evaluate(`${MOD.sessions}.then((m) => { const s = m.useSessions.getState(); const p = s.projects.find((x) => x.name === 'Grupo e2e'); return p ? { id: p.id, locations: p.locations.length, cursor: s.cursor, current: s.currentWorkspaceId } : null })`)
    t.check('el proyecto queda vacío, bajo el cursor y sin workspace actual', group && group.locations === 0 && group.cursor === `p:${group.id}` && group.current === null, JSON.stringify(group))
    const groupRow = `document.getElementById('row-p-${group?.id}')`
    t.check('el sidebar muestra la pista Sin carpetas', await waitFor(`${groupRow}?.closest('.sidebar__group')?.querySelector('.sidebar__hint')?.textContent.includes('Sin carpetas')`, 2000), await evaluate(`${groupRow}?.closest('.sidebar__group')?.textContent`))
    const hintGeo = await evaluate(`(() => { const g = ${groupRow}?.closest('.sidebar__group'); const h = g?.querySelector('.sidebar__hint')?.getBoundingClientRect(); const l = ${groupRow}?.querySelector('.row__label')?.getBoundingClientRect(); const sb = document.querySelector('.sidebar').getBoundingClientRect(); return h && l ? { hintX: Math.round(h.left), labelX: Math.round(l.left), right: Math.round(h.right), sbRight: Math.round(sb.right), top: Math.round(h.top), rowBottom: Math.round(${groupRow}.getBoundingClientRect().bottom) } : null })()`)
    t.check('la pista va debajo de la cabecera, sin desbordar', hintGeo && hintGeo.top >= hintGeo.rowBottom && hintGeo.right <= hintGeo.sbRight, JSON.stringify(hintGeo))
    t.check('la vista principal ofrece Agregar carpeta', await evaluate(`[...document.querySelectorAll('.main .btn, .main button')].some((b) => b.textContent.includes('Agregar carpeta'))`))
    if (SHOTS) await api.screenshot(join(SHOTS, 'project-empty.png'))
    await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().setFocus('list'))`)
    const sessionsBefore = await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().sessions.length)`)
    await press('n')
    t.check('N en un proyecto vacío avisa en vez de lanzar', await waitFor(`/no tiene carpetas/.test(document.body.textContent)`, 2000) && !(await evaluate(`!!document.querySelector('.overlay')`)), await evaluate(`document.querySelector('.overlay')?.textContent ?? ''`))
    t.check('y no crea ninguna sesión', (await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().sessions.length)`)) === sessionsBefore)

    const addLocation = (path) => evaluate(`${MOD.hosts}.then(async (m) => { const h = m.useHosts.getState(); h.startLocation({ mode: 'addTo', projectId: ${JSON.stringify(group?.id)} }); h.choosePlace({ host: null }); const w = await m.useHosts.getState().finishLocation(${JSON.stringify(path)}); m.useHosts.setState({ target: null, place: null }); (await ${MOD.ui}).useUi.getState().closeOverlay(); return w })`)
    const wsA = await addLocation(pathA)
    t.check('con una ubicación es `local` y la cabecera la representa', wsA?.kind === 'local' && (await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().cursor)`)) === `p:${group?.id}`, JSON.stringify(wsA))
    await ensurePane(api)
    const tabA = await evaluate(`import('/src/store/layout.ts').then((m) => m.useLayout.getState().tabs.find((t) => t.workspaceId === ${JSON.stringify(wsA?.id)})?.id ?? null)`)
    t.check('el tab cuelga directo del proyecto (sin fila de ubicación)', await waitFor(`(() => { const r = document.getElementById('row-t-${tabA}'); return !!r && !r.closest('.folder') && r.closest('.sidebar__group') === ${groupRow}?.closest('.sidebar__group') })()`, 2000))
    const wsB = await addLocation(pathB)
    t.check('con dos ubicaciones las dos son `folder`', await waitFor(`${MOD.sessions}.then((m) => m.useSessions.getState().workspaces.filter((w) => w.projectId === ${JSON.stringify(group?.id)}).map((w) => w.kind).join() === 'folder,folder')`, 2000))
    t.check('el tab de la primera se muda bajo su propia fila', await waitFor(`document.getElementById('row-t-${tabA}')?.closest('.folder')?.querySelector('.row__label')?.textContent === 'grupo-a'`, 2000), await evaluate(`${groupRow}?.closest('.sidebar__group')?.innerHTML.slice(0, 400)`))
    await sleep(200)
    const gGeo = await evaluate(`(() => {
      const g = ${groupRow}?.closest('.sidebar__group'); if (!g) return null
      const sb = document.querySelector('.sidebar').getBoundingClientRect()
      const pick = (r) => { const b = r.getBoundingClientRect(); const l = r.querySelector('.row__label')?.getBoundingClientRect(); const d = r.querySelector('.row__end .dot')?.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), right: Math.round(b.right), textX: l ? Math.round(l.left) : null, dotRight: d ? Math.round(d.right) : null, scroll: r.scrollWidth - r.clientWidth } }
      const folders = [...g.querySelectorAll('.folder')]
      return { header: pick(g.querySelector('.row[data-level="0"]')), locations: folders.map((f) => pick(f.querySelector('.row'))), tab: pick(document.getElementById('row-t-${tabA}')), sbRight: Math.round(sb.right) }
    })()`)
    t.check('las dos ubicaciones arrancan en la misma columna, a la derecha de la cabecera', gGeo && gGeo.locations.length === 2 && gGeo.locations[0].textX === gGeo.locations[1].textX && gGeo.locations[0].textX > gGeo.header.textX, JSON.stringify(gGeo))
    t.check('el tab no arranca antes que su ubicación y va debajo de ella', gGeo && gGeo.tab.textX >= gGeo.locations[0].textX && gGeo.tab.top >= gGeo.locations[0].bottom && gGeo.tab.bottom <= gGeo.locations[1].top, JSON.stringify(gGeo))
    t.check('la ubicación no repite el punto de su tab', gGeo && gGeo.locations.every((l) => l.dotRight === null) && gGeo.header.dotRight === null, JSON.stringify(gGeo))
    t.check('nada se desborda en el grupo', gGeo && [gGeo.header, gGeo.tab, ...gGeo.locations].every((r) => r.scroll <= 0 && r.right <= gGeo.sbRight), JSON.stringify(gGeo))
    if (SHOTS) await api.screenshot(join(SHOTS, 'project-group.png'))

    // Menú sobre una ubicación: quitarla y moverla; sobre la cabecera del grupo, solo lo del proyecto.
    const menuItems = () => evaluate(`[...document.querySelectorAll('.picker [role=option]')].map((o) => o.textContent)`)
    await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().setFocus('list'))`)
    await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().setCursor(m.rowKey.workspace(${JSON.stringify(wsB?.id)})))`)
    await run('project.menu')
    await waitFor(`!!document.querySelector('.picker')`)
    const onB = await menuItems()
    t.check('en la segunda ubicación: Mover arriba, Quitar del proyecto y Agregar subcarpeta; no Mover abajo', onB.some((x) => x.startsWith('Mover arriba')) && onB.some((x) => x.startsWith('Quitar del proyecto')) && onB.some((x) => x.startsWith('Agregar subcarpeta')) && !onB.some((x) => x.startsWith('Mover abajo')), JSON.stringify(onB))
    t.check('el título nombra la carpeta y los bloques van separados', await evaluate(`document.querySelector('.picker__title')?.textContent?.endsWith('/ grupo-b') && document.querySelectorAll('.picker__sep').length === 2`), await evaluate(`document.querySelector('.picker__title')?.textContent`))
    if (SHOTS) await api.screenshot(join(SHOTS, 'project-menu-location.png'))
    await press('escape')
    await waitFor(`!document.querySelector('.overlay')`)
    await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().setCursor(m.rowKey.project(${JSON.stringify(group?.id)})))`)
    t.check('la cabecera del grupo apunta a la primera ubicación', (await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().currentWorkspaceId)`)) === wsA?.id)
    await run('project.menu')
    await waitFor(`!!document.querySelector('.picker')`)
    const onHeader = await menuItems()
    t.check('en la cabecera del grupo no hay opciones de una ubicación', onHeader.some((x) => x.startsWith('Agregar carpeta')) && !onHeader.some((x) => /^(Quitar del proyecto|Mover arriba|Mover abajo|Agregar subcarpeta|Copiar ruta)/.test(x)), JSON.stringify(onHeader))
    await press('escape')
    await waitFor(`!document.querySelector('.overlay')`)

    // Subir la segunda: el orden cambia en el sidebar y en main.
    await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().setCursor(m.rowKey.workspace(${JSON.stringify(wsB?.id)})))`)
    await run('project.moveLocationUp')
    t.check('Subir ubicación la pone primera', await waitFor(`window.omni.invoke('project:list').then((r) => r.projects.find((p) => p.id === ${JSON.stringify(group?.id)})?.locations.map((l) => l.name).join() === 'grupo-b,grupo-a')`, 2000))
    t.check('y el sidebar sigue el orden', await waitFor(`[...(${groupRow}?.closest('.sidebar__group')?.querySelectorAll('.folder > .row:first-child .row__label') ?? [])].map((l) => l.textContent).join() === 'grupo-b,grupo-a'`, 2000))

    // Quitar la que tiene una sesión viva no se puede; cerrada, sí (aunque fuera la primera).
    await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().setCursor(m.rowKey.workspace(${JSON.stringify(wsA?.id)})))`)
    await run('project.removeFolder')
    t.check('con una sesión viva pide confirmar antes de quitarla', await waitFor(`/del proyecto\?/.test(document.querySelector('.picker__title')?.textContent ?? '')`, 2000))
    await press('enter')
    t.check('al confirmar se quita y la que queda vuelve a ser local', await waitFor(`${MOD.sessions}.then((m) => m.useSessions.getState().workspaces.filter((w) => w.projectId === ${JSON.stringify(group?.id)}).map((w) => w.id + ':' + w.kind).join() === ${JSON.stringify(`${wsB?.id}:local`)})`, 2000))
    await run('project.removeFolder')
    t.check('quitar la última deja el proyecto vacío, no lo borra', await waitFor(`window.omni.invoke('project:list').then((r) => r.projects.find((p) => p.id === ${JSON.stringify(group?.id)})?.locations.length === 0)`, 2000))
    await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().removeProject(${JSON.stringify(group?.id)}))`)

    // G. Ancho del sidebar: arrastrar el borde lo cambia; doble clic lo restaura.
    const edge = await evaluate(`(() => { const r = document.querySelector('.sidebar__resizer').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] })()`)
    const before = await evaluate(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edge[0], y: edge[1] })
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: edge[0], y: edge[1], button: 'left', clickCount: 1 })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edge[0] + 80, y: edge[1], button: 'left' })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: edge[0] + 80, y: edge[1], button: 'left', clickCount: 1 })
    await sleep(150)
    const wide = await evaluate(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`)
    t.check('arrastrar el borde ensancha el sidebar', Math.abs(wide - (before + 80)) <= 2, `${before} → ${wide}`)
    t.check('el ancho se recuerda', await evaluate(`localStorage.getItem('omni.sidebar.width') === String(${wide})`))
    if (SHOTS) await api.screenshot(join(SHOTS, 'sidebar-wide.png'))
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: edge[0] + 80, y: edge[1], button: 'left', clickCount: 2 })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: edge[0] + 80, y: edge[1], button: 'left', clickCount: 2 })
    await sleep(150)
    t.check('doble clic lo restaura', (await evaluate(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`)) === 290)
    await api.parkMouse()
  } finally {
    // Limpieza: el sidebar a su ancho, los ocultos escondidos, el proyecto fuera y la carpeta borrada.
    await evaluate(`${MOD.ui}.then((m) => { m.useUi.getState().setSidebarWidth(m.SIDEBAR_DEFAULT); m.useUi.getState().setShowHidden(false) })`).catch(() => null)
    if (await evaluate(`!!document.querySelector('.overlay')`).catch(() => false)) await press('escape')
    const base = join(homedir(), dirName)
    await evaluate(`${MOD.sessions}.then(async (m) => { const s = m.useSessions.getState(); for (const p of s.projects.filter((x) => x.name === 'Grupo e2e' || x.locations.some((l) => l.path.startsWith(${JSON.stringify(base)})))) await s.removeProject(p.id) })`).catch(() => null)
    rmSync(join(homedir(), dirName), { recursive: true, force: true })
  }
}
