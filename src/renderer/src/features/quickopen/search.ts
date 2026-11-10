/**
 * Lógica pura del quick open (ARCHITECTURE §3.11): parseo de prefijos, búsqueda difusa por
 * subsecuencia con puntuación y rangos de resaltado. Sin React ni stores: se prueba en Vitest.
 */

/** Tipo de resultado; `all` busca en todo y agrupa. */
export type QuickKind = 'all' | 'command' | 'agent' | 'file'

/** Prefijo que fuerza cada tipo; `all` no lleva. */
export const PREFIX: Record<Exclude<QuickKind, 'all'>, string> = { command: ':', agent: '@', file: '/' }

/** Orden de los chips y de la rotación con Tab. */
export const KINDS: readonly QuickKind[] = ['all', 'command', 'agent', 'file']

export const KIND_LABEL: Record<QuickKind, string> = { all: 'Todo', command: 'Comandos', agent: 'Agentes', file: 'Archivos' }

/** Máximo de resultados por grupo: sin prefijo se reparte, con prefijo hay sitio para más. */
export const LIMIT_ALL = 8
export const LIMIT_KIND = 40

export interface ParsedQuery {
  kind: QuickKind
  /** Texto a buscar, sin el prefijo ni espacios a los lados. */
  text: string
}

function kindOfPrefix(ch: string | undefined): QuickKind {
  if (ch === PREFIX.command) return 'command'
  if (ch === PREFIX.agent) return 'agent'
  if (ch === PREFIX.file) return 'file'
  return 'all'
}

/** `:foo` → comandos "foo"; `@` → agentes; `/` → archivos; sin prefijo → todo. */
export function parseQuery(input: string): ParsedQuery {
  const kind = kindOfPrefix(input[0])
  return { kind, text: (kind === 'all' ? input : input.slice(1)).trim() }
}

/**
 * Lo escrito es una ruta de carpeta para abrir como proyecto: `~`, `~/repo`, o absoluta bajo la carpeta
 * de usuario (`/Users/yo/repo`, `/home/yo/repo`; main solo sugiere ahí). `/src/app` sigue siendo
 * búsqueda de archivos (prefijo `/`). Devuelve la ruta sin espacios a los lados, o `null`.
 */
export function pathQuery(input: string): string | null {
  const text = input.trim()
  if (text === '~' || text.startsWith('~/')) return text
  if (/^\/(Users|home)\/[^/]+/.test(text)) return text
  return null
}

/**
 * Tab sobre una carpeta sugerida: cambia el último tramo de lo escrito por el nombre de la carpeta y
 * agrega `/`, conservando la forma que usó el usuario (`~/priv` → `~/private/`).
 */
export function completePath(input: string, folder: string): string {
  const text = input.trim()
  const name = folder.slice(folder.lastIndexOf('/') + 1)
  if (text === '~') return `~/${name}/`
  return `${text.slice(0, text.lastIndexOf('/') + 1)}${name}/`
}

/** Reescribe el prefijo del texto para que el campo refleje el chip elegido. */
export function withKind(input: string, kind: QuickKind): string {
  const { kind: current } = parseQuery(input)
  const rest = current === 'all' ? input : input.slice(1)
  return kind === 'all' ? rest : `${PREFIX[kind]}${rest}`
}

/** Chip siguiente (o anterior con `delta` -1), con vuelta. */
export function nextKind(kind: QuickKind, delta = 1): QuickKind {
  const i = KINDS.indexOf(kind)
  return KINDS[(i + delta + KINDS.length) % KINDS.length]
}

/** Tramo resaltado `[inicio, fin)` sobre el texto original. */
export type Range = readonly [number, number]

export interface Match {
  /** Mayor es mejor; comparable entre textos distintos para la misma consulta. */
  score: number
  ranges: Range[]
}

const BONUS_WORD_START = 3
/** Mayor que el de inicio de palabra: "Tab" entero gana a "T…ab" repartido en dos palabras. */
const BONUS_CONSECUTIVE = 4
/** Saltar letras cuesta: a igual resto, la alineación compacta gana. */
const PENALTY_GAP = 1
/** Preferencia leve por empezar antes en el texto (desempate, nunca supera un bonus). */
const PENALTY_LATE_START = 0.01

/** Límite de palabra: inicio, tras separador, o cambio minúscula→mayúscula (camelCase). */
function isWordStart(text: string, j: number): boolean {
  if (j === 0) return true
  const prev = text[j - 1]
  const cur = text[j]
  if (/[\s/\\\-_.:,()[\]]/.test(prev)) return true
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase()
}

/**
 * Subsecuencia case-insensitive con puntuación: cada letra vale 1, +3 si cae en inicio de palabra,
 * +4 si sigue a la anterior sin hueco, −1 si hubo salto. Programación dinámica O(n·m) que elige la alineación de
 * mayor puntuación (así `cod` en "Nuevo Codex" prefiere la C de Codex). `null` si no hay
 * subsecuencia; consulta vacía casa con todo sin rangos.
 */
export function fuzzyMatch(query: string, text: string): Match | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const n = q.length
  const m = t.length
  if (n === 0) return { score: 0, ranges: [] }
  if (n > m) return null

  const best: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(-Infinity))
  const from: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(-1))

  for (let i = 0; i < n; i++) {
    // Mejor puntuación de la letra anterior en cualquier posición k < j (sin bonus de consecutiva).
    let runMax = -Infinity
    let runArg = -1
    for (let j = 0; j < m; j++) {
      if (i > 0 && j > 0 && best[i - 1][j - 1] > runMax) {
        runMax = best[i - 1][j - 1]
        runArg = j - 1
      }
      if (t[j] !== q[i]) continue
      const base = 1 + (isWordStart(text, j) ? BONUS_WORD_START : 0)
      if (i === 0) {
        best[0][j] = base - j * PENALTY_LATE_START
        continue
      }
      let score = -Infinity
      let prev = -1
      if (j > 0 && best[i - 1][j - 1] > -Infinity) {
        score = best[i - 1][j - 1] + base + BONUS_CONSECUTIVE
        prev = j - 1
      }
      if (runMax > -Infinity && runMax + base - PENALTY_GAP > score) {
        score = runMax + base - PENALTY_GAP
        prev = runArg
      }
      best[i][j] = score
      from[i][j] = prev
    }
  }

  let endJ = -1
  let endScore = -Infinity
  for (let j = 0; j < m; j++) {
    if (best[n - 1][j] > endScore) {
      endScore = best[n - 1][j]
      endJ = j
    }
  }
  if (endJ === -1) return null

  // Reconstrucción de posiciones de atrás hacia adelante y fusión en rangos.
  const positions: number[] = []
  for (let i = n - 1, j = endJ; i >= 0 && j >= 0; i--) {
    positions.push(j)
    j = from[i][j]
  }
  positions.reverse()
  const ranges: Array<[number, number]> = []
  for (const p of positions) {
    const last = ranges[ranges.length - 1]
    if (last && last[1] === p) last[1] = p + 1
    else ranges.push([p, p + 1])
  }
  return { score: endScore, ranges }
}

/**
 * Filtra y ordena una lista por consulta difusa sobre el texto que da `textOf`. Sin consulta devuelve
 * todo en su orden original. Con consulta: mejor puntuación primero, luego texto más corto, luego
 * el orden original (estable).
 */
export function rank<T>(items: readonly T[], query: string, textOf: (item: T) => string): Array<{ item: T; match: Match }> {
  const hits: Array<{ item: T; match: Match; len: number; i: number }> = []
  items.forEach((item, i) => {
    const text = textOf(item)
    const match = fuzzyMatch(query, text)
    if (match) hits.push({ item, match, len: text.length, i })
  })
  if (query.length > 0) hits.sort((a, b) => b.match.score - a.match.score || a.len - b.len || a.i - b.i)
  return hits.map(({ item, match }) => ({ item, match }))
}

/**
 * Ruta lista para escribirse en un shell o en el prompt de un agente: tal cual si solo tiene
 * letras, dígitos y `. _ / -`; si no, entre comillas simples con cada `'` escapada (`'\''`).
 */
export function quoteForShell(path: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(path)) return path
  return `'${path.replace(/'/g, "'\\''")}'`
}
