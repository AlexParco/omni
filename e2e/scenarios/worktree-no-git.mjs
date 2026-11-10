// Worktree nuevo en un proyecto sin git (§3.15): `N` e `I` en la vista Worktrees no abren el diálogo
// y avisan en el pie por qué, en vez de no hacer nada. Usa un proyecto real del usuario que no es repo.
const MOD = { sessions: `import('/src/store/sessions.ts')`, ui: `import('/src/store/ui.ts')`, wt: `import('/src/store/worktrees.ts')`, qo: `import('/src/store/quickopen.ts')` }

export default async function (api, t) {
  const { evaluate, press, sleep, waitFor } = api
  // Carga la rama de cada workspace local (la vista lo hace sola; aquí sin esperar a la UI)
  await evaluate(`Promise.all([${MOD.sessions}, ${MOD.qo}]).then(([sm, qm]) => sm.useSessions.getState().workspaces.filter((w) => w.kind === 'local').forEach((w) => qm.useQuickOpen.getState().loadBranch(w.id)))`)
  // Proyecto cuyo workspace local ya tiene rama cacheada en null (no es repo git)
  const pick = `Promise.all([${MOD.sessions}, ${MOD.wt}, ${MOD.qo}]).then(([sm, wm, qm]) => { const s = sm.useSessions.getState(); const p = s.projects.find((x) => wm.projectIsRepo(s, x.id, qm.useQuickOpen.getState().branches) === false); return p ? { id: p.id, name: p.name, ws: s.workspaces.find((w) => w.projectId === p.id && w.kind === 'local')?.id } : null })`
  t.check('hay un proyecto que no es repo git', await waitFor(`${pick}.then((p) => !!p)`, 8000))
  const proj = await evaluate(pick)
  if (!proj) return
  await evaluate(`${MOD.sessions}.then((m) => m.useSessions.getState().setWorkspace(${JSON.stringify(proj.ws)}))`)
  await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().setView('worktrees'))`)
  t.check('la vista Worktrees está en pantalla', await waitFor(`!!document.querySelector('main.worktrees')`, 3000))
  await evaluate(`document.querySelector('main.worktrees')?.focus()`); await sleep(150)
  await press('n'); await sleep(400)
  t.check('N no abre el diálogo de nombre', !(await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().overlay === 'worktreeName')`)))
  const banner = () => evaluate(`document.querySelector('.status-bar')?.textContent ?? ''`)
  t.check('N avisa en el pie que el proyecto no es repo git', await waitFor(`/no es un repo git/.test(document.querySelector('.status-bar')?.textContent ?? '')`, 2000), await banner())
  t.check('el aviso nombra al proyecto', (await banner()).includes(proj.name), await banner())
  t.check('el aviso del pie se lee completo', await evaluate(`(() => { const b = document.querySelector('.status-bar__banner'); return !!b && b.scrollWidth <= b.clientWidth })()`), await evaluate(`(() => { const b = document.querySelector('.status-bar__banner'); return b ? b.scrollWidth + '/' + b.clientWidth : 'sin banner' })()`))
  t.check('la vista vacía dice que el proyecto no es repo git', await waitFor(`/no es un repo git/.test(document.querySelector('.worktrees__list')?.textContent ?? '') && /git init/.test(document.querySelector('.worktrees__list')?.textContent ?? '')`, 2000), await evaluate(`document.querySelector('.worktrees__list')?.textContent`))
  t.check('el vacío no ofrece N para crear uno', !(await evaluate(`/crea uno/.test(document.querySelector('.worktrees__list')?.textContent ?? '')`)))
  await press('i'); await sleep(400)
  t.check('I tampoco abre el diálogo de issue', !(await evaluate(`${MOD.ui}.then((m) => m.useUi.getState().overlay === 'worktreeIssue')`)))
  await press('escape'); await sleep(300)
}
