// Fase 2 de `pnpm e2e:revive`: tras matar daemon y app como un apagado de la Mac y volver a abrir,
// las tres sesiones vuelven con su mismo id, en su tab, y cada agente retoma su conversación.
import { readFileSync } from 'node:fs'
const ids = JSON.parse(readFileSync(process.env.OMNI_REVIVE_IDS, 'utf8'))
const H = `import('/src/panes/terminal/terminal-host.ts')`
export default async function (api, t) {
  const { evaluate, sleep, waitFor, click, screenshot } = api
  await waitFor(`import('/src/store/sessions.ts').then((m) => m.useSessions.getState().ready)`, 15000)
  const list = await evaluate(`window.omni.invoke('session:list')`)
  const byId = Object.fromEntries(list.map((s) => [s.id, s]))
  for (const k of ['shell', 'claude', 'codex']) t.check(`${k}: revivido con el mismo id`, byId[ids[k]]?.restored === true, JSON.stringify(byId[ids[k]] ?? list.map((s) => s.id)))
  t.check('claude: recuerda la misma conversación', byId[ids.claude]?.resumeId === ids.claudeResume, String(byId[ids.claude]?.resumeId))
  t.check('codex: aprendió el id de su conversación', !!ids.codexId && byId[ids.codex]?.resumeId === ids.codexId, `${byId[ids.codex]?.resumeId} vs ${ids.codexId}`)
  const hist = (id) => evaluate(`window.omni.invoke('session:history', ${JSON.stringify(id)})`)
  t.check('claude: se lanzó con --resume <id>', await waitFor(`window.omni.invoke('session:history', ${JSON.stringify(ids.claude)}).then((h) => h.includes('FAKE-CLAUDE retoma ${ids.claudeResume}'))`, 8000), (await hist(ids.claude)).slice(-240))
  t.check('codex: se lanzó con resume <id>', await waitFor(`window.omni.invoke('session:history', ${JSON.stringify(ids.codex)}).then((h) => h.includes('FAKE-CODEX retoma ${ids.codexId}'))`, 8000), (await hist(ids.codex)).slice(-240))
  const shellHist = await hist(ids.shell)
  t.check('shell: la pantalla de antes vuelve arriba', shellHist.includes('REVIVE-MARK-77') && shellHist.includes('sesión restaurada'), shellHist.slice(-300))
  t.check('shell: el marcador va antes del separador', shellHist.indexOf('REVIVE-MARK-77') < shellHist.indexOf('sesión restaurada'), '')
  const claudeHist = await hist(ids.claude)
  // Retomado: solo el separador, sin la foto vieja (la conversación la repinta el propio agente).
  t.check('claude retomado: separador sin la pantalla vieja', claudeHist.includes('sesión restaurada') && !claudeHist.includes('FAKE-CLAUDE nueva'), claudeHist.slice(0, 200))
  // Layout: cada sesión en su tab, como estaba guardado.
  const inLayout = await evaluate(`import('/src/store/layout.ts').then((m) => { const s = new Set(m.useLayout.getState().tabs.flatMap((tb) => m.leaves(tb.root).map((l) => l.sessionId))); return ${JSON.stringify([ids.shell, ids.claude, ids.codex])}.every((id) => s.has(id)) })`)
  t.check('las tres sesiones vuelven a sus tabs', inLayout, '')
  t.check('aviso de lo restaurado', await waitFor(`document.body.innerText.includes('Se restauraron 3 terminales')`, 5000), (await evaluate('document.body.innerText')).slice(0, 300))
  // Terminal viva: el shell revivido responde.
  await evaluate(`Promise.all([import('/src/store/sessions.ts'), import('/src/store/layout.ts')]).then(([sm, lm]) => { const tab = lm.useLayout.getState().tabs.find((tb) => lm.leaves(tb.root).some((l) => l.sessionId === ${JSON.stringify(ids.shell)})); if (tab) sm.useSessions.getState().activateTab(tab.id) })`)
  await sleep(500)
  await click('.pane')
  await sleep(1200)
  const buf = () => evaluate(`${H}.then((m) => { const term = m.getTerminal(${JSON.stringify(ids.shell)})?.term; if (!term) return ''; const b = term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? ''); return out.join('\\n') })`)
  const before = await buf()
  t.check('xterm pinta la pantalla de antes y el separador', before.includes('REVIVE-MARK-77') && /sesión restaurada \d\d:\d\d/.test(before), before.slice(-400))
  await api.type('echo VIVA-REVIVE\n')
  await sleep(800)
  t.check('el shell revivido responde', /VIVA-REVIVE\s*\n/.test(await buf()), (await buf()).slice(-200))
  if (process.env.E2E_SHOTS) await screenshot(process.env.E2E_SHOTS + '/revive-shell.png')
}
