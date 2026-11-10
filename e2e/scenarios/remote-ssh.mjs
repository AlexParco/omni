// Proyectos con varias ubicaciones y hosts remotos por SSH (ARCHITECTURE §3.5c, §3.26), sin VPS: la
// app corre con `OMNI_SSH_BIN=e2e/fake-ssh/ssh` (un OpenSSH falso que ejecuta lo "remoto" en este Mac)
// y un HOME aislado. Si la app no se lanzó con el ssh falso, el escenario se salta.
//   HOME=<scratch> OMNI_SSH_BIN=$PWD/e2e/fake-ssh/ssh OMNI_DAEMON=0 OMNI_CDP_PORT=9229 pnpm dev
//   HOME=<scratch> node e2e/cdp.mjs remote-ssh
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const S = `import('/src/store/sessions.ts')`
const H = `import('/src/store/hosts.ts')`
const U = `import('/src/store/ui.ts')`
const C = `import('/src/core/commands/registry.ts')`
const T = `import('/src/panes/terminal/terminal-host.ts')`

function repo(dir, file, text) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), text)
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=e2e@omni', '-c', 'user.name=e2e', 'add', '.')
  git('-c', 'user.email=e2e@omni', '-c', 'user.name=e2e', 'commit', '-qm', 'init')
}

export default async function (api, t) {
  const { evaluate, press, type, sleep, waitFor, click, screenshot } = api
  const home = homedir()
  const bin = await evaluate(`window.omni.invoke('host:sshConfig').then(() => true).catch(() => false)`)
  if (!bin || !home.startsWith('/tmp') && !home.includes('omni-')) {
    t.check('escenario remoto (requiere HOME aislado y OMNI_SSH_BIN)', true, `se salta: HOME=${home}`)
    return
  }
  const root = join(home, 'e2e-remote')
  rmSync(root, { recursive: true, force: true })
  repo(join(root, 'srv', 'billing-api'), 'index.ts', "export const pais = 'Perú'\n")
  repo(join(root, 'shop', 'sales', 'order-service'), 'order.ts', 'export const order = 1\n')
  repo(join(root, 'shop', 'core'), 'core.ts', 'export const core = 1\n')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'config'), 'Host vps-e2e\n  HostName 127.0.0.1\n  User e2e\n')
  const shots = process.env.E2E_SHOTS

  // 1. Agregar servidor desde ~/.ssh/config.
  await evaluate(`${C}.then((m) => m.commands.run('host.add'))`)
  t.check('diálogo Agregar servidor', await waitFor(`document.querySelector('.dialog')?.textContent.includes('Agregar servidor SSH')`, 3000), '')
  t.check('lista los hosts de ~/.ssh/config', await waitFor(`[...document.querySelectorAll('.hosts-dialog__list .row')].some((r) => r.textContent.includes('vps-e2e'))`, 8000), await evaluate(`document.querySelector('.dialog')?.textContent.slice(0, 300)`))
  if (shots) await screenshot(join(shots, 'remote-host-add.png'))
  await evaluate(`[...document.querySelectorAll('.hosts-dialog__list .row')].find((r) => r.textContent.includes('vps-e2e'))?.click()`)
  const hostId = await waitFor(`${H}.then((m) => m.useHosts.getState().hosts.find((h) => h.target === 'vps-e2e') && Object.values(m.useHosts.getState().status).some((s) => s.state === 'connected'))`, 15000)
  const host = await evaluate(`${H}.then((m) => { const h = m.useHosts.getState().hosts.find((x) => x.target === 'vps-e2e'); return { id: h?.id, status: m.useHosts.getState().status[h?.id] } })`)
  t.check('servidor conectado con preflight (home, sistema)', hostId && host.status?.state === 'connected' && host.status.home === home, JSON.stringify(host.status))
  await waitFor(`!document.querySelector('.overlay')`, 3000)

  // 2. Abrir carpeta remota con autocompletado.
  await evaluate(`${C}.then((m) => m.commands.run('project.openRemote'))`)
  t.check('elegir servidor', await waitFor(`[...document.querySelectorAll('.picker [role=option]')].some((o) => o.textContent.includes('vps-e2e'))`, 3000), '')
  await type('vps')
  await sleep(100)
  await press('enter')
  t.check('diálogo de carpeta remota', await waitFor(`document.querySelector('.dialog')?.textContent.includes('Abrir carpeta remota')`, 3000), '')
  await evaluate(`(() => { const i = document.querySelector('.hosts-dialog input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '~/e2e-remote/srv/sh'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  t.check('sugiere carpetas del servidor', await waitFor(`[...document.querySelectorAll('.hosts-dialog__list .row')].some((r) => r.querySelector('.row__label')?.textContent === 'billing-api')`, 8000), await evaluate(`document.querySelector('.hosts-dialog__list')?.textContent ?? 'sin lista'`))
  await press('tab')
  t.check('Tab completa la ruta', await waitFor(`document.querySelector('.hosts-dialog input')?.value.endsWith('/srv/billing-api/')`, 3000), await evaluate(`document.querySelector('.hosts-dialog input')?.value`))
  if (shots) await screenshot(join(shots, 'remote-path.png'))
  await press('enter')
  const remote = await waitFor(`${S}.then((m) => m.useSessions.getState().projects.some((p) => p.locations[0]?.host && p.locations[0].path.endsWith('/srv/billing-api')))`, 10000)
  t.check('proyecto remoto creado', remote, JSON.stringify(await evaluate(`${S}.then((m) => m.useSessions.getState().projects.map((p) => p.locations))`)))
  const projectId = await evaluate(`${S}.then((m) => m.useSessions.getState().projects.find((p) => p.locations[0]?.host)?.id)`)
  t.check('sidebar marca el proyecto remoto', await waitFor(`!!document.querySelector('.sidebar__host-mark[data-host-state="connected"]')`, 3000), '')
  // Pone el cursor sobre la fila de un workspace (la cabecera si es la única ubicación): así el proyecto actual es el suyo.
  const focusWs = (id) => evaluate(`${S}.then((m) => { const s = m.useSessions.getState(); const w = s.workspaces.find((x) => x.id === ${JSON.stringify(id)}); if (w) s.setCursor(m.cursorOf(w)) })`)

  // 3. Agregar una carpeta de este Mac al mismo proyecto.
  await focusWs(projectId)
  await evaluate(`${C}.then((m) => m.commands.run('project.addLocation'))`)
  t.check('elegir dónde: Este Mac', await waitFor(`[...document.querySelectorAll('.picker [role=option]')].some((o) => o.textContent.includes('Este Mac'))`, 3000), '')
  await type('Este Mac')
  await sleep(100)
  await press('enter')
  await waitFor(`!!document.querySelector('.hosts-dialog input')`, 3000)
  await evaluate(`(() => { const i = document.querySelector('.hosts-dialog input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(join(root, 'shop', 'sales', 'order-service'))}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(300)
  await press('enter')
  const two = await waitFor(`${S}.then((m) => m.useSessions.getState().projects.find((p) => p.id === ${JSON.stringify(projectId)})?.locations.length === 2)`, 8000)
  t.check('el proyecto tiene una ubicación remota y una local', two, '')
  t.check('fila de la ubicación local con su ruta', await waitFor(`[...document.querySelectorAll('.folder .row')].some((r) => r.textContent.includes('order-service'))`, 3000), '')
  // Con dos ubicaciones la remota (la primera) pasa a tener su propia fila con el icono de servidor;
  // la cabecera queda como grupo, sin marca de servidor.
  const billingGroup = `[...document.querySelectorAll('.sidebar__group')].find((g) => g.querySelector('.row[data-level="0"]')?.textContent.includes('billing-api'))`
  t.check('la ubicación remota tiene su fila con icono de servidor conectado', await waitFor(`!!${billingGroup}?.querySelector('.folder[data-host-state="connected"] .folder__icon')`, 3000), await evaluate(`${billingGroup}?.innerHTML.slice(0, 300) ?? ''`))
  t.check('la cabecera del grupo ya no lleva la marca de servidor', !(await evaluate(`!!${billingGroup}?.querySelector('.row[data-level="0"] .sidebar__host-mark')`)))
  const two0 = await evaluate(`(() => {
    const g = ${billingGroup}; if (!g) return null
    const sb = document.querySelector('.sidebar').getBoundingClientRect()
    const header = g.querySelector('.row[data-level="0"] .row__label').getBoundingClientRect()
    const rows = [...g.querySelectorAll('.folder > .row')].map((r) => { const b = r.getBoundingClientRect(); const l = r.querySelector('.row__label').getBoundingClientRect(); const ic = r.querySelector('.folder__icon').getBoundingClientRect(); return { textX: Math.round(l.left), iconX: Math.round(ic.left), right: Math.round(b.right), scroll: r.scrollWidth - r.clientWidth, labels: r.querySelector('.row__label').textContent } })
    return { headerX: Math.round(header.left), sbRight: Math.round(sb.right), rows }
  })()`)
  t.check('las dos ubicaciones (remota y local) alineadas, con sangría y sin desborde', two0 && two0.rows.length === 2 && two0.rows[0].textX === two0.rows[1].textX && two0.rows[0].iconX === two0.rows[1].iconX && two0.rows.every((r) => r.textX > two0.headerX && r.scroll <= 0 && r.right <= two0.sbRight), JSON.stringify(two0))
  if (shots) await screenshot(join(shots, 'remote-two-locations.png'))

  // 4. Renombrar el proyecto.
  await evaluate(`${C}.then((m) => m.commands.run('project.rename'))`)
  await waitFor(`!!document.querySelector('.hosts-dialog input')`, 3000)
  await evaluate(`(() => { const i = document.querySelector('.hosts-dialog input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Billing API'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(100)
  await press('enter')
  t.check('renombrado a Billing API', await waitFor(`${S}.then((m) => m.useSessions.getState().projects.find((p) => p.id === ${JSON.stringify(projectId)})?.name === 'Billing API')`, 3000), '')

  // 5. Unir otro proyecto (shop/core) dentro de este.
  await evaluate(`${S}.then((m) => m.useSessions.getState().openProjectPath(${JSON.stringify(join(root, 'shop', 'core'))}))`)
  await focusWs(projectId)
  await evaluate(`${C}.then((m) => m.commands.run('project.merge'))`)
  await waitFor(`[...document.querySelectorAll('.picker [role=option]')].some((o) => o.textContent.includes('core'))`, 3000)
  await type('core')
  await sleep(100)
  await press('enter')
  t.check('unir: tres ubicaciones y el otro proyecto desaparece', await waitFor(`${S}.then((m) => { const s = m.useSessions.getState(); return s.projects.find((p) => p.id === ${JSON.stringify(projectId)})?.locations.length === 3 && !s.projects.some((p) => p.name === 'core') })`, 5000), '')
  await sleep(300)
  if (shots) await screenshot(join(shots, 'remote-sidebar.png'))
  // Medición: las filas de ubicación no se desbordan y su texto arranca después del de su proyecto.
  const geo = await evaluate(`(() => { const sb = document.querySelector('.sidebar').getBoundingClientRect(); const rows = [...document.querySelectorAll('.folder .row')]; const proj = [...document.querySelectorAll('.sidebar__group')].find((g) => g.textContent.includes('Billing'))?.querySelector('.row__label')?.getBoundingClientRect(); return { overflow: rows.filter((r) => r.getBoundingClientRect().right > sb.right + 0.5).length, indent: rows.every((r) => r.querySelector('.row__label').getBoundingClientRect().left >= (proj?.left ?? 0)) } })()`)
  t.check('filas de ubicación sin desborde y con sangría', geo.overflow === 0 && geo.indent, JSON.stringify(geo))

  // 6. Terminal remota: cwd en el host y marcada como remota.
  await focusWs(projectId)
  const term = await evaluate(`Promise.all([${S}, import('/src/store/layout.ts')]).then(async ([sm, lm]) => { const info = await sm.useSessions.getState().create('shell'); if (info) lm.useLayout.getState().openTab(info.workspaceId, info.id); return info })`)
  t.check('terminal remota creada', term?.remote === true, JSON.stringify(term))
  await sleep(2500)
  await evaluate(`window.omni.send('session:write', ${JSON.stringify(term.id)}, 'echo REMOTO:$OMNI_SESSION:$(pwd)\\r')`)
  t.check('la terminal remota corre en la carpeta del host', await waitFor(`window.omni.invoke('session:history', ${JSON.stringify(term.id)}).then((h) => /REMOTO:1:.*srv\\/billing-api/.test(h))`, 8000), (await evaluate(`window.omni.invoke('session:history', ${JSON.stringify(term.id)})`)).slice(-300))
  if (shots) await screenshot(join(shots, 'remote-terminal.png'))

  // 7. Editor sobre un archivo remoto: lee, edita y guarda por SSH.
  // La ubicación remota se guarda con su ruta real en el host (en macOS `/tmp` es `/private/tmp`).
  const remoteRoot = await evaluate(`${S}.then((m) => m.useSessions.getState().workspaces.find((w) => w.id === ${JSON.stringify(projectId)})?.path)`)
  const remoteFile = join(remoteRoot, 'index.ts')
  const doc = await evaluate(`import('/src/store/docs.ts').then((m) => m.useDocs.getState().open(${JSON.stringify(projectId)}, ${JSON.stringify(remoteFile)}, 'editor', 'tab'))`).catch((e) => ({ error: String(e) }))
  const loaded = doc?.id ? await waitFor(`import('/src/panes/editor/editor-store.ts').then((m) => { const d = m.useEditor.getState().docs[${JSON.stringify(doc.id)}]; return d?.loaded && !d.error })`, 8000) : false
  t.check('el editor abre un archivo remoto', loaded, JSON.stringify(doc))
  if (loaded) {
    const write = await evaluate(`window.omni.invoke('file:write', ${JSON.stringify(projectId)}, ${JSON.stringify(remoteFile)}, "export const pais = 'Perú 🇵🇪'\\n").then(() => true, (e) => String(e))`)
    t.check('guardar por SSH escribe el archivo', write === true && readFileSync(remoteFile, 'utf8').includes('🇵🇪'), String(write))
  }

  // Limpieza: sesiones, proyecto y host.
  for (const id of [term?.id, doc?.id].filter(Boolean)) await evaluate(`${S}.then((m) => m.useSessions.getState().kill(${JSON.stringify(id)}))`).catch(() => null)
  await sleep(500)
  await evaluate(`${S}.then((m) => m.useSessions.getState().removeProject(${JSON.stringify(projectId)}))`).catch(() => null)
  await evaluate(`${H}.then((m) => m.useHosts.getState().remove(${JSON.stringify(host.id)}))`).catch(() => null)
  await evaluate(`${U}.then((m) => m.useUi.getState().closeOverlay())`).catch(() => null)
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
}
