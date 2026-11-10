import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef } from '@shared/types'
import { DEFAULT_AGENTS, mergeAgents } from './agents'

const DEFAULTS: AgentDef[] = [
  { id: 'shell', name: 'Terminal', badge: '$', command: null },
  { id: 'claude', name: 'Claude Code', badge: 'CC', command: 'claude' },
  { id: 'opencode', name: 'OpenCode', badge: 'OC', command: 'opencode' }
]

describe('mergeAgents', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sin overrides devuelve los defaults tal cual', () => {
    expect(mergeAgents(DEFAULTS, [])).toEqual(DEFAULTS)
    expect(mergeAgents(DEFAULTS, 'basura')).toEqual(DEFAULTS)
    expect(mergeAgents(DEFAULTS, [42, null, 'x'])).toEqual(DEFAULTS)
  })

  it('pisa name, badge y command (string o null) y respeta el id', () => {
    const merged = mergeAgents(DEFAULTS, [{ id: 'claude', command: 'claude --verbose', badge: 'CL', name: 'Claude' }, { id: 'nope', name: 'x' }, { id: 'opencode', command: null }])
    expect(merged.find((a) => a.id === 'claude')).toEqual({ ...DEFAULTS[1], command: 'claude --verbose', badge: 'CL', name: 'Claude' })
    expect(merged.find((a) => a.id === 'opencode')?.command).toBeNull()
    expect(merged).toHaveLength(DEFAULTS.length)
  })

  it('claves desconocidas o con tipo malo se descartan con warn y queda el default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const merged = mergeAgents(DEFAULTS, [{ id: 'claude', name: '', badge: 7, command: ['claude'], icon: 'x', hidden: true }])
    expect(merged.find((a) => a.id === 'claude')).toEqual(DEFAULTS[1])
    expect(warn).toHaveBeenCalledTimes(5)
    expect(mergeAgents(DEFAULTS, [{ id: 'shell', command: 42 }]).find((a) => a.id === 'shell')?.command).toBeNull()
  })

  it('answers y safePermissions de un agents.json viejo se ignoran en silencio', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const merged = mergeAgents(DEFAULTS, [{ id: 'claude', answers: { allow: '1', deny: '3' }, safePermissions: ['^ls\\b'], badge: 'CL' }])
    expect(merged.find((a) => a.id === 'claude')).toEqual({ ...DEFAULTS[1], badge: 'CL' })
    expect(warn).not.toHaveBeenCalled()
  })
})
