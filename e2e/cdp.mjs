// Runner de pruebas end-to-end contra la app en desarrollo, vía Chrome DevTools Protocol.
//
//   OMNI_CDP_PORT=9229 pnpm dev        # en otra terminal
//   pnpm e2e                           # corre todos los escenarios de e2e/scenarios
//   pnpm e2e split                     # solo los escenarios cuyo nombre contenga "split"
//
// Cada escenario exporta `default async (api, t) => {}`. `api` despacha teclas y ratón reales
// (pasan por xterm, el prefijo C-a y los overlays igual que las del usuario) y evalúa JS en el
// renderer. `t.check(nombre, ok, detalle)` acumula el resultado. Los escenarios deben dejar la
// app como la encontraron.
import { readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PORT = process.env.OMNI_CDP_PORT ?? '9229'
const HERE = dirname(fileURLToPath(import.meta.url))

/** modifiers de CDP: alt=1 ctrl=2 meta=4 shift=8 */
const MOD = { alt: 1, ctrl: 2, meta: 4, cmd: 4, shift: 8 }
const KEYS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  '"': { key: '"', code: 'Quote', vk: 222, text: '"', shift: true },
  '%': { key: '%', code: 'Digit5', vk: 53, text: '%', shift: true },
  '|': { key: '|', code: 'Backslash', vk: 220, text: '|', shift: true },
  '\\': { key: '\\', code: 'Backslash', vk: 220, text: '\\' },
  '-': { key: '-', code: 'Minus', vk: 189, text: '-' },
  '[': { key: '[', code: 'BracketLeft', vk: 219, text: '[' },
  ']': { key: ']', code: 'BracketRight', vk: 221, text: ']' },
  '{': { key: '{', code: 'BracketLeft', vk: 219, text: '{', shift: true },
  '}': { key: '}', code: 'BracketRight', vk: 221, text: '}', shift: true },
  _: { key: '_', code: 'Minus', vk: 189, text: '_', shift: true },
  '?': { key: '?', code: 'Slash', vk: 191, text: '?', shift: true },
  '/': { key: '/', code: 'Slash', vk: 191, text: '/' },
  ',': { key: ',', code: 'Comma', vk: 188, text: ',' },
  '.': { key: '.', code: 'Period', vk: 190, text: '.' },
  ';': { key: ';', code: 'Semicolon', vk: 186, text: ';' },
  '&': { key: '&', code: 'Digit7', vk: 55, text: '&', shift: true },
  '!': { key: '!', code: 'Digit1', vk: 49, text: '!', shift: true },
  '{': { key: '{', code: 'BracketLeft', vk: 219, text: '{', shift: true },
  '}': { key: '}', code: 'BracketRight', vk: 221, text: '}', shift: true }
}
for (const c of 'abcdefghijklmnopqrstuvwxyz') KEYS[c] = { key: c, code: `Key${c.toUpperCase()}`, vk: c.toUpperCase().charCodeAt(0), text: c }
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') KEYS[c] = { key: c, code: `Key${c}`, vk: c.charCodeAt(0), text: c, shift: true }
for (const d of '0123456789') KEYS[d] = { key: d, code: `Digit${d}`, vk: d.charCodeAt(0), text: d }
for (let n = 1; n <= 12; n++) KEYS[`f${n}`] = { key: `F${n}`, code: `F${n}`, vk: 111 + n }

async function connect() {
  let targets
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  } catch {
    throw new Error(`no hay CDP en el puerto ${PORT}: levanta la app con OMNI_CDP_PORT=${PORT} pnpm dev`)
  }
  // Dev sirve el renderer en localhost; la app empaquetada lo carga desde file://…/out/renderer/index.html.
  const page = targets.find((t) => t.type === 'page' && (/^http:\/\/localhost:\d+\/?$/.test(t.url) || /\/out\/renderer\/index\.html$/.test(t.url)))
  if (!page) throw new Error('renderer no encontrado: ' + JSON.stringify(targets.map((t) => t.url)))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  // Chromium descarta la entrada CDP si considera que la página no tiene el foco (p. ej. tras
  // recargar el renderer mientras una vista de navegador lo tenía). Emular el foco lo evita.
  const enableFocusEmulation = async () => {
    try {
      await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    } catch {
      /* versiones sin el dominio: se sigue sin emular */
    }
  }
  ws.onclose = () => {
    for (const { rej } of pending.values()) rej(new Error('CDP cerró la conexión (¿la app se reinició?)'))
    pending.clear()
  }
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      pending.set(++id, { res, rej })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // App empaquetada (renderer en file://): sin servidor de Vite, los `import('/src/…')` pasan por el gancho del bundle.
  const packaged = /^file:/.test(page.url ?? '')
  const evaluate = async (raw) => {
    const expression = packaged ? raw.replace(/import\('(\/src\/[^']+)'\)/g, "window.__omniImport('$1')") : raw
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'error en evaluate')
    return r.result.value
  }

  /** press('ctrl+a'), press('"'), press('cmd+shift+d') — mismo vocabulario que keybindings.ts */
  const press = async (chord) => {
    const parts = chord.split('+')
    const name = parts.pop()
    const k = KEYS[name]
    if (!k) throw new Error('tecla desconocida: ' + name)
    let modifiers = 0
    for (const p of parts) modifiers |= MOD[p]
    if (k.shift) modifiers |= MOD.shift
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers }
    const hasText = k.text && !(modifiers & (MOD.ctrl | MOD.meta))
    await send('Input.dispatchKeyEvent', {
      type: hasText ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(hasText ? { text: k.text, unmodifiedText: k.text } : {})
    })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(60)
  }
  /** Texto literal en lo que tenga el foco (una terminal incluida). */
  const type = async (text) => {
    for (const ch of text) {
      if (ch === '\n') await press('enter')
      else await send('Input.insertText', { text: ch })
    }
    await sleep(30)
  }
  /** Clic real de CDP en un punto (coordenadas CSS del renderer). */
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(80)
  }
  const click = async (selector) => {
    const pt = await evaluate(
      // Si la fila está fuera del área visible de su lista (sidebar o diálogo con scroll), el clic al
      // centro caería en otro elemento: se trae a la vista primero.
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`
    )
    if (!pt) throw new Error('no existe ' + selector)
    const [x, y] = pt
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(80)
  }
  /** Lleva el puntero a un rincón: el hover de un clic anterior no ensucia capturas ni estados. */
  const parkMouse = async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
    await sleep(50)
  }
  const count = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  /** Espera hasta que `expression` sea truthy (o vence el plazo). */
  const waitFor = async (expression, timeoutMs = 3000) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await evaluate(expression)) return true
      await sleep(50)
    }
    return false
  }
  /** Foto del estado visible que todos los escenarios consultan. */
  const snapshot = () =>
    evaluate(`({
      focus: document.querySelector('.app')?.dataset.focus ?? null,
      overlay: !!document.querySelector('.overlay'),
      placeholder: document.querySelector('.picker__input input')?.placeholder ?? document.querySelector('.picker__title')?.textContent ?? null,
      inputValue: document.querySelector('.picker__input input')?.value ?? null,
      panes: document.querySelectorAll('.pane').length,
      tabs: document.querySelectorAll('.tabs .tab:not(.tab--action)').length,
      active: (document.activeElement?.tagName ?? '') + '.' + (document.activeElement?.className ?? '')
    })`)

  /** Emula otro tamaño de ventana (ancho, alto); `setViewport(null)` lo restaura. */
  const setViewport = async (width, height) => {
    if (width === null) return send('Emulation.clearDeviceMetricsOverride')
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false })
  }
  /** Trae la ventana de omni al frente: las vistas nativas (navegador) no pintan si la ventana está tapada. */
  const bringToFront = async () => {
    await send('Page.bringToFront')
    await sleep(150)
  }
  /** Prefijo configurado en la app (⌘,): los escenarios nunca asumen `ctrl+a`. */
  const prefix = async () => (await evaluate(`window.omni.invoke('settings:get')`)).prefix
  /** Captura PNG del renderer (para revisar a ojo lo que el DOM no cuenta: color, espaciado). */
  const screenshot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(file, Buffer.from(r.data, 'base64'))
    return file
  }

  await enableFocusEmulation()
  // Un escenario de resize abortado deja el viewport emulado (p. ej. 1280 × 800) y las vistas nativas
  // caen fuera del área capturable ("display surface not available"): se limpia al conectar.
  await send('Emulation.clearDeviceMetricsOverride').catch(() => null)
  /**
   * Teclas a la página embebida (la vista es otro target CDP): recorren `before-input-event` de main
   * y el reenvío `browser:key`, como las del usuario con el clic dentro de la página. `null` si no hay vista.
   */
  const pressInView = async (chord, match = '') => {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    // `match` acota a una vista concreta (por título o URL): el usuario puede tener otros navegadores abiertos.
    const view = targets.find((t) => t.type === 'page' && !/^http:\/\/localhost:\d+\/?$/.test(t.url) && !/\/out\/renderer\/index\.html$/.test(t.url) && !t.url.includes('devtools') && (t.url.includes(match) || (t.title ?? '').includes(match)))
    if (!view) return null
    const vws = new WebSocket(view.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      vws.onopen = res
      vws.onerror = rej
    })
    let vid = 0
    const vpending = new Map()
    vws.onmessage = (m) => {
      const msg = JSON.parse(m.data)
      if (msg.id && vpending.has(msg.id)) {
        const { res, rej } = vpending.get(msg.id)
        vpending.delete(msg.id)
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
      }
    }
    const vsend = (method, params = {}) =>
      new Promise((res, rej) => {
        vpending.set(++vid, { res, rej })
        vws.send(JSON.stringify({ id: vid, method, params }))
      })
    try {
      const parts = chord.split('+')
      const name = parts.pop()
      const k = KEYS[name]
      if (!k) throw new Error('tecla desconocida: ' + name)
      let modifiers = 0
      for (const p of parts) modifiers |= MOD[p]
      if (k.shift) modifiers |= MOD.shift
      const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers }
      // En la vista siempre `rawKeyDown`: Electron reporta el `keyDown` con texto de CDP como otro tipo y
      // `before-input-event` lo ignora; un teclado real manda keyDown normal. Para atajos basta el keydown.
      await vsend('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
      await vsend('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await sleep(80)
      return true
    } finally {
      vws.close()
    }
  }
  /** Llamada CDP cruda para experimentos (Emulation.*, Page.*). */
  const cdp = (method, params = {}) => send(method, params)
  return { evaluate, press, type, click, clickAt, parkMouse, setViewport, prefix, bringToFront, cdp, pressInView, count, waitFor, snapshot, screenshot, sleep, close: () => ws.close() }
}

function makeT(name) {
  const results = []
  return {
    results,
    check(label, ok, detail = '') {
      results.push({ ok: !!ok, label, detail })
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  · ' + detail : ''}`)
    },
    log: (...a) => console.log('     ', ...a),
    name
  }
}

// Argumentos: filtros por nombre de escenario, o rutas explícitas a archivos .mjs (scripts sueltos).
const args = process.argv.slice(2)
const explicit = args.filter((a) => a.endsWith('.mjs')).map((a) => resolve(a))
const filters = args.filter((a) => !a.endsWith('.mjs'))
const files = explicit.length
  ? explicit
  : readdirSync(join(HERE, 'scenarios'))
      .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
      .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
      .sort()
      .map((f) => join(HERE, 'scenarios', f))

const api = await connect()
let failed = 0
try {
  for (const file of files) {
    console.log(`\n${basename(file)}`)
    const t = makeT(file)
    try {
      const mod = await import(pathToFileURL(file).href)
      await mod.default(api, t)
    } catch (err) {
      t.check('sin excepción', false, String(err?.message ?? err))
      if (process.env.E2E_DEBUG && err?.stack) console.log('      ' + String(err.stack).split('\n').slice(0, 4).join('\n      '))
    }
    failed += t.results.filter((r) => !r.ok).length
  }
} finally {
  api.close()
}
console.log(failed === 0 ? '\ntodo ok' : `\n${failed} fallo(s)`)
process.exitCode = failed === 0 ? 0 : 1
