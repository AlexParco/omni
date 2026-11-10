// Worktrees en un servidor (§3.26) con el ssh falso (`OMNI_SSH_BIN`, HOME aislado): un repo en una carpeta
// remota; "Nuevo worktree" lo crea en `~/.omni/worktrees` del host, el sidebar lo muestra como remoto, su
// terminal arranca allá, la revisión ve el diff (también un archivo sin seguimiento) y el merge vuelve al
// repo del host. Con el ssh falso el "servidor" es este Mac.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const S = `import('/src/store/sessions.ts')`
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=e2e@omni', '-c', 'user.name=e2e', ...a], { encoding: 'utf8' })

export default async function (api, t) {
  const { evaluate, sleep, waitFor } = api
  const home = homedir()
  if (!home.startsWith('/tmp') && !home.includes('omni-')) {
    t.check('escenario remoto (requiere HOME aislado y OMNI_SSH_BIN)', true, `se salta: HOME=${home}`)
    return
  }
  const repo = join(home, 'srv', 'wt-app')
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'app.js'), 'export const n = 1\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  const { host } = await evaluate(`window.omni.invoke('host:add', 'vps-wt', 'vps-wt')`)
  await evaluate(`window.omni.invoke('host:connect', ${JSON.stringify(host.id)})`)
  const project = await evaluate(`window.omni.invoke('project:create', 'Worktree remoto e2e')`)
  let wt = null
  let shell = null
  try {
    const loc = await evaluate(`window.omni.invoke('project:addLocation', ${JSON.stringify(project.id)}, { path: ${JSON.stringify(repo)}, host: ${JSON.stringify(host.id)} })`)
    await evaluate(`${S}.then((m) => m.useSessions.getState().reloadProjects())`)
    wt = await evaluate(`window.omni.invoke('worktree:create', ${JSON.stringify(project.id)}, { name: 'remota', locationId: ${JSON.stringify(loc.id)} })`)
    t.check('el worktree se crea en ~/.omni/worktrees del host', wt.path.startsWith(join(home, '.omni', 'worktrees')) && existsSync(join(wt.path, 'app.js')), wt.path)
    await evaluate(`${S}.then((m) => m.useSessions.getState().reloadProjects())`)
    const remoteWs = await evaluate(`${S}.then((m) => m.useSessions.getState().workspaces.find((w) => w.id === ${JSON.stringify(wt.id)}))`)
    t.check('su workspace es remoto', remoteWs?.host === host.id, JSON.stringify(remoteWs))
    t.check('el sidebar lo muestra en el proyecto', await waitFor(`!!document.getElementById('row-ws-${wt.id}')`, 3000))

    await evaluate(`${S}.then((m) => m.useSessions.getState().setWorkspace(${JSON.stringify(wt.id)}))`)
    shell = await evaluate(`${S}.then(async (m) => { const info = await m.useSessions.getState().create('shell'); (await import('/src/store/layout.ts')).useLayout.getState().openTab(info.workspaceId, info.id); return info })`)
    t.check('su terminal es remota y arranca en el worktree', shell?.remote === true && shell.cwd === wt.path, JSON.stringify(shell))
    await sleep(800)
    await evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, "printf 'export const n = 2\\\\n' > app.js && printf 'nuevo\\\\n' > nuevo.txt" + String.fromCharCode(13))`)
    await waitFor(`window.omni.invoke('worktree:status', ${JSON.stringify(wt.id)}, true).then((s) => s.stat.files === 2)`, 5000)
    const status = await evaluate(`window.omni.invoke('worktree:status', ${JSON.stringify(wt.id)}, true)`)
    t.check('el estado se mide en el host (cambio + archivo nuevo)', status.dirty && status.stat.files === 2 && status.stat.additions === 2, JSON.stringify(status.stat))
    const diff = await evaluate(`window.omni.invoke('git:diff', ${JSON.stringify(wt.id)})`)
    t.check('la revisión ve el diff del host', diff.files.map((f) => `${f.path}:${f.status}`).sort().join(',') === 'app.js:M,nuevo.txt:A', JSON.stringify(diff.files.map((f) => f.path)))

    await evaluate(`${S}.then((m) => m.useSessions.getState().kill(${JSON.stringify(shell.id)}))`)
    shell = null
    await sleep(400)
    const merged = await evaluate(`window.omni.invoke('git:merge', ${JSON.stringify(wt.id)})`)
    t.check('el merge vuelve al repo del host', /^[0-9a-f]{40}$/.test(merged.commit) && git(repo, 'log', '-1', '--format=%s').trim() === 'remota (omni)', git(repo, 'log', '-1', '--format=%s'))
    // Como en local, tras el merge el worktree se borra solo: carpeta y rama en el host.
    t.check('tras el merge se limpia la carpeta y la rama en el host', await waitFor(`Promise.resolve(${JSON.stringify(wt.path)})`, 100) && !existsSync(wt.path) && git(repo, 'branch', '--list', 'omni/remota').trim() === '', wt.path)
    wt = null
  } finally {
    if (shell) await evaluate(`${S}.then((m) => m.useSessions.getState().kill(${JSON.stringify(shell.id)}))`).catch(() => undefined)
    if (wt) await evaluate(`window.omni.invoke('worktree:remove', ${JSON.stringify(wt.id)})`).catch(() => undefined)
    await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(project.id)}).then(() => window.omni.invoke('host:remove', ${JSON.stringify(host.id)})).then(() => ${S}).then((m) => m.useSessions.getState().reloadProjects())`).catch(() => undefined)
    rmSync(join(home, 'srv'), { recursive: true, force: true })
  }
}
