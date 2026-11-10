import type { AgentId } from '@shared/types'

/**
 * Patrones de permiso por agente (ARCHITECTURE §3.13). Regex sobre la cola de la terminal ya sin
 * ANSI (`core/terminal-text.ts`) que dicen qué está pidiendo el agente: alimentan el estado
 * "pregunta" de la sesión y el cuerpo de la notificación. Puro, sin React ni stores.
 * Un patrón no reconocido devuelve `null`: la sesión queda como pregunta genérica.
 */

/** `trust` es el diálogo de confianza de Claude Code al abrir una carpeta nueva: lo responde el usuario dentro de la sesión. */
export type PermissionKind = 'bash' | 'edit' | 'read' | 'other' | 'trust'

export interface Permission {
  kind: PermissionKind
  /** Lo que se muestra en una línea: el comando, el archivo o la pregunta tal cual. */
  summary: string
}

/** Bordes de caja que las TUI pintan alrededor del diálogo; estorban para leer las líneas. */
const BOX_CHARS = /[│┃║╭╮╰╯─━═┌┐└┘├┤┬┴┼]/g

const clean = (line: string): string => line.replace(BOX_CHARS, ' ').trim()
/** El diálogo solo cuenta si su opción está entre las últimas líneas: uno viejo, ya respondido, no vuelve a ser permiso. */
const RECENT_LINES = 12
const isRecent = (lines: readonly string[], i: number): boolean => i !== -1 && i >= lines.length - RECENT_LINES
/** Línea de opción numerada o con marcador: no sirve de resumen. */
const isOption = (line: string): boolean => /^[❯▶>]?\s*(\d+\.|[Yy]es\b|[Nn]o\b|\(y\)|\(n\)|\(a\))/.test(line)

/* ---------- Claude Code ---------- */

/**
 * Diálogo de confianza de Claude Code ("Accessing workspace: <ruta>" … "Quick safety check: Is this a
 * project you created or one you trust?"). No suena BEL: `sessions.onData` lo busca en la salida cruda
 * con `hasTrustPrompt` y marca atención. Cualquiera de las dos frases basta (un chunk puede traer solo una).
 */
const TRUST_PROMPT = /Is this a project you created or one you trust|Accessing workspace:/i

/** El texto (ya sin ANSI, puede traer bordes de caja y saltos) contiene el diálogo de confianza. */
export function hasTrustPrompt(text: string): boolean {
  return TRUST_PROMPT.test(text.replace(BOX_CHARS, ' ').replace(/\s+/g, ' '))
}

/**
 * Pie de los diálogos de selección de Claude Code (confianza, servidores MCP nuevos, etc.): ninguno
 * suena BEL. Sirve para marcar atención y para resumir el diálogo cuando no es uno conocido.
 */
const CLAUDE_DIALOG_FOOTER = /Enter to confirm\s*·\s*Esc to cancel/i

export function hasClaudeDialog(text: string): boolean {
  return CLAUDE_DIALOG_FOOTER.test(text.replace(BOX_CHARS, ' ').replace(/\s+/g, ' '))
}

/** Diálogo de selección reciente que no es de confianza: título = primera línea del bloque tras la última regla horizontal. */
function detectClaudeDialog(lines: string[]): Permission | null {
  const footer = findLast(lines, (l) => CLAUDE_DIALOG_FOOTER.test(l))
  if (!isRecent(lines, footer)) return null
  let start = 0
  for (let i = footer - 1; i >= 0; i--) if (/^[─━═\s]{8,}$/.test(lines[i])) { start = i + 1; break }
  const title = lines.slice(start, footer).find((l) => l !== '' && !isOption(l) && !/^[❯>]/.test(l))
  return { kind: 'other', summary: title ?? 'Claude Code espera una respuesta' }
}

/** Ruta tras "Accessing workspace:" (en la misma línea o en la siguiente no vacía), o `null`. */
function trustPathOf(lines: string[], at: number): string | null {
  const same = /Accessing workspace:\s*(.+)$/i.exec(lines[at])
  if (same && same[1].trim()) return same[1].trim()
  const next = lines.slice(at + 1).find((l) => l !== '')
  return next && !/trust|safety check/i.test(next) ? next : null
}

/** Diálogo de confianza reciente: resumen con la carpeta. Va antes que los permisos: sus opciones ("1. Yes, proceed") parecen un permiso. */
function detectTrust(lines: string[]): Permission | null {
  const question = findLast(lines, (l) => /Is this a project you created or one you trust/i.test(l))
  const access = findLast(lines, (l) => /^Accessing workspace:/i.test(l))
  if (!isRecent(lines, question) && !isRecent(lines, access)) return null
  const path = access !== -1 ? trustPathOf(lines, access) : null
  return { kind: 'trust', summary: path ? `Confiar en la carpeta ${path}` : 'Confiar en esta carpeta' }
}

/** Cabecera del diálogo de permisos de Claude Code → tipo. */
const CLAUDE_HEADERS: Array<{ re: RegExp; kind: PermissionKind }> = [
  { re: /^Bash command$/i, kind: 'bash' },
  { re: /^(Edit|Update|Multi ?edit) file$/i, kind: 'edit' },
  { re: /^(Write|Create)( file)?$/i, kind: 'edit' },
  { re: /^Read( files?)?$/i, kind: 'read' }
]

/** Preguntas de Claude Code que llevan el archivo dentro. */
const CLAUDE_QUESTIONS: Array<{ re: RegExp; kind: PermissionKind }> = [
  // La pregunta termina en `?`: lo que venga detrás en la misma fila (indicadores de la TUI, ◐) no es parte del resumen.
  { re: /^Do you want to make this edit to (.+?)(?:\?.*)?$/i, kind: 'edit' },
  { re: /^Do you want to (?:create|write to|write) (.+?)(?:\?.*)?$/i, kind: 'edit' },
  { re: /^Do you want to (?:allow .+? to )?read (.+?)(?:\?.*)?$/i, kind: 'read' }
]

function detectClaude(lines: string[]): Permission | null {
  const trust = detectTrust(lines)
  if (trust) return trust
  const question = findLast(lines, (l) => /^Do you want to /i.test(l))
  const option = findLast(lines, (l) => /^[❯>]?\s*1\.\s*Yes\b/i.test(l))
  if (!isRecent(lines, question) && !isRecent(lines, option)) return detectClaudeDialog(lines)
  const end = question !== -1 ? question : option
  const q = question !== -1 ? lines[question] : ''
  for (const { re, kind } of CLAUDE_QUESTIONS) {
    const m = re.exec(q)
    if (m) return { kind, summary: m[1].trim() }
  }
  for (let i = end - 1; i >= 0; i--) {
    const header = CLAUDE_HEADERS.find((h) => h.re.test(lines[i]))
    if (!header) continue
    // Cuerpo útil: sin consejos de la TUI ("Tip: …"), separadores ni el aviso de aprobación. Si hay un
    // separador punteado (formato actual: descripción, ╌╌╌, comando, ╌╌╌), manda la línea tras él;
    // si no (formato antiguo: comando y luego descripción), la primera.
    const isRule = (l: string): boolean => /^[╌┄┈\-─]{4,}$/.test(l.replace(/\s/g, ''))
    const useful = (l: string): boolean => l !== '' && !isOption(l) && !isRule(l) && !/^Tip:/i.test(l) && !/requires approval/i.test(l)
    const slice = lines.slice(i + 1, end)
    const rule = slice.findIndex(isRule)
    const pick = (rule !== -1 ? slice.slice(rule + 1) : slice).find(useful) ?? slice.find(useful)
    return { kind: header.kind, summary: pick ?? lines[i] }
  }
  return { kind: 'other', summary: q || 'Do you want to proceed?' }
}

/* ---------- Codex ---------- */

const CODEX_PROMPTS: Array<{ re: RegExp; kind: PermissionKind }> = [
  { re: /^(Allow|Run) command\??|wants to run/i, kind: 'bash' },
  { re: /^(Apply|Allow) (?:this |these )?(?:changes?|edits?|patch)\??|wants to (?:edit|apply|write)/i, kind: 'edit' },
  { re: /\bapprov(e|al)\b/i, kind: 'other' }
]

function detectCodex(lines: string[]): Permission | null {
  for (const { re, kind } of CODEX_PROMPTS) {
    const i = findLast(lines, (l) => re.test(l))
    if (!isRecent(lines, i)) continue
    // El comando o el archivo va justo debajo del aviso (`$ npm test`); si no hay, la línea anterior.
    const below = lines.slice(i + 1).find((l) => l !== '' && !isOption(l))
    const above = i > 0 && !isOption(lines[i - 1]) ? lines[i - 1] : undefined
    const summary = kind === 'other' ? lines[i] : (below ?? above ?? lines[i]).replace(/^\$\s*/, '')
    return { kind, summary }
  }
  return null
}

const DETECTORS: Partial<Record<AgentId, (lines: string[]) => Permission | null>> = { claude: detectClaude, codex: detectCodex }

/**
 * Qué permiso pide el agente, mirando la cola de su terminal. Solo Claude Code y Codex tienen
 * patrones; el resto (Hermes, OpenCode, Goose, shell) queda en BEL genérico hasta tener los suyos.
 */
export function detectPermission(agentId: AgentId, tail: readonly string[]): Permission | null {
  const detect = DETECTORS[agentId]
  if (!detect) return null
  return detect(tail.map(clean))
}

function findLast(lines: string[], test: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i])) return i
  return -1
}
