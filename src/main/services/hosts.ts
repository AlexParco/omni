import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RemoteHost } from '@shared/types'
import { CONFIG_DIR } from '../paths'

const DEFAULT_FILE = join(CONFIG_DIR, 'hosts.json')

/**
 * Lo que se le acepta a `ssh` como destino: un alias de `~/.ssh/config` o `user@host`, sin espacios
 * ni un `-` al inicio (que `ssh` leería como opción). El puerto y las llaves van en `~/.ssh/config`.
 */
const TARGET_RE = /^(?!-)[A-Za-z0-9_.@:%+[\]-]{1,255}$/

/** Valida y normaliza el destino; error humano si no sirve. Exportada para tests. */
export function validateTarget(raw: string): string {
  const target = raw.trim()
  if (!TARGET_RE.test(target)) throw new Error(`destino SSH inválido: "${raw}". Usa un alias de ~/.ssh/config o usuario@host`)
  return target
}

/** Deja solo hosts con forma válida (ids y destinos únicos). Exportada para tests. */
export function sanitizeHosts(raw: unknown): RemoteHost[] {
  const list = typeof raw === 'object' && raw !== null && Array.isArray((raw as { hosts?: unknown }).hosts) ? (raw as { hosts: unknown[] }).hosts : []
  const out: RemoteHost[] = []
  for (const x of list) {
    if (typeof x !== 'object' || x === null) continue
    const r = x as Record<string, unknown>
    if (typeof r.id !== 'string' || r.id === '' || typeof r.target !== 'string' || !TARGET_RE.test(r.target)) continue
    if (out.some((h) => h.id === r.id || h.target === r.target)) continue
    const name = typeof r.name === 'string' && r.name.trim() !== '' ? r.name.trim() : r.target
    out.push({ id: r.id, name, target: r.target })
  }
  return out
}

/**
 * `~/.config/omni/hosts.json`: los servidores a los que omni se conecta por SSH (ARCHITECTURE §3.26).
 * Solo guarda nombre y destino: llaves, puertos y saltos los resuelve `ssh` con `~/.ssh/config`, así
 * omni nunca guarda credenciales.
 */
export class HostStore {
  private hosts: RemoteHost[] = []

  constructor(private readonly file = DEFAULT_FILE) {
    if (!existsSync(file)) return
    try {
      this.hosts = sanitizeHosts(JSON.parse(readFileSync(file, 'utf8')))
    } catch (err) {
      console.warn(`[omni] se ignora ${file}:`, err)
    }
  }

  list(): RemoteHost[] {
    return this.hosts
  }

  get(id: string): RemoteHost | undefined {
    return this.hosts.find((h) => h.id === id)
  }

  /** Devuelve el existente si el destino ya estaba registrado. */
  add(name: string, rawTarget: string): RemoteHost {
    const target = validateTarget(rawTarget)
    const found = this.hosts.find((h) => h.target === target)
    if (found) return found
    const host: RemoteHost = { id: randomUUID(), name: name.trim() || target, target }
    this.hosts.push(host)
    this.save()
    return host
  }

  remove(id: string): void {
    this.hosts = this.hosts.filter((h) => h.id !== id)
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ hosts: this.hosts }, null, 2) + '\n')
    renameSync(tmp, this.file)
  }
}
