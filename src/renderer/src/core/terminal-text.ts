/**
 * Texto de terminal sin adornos (ARCHITECTURE §3.13): lo que las notificaciones y Broadcast leen de la
 * cola de una sesión sale de `session:history`, que trae bytes crudos con ANSI. Puro, sin DOM ni xterm.
 */

/* eslint-disable no-control-regex */
/** CSI (`ESC [` o `0x9b`): parámetros, intermedios y el byte final. Cubre `?` y `>` privados. */
const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g
/** OSC (`ESC ]` títulos, hyperlinks): termina en BEL o en ST (`ESC \`). */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
/** DCS, SOS, PM y APC: cadenas hasta ST. */
const STRING_SEQ = /\x1b[PX^_][^\x1b]*(?:\x1b\\)?/g
/** Secuencias de dos y tres bytes: juegos de caracteres (`ESC ( B`), `ESC =`, `ESC >`, `ESC 7`… */
const SHORT_ESC = /\x1b[ -/]?[0-~]/g
/** Controles C0 y DEL, salvo salto de línea, retorno de carro y tabulador. */
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
/* eslint-enable no-control-regex */

/**
 * Movimientos horizontales del cursor (`ESC[<col>G` absoluto, `ESC[<n>C` adelante): las TUI de Ink
 * (Claude Code) separan las palabras con ellos en vez de escribir espacios. Se vuelven un espacio
 * para que el texto siga legible y los patrones de permiso casen.
 */
const CURSOR_GAP = /(?:\x1b\[|\x9b)\d*[CG]/g

/** Quita CSI, OSC, DCS y demás secuencias de escape y los caracteres de control, conservando `\n`, `\r` y `\t`. */
export function stripAnsi(text: string): string {
  return text.replace(OSC, '').replace(STRING_SEQ, '').replace(CURSOR_GAP, ' ').replace(CSI, '').replace(SHORT_ESC, '').replace(CONTROLS, '')
}

/**
 * Últimas `n` líneas no vacías. `\r` cuenta como salto: una TUI reescribe la línea con `\r` y cada
 * versión queda como línea propia (mejor repetida que pegada). Las líneas conservan la sangría y
 * pierden los espacios finales; los tabuladores pasan a espacios.
 */
export function tailLines(text: string, n: number): string[] {
  if (n <= 0) return []
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\t/g, '    ').replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
  return lines.slice(-n)
}

/* ---------- lo que dijo el agente (notificaciones, Broadcast) ---------- */

/** Marcador de mensaje de las TUI de agentes: `⏺` y `●` de Claude Code, `•` de Codex. */
const MESSAGE = /^\s*[⏺●•]\s+(.+)$/
/** Llamada a herramienta (`Bash(npm test)`, `Update(src/a.ts)`, `Read 3 files`): no es lo que el agente le dice al usuario. */
const TOOL_CALL = /^[A-Z][A-Za-z]*(?:\(.*\)?|\s+\d+\s+\w+.*)$/
/** Resultado de una herramienta, colgado de su llamada. */
const TOOL_RESULT = /^\s*⎿/
/** Solo bordes y reglas de caja (`╭───╮`, `─────`). */
const RULE = /^[\s─━═╭╮╰╯│┃║┌┐└┘├┤┬┴┼▔▁-]+$/
/** Prompt vacío o con la sugerencia gris dentro (`│ > `, `❯ Try "…"`). */
const PROMPT = /^\s*[│┃]?\s*[>❯›]\s/
/** Prompt de la shell esperando (`λ ~/repo/`, `➜ repo git:(main)`, `yo@mac:~/repo$`): no es lo que dijo nadie. */
const SHELL_PROMPT = /^\s*[λ➜]\s|^[\w.-]+@[\w.-]+[:\s].*[$%#]\s*$/
/** Barras de estado y ayudas al pie de las TUI: modo de vim, permisos, atajos, spinner. */
const STATUS = /-- (?:INSERT|NORMAL|VISUAL) --|shift\+tab|esc to (?:interrupt|cancel)|\? for shortcuts|ctrl\+[a-z] to|auto mode|accept edits|bypass permissions|plan mode|⏵⏵|tokens?\b.*\bleft|context left|Context low/i
/** Cuánto texto cabe en el cuerpo de una notificación. */
export const MESSAGE_MAX_CHARS = 180

/** Línea que pinta la TUI y no el agente: bordes, prompt, barra de estado. */
export function isTuiChrome(line: string): boolean {
  return RULE.test(line) || PROMPT.test(line) || SHELL_PROMPT.test(line) || STATUS.test(line)
}

/** Recorta a `max` caracteres por palabra, con `…` si sobró texto. */
export function clip(text: string, max = MESSAGE_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`
}

/**
 * Lo último que el agente le dijo al usuario, leído de su pantalla renderizada (`screenLines`): el
 * último mensaje con marcador que no sea una llamada a herramienta, con sus líneas de continuación
 * (sangradas) unidas. Si solo hay herramientas, la última. `null` si no hay ningún mensaje.
 */
export function agentMessage(lines: readonly string[], max = MESSAGE_MAX_CHARS): string | null {
  let tool: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = MESSAGE.exec(lines[i])
    if (!m) continue
    const first = m[1].trim()
    if (TOOL_CALL.test(first)) {
      tool ??= first
      continue
    }
    const parts = [first]
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      if (MESSAGE.test(next) || TOOL_RESULT.test(next) || isTuiChrome(next) || !/^\s{2,}\S/.test(next)) break
      parts.push(next.trim())
    }
    return clip(parts.join(' '), max)
  }
  return tool === null ? null : clip(tool, max)
}

/** Última línea que no es chrome de la TUI, recortada; `null` si no queda ninguna. */
export function lastMeaningfulLine(lines: readonly string[], max = MESSAGE_MAX_CHARS): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/[│┃║]/g, ' ').trim()
    if (line !== '' && !isTuiChrome(lines[i])) return clip(line, max)
  }
  return null
}
