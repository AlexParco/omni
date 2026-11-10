/**
 * Artifact de Claude (`claude.ai/artifact/…`, `claude.ai/code/artifact/…` o uno publicado en
 * `claude.site/artifacts/…`): se abre en el navegador de omni, cuya partición persistente conserva el
 * login de claude.ai entre aperturas (§3.9). Exportada para tests.
 */
export function isClaudeArtifact(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (u.hostname === 'claude.ai' || u.hostname === 'www.claude.ai') return /^\/(?:code\/)?artifacts?\//.test(u.pathname)
  return u.hostname === 'claude.site' && u.pathname.startsWith('/artifacts/')
}
