// Servidor de lenguaje en el editor (ARCHITECTURE §3.19b), contra servidores reales y sin red:
// un proyecto de prueba con el TypeScript 7 de omni (`tsc --lsp`) y, si existe en esta máquina, otro
// con un TypeScript 5 (typescript-language-server + su tsserver). En cada uno: cabecera con el
// servidor, error de tipos en vivo (sin guardar), error nuevo al escribir, autocompletado del
// servidor, tipos al pasar el mouse, `gd` y F12 a otro archivo, ⇧F12 referencias y F2 renombrar.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
// Carpeta `node_modules/typescript` de algún proyecto con TypeScript 5 (opcional): se compara contra ella.
const TS5 = process.env.OMNI_E2E_TS5 ?? join(homedir(), 'node_modules', 'typescript')
const S = `import('/src/store/sessions.ts')`
const D = `import('/src/store/docs.ts')`
const E = `import('/src/panes/editor/editor-store.ts')`
const A_TS = "export function greet(name: string): string {\n  return 'hola ' + name\n}\n"
const B_TS = "import { greet } from './a'\n\nconst n: number = greet('mundo')\nconsole.log(n, greet('otra'))\n"

function fixture(name, typescriptDir) {
  // Dentro del HOME (la app solo abre proyectos ahí); con `HOME=<scratch>` el e2e no ensucia el real.
  const dir = join(homedir(), `.omni-e2e-lsp-${name}-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(typescriptDir, join(dir, 'node_modules', 'typescript'))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true }, include: ['*.ts'] }, null, 2))
  writeFileSync(join(dir, 'a.ts'), A_TS)
  writeFileSync(join(dir, 'b.ts'), B_TS)
  return dir
}

export default async function (api, t) {
  const cases = [{ name: 'ts7', ts: join(ROOT, 'node_modules', 'typescript'), expect: /^TypeScript 7\./ }]
  if (existsSync(join(TS5, 'lib', 'tsserver.js'))) cases.push({ name: 'ts5', ts: TS5, expect: /^TypeScript 5\./ })
  else t.check('TypeScript 5 de referencia (opcional)', true, `no está ${TS5}: solo se prueba TS 7`)
  for (const c of cases) await runCase(api, t, c)
}

async function runCase(api, t, { name, ts, expect }) {
  const { evaluate, press, type, sleep, waitFor, cdp, screenshot } = api
  const dir = fixture(name, ts)
  const b = join(dir, 'b.ts')
  const a = join(dir, 'a.ts')
  const tag = `[${name}]`
  let opened = []
  try {
    const ws = await evaluate(`${S}.then((m) => m.useSessions.getState().openProjectPath(${JSON.stringify(dir)})).then((r) => r.workspace.id)`)
    const info = await evaluate(`${D}.then((m) => m.useDocs.getState().open(${JSON.stringify(ws)}, ${JSON.stringify(b)}, 'editor', 'tab'))`)
    opened.push(info.id)
    const doc = (field) => `${E}.then((m) => m.useEditor.getState().docs[${JSON.stringify(info.id)}]?.${field})`
    t.check(`${tag} servidor listo en la cabecera`, await waitFor(`${doc('lsp')}.then((l) => l?.state === 'ready')`, 20000), JSON.stringify(await evaluate(doc('lsp'))))
    const lspName = (await evaluate(doc('lsp')))?.name ?? ''
    t.check(`${tag} el servidor es el TypeScript del proyecto`, expect.test(lspName), lspName)
    const label = await evaluate(`document.querySelector('.editor[data-session-id="${info.id}"] .editor__lang')?.textContent`)
    t.check(`${tag} la cabecera dice el servidor`, label === lspName, label)

    // Error de tipos en vivo: TS2322 (string no va en number) sin haber guardado nada.
    const hasCode = (code) => `${doc('diagnostics')}.then((d) => (d ?? []).some((x) => x.source === 'lsp' && x.code === '${code}'))`
    t.check(`${tag} error de tipos del servidor (TS2322)`, await waitFor(hasCode('TS2322'), 20000), JSON.stringify(await evaluate(doc('diagnostics'))))
    const tools = await evaluate(doc('diagnostics'))
    t.check(`${tag} tsc no duplica los errores del servidor`, !(tools ?? []).some((x) => x.source === 'tsc'), JSON.stringify(tools?.map((x) => x.source)))
    await sleep(300)
    if (process.env.E2E_SHOTS) await screenshot(join(process.env.E2E_SHOTS, `lsp-${name}-error.png`))

    // Escribir un error nuevo (vim: G o + texto + Esc): aparece sin guardar.
    await evaluate(`document.querySelector('.editor[data-session-id="${info.id}"] .cm-content')?.focus()`)
    await sleep(200)
    await press('G')
    await press('o')
    await type('const flag: boolean = 42')
    await press('escape')
    t.check(`${tag} error nuevo al escribir, sin guardar`, await waitFor(`${doc('diagnostics')}.then((d) => (d ?? []).filter((x) => x.source === 'lsp' && x.code === 'TS2322').length >= 2)`, 15000), JSON.stringify(await evaluate(doc('diagnostics'))))
    t.check(`${tag} el archivo sigue sin guardar`, readFileSync(b, 'utf8') === B_TS, '')

    // Autocompletado del servidor: en INSERT, `gre` ofrece `greet` (viene del import, no de las palabras del archivo).
    await press('o')
    await type('gre')
    const completes = await waitFor(`[...document.querySelectorAll('.cm-tooltip-autocomplete li')].some((li) => li.textContent.startsWith('greet'))`, 10000)
    t.check(`${tag} autocompletado del servidor ofrece greet`, completes, await evaluate(`[...document.querySelectorAll('.cm-tooltip-autocomplete li')].map((li) => li.textContent).slice(0, 5).join(' | ')`))
    if (process.env.E2E_SHOTS) await screenshot(join(process.env.E2E_SHOTS, `lsp-${name}-completion.png`))
    await press('escape')
    await press('escape')
    // Deshace lo escrito (dos cambios) para que las líneas del archivo queden como en disco.
    await press('u')
    await press('u')
    await sleep(300)

    // Tipos al pasar el mouse sobre `greet` de la línea 3.
    const rect = await evaluate(`(() => {
      const line = [...document.querySelectorAll('.editor[data-session-id="${info.id}"] .cm-line')].find((l) => l.textContent.startsWith('const n'))
      if (!line) return null
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      for (let node; (node = walker.nextNode()); ) {
        const i = node.textContent.indexOf('greet')
        if (i < 0) continue
        const r = document.createRange(); r.setStart(node, i + 1); r.setEnd(node, i + 2)
        const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      }
      return null
    })()`)
    if (rect) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
      const hover = await waitFor(`/greet\\(name: string\\)/.test(document.querySelector('.cm-lsp-hover-tooltip')?.textContent ?? '')`, 10000)
      t.check(`${tag} tipos al pasar el mouse`, hover, await evaluate(`document.querySelector('.cm-lsp-hover-tooltip')?.textContent ?? 'sin tooltip'`))
      if (process.env.E2E_SHOTS) await screenshot(join(process.env.E2E_SHOTS, `lsp-${name}-hover.png`))
      await api.parkMouse()
    } else t.check(`${tag} tipos al pasar el mouse`, false, 'no se encontró greet en la línea 3')

    // `gd` sobre `greet` (búsqueda de vim): abre a.ts al lado con el cursor en la función.
    await evaluate(`document.querySelector('.editor[data-session-id="${info.id}"] .cm-content')?.focus()`)
    // Línea 3 y luego la primera `g` (la de `greet`): la búsqueda de vim con `(` no es fiable.
    await press('3')
    await press('G')
    await press('f')
    await press('g')
    await sleep(200)
    await press('g')
    await press('d')
    const aId = `${S}.then((m) => m.useSessions.getState().sessions.find((s) => s.agent === 'editor' && s.args?.[0] === ${JSON.stringify(a)})?.id ?? null)`
    t.check(`${tag} gd abre el archivo de la definición`, await waitFor(`${aId}.then((id) => !!id)`, 10000), '')
    const aSession = await evaluate(aId)
    if (aSession) opened.push(aSession)
    const aLine = await waitFor(`${E}.then((m) => m.useEditor.getState().docs[${JSON.stringify(aSession)}]?.line === 0)`, 5000)
    t.check(`${tag} gd deja el cursor en la definición (línea 1)`, aLine, String(await evaluate(`${E}.then((m) => m.useEditor.getState().docs[${JSON.stringify(aSession)}]?.line)`)))

    // Con dos editores lado a lado la cabecera es angosta: nada se parte ni se sale de ella.
    const bars = await evaluate(`[...document.querySelectorAll('.editor__bar')].map((bar) => { const r = bar.getBoundingClientRect(); const kids = [...bar.querySelectorAll('.btn, .badge, .editor__diagnostics')]; return { right: Math.round(r.right), h: Math.round(r.height), out: kids.filter((k) => k.getBoundingClientRect().right > r.right + 0.5).map((k) => k.textContent), tall: kids.filter((k) => k.getBoundingClientRect().height > r.height).map((k) => k.textContent) } })`)
    t.check(`${tag} cabeceras en split: nada se sale ni se parte en dos líneas`, bars.length >= 2 && bars.every((b) => b.out.length === 0 && b.tall.length === 0), JSON.stringify(bars))

    // F12 desde b.ts también salta (comando editor.definition); ⇧F12 lista las referencias.
    await evaluate(`${D}.then((m) => m.useDocs.getState().open(${JSON.stringify(ws)}, ${JSON.stringify(b)}, 'editor', 'tab'))`)
    await sleep(300)
    await evaluate(`document.querySelector('.editor[data-session-id="${info.id}"] .cm-content')?.focus()`)
    // Línea 3 y luego la primera `g` (la de `greet`): la búsqueda de vim con `(` no es fiable.
    await press('3')
    await press('G')
    await press('f')
    await press('g')
    await sleep(200)
    await press('shift+f12')
    const refs = await waitFor(`document.querySelectorAll('.cm-lsp-reference-panel .cm-lsp-reference').length >= 3`, 10000)
    t.check(`${tag} ⇧F12 lista las referencias (declaración, import y 2 usos)`, refs, await evaluate(`document.querySelector('.cm-lsp-reference-panel')?.textContent ?? 'sin panel'`))
    if (process.env.E2E_SHOTS) await screenshot(join(process.env.E2E_SHOTS, `lsp-${name}-refs.png`))
    await press('escape')
    await sleep(150)

    // F2 renombra en los dos archivos (sin guardar: los buffers quedan sucios).
    await press('f2')
    const panel = await waitFor(`!!document.querySelector('.cm-lsp-rename-panel input')`, 5000)
    t.check(`${tag} F2 abre el panel de renombrar`, panel, '')
    if (panel) {
      await evaluate(`(() => { const i = document.querySelector('.cm-lsp-rename-panel input'); i.value = 'saludar'; i.form.requestSubmit() })()`)
      const renamed = await waitFor(`[...document.querySelectorAll('.editor[data-session-id="${info.id}"] .cm-line')].some((l) => l.textContent.includes("saludar('mundo')"))`, 10000)
      t.check(`${tag} F2 renombra greet → saludar`, renamed, '')
    }
  } finally {
    // Cierra sin guardar (los buffers renombrados quedan sucios: se matan directo) y borra el proyecto de prueba.
    for (const id of opened) await evaluate(`${S}.then((m) => m.useSessions.getState().kill(${JSON.stringify(id)}))`).catch(() => null)
    await evaluate(`${S}.then((m) => { const s = m.useSessions.getState(); const p = s.projects.find((x) => x.locations[0]?.path === ${JSON.stringify(dir)}); return p ? s.removeProject?.(p.id) : null })`).catch(() => null)
    await sleep(300)
    rmSync(dir, { recursive: true, force: true })
  }
}
