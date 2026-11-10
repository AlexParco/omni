// MCP `omni-browser` (§3.23) contra la app viva: el servidor real por stdio sobre una página local de
// prueba. Navegar, leer con refs, escribir, clic, teclas (sin disparar atajos de omni), scroll, consola,
// eval, esperar, dibujar y capturar. Necesita que el socket del MCP sea el de esta app: con otro omni
// abierto, arrancar dev con `OMNI_SOCK=<ruta>` y correr el e2e con la misma variable.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const MCP = join(process.cwd(), 'bin', 'omni-browser-mcp.mjs')
const SESSIONS = `import('/src/store/sessions.ts')`

const PAGE = `<!doctype html><html><head><title>Prueba MCP</title><style>
body { font: 14px sans-serif; margin: 24px; } #tall { height: 3000px; } #cover { position: relative; }
#veil { position: absolute; inset: 0; background: rgba(0,0,0,.2); }
</style></head><body>
<h1>Página de prueba</h1>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'enviado ' + document.getElementById('name').value">
  <label for="name">Nombre</label> <input id="name" placeholder="tu nombre">
  <button type="button" id="hi" onclick="document.getElementById('out').textContent = 'Hola ' + document.getElementById('name').value">Saludar</button>
</form>
<p id="out">nada aún</p>
<div id="cover"><button id="hidden-btn" onclick="document.title = 'MAL'">Tapado</button><div id="veil"></div></div>
<a href="/two">Ir a la dos</a>
<div id="tall"></div><p>final de la página</p>
<script>console.error('boom-e2e'); setTimeout(() => { const p = document.createElement('p'); p.textContent = 'llegó tarde'; document.body.append(p) }, 700)</script>
</body></html>`

export default async function (api, t) {
  const { evaluate, sleep, waitFor } = api
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(req.url === '/two' ? '<!doctype html><title>Dos</title><h1>Segunda</h1>' : PAGE)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const proc = spawn('node', [MCP], { env: { ...process.env, OMNI_MCP_AGENT: 'e2e' }, stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = new Map()
  createInterface({ input: proc.stdout }).on('line', (line) => {
    const msg = JSON.parse(line)
    waiting.get(msg.id)?.(msg)
    waiting.delete(msg.id)
  })
  let nextId = 1
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  /** Llama una herramienta; devuelve { text, image, error }. */
  const call = async (name, args = {}) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    return { text, image: r.content.find((c) => c.type === 'image'), error: r.isError === true }
  }
  const refOf = (listing, pattern) => listing.split('\n').find((l) => pattern.test(l))?.match(/\[(r\d+)\]/)?.[1]

  let sessionId = null
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
    t.check('el servidor se presenta como omni-browser', init.result?.serverInfo?.name === 'omni-browser', JSON.stringify(init.result?.serverInfo))

    const nav = await call('navigate', { url: base, newTab: true })
    sessionId = JSON.parse(nav.text).sessionId
    t.check('navigate abre un navegador nuevo y espera la carga', !nav.error && /Prueba MCP/.test(nav.text), nav.text)
    await waitFor(`!!document.querySelector('.pane .browser')`, 5000)

    const tabs = JSON.parse((await call('tabs')).text)
    t.check('tabs lista el navegador como destino por defecto', tabs.some((x) => x.sessionId === sessionId && x.target), JSON.stringify(tabs))

    const read = (await call('read_page')).text
    const field = refOf(read, /textbox "Nombre"/)
    const button = refOf(read, /button "Saludar"/)
    const covered = refOf(read, /button "Tapado"/)
    const link = refOf(read, /link "Ir a la dos"/)
    t.check('read_page lista controles con ref, nombre y href', !!field && !!button && !!covered && /href=\/two/.test(read) && /heading "Página de prueba" h1/.test(read), read)

    const typed = await call('type', { ref: field, text: 'Ana' })
    t.check('type escribe en el campo por ref', !typed.error && (await call('eval', { code: `document.getElementById('name').value` })).text === 'Ana', typed.text)
    const replaced = await call('type', { ref: field, text: 'Bea', clear: true })
    t.check('type con clear reemplaza el contenido', !replaced.error && (await call('eval', { code: `document.getElementById('name').value` })).text === 'Bea', replaced.text)

    const click = await call('click', { ref: button })
    const outText = (await call('eval', { code: `document.getElementById('out').textContent` })).text
    t.check('click por ref dispara el onclick de la página (eventos de ratón de verdad)', !click.error && outText === 'Hola Bea' && /"via": "cdp"/.test(click.text), `${click.text} · out=${outText}`)

    await call('click', { ref: field })
    await call('press_key', { keys: 'Enter' })
    t.check('press_key Enter envía el formulario', (await call('eval', { code: `document.getElementById('out').textContent` })).text === 'enviado Bea')

    const overlayBefore = await evaluate(`import('/src/store/ui.ts').then((m) => m.useUi.getState().overlay)`)
    await call('press_key', { keys: 'cmd+k' })
    await sleep(250)
    const overlayAfter = await evaluate(`import('/src/store/ui.ts').then((m) => m.useUi.getState().overlay)`)
    t.check('una tecla con ⌘ del agente no dispara atajos de omni', overlayBefore === overlayAfter, `${overlayBefore} → ${overlayAfter}`)

    const tapado = await call('click', { ref: covered })
    t.check('click sobre algo tapado falla diciendo qué lo tapa', tapado.error && /tapado por div#veil/.test(tapado.text) && (await call('eval', { code: 'document.title' })).text !== 'MAL', tapado.text)

    const scrolled = JSON.parse((await call('scroll', { direction: 'down', amount: 900 })).text)
    t.check('scroll desplaza la página', scrolled.box === 'page' && scrolled.top >= 800, JSON.stringify(scrolled))
    await call('scroll', { direction: 'up', amount: 5000 })

    const consoleOut = await call('console', { pattern: 'boom' })
    t.check('console devuelve los errores de la página', /boom-e2e/.test(consoleOut.text), consoleOut.text)

    const late = await call('wait_for', { text: 'llegó tarde', timeout: 5000 })
    t.check('wait_for espera texto que aparece después', !late.error, late.text)
    const never = await call('wait_for', { text: 'nunca jamás', timeout: 400 })
    t.check('wait_for vence con error humano', never.error && /no se cumplió/.test(never.text), never.text)

    const fresh = (await call('read_page')).text
    const out = refOf(fresh, /button "Saludar"/)
    const drawn = await call('draw', { shapes: [{ kind: 'box', ref: out, label: 'Este botón' }, { kind: 'arrow', x: 400, y: 300, ref: out, color: 'blue' }, { kind: 'dot', x: 40, y: 40, label: '1' }, { kind: 'text', x: 300, y: 40, label: 'Nota del agente' }] })
    const layer = await call('eval', { code: `document.querySelector('[data-omni-draw]')?.childElementCount ?? 0` })
    t.check('draw pinta caja con etiqueta, flecha, punto y texto sobre la página', !drawn.error && Number(layer.text) >= 5, `${drawn.text} · ${layer.text}`)
    const readDrawn = (await call('read_page', { mode: 'all' })).text
    t.check('read_page no lee las marcas de omni como contenido', !/Nota del agente/.test(readDrawn))

    const shot = await call('screenshot')
    const meta = JSON.parse(shot.text)
    t.check('screenshot devuelve una imagen JPEG al ancho CSS de la vista', !!shot.image && shot.image.mimeType === 'image/jpeg' && shot.image.data.length > 2000 && meta.width > 200, shot.text)
    if (process.env.E2E_SHOTS && shot.image) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(process.env.E2E_SHOTS, 'browser-mcp-draw.jpg'), Buffer.from(shot.image.data, 'base64'))
    }

    const cleared = await call('draw', { clear: true })
    t.check('draw clear borra las marcas', !cleared.error && (await call('eval', { code: `!!document.querySelector('[data-omni-draw]')` })).text === 'false')

    const go = await call('click', { ref: link })
    t.check('un clic en un enlace navega y espera la página nueva', !go.error && /\/two/.test(JSON.parse(go.text).url), go.text)
    const gone = await call('click', { ref: field })
    t.check('un ref de la página anterior falla pidiendo volver a leer', gone.error && /vuelve a leerla/.test(gone.text), gone.text)
    const back = await call('navigate', { url: 'back' })
    t.check('navigate back vuelve atrás', !back.error && /Prueba MCP/.test(back.text), back.text)

    const evalErr = await call('eval', { code: 'const a = 1; null.boom' })
    t.check('eval con excepción devuelve el mensaje real', evalErr.error && /TypeError/.test(evalErr.text), evalErr.text)
    const evalOk = await call('eval', { code: 'const n = 2; ({ n, t: document.title })' })
    t.check('eval devuelve la última expresión como JSON', /"n": 2/.test(evalOk.text) && /Prueba MCP/.test(evalOk.text), evalOk.text)

    t.check('la franja del navegador muestra el aviso MCP', await waitFor(`/MCP/.test([...document.querySelectorAll('.pane .strip')].map((s) => s.textContent).join(' '))`, 3000))
  } finally {
    proc.stdin.end()
    server.close()
    if (sessionId) await evaluate(`${SESSIONS}.then((m) => m.useSessions.getState().kill(${JSON.stringify(sessionId)}))`)
    await sleep(300)
  }
}
