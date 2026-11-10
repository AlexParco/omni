// Subcarpetas, segunda parte (§3.5c): sobre la fila de una carpeta, "Renombrar carpeta" cambia su nombre
// (no la ruta) y "Tests de la carpeta" guarda un comando propio que manda sobre el del proyecto.
import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const S = `import('/src/store/sessions.ts')`
const run = (id) => `import('/src/core/commands/registry.ts').then((m) => m.commands.run(${JSON.stringify(id)}))`

export default async function (api, t) {
  const { evaluate, press, type, sleep, waitFor } = api
  const base = join(homedir(), 'omni-e2e-folder-extras')
  for (const d of ['api', 'web']) mkdirSync(join(base, d), { recursive: true })
  // `+` de Proyectos: menú con Nuevo proyecto (vacío), Abrir carpeta y Abrir carpeta remota.
  await evaluate(`document.querySelector('.sidebar__section button[aria-label="Agregar proyecto"]').click()`)
  t.check('el + ofrece nuevo proyecto, abrir carpeta y carpeta remota', await waitFor(`[...document.querySelectorAll('.picker [role=option]')].map((o) => o.textContent).join('|').match(/^Nuevo proyecto.*\|Abrir carpeta.*\|Abrir carpeta remota/) !== null`, 2000), await evaluate(`[...document.querySelectorAll('.picker [role=option]')].map((o) => o.textContent).join(' | ')`))
  if (process.env.E2E_SHOTS) await api.screenshot(join(process.env.E2E_SHOTS, 'project-add.png'))
  await press('enter')
  t.check('Nuevo proyecto pide solo el nombre', await waitFor(`document.querySelector('.dialog')?.textContent?.includes('Nuevo proyecto')`, 2000))
  await type('Vacío e2e')
  await press('enter')
  t.check('se crea sin carpetas y sin abrir otro diálogo', await waitFor(`!document.querySelector('.overlay') && [...document.querySelectorAll('.sidebar__group')].some((g) => g.textContent.includes('Vacío e2e') && g.textContent.includes('Sin carpetas'))`, 3000))
  const empty = await evaluate(`import('/src/store/sessions.ts').then((m) => m.useSessions.getState().projects.find((p) => p.name === 'Vacío e2e')?.id)`)
  if (empty) await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(empty)})`)

  const project = await evaluate(`window.omni.invoke('project:create', 'Extras e2e')`)
  try {
    const a = await evaluate(`window.omni.invoke('project:addLocation', ${JSON.stringify(project.id)}, { path: ${JSON.stringify(join(base, 'api'))} })`)
    const b = await evaluate(`window.omni.invoke('project:addLocation', ${JSON.stringify(project.id)}, { path: ${JSON.stringify(join(base, 'web'))} })`)
    await evaluate(`window.omni.invoke('project:setTestCommand', ${JSON.stringify(project.id)}, 'pnpm test')`)
    await evaluate(`${S}.then(async (m) => { await m.useSessions.getState().reloadProjects(); m.useSessions.getState().setCursor('ws:${b.id}') })`)
    await sleep(300)

    await evaluate(run('project.renameFolder'))
    t.check('Renombrar carpeta abre su diálogo con la ruta', await waitFor(`document.querySelector('.dialog')?.textContent?.includes('Renombrar carpeta') && document.querySelector('.dialog')?.textContent?.includes(${JSON.stringify(join(base, 'web'))})`, 2000))
    await type('frontend')
    await press('enter')
    t.check('la fila de la carpeta lleva el nombre nuevo', await waitFor(`!!document.getElementById('row-ws-${b.id}') && document.getElementById('row-ws-${b.id}').querySelector('.row__label')?.textContent === 'frontend'`, 3000), await evaluate(`document.getElementById('row-ws-${b.id}')?.textContent ?? 'sin fila'`))
    const path = await evaluate(`${S}.then((m) => m.useSessions.getState().workspaces.find((w) => w.id === ${JSON.stringify(b.id)})?.path)`)
    t.check('la ruta no cambia', path === join(base, 'web'), path)

    await evaluate(`${S}.then((m) => m.useSessions.getState().setCursor('ws:${b.id}'))`)
    await sleep(200)
    await evaluate(run('project.setFolderTestCommand'))
    t.check('Tests de la carpeta abre el diálogo de esa carpeta', await waitFor(`document.querySelector('.dialog')?.textContent?.includes('Comando de tests de frontend')`, 2000))
    await type('pnpm test:web')
    await press('enter')
    const saved = await waitFor(`${S}.then((m) => m.useSessions.getState().projects.find((p) => p.id === ${JSON.stringify(project.id)})?.locations.find((l) => l.id === ${JSON.stringify(b.id)})?.testCommand === 'pnpm test:web')`, 3000)
    t.check('la carpeta guarda su comando', saved)
    const effective = await evaluate(`import('/src/store/worktrees.ts').then(async (w) => { const s = (await ${S}).useSessions.getState(); return [${JSON.stringify(a.id)}, ${JSON.stringify(b.id)}].map((id) => w.testCommandOf(s.projects, s.workspaces.find((x) => x.id === id))) })`)
    t.check('manda sobre el del proyecto solo en esa carpeta', effective[0] === 'pnpm test' && effective[1] === 'pnpm test:web', JSON.stringify(effective))
  } finally {
    await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(project.id)}).then(() => ${S}).then((m) => m.useSessions.getState().reloadProjects())`).catch(() => undefined)
    rmSync(base, { recursive: true, force: true })
  }
}
