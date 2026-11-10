// Dictado (§3.22) con whisper simulado (la app corre con OMNI_FAKE_WHISPER): mantener ⌥Space abre el
// overlay apuntando al pane con foco, soltar transcribe y escribe el texto en la terminal; ⇧ al soltar
// deja revisar antes de enviar; Esc descarta. La grabadora se sustituye por una falsa (sin micrófono).
import { ensurePane, closePanes } from './_helpers.mjs'

export default async function (api, t) {
  const { press, evaluate, snapshot, sleep, waitFor, cdp } = api
  const fake = await evaluate(`window.omni.invoke('whisper:status').then(() => true).catch(() => false)`)
  t.check('whisper:status responde', fake)
  await ensurePane(api)
  const shell = await evaluate(`import('/src/store/sessions.ts').then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0])`)
  // Grabadora falsa: 600 ms de silencio a 16 kHz
  await evaluate(`import('/src/store/voice.ts').then((m) => { m.setRecorderFactory(() => ({ start: async () => undefined, stop: async () => new ArrayBuffer(16000 * 2 * 0.6), cancel: () => undefined })); return true }).catch((e) => 'ERR ' + e.message)`)
  await evaluate(`import('/src/store/voice.ts').then((m) => { window.__voiceLog = []; m.useVoice.subscribe((st, prev) => { if (st.phase !== prev.phase) window.__voiceLog.push(st.phase + (st.reason ? ':' + st.reason + (st.detail ? ' ' + st.detail : '') : '')) }); return true })`)
  const log = () => evaluate(`JSON.stringify(window.__voiceLog)`)
  const keyDown = () => cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 1 })
  const keyUp = (shift) => cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 1 | (shift ? 8 : 0) })
  await keyDown()
  t.check('⌥Space mantenido abre el overlay de dictado apuntando al shell', await waitFor(`!!document.querySelector('.voice') && /Dictando a/.test(document.querySelector('.voice')?.textContent ?? '')`, 3000), JSON.stringify(await snapshot()))
  await sleep(700)
  await keyUp(false)
  t.check('al soltar, transcribe y escribe el texto en la terminal', await waitFor(`import('/src/panes/terminal/terminal-host.ts').then((m) => { const term = m.getTerminal(${JSON.stringify(shell.id)})?.term; if (!term) return false; const b = term.buffer.active; let all = ''; for (let i = 0; i <= b.baseY + b.cursorY; i++) all += b.getLine(i)?.translateToString(true) ?? ''; return /backoff exponencial/.test(all) })`, 8000), await log())
  t.check('el overlay se cierra solo tras enviar', await waitFor(`!document.querySelector('.voice')`, 4000))
  // Revisar antes de enviar
  await keyDown(); await sleep(700); await keyUp(true)
  t.check('⇧ al soltar deja el texto para revisar', await waitFor(`!!document.querySelector('.voice textarea, .voice .text-area')`, 6000), await log())
  if (process.env.E2E_SHOTS) await api.screenshot(process.env.E2E_SHOTS + '/voice-review.png')
  await press('escape')
  t.check('Esc descarta la revisión', await waitFor(`!document.querySelector('.voice')`, 3000))
  await closePanes(api, 1)
}
