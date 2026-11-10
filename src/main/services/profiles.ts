import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BrowserProfile } from '@shared/types'

const DEFAULT_FILE = join(homedir(), '.config', 'omni', 'profiles.json')

/** Perfil "Por defecto": siempre existe, no se borra ni se renombra. */
export const DEFAULT_PROFILE: BrowserProfile = { id: 'default', name: 'Por defecto', builtin: true }

const NAME_MAX = 40
/** Ids con forma de partición válida: lo que `persist:omni-<id>` admite sin sorpresas. */
const ID_RE = /^[A-Za-z0-9-]{1,64}$/

/** Partición persistente de Electron de un perfil (ARCHITECTURE §3.9): `persist:omni-<id>`. */
export function partitionOf(profile: BrowserProfile | string): string {
  const id = typeof profile === 'string' ? profile : profile.id
  return `persist:omni-${id}`
}

/** Nombre visible: sin espacios de más ni saltos, recortado; vacío si no queda nada. */
export function sanitizeProfileName(name: unknown): string {
  if (typeof name !== 'string') return ''
  return name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/**
 * Lista válida a partir de lo que haya en disco: el builtin va siempre primero con su nombre fijo,
 * se descartan entradas sin forma, ids repetidos o nombres vacíos. Exportado para tests.
 */
export function sanitizeProfiles(raw: unknown): BrowserProfile[] {
  const out: BrowserProfile[] = [{ ...DEFAULT_PROFILE }]
  const seen = new Set<string>([DEFAULT_PROFILE.id])
  const list = isRecord(raw) && Array.isArray(raw.profiles) ? raw.profiles : Array.isArray(raw) ? raw : []
  for (const item of list) {
    if (!isRecord(item) || typeof item.id !== 'string' || !ID_RE.test(item.id) || seen.has(item.id)) continue
    const name = sanitizeProfileName(item.name)
    if (name === '') continue
    seen.add(item.id)
    out.push({ id: item.id, name })
  }
  return out
}

/**
 * `~/.config/omni/profiles.json`: perfiles de navegación del usuario. Main es el dueño; cada
 * perfil es una partición persistente de Electron y borrar el perfil no borra sus datos en disco
 * (Electron no expone borrar una partición; `browser:clearData` vacía cookies y storage).
 */
export class ProfileStore {
  private profiles: BrowserProfile[] = [{ ...DEFAULT_PROFILE }]

  constructor(private readonly file = DEFAULT_FILE) {
    this.load()
  }

  list(): BrowserProfile[] {
    return this.profiles.map((p) => ({ ...p }))
  }

  get(id: string): BrowserProfile | undefined {
    const p = this.profiles.find((p) => p.id === id)
    return p ? { ...p } : undefined
  }

  /** Perfil por id, o el builtin si no existe (un `profileId` guardado puede apuntar a uno ya borrado). */
  resolve(id: string | undefined): BrowserProfile {
    return (id && this.get(id)) || { ...DEFAULT_PROFILE }
  }

  create(name: string): BrowserProfile {
    const clean = sanitizeProfileName(name)
    if (clean === '') throw new Error('el perfil necesita un nombre')
    const profile: BrowserProfile = { id: randomUUID(), name: clean }
    this.profiles.push(profile)
    this.save()
    return { ...profile }
  }

  remove(id: string): void {
    if (id === DEFAULT_PROFILE.id) throw new Error('el perfil "Por defecto" no se puede borrar')
    const before = this.profiles.length
    this.profiles = this.profiles.filter((p) => p.id !== id)
    if (this.profiles.length !== before) this.save()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      this.profiles = sanitizeProfiles(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (err) {
      console.warn(`[omni] se ignora ${this.file}:`, err)
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    // El builtin no se persiste: se regenera siempre en memoria.
    const profiles = this.profiles.filter((p) => !p.builtin)
    writeFileSync(tmp, JSON.stringify({ profiles }, null, 2) + '\n')
    renameSync(tmp, this.file)
  }
}
