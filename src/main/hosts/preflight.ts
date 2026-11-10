import type { AgentId, HostTools } from '@shared/types'
import type { RemoteRunner } from './remote-fs'
import { loginWrap } from './shq'

/**
 * Preflight al conectar: UNA llamada remota que, con el entorno del shell de login (donde está el
 * PATH de nvm/asdf), reporta sistema, `$HOME` y qué herramientas hay, con su ruta absoluta (la
 * terminal lanza dtach fuera del shell de login, donde ese PATH no existe). Lo que imprima el
 * perfil del usuario antes del marcador (banners, `echo` en `.profile`) se ignora.
 */

export interface PreflightResult {
  /** `uname -sm`, p. ej. `Linux x86_64`. */
  system: string
  home: string
  tools: HostTools
}

const MARK = '__omni_preflight__'
const PREFLIGHT_AGENTS = ['claude', 'codex', 'opencode', 'goose', 'hermes'] as const satisfies readonly AgentId[]
/** Gestores de paquetes en orden de preferencia, con la línea que instala dtach en cada uno. */
const INSTALLERS: ReadonlyArray<readonly [string, string]> = [
  ['apt-get', 'sudo apt-get install -y dtach'],
  ['dnf', 'sudo dnf install -y dtach'],
  ['yum', 'sudo yum install -y dtach'],
  ['zypper', 'sudo zypper install -y dtach'],
  ['pacman', 'sudo pacman -S --noconfirm dtach'],
  ['apk', 'sudo apk add dtach'],
  ['brew', 'brew install dtach']
]
const TOOLS = ['dtach', 'git', ...PREFLIGHT_AGENTS, ...INSTALLERS.map(([pm]) => pm)] as const

/** Script del preflight (texto fijo, sin datos del usuario). */
export const PREFLIGHT_SCRIPT = [
  `printf '%s\\n' ${MARK}`,
  `printf 'system=%s\\n' "$(uname -sm 2>/dev/null)"`,
  `printf 'home=%s\\n' "$HOME"`,
  `for t in ${TOOLS.join(' ')}; do p=$(command -v "$t" 2>/dev/null) && printf 'tool=%s %s\\n' "$t" "$p"; done`,
  'exit 0'
].join('\n')

/** Salida del script → resultado. Pura. Rechaza si falta el marcador (el login shell no corrió el script). */
export function parsePreflight(stdout: string): PreflightResult {
  const lines = stdout.split(/\r?\n/)
  const start = lines.indexOf(MARK)
  if (start === -1) throw new Error('El host no respondió al preflight (¿el shell de login falla al arrancar?)')
  let system = ''
  let home = ''
  // `tool=<nombre> <ruta>`: la ruta puede tener espacios; sin ruta (o relativa) solo se sabe que está.
  const found = new Map<string, string | null>()
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('system=')) system = line.slice('system='.length).trim()
    else if (line.startsWith('home=')) home = line.slice('home='.length)
    else if (line.startsWith('tool=')) {
      const rest = line.slice('tool='.length)
      const space = rest.indexOf(' ')
      const name = (space === -1 ? rest : rest.slice(0, space)).trim()
      const path = space === -1 ? '' : rest.slice(space + 1)
      found.set(name, path.startsWith('/') ? path : null)
    }
  }
  const tools: HostTools = { dtach: found.has('dtach'), git: found.has('git'), agents: PREFLIGHT_AGENTS.filter((a) => found.has(a)) }
  const dtachPath = found.get('dtach')
  if (dtachPath) tools.dtachPath = dtachPath
  if (!tools.dtach) {
    const installer = INSTALLERS.find(([pm]) => found.has(pm))
    if (installer) tools.dtachInstall = installer[1]
  }
  return { system, home, tools }
}

/** Corre el preflight por el transporte (una sola llamada `ssh`). */
export async function preflight(runner: RemoteRunner): Promise<PreflightResult> {
  const result = await runner.run(loginWrap(PREFLIGHT_SCRIPT), { timeoutMs: 30_000 })
  if (result.code !== 0) {
    const lines = result.stderr.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    throw new Error(`Falló el preflight: ${lines.at(-1) ?? `código ${result.code ?? 'señal'}`}`)
  }
  return parsePreflight(result.stdout.toString('utf8'))
}
