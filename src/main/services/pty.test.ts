import { describe, expect, it } from 'vitest'
import { agentCommand } from './pty'
import { shellEnv } from '../../daemon/ptys'

describe('agentCommand', () => {
  it('sin args escribe el comando pelado', () => {
    expect(agentCommand('claude')).toBe('claude')
    expect(agentCommand('claude', [])).toBe('claude')
  })

  it('con args los pega tras el comando separados por espacio', () => {
    expect(agentCommand('claude', ['--dangerously-skip-permissions'])).toBe('claude --dangerously-skip-permissions')
    expect(agentCommand('codex', ['--full-auto', '-m', 'o3'])).toBe('codex --full-auto -m o3')
  })

  it('ignora args vacíos o solo espacios', () => {
    expect(agentCommand('claude', ['', '  ', '--verbose'])).toBe('claude --verbose')
  })
})

describe('shellEnv', () => {
  it('no pasa marcadores de Claude Code ni variables del lanzador a los shells', () => {
    const env = shellEnv({ PATH: '/bin', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: '/x' })
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/x' })
  })
})
