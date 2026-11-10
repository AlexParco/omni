import { join } from 'node:path'
import { BrowserWindow, Menu, screen, shell } from 'electron'
import { MIN_HEIGHT, MIN_WIDTH, fitToDisplays, loadWindowState, saveWindowState } from './services/window-state'

/** Espera tras el último move/resize antes de escribir `window.json` (arrastrar emite decenas por segundo). */
const SAVE_DEBOUNCE_MS = 500

/** Ventana principal viva (una sola). Los servicios que montan vistas nativas la piden por aquí. */
let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function createWindow(): BrowserWindow {
  // Tamaño y posición de la última vez, ajustados a los monitores de ahora (uno desconectado no deja la ventana fuera).
  const saved = loadWindowState()
  const bounds = saved ? fitToDisplays(saved.bounds, screen.getAllDisplays().map((d) => d.workArea)) : null
  const win = new BrowserWindow({
    ...(bounds ?? { width: 1280, height: 800 }),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: '#0a0a0a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  win.on('ready-to-show', () => {
    if (saved?.fullscreen) win.setFullScreen(true)
    else if (saved?.maximized) win.maximize()
    win.show()
  })
  trackWindowState(win)
  // La ventana de la app nunca navega: soltar un archivo fuera de una terminal la reemplazaría por él.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/**
 * Guarda tamaño, posición y modo de la ventana en `window.json` al moverla o redimensionarla
 * (con espera) y al cerrarla. Se guardan los bounds normales: maximizada, se recuerda el tamaño de antes.
 */
function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = (): void => {
    clearTimeout(timer)
    if (win.isDestroyed()) return
    saveWindowState({ bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() })
  }
  const later = (): void => {
    clearTimeout(timer)
    timer = setTimeout(save, SAVE_DEBOUNCE_MS)
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('maximize', later)
  win.on('unmaximize', later)
  win.on('enter-full-screen', later)
  win.on('leave-full-screen', later)
  win.on('close', save)
}

/** Menú mínimo: conserva ⌘Q, copiar/pegar y devtools; libera ⌘T, ⌘K, ⌘W y ⌘R para la app (recargar el renderer queda en ⌘⇧R). */
export function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }]
      },
      { role: 'windowMenu' }
    ])
  )
}
