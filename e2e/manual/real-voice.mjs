// Dictado con whisper REAL (app empaquetada: sin OMNI_FAKE_WHISPER) y voz sintetizada con `say`.
// La grabadora se sustituye por una que devuelve ese PCM: todo lo demás es real (⌥Space mantenido,
// whisper-cli + modelo base, texto escrito en el prompt del destino). No cubre el micrófono físico.
import { readFileSync } from 'node:fs'
import { ensurePane, closePanes } from '../scenarios/_helpers.mjs'

// Audio de prueba en base64 (un .webm corto con voz): `OMNI_VOICE_B64=<ruta> node e2e/cdp.mjs e2e/manual/real-voice.mjs`.
if (!process.env.OMNI_VOICE_B64) throw new Error('falta OMNI_VOICE_B64 con la ruta al audio de prueba en base64')
const B64 = readFileSync(process.env.OMNI_VOICE_B64, 'utf8')
const I = (p) => `import('${p}')`

export default async function (api, t) {
  const { evaluate, sleep, waitFor, cdp } = api
  const st = await evaluate(`window.omni.invoke('whisper:status')`)
  t.check('whisper real disponible (binario y modelo)', !!st.binary && !!st.model, JSON.stringify(st))
  await ensurePane(api)
  const shell = await evaluate(`${I('/src/store/sessions.ts')}.then((m) => m.useSessions.getState().sessions.filter((x) => x.agent === 'shell').sort((a, b) => b.createdAt - a.createdAt)[0])`)
  await evaluate(`${I('/src/store/voice.ts')}.then((m) => { const b = Uint8Array.from(atob(${JSON.stringify(B64)}), (c) => c.charCodeAt(0)).buffer; m.setRecorderFactory(() => ({ start: async () => undefined, stop: async () => b.slice(0), cancel: () => undefined })); return true })`)
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 1 })
  t.check('⌥Space abre el dictado', await waitFor(`!!document.querySelector('.voice')`, 3000))
  await sleep(3400)
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 1 | 8 })
  t.check('⇧ al soltar: whisper real transcribe y deja el texto para revisar', await waitFor(`!!document.querySelector('.voice textarea')`, 30000), await evaluate(`document.querySelector('.voice')?.textContent?.slice(0, 200) ?? 'sin overlay'`))
  const text = await evaluate(`document.querySelector('.voice textarea')?.value ?? ''`)
  t.check('la transcripción en español reconoce la frase', /re ?intento/i.test(text) && /exponencial/i.test(text), text)
  await api.press('escape')
  t.check('Esc descarta sin escribir en el shell', await waitFor(`!document.querySelector('.voice')`, 3000))
  await evaluate(`${I('/src/store/voice.ts')}.then((m) => m.setRecorderFactory(null))`)
  await closePanes(api, 1)
}
