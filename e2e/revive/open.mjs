// Fase 1 de `pnpm e2e:revive`: abre un shell con un marcador, un Claude Code y un Codex (de mentira)
// en el proyecto de prueba y anota sus ids. Espera a que el daemon guarde la foto de las pantallas.
import { writeFileSync } from 'node:fs'
const S = `import('/src/store/sessions.ts')`
const L = `import('/src/store/layout.ts')`
export default async function (api, t) {
  const { evaluate, sleep, waitFor } = api
  await waitFor(`${S}.then((m) => m.useSessions.getState().ready)`, 10000)
  const open = (agent) => evaluate(`Promise.all([${S}, ${L}]).then(async ([sm, lm]) => { const info = await sm.useSessions.getState().create(${JSON.stringify(agent)}); if (info) lm.useLayout.getState().openTab(info.workspaceId, info.id); return info })`)
  const shell = await open('shell')
  await sleep(1500)
  await evaluate(`window.omni.send('session:write', ${JSON.stringify(shell.id)}, 'echo REVIVE-MARK-77\\r')`)
  const claude = await open('claude')
  const codex = await open('codex')
  t.check('tres sesiones creadas', !!shell && !!claude && !!codex, JSON.stringify([shell?.id, claude?.id, codex?.id]))
  t.check('Claude se lanzó con --session-id y lo recuerda', typeof claude?.resumeId === 'string' && claude.resumeId.length === 36, String(claude?.resumeId))
  const hist = (id) => evaluate(`window.omni.invoke('session:history', ${JSON.stringify(id)})`)
  t.check('el Claude falso arrancó con su id', await waitFor(`window.omni.invoke('session:history', ${JSON.stringify(claude.id)}).then((h) => h.includes('FAKE-CLAUDE nueva ${claude.resumeId}'))`, 8000), (await hist(claude.id)).slice(-200))
  t.check('el Codex falso arrancó', await waitFor(`window.omni.invoke('session:history', ${JSON.stringify(codex.id)}).then((h) => h.includes('FAKE-CODEX nueva'))`, 8000), (await hist(codex.id)).slice(-200))
  t.check('el shell imprimió el marcador', await waitFor(`window.omni.invoke('session:history', ${JSON.stringify(shell.id)}).then((h) => h.includes('REVIVE-MARK-77'))`, 5000), '')
  const codexId = /FAKE-CODEX nueva ([0-9a-f-]{36})/.exec(await hist(codex.id))?.[1] ?? null
  // `/resume` a otro chat dentro de Claude Code: el daemon lo sigue por ~/.claude/sessions/<pid>.json
  // y revivir debe retomar ese chat, no el del lanzamiento.
  const other = '0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  await evaluate(`window.omni.send('session:write', ${JSON.stringify(claude.id)}, '/resume ${other}\\r')`)
  t.check('el Claude falso cambió de chat', await waitFor(`window.omni.invoke('session:history', ${JSON.stringify(claude.id)}).then((h) => h.includes('FAKE-CLAUDE cambió a ${other}'))`, 5000), (await hist(claude.id)).slice(-200))
  t.check('el daemon aprendió el chat nuevo', await waitFor(`window.omni.invoke('session:list').then((l) => l.find((s) => s.id === ${JSON.stringify(claude.id)})?.resumeId === '${other}')`, 15000), '')
  // Foto de pantalla cada 5 s y `state:save` con debounce: se deja pasar una vuelta completa.
  await sleep(6500)
  writeFileSync(process.env.OMNI_REVIVE_IDS, JSON.stringify({ shell: shell.id, claude: claude.id, claudeResume: other, codex: codex.id, codexId }))
}
