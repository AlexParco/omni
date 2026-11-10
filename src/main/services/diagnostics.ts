import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { CodeDiagnostic } from '@shared/types'
import { exec as defaultExec, type Exec } from '../exec'
import { EXTRA_BIN_DIRS } from './whisper'
import { testsEnv } from './worktrees'

/**
 * Diagnósticos del editor (ARCHITECTURE §3.19): corre el `tsc` y el `eslint` que el proyecto ya tiene
 * instalados (su `node_modules/.bin`, buscado desde la carpeta del archivo hasta la raíz del
 * workspace) y devuelve lo que digan sobre un archivo. Nunca descarga nada ni usa binarios globales:
 * sin herramienta instalada no hay diagnósticos. Sin shell: argumentos como lista.
 */

/** Tope por herramienta; un proyecto enorme no deja colgado el editor. */
export const DIAGNOSTICS_TIMEOUT_MS = 60_000

type Tool = 'tsc' | 'eslint'

export interface DiagnosticsResult {
  diagnostics: CodeDiagnostic[]
  tools: Tool[]
}

/** Carpetas desde `from` hasta `root` (ambas incluidas), de la más honda a la raíz. */
export function dirsUpTo(from: string, root: string): string[] {
  const out: string[] = []
  let dir = from
  for (;;) {
    out.push(dir)
    if (dir === root || !dir.startsWith(root)) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

/** Quita comentarios `//` y `/* *\/` de un JSON de tsconfig (fuera de strings) y comas finales. */
export function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/**
 * Configs que hay que pasarle a `tsc -p`: la propia, o sus `references` si es un tsconfig "solución"
 * (con `files: []`, como el de electron-vite), que por sí solo no revisa nada.
 */
export function tscConfigs(tsconfigPath: string, text: string): string[] {
  try {
    const json = JSON.parse(stripJsonc(text)) as { files?: unknown[]; include?: unknown[]; references?: Array<{ path?: string }> }
    const refs = (json.references ?? []).map((r) => r.path).filter((x): x is string => typeof x === 'string')
    const solution = Array.isArray(json.files) && json.files.length === 0 && json.include === undefined
    if (solution && refs.length > 0) {
      return refs.map((r) => {
        const abs = resolve(dirname(tsconfigPath), r)
        return abs.endsWith('.json') ? abs : join(abs, 'tsconfig.json')
      })
    }
  } catch {
    // tsconfig ilegible: que tsc lo diga con su propio error, revisando la config tal cual.
  }
  return [tsconfigPath]
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/

/** Salida de `tsc --pretty false`: una línea por diagnóstico y continuaciones con sangría. Rutas relativas a `cwd`. */
export function parseTsc(output: string, cwd: string): CodeDiagnostic[] {
  const out: CodeDiagnostic[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = TSC_LINE.exec(line)
    if (m) {
      const [, file, ln, col, sev, code, message] = m
      out.push({
        path: isAbsolute(file) ? file : resolve(cwd, file),
        line: Number(ln),
        col: Number(col),
        endLine: null,
        endCol: null,
        severity: sev === 'error' ? 'error' : sev === 'warning' ? 'warning' : 'info',
        message,
        source: 'tsc',
        code
      })
    } else if (/^\s+\S/.test(line) && out.length > 0) out[out.length - 1].message += `\n${line.trim()}`
  }
  return out
}

interface EslintMessage {
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  severity?: number
  message?: string
  ruleId?: string | null
}

/** Salida de `eslint -f json`; `null` si no es JSON (sin config, versión rara): no hay nada que pintar. */
export function parseEslint(stdout: string): CodeDiagnostic[] | null {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(json)) return null
  const out: CodeDiagnostic[] = []
  for (const file of json as Array<{ filePath?: string; messages?: EslintMessage[] }>) {
    for (const m of file.messages ?? []) {
      if (typeof file.filePath !== 'string' || typeof m.message !== 'string') continue
      out.push({
        path: file.filePath,
        line: m.line ?? 1,
        col: m.column ?? 1,
        endLine: m.endLine ?? null,
        endCol: m.endColumn ?? null,
        severity: m.severity === 2 ? 'error' : 'warning',
        message: m.message,
        source: 'eslint',
        code: m.ruleId ?? null
      })
    }
  }
  return out
}

export interface DiagnosticsOptions {
  exec?: Exec
  /** ¿Existe el archivo? Inyectable en tests. */
  exists?: (path: string) => Promise<boolean>
  readText?: (path: string) => Promise<string>
  timeoutMs?: number
}

const defaultExists = (path: string): Promise<boolean> =>
  fs.access(path).then(
    () => true,
    () => false
  )

export class DiagnosticsService {
  private readonly exec: Exec
  private readonly exists: (path: string) => Promise<boolean>
  private readonly readText: (path: string) => Promise<string>
  private readonly timeoutMs: number
  /** `tsc` en curso por config: dos editores del mismo proyecto comparten la corrida. */
  private readonly inflight = new Map<string, Promise<{ diagnostics: CodeDiagnostic[]; failed: boolean }>>()

  constructor(opts: DiagnosticsOptions = {}) {
    this.exec = opts.exec ?? defaultExec
    this.exists = opts.exists ?? defaultExists
    this.readText = opts.readText ?? ((p) => fs.readFile(p, 'utf8'))
    this.timeoutMs = opts.timeoutMs ?? DIAGNOSTICS_TIMEOUT_MS
  }

  /**
   * Diagnósticos de `path` (absoluto, dentro de `root`). Una herramienta que falla al arrancar no tumba
   * la otra. `skip` omite herramientas (p. ej. `tsc` cuando el editor ya tiene un servidor LSP vivo).
   */
  async check(root: string, path: string, skip: readonly Tool[] = []): Promise<DiagnosticsResult> {
    const dirs = dirsUpTo(dirname(path), root)
    const [tsc, eslint] = await Promise.all([
      skip.includes('tsc') ? null : this.runTsc(dirs, path).catch(() => null),
      skip.includes('eslint') ? null : this.runEslint(dirs, path).catch(() => null)
    ])
    const tools: Tool[] = []
    const diagnostics: CodeDiagnostic[] = []
    if (tsc) {
      tools.push('tsc')
      diagnostics.push(...tsc)
    }
    if (eslint) {
      tools.push('eslint')
      diagnostics.push(...eslint)
    }
    diagnostics.sort((a, b) => a.line - b.line || a.col - b.col)
    return { diagnostics, tools }
  }

  /** Primer `node_modules/.bin/<name>` subiendo por `dirs`. */
  private async findBin(dirs: string[], name: string): Promise<string | null> {
    for (const dir of dirs) {
      const bin = join(dir, 'node_modules', '.bin', name)
      if (await this.exists(bin)) return bin
    }
    return null
  }

  private async findFile(dirs: string[], names: string[]): Promise<string | null> {
    for (const dir of dirs) for (const name of names) if (await this.exists(join(dir, name))) return join(dir, name)
    return null
  }

  /** Entorno de los tests (sin variables de Electron) con Homebrew en el PATH: los `.bin` llaman a `node`. */
  private env(): Record<string, string> {
    const env = testsEnv()
    env.PATH = [env.PATH ?? '', ...EXTRA_BIN_DIRS].filter((x) => x !== '').join(':')
    return env
  }

  private async runTsc(dirs: string[], path: string): Promise<CodeDiagnostic[] | null> {
    if (!/\.(c|m)?tsx?$|\.(c|m)?jsx?$/.test(path)) return null
    const [bin, tsconfig] = await Promise.all([this.findBin(dirs, 'tsc'), this.findFile(dirs, ['tsconfig.json'])])
    if (!bin || !tsconfig) return null
    const configs = tscConfigs(tsconfig, await this.readText(tsconfig))
    const all = await Promise.all(configs.map((config) => this.tscOnce(bin, config)))
    // tsc sale con código ≠ 0 cuando encuentra errores; si además no dejó ninguno legible es que no
    // pudo correr (binario roto, node ausente, config inválida): no se presenta como "sin errores".
    if (all.every((r) => r.failed)) return null
    return all.flatMap((r) => r.diagnostics).filter((d) => d.path === path)
  }

  private tscOnce(bin: string, config: string): Promise<{ diagnostics: CodeDiagnostic[]; failed: boolean }> {
    const running = this.inflight.get(config)
    if (running) return running
    const cwd = dirname(config)
    const run = this.exec(bin, ['--noEmit', '--pretty', 'false', '-p', config], { cwd, timeoutMs: this.timeoutMs, env: this.env() })
      .then((r) => {
        const diagnostics = parseTsc(r.stdout, cwd)
        return { diagnostics, failed: r.code !== 0 && diagnostics.length === 0 }
      })
      .finally(() => this.inflight.delete(config))
    this.inflight.set(config, run)
    return run
  }

  private async runEslint(dirs: string[], path: string): Promise<CodeDiagnostic[] | null> {
    if (!/\.(c|m)?(t|j)sx?$|\.vue$|\.svelte$/.test(path)) return null
    const bin = await this.findBin(dirs, 'eslint')
    if (!bin) return null
    const cwd = dirname(dirname(dirname(bin)))
    const r = await this.exec(bin, ['-f', 'json', '--no-warn-ignored', path], { cwd, timeoutMs: this.timeoutMs, env: this.env() })
    return parseEslint(r.stdout)
  }
}
