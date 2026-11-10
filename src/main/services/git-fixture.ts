import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Repos git reales en carpetas temporales para los tests de worktrees y revisión. Solo lo usan
 * los `*.test.ts`: no es un servicio.
 */

/** Corre git en `cwd` y devuelve stdout; tira si falla. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Carpeta temporal con un repo en `main`, identidad propia (sin firmar, sin hooks globales) y un commit inicial. */
export function initRepo(prefix = 'omni-repo-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'omni test')
  git(dir, 'config', 'user.email', 'omni@test.local')
  git(dir, 'config', 'commit.gpgsign', 'false')
  const hooks = join(dir, '.nohooks')
  mkdirSync(hooks)
  git(dir, 'config', 'core.hooksPath', hooks)
  commitFile(dir, 'README.md', '# demo\n', 'init')
  return dir
}

/** Escribe el archivo y lo commitea. */
export function commitFile(dir: string, rel: string, content: string, message: string): void {
  writeFileSync(join(dir, rel), content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}
