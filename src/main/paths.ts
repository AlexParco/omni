import { homedir } from 'node:os'
import { join } from 'node:path'

/** `~/.config/omni`: donde viven los JSON de main y los worktrees. */
export const CONFIG_DIR = join(homedir(), '.config', 'omni')

/** Raíz de los worktrees: fuera de los repos, nada que ignorar (ARCHITECTURE §3.15). La comparten `ProjectStore` y `WorktreeService`. */
export const WORKTREES_ROOT = join(CONFIG_DIR, 'worktrees')
