// Pegar una imagen en la terminal. ⌘V con una imagen en el portapapeles (sin texto) se trata como
// soltarla: en una terminal local se guarda en la carpeta de soltados y se pega la ruta; en una remota
// (§3.26) se sube a `~/.omni/drops/` del host. ⌃V en una remota (el "pegar imagen" de Claude Code, que
// en el VPS leería un portapapeles vacío) sube la imagen del portapapeles del Mac y pega su ruta.
// La parte remota requiere HOME aislado y `OMNI_SSH_BIN` (ssh falso); ⌃V usa el portapapeles real.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertQuiet, closePanes, ensurePane } from './_helpers.mjs'

const S = `import('/src/store/sessions.ts')`
const L = `import('/src/store/layout.ts')`
const T = `import('/src/panes/terminal/terminal-host.ts')`
// PNG de 1×1 px.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export default async function (api, t) {
  const { evaluate, sleep, waitFor } = api
  await assertQuiet(api)
  const screenOf = (id) => evaluate(`${T}.then((m) => (m.screenLines(${JSON.stringify(id)}, 40) ?? []).join(''))`)
  // Pegado sintético sobre la terminal con foco: el mismo evento que dispara ⌘V.
  const pasteEvent = (withText) =>
    evaluate(`(() => { const bin = atob(${JSON.stringify(PNG)}); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); const dt = new DataTransfer(); dt.items.add(new File([bytes], 'image.png', { type: 'image/png' })); ${withText ? `dt.setData('text/plain', 'texto-pegado')` : ''}; const ta = document.querySelector('.pane[data-focus="live"] textarea') ?? document.querySelector('.pane textarea'); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true })()`)

  // Local: ⌘V con una imagen pega la ruta de un PNG guardado. La terminal nace en el workspace actual:
  // se fija uno local (una corrida anterior cortada pudo dejar uno remoto).
  await evaluate(`${S}.then((m) => { const s = m.useSessions.getState(); const w = s.workspaces.find((x) => !x.host); if (w) s.setWorkspace(w.id) })`)
  await ensurePane(api)
  const local = await evaluate(`${S}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0]?.id)`)
  await pasteEvent(false)
  const pasted = await waitFor(`${T}.then((m) => /portapapeles\\.png/.test((m.screenLines(${JSON.stringify(local)}, 40) ?? []).join('')))`, 4000)
  const localScreen = await screenOf(local)
  t.check('⌘V con una imagen pega la ruta de un PNG guardado', pasted, localScreen.slice(-160))
  const localPath = localScreen.match(/(\/\S*?portapapeles\.png)/)?.[1]
  t.check('el PNG pegado existe en disco', !!localPath && existsSync(localPath), String(localPath))
  // Con texto en el portapapeles manda el pegado normal (el texto, no una imagen).
  await pasteEvent(true)
  await sleep(500)
  const withText = await screenOf(local)
  t.check('con texto en el portapapeles se pega el texto', withText.includes('texto-pegado') && (withText.match(/portapapeles\.png/g) ?? []).length === 1, withText.slice(-160))
  await api.press('ctrl+c')
  await sleep(200)
  await closePanes(api, 1)

  // Remota: ⌃V sube la imagen del portapapeles del Mac y pega la ruta del host.
  const home = homedir()
  const fake = await evaluate(`window.omni.invoke('host:sshConfig').then(() => true).catch(() => false)`)
  if (!fake || (!home.startsWith('/tmp') && !home.includes('omni-'))) {
    t.check('parte remota (requiere HOME aislado y OMNI_SSH_BIN)', true, `se salta: HOME=${home}`)
    return
  }
  const dir = join(home, 'e2e-clip')
  mkdirSync(dir, { recursive: true })
  const png = join(tmpdir(), `omni-e2e-clip-${process.pid}.png`)
  writeFileSync(png, Buffer.from(PNG, 'base64'))
  execFileSync('osascript', ['-e', `set the clipboard to (read (POSIX file "${png}") as «class PNGf»)`])
  const { host } = await evaluate(`window.omni.invoke('host:add', 'vps-clip', 'vps-clip')`)
  await evaluate(`window.omni.invoke('host:connect', ${JSON.stringify(host.id)})`)
  const project = await evaluate(`window.omni.invoke('project:create', 'Portapapeles e2e')`)
  let shell = null
  try {
    const ws = await evaluate(`window.omni.invoke('project:addLocation', ${JSON.stringify(project.id)}, { path: ${JSON.stringify(dir)}, host: ${JSON.stringify(host.id)} })`)
    await evaluate(`${S}.then(async (m) => { await m.useSessions.getState().reloadProjects(); m.useSessions.getState().setWorkspace(${JSON.stringify(ws.id)}) })`)
    shell = await evaluate(`${S}.then(async (m) => { const info = await m.useSessions.getState().create('shell'); (await ${L}).useLayout.getState().openTab(info.workspaceId, info.id); return info })`)
    t.check('la terminal es remota', shell?.remote === true)
    await sleep(1500)
    await api.click('.pane')
    await sleep(200)
    await api.press('ctrl+v')
    const up = await waitFor(`${T}.then((m) => /\\.omni\\/drops\\/\\S*portapapeles\\.png/.test((m.screenLines(${JSON.stringify(shell.id)}, 40) ?? []).join('')))`, 6000)
    const remoteScreen = await screenOf(shell.id)
    t.check('⌃V en la remota sube la imagen del Mac y pega la ruta del host', up, remoteScreen.slice(-160))
    const remotePath = remoteScreen.match(/(\/\S*\.omni\/drops\/\S*portapapeles\.png)/)?.[1]
    t.check('el PNG está en ~/.omni/drops del host', !!remotePath && existsSync(remotePath), String(remotePath))
  } finally {
    rmSync(png, { force: true })
    if (shell) await evaluate(`${S}.then((m) => m.useSessions.getState().kill(${JSON.stringify(shell.id)}))`).catch(() => undefined)
    await sleep(500)
    await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(project.id)}).then(() => window.omni.invoke('host:remove', ${JSON.stringify(host.id)})).then(() => ${S}).then((m) => m.useSessions.getState().reloadProjects())`).catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}
