import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loginWrap, remoteLine, shCommand, shq } from './shq'

/** Corre una línea con el `/bin/sh` real y devuelve stdout: el comillado se prueba contra un shell, no contra un regex. */
function sh(line: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('/bin/sh', ['-c', line], { encoding: 'utf8', env })
}

const TRICKY = [
  '',
  ' ',
  'simple',
  'con espacios  dobles',
  "it's",
  "''",
  "'",
  'a"b"c',
  '$HOME',
  '${HOME}',
  '$(echo pwned)',
  '`echo pwned`',
  'back\\slash\\',
  'line\nbreak\n',
  'tab\there',
  '-n',
  '--',
  '-rf /',
  'ñandú 日本語 🚀',
  '*',
  '~',
  ';echo pwned;',
  '&& echo pwned',
  '| cat',
  '!event',
  '#comment',
  "mix 'single' \"double\" $var `tick` \\ \n end"
]

describe('shq', () => {
  it('envuelve en comillas simples y escapa la comilla simple', () => {
    expect(shq('abc')).toBe("'abc'")
    expect(shq('')).toBe("''")
    expect(shq("it's")).toBe("'it'\\''s'")
  })

  it.each(TRICKY.map((s) => [JSON.stringify(s), s]))('llega literal a /bin/sh: %s', (_label, s) => {
    expect(sh(`printf '%s' ${shq(s)}`)).toBe(s)
  })

  it('el string vacío es un argumento, no ninguno', () => {
    expect(sh(`set -- ${shq('')} ${shq('x')}; printf '%s' "$#"`)).toBe('2')
  })
})

describe('shCommand', () => {
  it('arma `exec` con cada argumento comillado', () => {
    expect(shCommand(['git', 'status', '--porcelain'])).toBe("exec 'git' 'status' '--porcelain'")
  })

  it('con cwd hace `cd --` antes', () => {
    expect(shCommand(['ls'], '/srv/my app')).toBe("cd -- '/srv/my app' && exec 'ls'")
  })

  it('sin ejecutable es un error', () => {
    expect(() => shCommand([])).toThrow()
  })

  it('todos los argumentos difíciles llegan intactos y en orden', () => {
    const out = sh(shCommand(['printf', '%s\\0', ...TRICKY]))
    expect(out.split('\0').slice(0, -1)).toEqual(TRICKY)
  })

  it('cd a una carpeta con nombre difícil (y que empieza con guion)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omni-shq-'))
    const dir = join(root, "-d 'q' $x `t`\nñ")
    mkdirSync(dir)
    try {
      expect(sh(shCommand(['pwd', '-P'], dir)).trim()).toBe(realpathSync(dir))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('el código de salida es el del comando', () => {
    expect(() => sh(shCommand(['sh', '-c', 'exit 7']))).toThrow(/status 7|code 7|7/)
  })
})

describe('loginWrap', () => {
  it('corre la línea en $SHELL -lc con los argumentos intactos', () => {
    const out = sh(loginWrap(shCommand(['printf', '%s\\0', ...TRICKY])), { ...process.env, SHELL: '/bin/sh' })
    expect(out.split('\0').slice(0, -1)).toEqual(TRICKY)
  })

  it('sin $SHELL usa /bin/sh', () => {
    const env = { ...process.env, SHELL: '' }
    expect(sh(loginWrap("printf '%s' ok"), env)).toBe('ok')
  })

  it('con un $SHELL csh/tcsh (no aceptan -lc) corre la línea igual, con saltos de línea y !', () => {
    const line = `printf '%s|' "$0" a!b\nprintf 'dos'`
    for (const shell of ['/bin/csh', '/bin/tcsh']) {
      expect(sh(loginWrap(line), { ...process.env, SHELL: shell }), shell).toBe('/bin/sh|a!b|dos')
    }
  })

  it('el entorno del perfil de login (PATH de nvm, etc.) llega a la línea', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-login-'))
    try {
      // "Shell de login" que, como un perfil, exporta algo y corre lo que le pasen con -lc.
      const shell = join(dir, 'login-shell')
      writeFileSync(shell, '#!/bin/sh\n[ "$1" = -lc ] || exit 9\nexport FROM_PROFILE=si\nexec /bin/sh -c "$2"\n')
      chmodSync(shell, 0o755)
      expect(sh(loginWrap('printf %s "$FROM_PROFILE"'), { ...process.env, SHELL: shell })).toBe('si')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('la línea viaja en OMNI_LINE y no queda en el entorno del comando', () => {
    expect(sh(loginWrap('printf "[%s]" "${OMNI_LINE-unset}"'), { ...process.env, SHELL: '/bin/sh' })).toBe('[unset]')
  })
})

describe('remoteLine', () => {
  /** Como sshd: la línea la parsea el shell de login del usuario con `-c`. */
  const viaLogin = (shell: string, line: string): string => execFileSync(shell, ['-c', remoteLine(line)], { encoding: 'utf8' })
  const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/csh', '/bin/tcsh', '/bin/dash'].filter((s) => existsSync(s))

  it('línea simple: `exec /bin/sh -c` con la línea comillada, legible', () => {
    expect(remoteLine('printf %s "$HOME"')).toBe(`exec /bin/sh -c 'printf %s "$HOME"'`)
  })

  it.each(SHELLS)('con %s como shell de login llegan intactos todos los argumentos difíciles', (shell) => {
    const out = viaLogin(shell, shCommand(['printf', '%s\\0', ...TRICKY]))
    expect(out.split('\0').slice(0, -1)).toEqual(TRICKY)
  })

  it.each(SHELLS)('con %s: sintaxis POSIX (${…}, 2>/dev/null, $(…), saltos de línea) la corre /bin/sh', (shell) => {
    const line = `x=\${UNDEFINED_OMNI:-def} 2>/dev/null\nprintf '%s-%s' "$x" "$(printf ok)"`
    expect(viaLogin(shell, line)).toBe('def-ok')
  })

  it('el código de salida es el de la línea', () => {
    expect(() => viaLogin('/bin/csh', 'exit 7')).toThrow(/status 7|code 7|7/)
  })
})
