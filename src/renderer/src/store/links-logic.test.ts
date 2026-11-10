import { describe, expect, it } from 'vitest'
import { isClaudeArtifact } from './links-logic'

describe('isClaudeArtifact', () => {
  it('reconoce los artifacts de claude.ai y los publicados en claude.site', () => {
    expect(isClaudeArtifact('https://claude.ai/artifact/abc-123')).toBe(true)
    expect(isClaudeArtifact('https://claude.ai/code/artifact/9f1e2d')).toBe(true)
    expect(isClaudeArtifact('https://claude.ai/artifacts/abc')).toBe(true)
    expect(isClaudeArtifact('https://claude.site/artifacts/abc')).toBe(true)
  })

  it('el resto de enlaces sigue al navegador del sistema', () => {
    expect(isClaudeArtifact('https://claude.ai/chat/abc')).toBe(false)
    expect(isClaudeArtifact('http://claude.ai/artifact/abc')).toBe(false)
    expect(isClaudeArtifact('https://claude.ai.evil.com/artifact/abc')).toBe(false)
    expect(isClaudeArtifact('https://github.com/x/y')).toBe(false)
    expect(isClaudeArtifact('no es url')).toBe(false)
  })
})
