// Servidor de lenguaje y diagnósticos en un servidor (§3.19b, §3.26) con el ssh falso (`OMNI_SSH_BIN`, HOME
// aislado): un proyecto TypeScript 7 en una carpeta remota; abrir un archivo lanza el `tsc --lsp` del
// proyecto EN EL HOST por `ssh -T` y el editor recibe el error de tipos en vivo. Además, el `tsc` del
// proyecto corre en el host para los diagnósticos del editor. Con el ssh falso el "servidor" es este Mac.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
const S = `import('/src/store/sessions.ts')`
const D = `import('/src/store/docs.ts')`
const E = `import('/src/panes/editor/editor-store.ts')`

export default async function (api, t) {
  const { evaluate, waitFor } = api
  const home = homedir()
  if (!home.startsWith('/tmp') && !home.includes('omni-')) {
    t.check('escenario remoto (requiere HOME aislado y OMNI_SSH_BIN)', true, `se salta: HOME=${home}`)
    return
  }
  const dir = join(home, 'srv', 'lsp-app')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(dir, 'node_modules', 'typescript'))
  // Como un `pnpm install`: los diagnósticos buscan `node_modules/.bin/tsc`.
  mkdirSync(join(dir, 'node_modules', '.bin'))
  symlinkSync('../typescript/bin/tsc', join(dir, 'node_modules', '.bin', 'tsc'))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true }, include: ['*.ts'] }))
  writeFileSync(join(dir, 'a.ts'), "export function greet(name: string): string {\n  return 'hola ' + name\n}\n")
  writeFileSync(join(dir, 'b.ts'), "import { greet } from './a'\n\nconst n: number = greet('mundo')\nconsole.log(n)\n")
  const { host } = await evaluate(`window.omni.invoke('host:add', 'vps-lsp', 'vps-lsp')`)
  await evaluate(`window.omni.invoke('host:connect', ${JSON.stringify(host.id)})`)
  const project = await evaluate(`window.omni.invoke('project:create', 'LSP remoto e2e')`)
  let opened = null
  try {
    const ws = await evaluate(`window.omni.invoke('project:addLocation', ${JSON.stringify(project.id)}, { path: ${JSON.stringify(dir)}, host: ${JSON.stringify(host.id)} })`)
    await evaluate(`${S}.then((m) => m.useSessions.getState().reloadProjects())`)
    // La ruta que guardó el host (real, sin symlinks): las del editor son relativas a ella.
    const b = join(ws.path, 'b.ts')
    const info = await evaluate(`${D}.then((m) => m.useDocs.getState().open(${JSON.stringify(ws.id)}, ${JSON.stringify(b)}, 'editor', 'tab'))`)
    opened = info.id
    const doc = (field) => `${E}.then((m) => m.useEditor.getState().docs[${JSON.stringify(info.id)}]?.${field})`
    t.check('el servidor de lenguaje del host queda listo', await waitFor(`${doc('lsp')}.then((l) => l?.state === 'ready')`, 30000), JSON.stringify(await evaluate(doc('lsp'))))
    const name = (await evaluate(doc('lsp')))?.name ?? ''
    t.check('es el TypeScript del proyecto en el host', /^TypeScript 7\./.test(name), name)
    t.check('el error de tipos llega del servidor remoto (TS2322)', await waitFor(`${doc('diagnostics')}.then((d) => (d ?? []).some((x) => x.source === 'lsp' && x.code === 'TS2322'))`, 30000), JSON.stringify(await evaluate(doc('diagnostics'))))
    const check = await evaluate(`window.omni.invoke('diagnostics:check', ${JSON.stringify(ws.id)}, ${JSON.stringify(b)}, ['eslint'])`)
    t.check('los diagnósticos del editor corren el tsc del proyecto en el host', check.tools.includes('tsc') && check.diagnostics.some((d) => d.code === 'TS2322'), JSON.stringify(check))
  } finally {
    if (opened) await evaluate(`${S}.then((m) => m.useSessions.getState().kill(${JSON.stringify(opened)}))`).catch(() => undefined)
    await evaluate(`window.omni.invoke('project:remove', ${JSON.stringify(project.id)}).then(() => window.omni.invoke('host:remove', ${JSON.stringify(host.id)})).then(() => ${S}).then((m) => m.useSessions.getState().reloadProjects())`).catch(() => undefined)
    rmSync(join(home, 'srv'), { recursive: true, force: true })
  }
}
