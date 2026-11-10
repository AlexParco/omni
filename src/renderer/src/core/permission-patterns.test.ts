import { describe, expect, it } from 'vitest'
import { detectPermission, hasTrustPrompt } from './permission-patterns'

const CLAUDE_BASH = [
  '╭──────────────────────────────────────────╮',
  '│ Bash command                              │',
  '│                                           │',
  '│   npm test                                │',
  '│   Run the unit tests                      │',
  '│                                           │',
  '│ Do you want to proceed?                   │',
  '│ ❯ 1. Yes                                  │',
  "│   2. Yes, and don't ask again for npm     │",
  '│   3. No, and tell Claude what to do       │',
  '╰──────────────────────────────────────────╯'
]

describe('detectPermission · Claude Code', () => {
  it('Bash command: tipo bash y el comando como resumen', () => {
    expect(detectPermission('claude', CLAUDE_BASH)).toEqual({ kind: 'bash', summary: 'npm test' })
  })

  it('Edit file: el archivo sale de la pregunta', () => {
    const tail = ['│ Edit file', '│ src/app.ts', '│  - a', '│  + b', '│ Do you want to make this edit to src/app.ts?', '│ ❯ 1. Yes', '│   2. No']
    expect(detectPermission('claude', tail)).toEqual({ kind: 'edit', summary: 'src/app.ts' })
  })

  it('Write y Read: tipo por cabecera y por pregunta', () => {
    expect(detectPermission('claude', ['Write', 'docs/README.md', 'Do you want to proceed?', '❯ 1. Yes'])).toEqual({ kind: 'edit', summary: 'docs/README.md' })
    expect(detectPermission('claude', ['Create file', 'Do you want to create notes.md?', '❯ 1. Yes'])).toEqual({ kind: 'edit', summary: 'notes.md' })
    expect(detectPermission('claude', ['Read', '/etc/hosts', 'Do you want to proceed?', '❯ 1. Yes'])).toEqual({ kind: 'read', summary: '/etc/hosts' })
    expect(detectPermission('claude', ['Do you want to allow Claude to read ~/.zshrc?', '❯ 1. Yes', '  2. No'])).toEqual({ kind: 'read', summary: '~/.zshrc' })
  })

  it('pregunta sin cabecera conocida: other con la pregunta tal cual', () => {
    expect(detectPermission('claude', ['Fetch URL', 'https://x.y', 'Do you want to proceed?', '❯ 1. Yes'])).toEqual({ kind: 'other', summary: 'Do you want to proceed?' })
  })

  it('solo las opciones numeradas también bastan', () => {
    expect(detectPermission('claude', ['Bash command', 'ls -la', '❯ 1. Yes', '  2. No'])).toEqual({ kind: 'bash', summary: 'ls -la' })
  })

  it('manda la última pregunta: una anterior ya respondida no cuenta', () => {
    const tail = ['Bash command', 'rm -rf dist', 'Do you want to proceed?', '❯ 1. Yes', 'Listo.', 'Bash command', 'git status', 'Do you want to proceed?', '❯ 1. Yes']
    expect(detectPermission('claude', tail)).toEqual({ kind: 'bash', summary: 'git status' })
  })

  it('un diálogo viejo seguido de salida nueva ya no es permiso', () => {
    const output = Array.from({ length: 15 }, (_, i) => `línea ${i}`)
    expect(detectPermission('claude', [...CLAUDE_BASH, ...output])).toBeNull()
    expect(detectPermission('claude', [...CLAUDE_BASH, ...output.slice(0, 5)])).toEqual({ kind: 'bash', summary: 'npm test' })
    expect(detectPermission('codex', ['Allow command?', '  $ ls', '  ▶ Yes (y)', ...output])).toBeNull()
  })

  it('sin diálogo de permiso devuelve null', () => {
    expect(detectPermission('claude', ['Working…', 'Reading src/app.ts'])).toBeNull()
    expect(detectPermission('claude', [])).toBeNull()
  })
})

describe('detectPermission · Codex', () => {
  it('Allow command? con el comando debajo', () => {
    expect(detectPermission('codex', ['Allow command?', '  $ npm test', '  ▶ Yes (y)', '    Yes, always (a)', '    No (n)'])).toEqual({ kind: 'bash', summary: 'npm test' })
  })

  it('wants to run: el comando debajo sin el `$`', () => {
    expect(detectPermission('codex', ['Codex wants to run the following command:', '  cargo build', 'Approve? [y/n]'])).toEqual({ kind: 'bash', summary: 'cargo build' })
  })

  it('cambios: tipo edit con el archivo', () => {
    expect(detectPermission('codex', ['Apply changes?', 'src/lib.rs', '▶ Yes (y)'])).toEqual({ kind: 'edit', summary: 'src/lib.rs' })
  })

  it('approve suelto: other', () => {
    expect(detectPermission('codex', ['Waiting for approval to continue', '(y) approve  (n) deny'])).toEqual({ kind: 'other', summary: '(y) approve  (n) deny' })
    expect(detectPermission('codex', ['thinking…'])).toBeNull()
  })
})

describe('detectPermission · otros agentes', () => {
  it('sin patrones: siempre null', () => {
    expect(detectPermission('hermes', CLAUDE_BASH)).toBeNull()
    expect(detectPermission('opencode', ['Allow command?'])).toBeNull()
    expect(detectPermission('shell', ['Do you want to proceed?'])).toBeNull()
  })
})

describe('detectPermission · diálogo de confianza de Claude Code', () => {
  const TRUST = [
    '╭──────────────────────────────────────────────────────╮',
    '│ Accessing workspace:                                  │',
    '│ /Users/x/.config/omni/worktrees/omni/cc-1             │',
    '│                                                       │',
    '│ Quick safety check: Is this a project you created or  │',
    '│ one you trust?                                        │',
    '│                                                       │',
    '│ ❯ 1. Yes, proceed                                     │',
    '│   2. No, exit                                         │',
    '╰──────────────────────────────────────────────────────╯'
  ]

  it('tipo trust con la carpeta de la línea siguiente a "Accessing workspace:"', () => {
    expect(detectPermission('claude', TRUST)).toEqual({ kind: 'trust', summary: 'Confiar en la carpeta /Users/x/.config/omni/worktrees/omni/cc-1' })
  })

  it('la ruta también puede venir en la misma línea; sin ruta, resumen genérico', () => {
    expect(detectPermission('claude', ['Accessing workspace: /tmp/p', 'Is this a project you created or one you trust?', '❯ 1. Yes, proceed'])).toEqual({ kind: 'trust', summary: 'Confiar en la carpeta /tmp/p' })
    expect(detectPermission('claude', ['Quick safety check: Is this a project you created or one you trust?', '❯ 1. Yes, proceed', '  2. No, exit'])).toEqual({ kind: 'trust', summary: 'Confiar en esta carpeta' })
  })

  it('manda sobre las opciones numeradas y un diálogo viejo seguido de salida ya no cuenta', () => {
    const output = Array.from({ length: 15 }, (_, i) => `línea ${i}`)
    expect(detectPermission('claude', [...TRUST, ...output])).toBeNull()
    expect(detectPermission('claude', [...TRUST, ...output.slice(0, 3)])?.kind).toBe('trust')
    // Un permiso posterior al diálogo de confianza ya respondido es un permiso normal.
    expect(detectPermission('claude', [...TRUST, ...output, ...CLAUDE_BASH])).toEqual({ kind: 'bash', summary: 'npm test' })
  })

  it('hasTrustPrompt: cualquiera de las dos frases, con bordes de caja y saltos de línea en medio', () => {
    expect(hasTrustPrompt(TRUST.join('\n'))).toBe(true)
    expect(hasTrustPrompt('Quick safety check: Is this a project you created or\n│ one you trust?')).toBe(true)
    expect(hasTrustPrompt('Accessing workspace:\n/tmp/p')).toBe(true)
    expect(hasTrustPrompt('Do you want to proceed?\n❯ 1. Yes')).toBe(false)
  })
})

describe('diálogos de selección de Claude Code (sin BEL)', () => {
  const INK = [
    '────────────────────────────────────────',
    ' New MCP server found in this project: github',
    '',
    ' MCP servers may execute code or access system resources.',
    '',
    ' Use this MCP server',
    ' Use this and all future MCP servers in this project',
    ' ❯ Continue without using this MCP server',
    '',
    ' Enter to confirm · Esc to cancel'
  ]
  it('hasClaudeDialog reconoce el pie "Enter to confirm · Esc to cancel"', async () => {
    const { hasClaudeDialog } = await import('./permission-patterns')
    expect(hasClaudeDialog(INK.join('\n'))).toBe(true)
    expect(hasClaudeDialog('λ ~ $ ')).toBe(false)
  })
  it('un diálogo que no es de confianza entra como "other" con su título', () => {
    const p = detectPermission('claude', INK)
    expect(p).toEqual({ kind: 'other', summary: 'New MCP server found in this project: github' })
  })
  it('la confianza sigue teniendo prioridad y acepta espacios irregulares', () => {
    const lines = ['Accessing  workspace:', ' /tmp/wt', '', ' Quick safety check: Is this a project you created or one you trust?', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel']
    expect(detectPermission('claude', lines)?.kind).toBe('trust')
  })
})

describe('permiso Bash real de Claude Code (pantalla completa)', () => {
  const SCREEN = [
    ' Bash command',
    ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
    ' Run current tests and check Node version',
    ' ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' npm test 2>&1 | tail -5; node --version',
    ' ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' This command requires approval',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don’t ask again for: npm test *',
    '   4. No'
  ]
  it('el resumen es el comando, no el consejo ni la descripción', () => {
    expect(detectPermission('claude', SCREEN)).toEqual({ kind: 'bash', summary: 'npm test 2>&1 | tail -5; node --version' })
  })
})
