import { describe, expect, it, vi } from 'vitest'
import type { ExecOptions, ExecResult } from '../exec'
import { DiagnosticsService, dirsUpTo, parseEslint, parseTsc, stripJsonc, tscConfigs } from './diagnostics'

describe('dirsUpTo', () => {
  it('sube desde la carpeta del archivo hasta la raíz del workspace, sin pasarla', () => {
    expect(dirsUpTo('/w/src/a', '/w')).toEqual(['/w/src/a', '/w/src', '/w'])
    expect(dirsUpTo('/w', '/w')).toEqual(['/w'])
  })
})

describe('tsconfig', () => {
  it('quita comentarios y comas finales sin tocar strings con barras', () => {
    const text = '{\n  // hola\n  "a": "http://x/*y*/", /* bloque */\n  "b": [1, 2,],\n}'
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: 'http://x/*y*/', b: [1, 2] })
  })

  it('un tsconfig "solución" (files vacío + references) se reemplaza por sus referencias', () => {
    const text = '{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./packages/app" }] }'
    expect(tscConfigs('/w/tsconfig.json', text)).toEqual(['/w/tsconfig.node.json', '/w/packages/app/tsconfig.json'])
  })

  it('un tsconfig normal (o ilegible) se revisa tal cual', () => {
    expect(tscConfigs('/w/tsconfig.json', '{ "include": ["src"], "references": [{ "path": "./x" }] }')).toEqual(['/w/tsconfig.json'])
    expect(tscConfigs('/w/tsconfig.json', '{ roto')).toEqual(['/w/tsconfig.json'])
  })
})

describe('parseTsc', () => {
  it('lee ruta(línea,col), severidad, código y las líneas de continuación', () => {
    const out = "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(4,3): error TS2345: Argument of type 'X'\n  Type 'X' is missing the following properties.\nbasura que no es diagnóstico"
    const d = parseTsc(out, '/w')
    expect(d).toHaveLength(2)
    expect(d[0]).toMatchObject({ path: '/w/src/a.ts', line: 1, col: 7, endLine: null, severity: 'error', source: 'tsc', code: 'TS2322' })
    expect(d[1].message).toBe("Argument of type 'X'\nType 'X' is missing the following properties.")
  })
})

describe('parseEslint', () => {
  it('convierte severidad 2/1 en error/aviso y conserva el rango y la regla', () => {
    const json = JSON.stringify([{ filePath: '/w/a.ts', messages: [{ line: 2, column: 5, endLine: 2, endColumn: 9, severity: 2, message: 'x no se usa', ruleId: 'no-unused-vars' }, { line: 3, column: 1, severity: 1, message: 'aviso', ruleId: null }] }])
    expect(parseEslint(json)).toEqual([
      { path: '/w/a.ts', line: 2, col: 5, endLine: 2, endCol: 9, severity: 'error', message: 'x no se usa', source: 'eslint', code: 'no-unused-vars' },
      { path: '/w/a.ts', line: 3, col: 1, endLine: null, endCol: null, severity: 'warning', message: 'aviso', source: 'eslint', code: null }
    ])
  })

  it('una salida que no es JSON (sin config de eslint) no es un error: no hay nada', () => {
    expect(parseEslint('Oops! Something went wrong! ESLint couldn\'t find a configuration file.')).toBeNull()
  })
})

describe('DiagnosticsService', () => {
  const result = (stdout: string, code = 1): ExecResult => ({ code, stdout, stderr: '' })

  it('corre el tsc del proyecto en cada referencia y devuelve solo lo del archivo pedido', async () => {
    const files = new Set(['/w/node_modules/.bin/tsc', '/w/tsconfig.json'])
    const exec = vi.fn(async (_cmd: string, args: string[], _opts: ExecOptions) => (args.at(-1) === '/w/tsconfig.web.json' ? result('src/a.ts(3,1): error TS1: malo\nsrc/otro.ts(1,1): error TS2: ajeno') : result('', 0)))
    const svc = new DiagnosticsService({ exec, exists: async (p) => files.has(p), readText: async () => '{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }] }' })
    const r = await svc.check('/w', '/w/src/a.ts')
    expect(r.tools).toEqual(['tsc'])
    expect(r.diagnostics.map((d) => [d.path, d.line, d.code])).toEqual([['/w/src/a.ts', 3, 'TS1']])
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec.mock.calls[0][0]).toBe('/w/node_modules/.bin/tsc')
    expect(exec.mock.calls[0][1]).toEqual(['--noEmit', '--pretty', 'false', '-p', '/w/tsconfig.node.json'])
    // Sin variables de Electron y con Homebrew en el PATH (los .bin llaman a node).
    const env = exec.mock.calls[0][2].env ?? {}
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.PATH).toContain('/opt/homebrew/bin')
  })

  it('sin binarios instalados no corre nada (nunca npx ni globales)', async () => {
    const exec = vi.fn()
    const svc = new DiagnosticsService({ exec, exists: async () => false, readText: async () => '{}' })
    expect(await svc.check('/w', '/w/a.ts')).toEqual({ diagnostics: [], tools: [] })
    expect(exec).not.toHaveBeenCalled()
  })

  it('eslint del proyecto con salida JSON; si su salida no es JSON no cuenta como herramienta', async () => {
    const files = new Set(['/w/node_modules/.bin/eslint'])
    let stdout = JSON.stringify([{ filePath: '/w/a.ts', messages: [{ line: 1, column: 1, severity: 2, message: 'm', ruleId: 'r' }] }])
    const exec = vi.fn(async () => result(stdout))
    const svc = new DiagnosticsService({ exec, exists: async (p) => files.has(p), readText: async () => '{}' })
    const r = await svc.check('/w', '/w/a.ts')
    expect(r.tools).toEqual(['eslint'])
    expect(r.diagnostics[0]).toMatchObject({ source: 'eslint', code: 'r' })
    expect(exec.mock.calls[0]).toEqual(expect.arrayContaining(['/w/node_modules/.bin/eslint', ['-f', 'json', '--no-warn-ignored', '/w/a.ts']]))
    stdout = 'no config'
    expect((await svc.check('/w', '/w/a.ts')).tools).toEqual([])
  })

  it('un tsc que no pudo correr (sale con error sin diagnósticos) no cuenta como "sin errores"', async () => {
    const files = new Set(['/w/node_modules/.bin/tsc', '/w/tsconfig.json'])
    const exec = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'Cannot find module typescript' }))
    const svc = new DiagnosticsService({ exec, exists: async (p) => files.has(p), readText: async () => '{ "include": ["."] }' })
    expect(await svc.check('/w', '/w/a.ts')).toEqual({ diagnostics: [], tools: [] })
  })

  it('archivos que no son JS/TS no corren nada', async () => {
    const exec = vi.fn()
    const svc = new DiagnosticsService({ exec, exists: async () => true, readText: async () => '{}' })
    expect((await svc.check('/w', '/w/README.md')).tools).toEqual([])
    expect(exec).not.toHaveBeenCalled()
  })

  it('skip omite herramientas (tsc cuando hay un servidor LSP vivo) y sin skip corre ambas', async () => {
    const files = new Set(['/w/node_modules/.bin/tsc', '/w/node_modules/.bin/eslint', '/w/tsconfig.json'])
    const exec = vi.fn(async (cmd: string) => (cmd.endsWith('eslint') ? result('[]', 0) : result('', 0)))
    const svc = new DiagnosticsService({ exec, exists: async (p) => files.has(p), readText: async () => '{ "include": ["."] }' })
    expect((await svc.check('/w', '/w/a.ts', ['tsc'])).tools).toEqual(['eslint'])
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['/w/node_modules/.bin/eslint'])
    exec.mockClear()
    expect((await svc.check('/w', '/w/a.ts')).tools).toEqual(['tsc', 'eslint'])
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('dos editores del mismo proyecto comparten la corrida de tsc en curso', async () => {
    let release: (r: ExecResult) => void = () => undefined
    const exec = vi.fn(() => new Promise<ExecResult>((r) => (release = r)))
    const files = new Set(['/w/node_modules/.bin/tsc', '/w/tsconfig.json'])
    const svc = new DiagnosticsService({ exec, exists: async (p) => files.has(p), readText: async () => '{ "include": ["."] }' })
    const a = svc.check('/w', '/w/a.ts')
    const b = svc.check('/w', '/w/b.ts')
    await new Promise((r) => setTimeout(r, 0))
    release(result('a.ts(1,1): error TS1: x\nb.ts(2,2): error TS2: y'))
    const [ra, rb] = await Promise.all([a, b])
    expect(exec).toHaveBeenCalledTimes(1)
    expect(ra.diagnostics.map((d) => d.code)).toEqual(['TS1'])
    expect(rb.diagnostics.map((d) => d.code)).toEqual(['TS2'])
  })
})
