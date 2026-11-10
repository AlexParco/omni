import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { OmniBridge } from '@shared/ipc'

// Puente genérico y tipado. No sabe de dominios: solo transporta canales declarados en shared/ipc.ts.
const bridge: OmniBridge = {
  // Mismo gate que el puerto CDP de main: sin él no hay ganchos de prueba en el renderer.
  testMode: !!process.env.OMNI_CDP_PORT,
  pathForFile: (file) => webUtils.getPathForFile(file),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, cb) => {
    const handler = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void =>
      (cb as (...a: unknown[]) => void)(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('omni', bridge)
