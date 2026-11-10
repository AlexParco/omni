import { create } from 'zustand'
import { omni } from '@/lib/omni'

interface DaemonState {
  /** El daemon de terminales es de otro build: el pie ofrece "Actualizar terminales" (§3.10c). */
  outdated: boolean
  /** Hay una actualización en curso: main recarga la ventana al terminar. */
  upgrading: boolean
  /** Pregunta a main una vez al arrancar el renderer (tras una actualización vuelve `false`). */
  refresh(): Promise<void>
  upgrade(): Promise<void>
}

export const useDaemon = create<DaemonState>((set, get) => ({
  outdated: false,
  upgrading: false,

  async refresh() {
    const status = await omni.invoke('daemon:status').catch(() => ({ outdated: false }))
    set({ outdated: status.outdated })
  },

  async upgrade() {
    if (get().upgrading) return
    set({ upgrading: true })
    try {
      await omni.invoke('daemon:upgrade')
    } finally {
      // Si main recargó la ventana esto no llega a correr; si falló, el aviso sigue ofreciendo reintentar.
      set({ upgrading: false })
      void get().refresh()
    }
  }
}))
