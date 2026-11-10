import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, TERMINAL_FONTS, TERMINAL_FONT_WEIGHTS, TERMINAL_LINE_HEIGHTS, TERMINAL_SCROLL_SPEEDS, type NotificationsSetting, type Settings, type TerminalFontId } from '@shared/types'

const DEFAULT_FILE = join(homedir(), '.config', 'omni', 'settings.json')

/** Chord válido como prefijo: uno o más modificadores (ctrl/alt, nunca cmd) más una tecla. */
const PREFIX_RE = /^((ctrl|alt)\+)+(shift\+)?[a-z0-9`\-=[\]\\;',./]$/
const FONT_MIN = 9
const FONT_MAX = 24
/** `capa:comando`; el renderer decide si el comando existe. */
const KEY_ID_RE = /^(global|list|terminal|worktrees|review|broadcast|editorTree):[A-Za-z0-9_.-]+$/
/** Chord con sintaxis plausible; el renderer lo normaliza. */
const CHORD_RE = /^((ctrl|alt|shift|cmd)\+)*[^\s+]+$/
const MAX_CHORDS = 3
const NOTIFICATIONS: readonly NotificationsSetting[] = ['all', 'questions', 'done', 'off']

/**
 * Ajustes del usuario en JSON. Main es el dueño: valida, persiste y avisa al renderer
 * (`settings:changed`). Claves desconocidas o valores inválidos se descartan en silencio y
 * caen al valor por defecto; el archivo se puede editar a mano.
 */
export class SettingsStore {
  private settings: Settings = { ...DEFAULT_SETTINGS }

  constructor(private readonly file = DEFAULT_FILE) {
    this.load()
  }

  get(): Settings {
    return { ...this.settings }
  }

  /** Aplica solo las claves válidas del parche y persiste. Devuelve el resultado completo. */
  update(patch: Partial<Settings>): Settings {
    this.settings = sanitize({ ...this.settings, ...patch })
    this.save()
    return this.get()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      this.settings = sanitize({ ...DEFAULT_SETTINGS, ...(isRecord(raw) ? raw : {}) })
    } catch (err) {
      console.warn(`[omni] se ignora ${this.file}:`, err)
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.settings, null, 2) + '\n')
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** Deja cada clave con un valor válido o con su valor por defecto. Exportado para tests. */
export function sanitize(input: Record<string, unknown>): Settings {
  const prefix = typeof input.prefix === 'string' && PREFIX_RE.test(input.prefix) ? input.prefix : DEFAULT_SETTINGS.prefix
  const size = typeof input.terminalFontSize === 'number' && Number.isFinite(input.terminalFontSize) ? Math.round(input.terminalFontSize) : NaN
  const terminalFontSize = size >= FONT_MIN && size <= FONT_MAX ? size : DEFAULT_SETTINGS.terminalFontSize
  const keys: Record<string, string[]> = {}
  if (isRecord(input.keys)) {
    for (const [id, chords] of Object.entries(input.keys)) {
      if (!KEY_ID_RE.test(id) || !Array.isArray(chords)) continue
      keys[id] = chords.filter((c): c is string => typeof c === 'string' && CHORD_RE.test(c)).slice(0, MAX_CHORDS)
    }
  }
  const notifications = NOTIFICATIONS.find((n) => n === input.notifications) ?? DEFAULT_SETTINGS.notifications
  const terminalFont = typeof input.terminalFont === 'string' && Object.hasOwn(TERMINAL_FONTS, input.terminalFont) ? (input.terminalFont as TerminalFontId) : DEFAULT_SETTINGS.terminalFont
  const terminalLineHeight = TERMINAL_LINE_HEIGHTS.find((h) => h === input.terminalLineHeight) ?? DEFAULT_SETTINGS.terminalLineHeight
  const terminalFontWeight = TERMINAL_FONT_WEIGHTS.find((w) => w === input.terminalFontWeight) ?? DEFAULT_SETTINGS.terminalFontWeight
  const terminalScrollSpeed = TERMINAL_SCROLL_SPEEDS.find((v) => v === input.terminalScrollSpeed) ?? DEFAULT_SETTINGS.terminalScrollSpeed
  const reviveSessions = typeof input.reviveSessions === 'boolean' ? input.reviveSessions : DEFAULT_SETTINGS.reviveSessions
  const openAtLogin = typeof input.openAtLogin === 'boolean' ? input.openAtLogin : DEFAULT_SETTINGS.openAtLogin
  return { prefix, terminalFontSize, keys, notifications, terminalFont, terminalLineHeight, terminalFontWeight, terminalScrollSpeed, reviveSessions, openAtLogin }
}

export const SETTINGS_LIMITS = { fontMin: FONT_MIN, fontMax: FONT_MAX, prefixPattern: PREFIX_RE } as const
