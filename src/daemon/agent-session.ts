import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Conversación viva de Claude Code dentro de una sesión. omni lo lanza con `--session-id <uuid>`, pero
 * `/resume` (o `/clear`) dentro de Claude Code cambia de conversación sin que la terminal se entere:
 * revivir con el uuid del lanzamiento abriría el chat viejo. Claude Code deja por proceso
 * `~/.claude/sessions/<pid>.json` con el `sessionId` en curso; aquí se lee ese archivo para los
 * descendientes del shell de cada sesión.
 */

/** Tabla `pid → ppid` de los procesos del sistema. */
export type ProcessTable = Map<number, number>

/** Lee la tabla de procesos con `ps`; vacía si falla (no hay nada que seguir). */
export function readProcessTable(): Promise<ProcessTable> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? new Map() : parseProcessTable(stdout))
    })
  })
}

/** Convierte la salida de `ps -o pid=,ppid=` en la tabla; ignora líneas que no son dos números. */
export function parseProcessTable(out: string): ProcessTable {
  const table: ProcessTable = new Map()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (m) table.set(Number(m[1]), Number(m[2]))
  }
  return table
}

/** Descendientes de `root` (sin incluirlo), del más cercano al más lejano. */
export function descendants(table: ProcessTable, root: number): number[] {
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of table) {
    const list = children.get(ppid)
    if (list) list.push(pid)
    else children.set(ppid, [pid])
  }
  const out: number[] = []
  const queue = [...(children.get(root) ?? [])]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    out.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return out
}

/** Lector del archivo de sesión de Claude Code por pid; `null` si no existe o no se puede leer. */
export type SessionFileReader = (pid: number) => Promise<string | null>

/** Lector real: `~/.claude/sessions/<pid>.json` (o bajo `CLAUDE_CONFIG_DIR` si está definido). */
export const readClaudeSessionFile: SessionFileReader = async (pid) => {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  try {
    return await readFile(join(dir, 'sessions', `${pid}.json`), 'utf8')
  } catch {
    return null
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `sessionId` en curso del primer Claude Code bajo `shellPid`; `null` si no corre ninguno o su
 * archivo no trae un uuid válido (nunca se inventa un id: se queda el que había).
 */
export async function claudeSessionUnder(table: ProcessTable, shellPid: number, read: SessionFileReader = readClaudeSessionFile): Promise<string | null> {
  for (const pid of descendants(table, shellPid)) {
    const raw = await read(pid)
    if (raw === null) continue
    try {
      const data: unknown = JSON.parse(raw)
      const id = typeof data === 'object' && data !== null ? (data as { sessionId?: unknown }).sessionId : undefined
      if (typeof id === 'string' && UUID.test(id)) return id
    } catch {
      // Archivo a medio escribir: se reintenta en la próxima vuelta.
    }
  }
  return null
}
