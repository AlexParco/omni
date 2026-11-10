import { randomBytes } from 'node:crypto'
import type { HostDirent, HostFs, HostStat } from './types'
import type { RunOptions, RunResult } from './ssh'
import { shCommand } from './shq'

/**
 * `HostFs` de un host remoto: cada operación es UN `ssh` con un script POSIX corto. El script es
 * fijo y la ruta va como argumento (`sh -c '<script>' omni '<ruta>'`), así una ruta con comillas,
 * `$` o saltos de línea nunca se interpreta. Pensado para Linux con GNU coreutils; macOS/BSD y
 * busybox por las ramas de respaldo (`stat -f`, `stat -c`).
 */

/** Lo único que `RemoteFs` necesita del transporte (inyectable en tests). */
export interface RemoteRunner {
  run(cmdline: string, opts?: RunOptions): Promise<RunResult>
}

/** Códigos de salida propios de los scripts (el resto es un fallo con stderr). */
const NOT_FOUND = 3
const WRONG_KIND = 4
const NOT_FILE = 5
const NOT_WRITABLE = 6

/**
 * `mt <ruta>` imprime `<tamaño> <mtime en s, con decimales si hay>` siguiendo symlinks.
 * GNU find (`%T@` trae fracción) → `stat -c` (busybox) → `stat -f` (BSD/macOS, `%Fm` con fracción).
 * El orden importa: en GNU `stat -f` es "estado del filesystem" y no falla.
 */
const MT = `mt() {
  m=$(find -L "$1" -maxdepth 0 -printf '%s %T@' 2>/dev/null) && [ -n "$m" ] && { printf '%s' "$m"; return 0; }
  m=$(stat -L -c '%s %Y' "$1" 2>/dev/null) && [ -n "$m" ] && { printf '%s' "$m"; return 0; }
  stat -L -f '%z %Fm' "$1"
}
`

const STAT_SCRIPT = `${MT}p=$1
[ -e "$p" ] || exit ${NOT_FOUND}
if [ -d "$p" ]; then printf 'd '; else printf 'f '; fi
mt "$p"`

const READ_SCRIPT = `p=$1
[ -e "$p" ] || exit ${NOT_FOUND}
[ -d "$p" ] && exit ${WRONG_KIND}
exec cat -- "$p"`

// Escribe sobre el destino si es un symlink a algo que existe; un symlink roto se reemplaza a sí
// mismo (como en local): seguirlo crearía un archivo donde apunte, quizá fuera del workspace.
// Conserva los permisos del archivo copiándolo al tmp con `cp -p` antes de truncarlo con `cat >`
// (portátil, sin `stat` de modo ni `chmod --reference`).
const WRITE_SCRIPT = `${MT}p=$1
if [ -L "$p" ] && [ -e "$p" ]; then
  r=$(realpath -- "$p" 2>/dev/null || readlink -f -- "$p" 2>/dev/null) && [ -n "$r" ] && p=$r
fi
[ -d "$p" ] && exit ${WRONG_KIND}
d=\${p%/*}
[ -n "$d" ] || d=/
[ -d "$d" ] || exit ${NOT_FOUND}
t="$d/.\${p##*/}.omni-$2.tmp"
if [ -e "$p" ]; then
  [ -f "$p" ] || exit ${NOT_FILE}
  [ -w "$p" ] || exit ${NOT_WRITABLE}
fi
[ -w "$d" ] || exit ${NOT_WRITABLE}
if [ -e "$p" ]; then cp -p -- "$p" "$t" || { rm -f -- "$t"; exit 1; }; fi
cat > "$t" || { rm -f -- "$t"; exit 1; }
mv -f -- "$t" "$p" || { rm -f -- "$t"; exit 1; }
mt "$p"`

// Un nombre puede tener saltos de línea: cada entrada termina en NUL. `[ -d ]` sigue symlinks,
// como el árbol local (files.ts) que hace `stat` de los symlinks.
const READDIR_SCRIPT = `p=$1
[ -e "$p" ] || exit ${NOT_FOUND}
[ -d "$p" ] || exit ${WRONG_KIND}
cd -- "$p" || exit 1
for f in .* *; do
  case $f in .|..) continue ;; esac
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -d "$f" ]; then printf 'd/%s\\000' "$f"; else printf 'f/%s\\000' "$f"; fi
done`

const REALPATH_SCRIPT = `p=$1
[ -e "$p" ] || exit ${NOT_FOUND}
r=$(realpath -- "$p" 2>/dev/null) || r=$(readlink -f -- "$p" 2>/dev/null) || r=$(cd -P -- "$p" 2>/dev/null && pwd -P) || exit 1
printf '%s' "$r"`

const MKDIRP_SCRIPT = `exec mkdir -p -- "$1"`

/** Línea remota que corre un script fijo con argumentos posicionales (`$1`, `$2`…). */
export function scriptLine(script: string, args: string[]): string {
  return shCommand(['/bin/sh', '-c', script, 'omni', ...args])
}

/** `<tamaño> <mtime s[.fracción]>` → bytes y ms. Pura. */
export function parseSizeMtime(text: string): { size: number; mtime: number } {
  const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)\s*$/.exec(text)
  if (!match) throw new Error(`respuesta de stat inesperada: ${JSON.stringify(text.slice(0, 80))}`)
  return { size: Number(match[1]), mtime: Math.round(Number(match[2]) * 1000) }
}

/** Salida de `READDIR_SCRIPT` (`d/nombre\0f/nombre\0…`) → entradas. Pura. */
export function parseDirents(out: Buffer): HostDirent[] {
  const entries: HostDirent[] = []
  for (const raw of out.toString('utf8').split('\0')) {
    if (raw === '') continue
    const kind = raw.slice(0, 2)
    if (kind !== 'd/' && kind !== 'f/') throw new Error(`respuesta de readdir inesperada: ${JSON.stringify(raw.slice(0, 80))}`)
    entries.push({ name: raw.slice(2), dir: kind === 'd/' })
  }
  return entries
}

function assertAbsolute(path: string): void {
  if (!path.startsWith('/')) throw new Error(`ruta no absoluta: ${path}`)
}

/** Error humano a partir del código del script o de su stderr. */
function fsError(path: string, result: RunResult, messages: Partial<Record<number, string>>): Error {
  const known = result.code === null ? undefined : messages[result.code]
  if (known) return new Error(`${known}: ${path}`)
  if (result.code === null) return new Error(`se agotó el tiempo: ${path}`)
  const lines = result.stderr.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const last = lines.at(-1)
  if (last && /Permission denied/i.test(last)) return new Error(`sin permiso: ${path}`)
  if (last && /No such file/i.test(last)) return new Error(`no existe: ${path}`)
  if (last && /File exists|Not a directory/i.test(last)) return new Error(`hay un archivo en el camino: ${path}`)
  return new Error(`${path}: ${last ?? `código ${result.code}`}`)
}

const COMMON = { [NOT_FOUND]: 'no existe', [NOT_WRITABLE]: 'sin permiso de escritura', [NOT_FILE]: 'no es un archivo' }

export class RemoteFs implements HostFs {
  constructor(private readonly runner: RemoteRunner) {}

  async stat(path: string): Promise<HostStat | null> {
    assertAbsolute(path)
    const result = await this.runner.run(scriptLine(STAT_SCRIPT, [path]))
    if (result.code === NOT_FOUND) return null
    if (result.code !== 0) throw fsError(path, result, COMMON)
    const text = result.stdout.toString('utf8')
    return { dir: text.startsWith('d '), ...parseSizeMtime(text.slice(2)) }
  }

  async readFile(path: string): Promise<Buffer> {
    assertAbsolute(path)
    const result = await this.runner.run(scriptLine(READ_SCRIPT, [path]), { timeoutMs: 120_000 })
    if (result.code !== 0) throw fsError(path, result, { ...COMMON, [WRONG_KIND]: 'es una carpeta' })
    return result.stdout
  }

  async writeFile(path: string, data: Buffer | string): Promise<number> {
    assertAbsolute(path)
    const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    const token = randomBytes(6).toString('hex')
    const result = await this.runner.run(scriptLine(WRITE_SCRIPT, [path, token]), { input, timeoutMs: 120_000 })
    if (result.code !== 0) {
      throw fsError(path, result, { ...COMMON, [NOT_FOUND]: 'no existe la carpeta de', [WRONG_KIND]: 'es una carpeta' })
    }
    return parseSizeMtime(result.stdout.toString('utf8')).mtime
  }

  async readdir(path: string): Promise<HostDirent[]> {
    assertAbsolute(path)
    const result = await this.runner.run(scriptLine(READDIR_SCRIPT, [path]))
    if (result.code !== 0) throw fsError(path, result, { ...COMMON, [WRONG_KIND]: 'no es una carpeta' })
    return parseDirents(result.stdout)
  }

  async realpath(path: string): Promise<string> {
    assertAbsolute(path)
    const result = await this.runner.run(scriptLine(REALPATH_SCRIPT, [path]))
    if (result.code !== 0) throw fsError(path, result, COMMON)
    return result.stdout.toString('utf8')
  }

  async mkdirp(path: string): Promise<void> {
    assertAbsolute(path)
    const result = await this.runner.run(scriptLine(MKDIRP_SCRIPT, [path]))
    if (result.code !== 0) throw fsError(path, result, COMMON)
  }
}
