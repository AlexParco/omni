import { app } from 'electron'

/**
 * Ajuste "Abrir omni al iniciar sesión" (§3.10b): con él y "Revivir sesiones", prender la Mac deja
 * todo como estaba sin abrir nada a mano. Solo la app empaquetada se registra: en dev el ítem
 * apuntaría al binario de Electron de `node_modules`.
 */
export function applyLoginItem(openAtLogin: boolean): void {
  if (!app.isPackaged || process.platform !== 'darwin') return
  try {
    if (app.getLoginItemSettings().openAtLogin !== openAtLogin) app.setLoginItemSettings({ openAtLogin })
  } catch (err) {
    console.warn('[omni] no se pudo cambiar el inicio de sesión:', err)
  }
}
