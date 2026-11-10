import { omni } from '@/lib/omni'
import { useBrowser } from './browser'
import { useControl } from './control'
import { humanError } from './control-logic'
import { useLayout } from './layout'
import { enterSession } from './notify'
import { isClaudeArtifact } from './links-logic'
import { useSessions } from './sessions'

/** Navegador que se abrió para cada enlace (mientras viva la sesión, se reusa aunque la página haya redirigido). */
const openedFor = new Map<string, string>()

/**
 * Abre `url` en el navegador de omni, en el workspace de la sesión de origen: si ya hay un navegador
 * mostrando esa URL, entra a él en vez de abrir otro.
 */
export async function openInOmniBrowser(url: string, fromSessionId: string | null): Promise<void> {
  const sessions = useSessions.getState()
  const states = useBrowser.getState().states
  // La página puede redirigir (login de claude.ai, ruta final): también vale el navegador abierto para este enlace.
  const opener = openedFor.get(url)
  const already = sessions.sessions.find((s) => s.agent === 'browser' && (s.id === opener || states[s.id]?.url === url))
  if (already) return enterSession(already.id)
  const origin = fromSessionId ? sessions.sessions.find((s) => s.id === fromSessionId) : undefined
  if (origin) sessions.setWorkspace(origin.workspaceId)
  try {
    const info = await sessions.create('browser')
    if (!info) return useControl.getState().announce('No hay ningún proyecto abierto donde abrir el navegador')
    useLayout.getState().openTab(info.workspaceId, info.id)
    openedFor.set(url, info.id)
    await useBrowser.getState().navigate(info.id, url)
    enterSession(info.id)
  } catch (e) {
    useControl.getState().announce(humanError(e, 'No se pudo abrir el enlace'))
  }
}

/**
 * Clic en un enlace de una terminal (texto plano u OSC 8): los artifacts de Claude van al navegador de
 * omni; el resto, al navegador del sistema como siempre.
 */
export function openTerminalLink(url: string, fromSessionId: string | null): void {
  if (isClaudeArtifact(url)) void openInOmniBrowser(url, fromSessionId)
  else void omni.invoke('shell:openExternal', url).catch(() => useControl.getState().announce('No se pudo abrir el enlace'))
}

/**
 * Servidor que corre en el VPS (§3.26): reenvía su puerto al Mac por la conexión SSH compartida y abre
 * la URL con el puerto local (el mismo si estaba libre) en el navegador de omni.
 */
export async function openRemoteUrl(sessionId: string, url: string): Promise<void> {
  const session = useSessions.getState().sessions.find((s) => s.id === sessionId)
  if (!session) return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return useControl.getState().announce(`URL inválida: ${url}`)
  }
  const remotePort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  try {
    const { localPort } = await omni.invoke('host:forwardPort', session.workspaceId, remotePort)
    parsed.hostname = 'localhost'
    parsed.port = String(localPort)
    await openInOmniBrowser(parsed.toString(), sessionId)
    // Después de abrir: el aviso sale en la franja del navegador, que es la que queda a la vista.
    if (localPort !== remotePort) useControl.getState().announce(`El puerto ${remotePort} está ocupado en este Mac: se abrió en el ${localPort}`)
  } catch (e) {
    useControl.getState().announce(humanError(e, `No se pudo reenviar el puerto ${remotePort}`))
  }
}
