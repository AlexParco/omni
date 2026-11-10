import { create } from 'zustand'
import type { CostSummary } from '@shared/types'
import { omni } from '@/lib/omni'

/** Main cachea 30 s (§3.17): repedir cada minuto basta, y solo con la ventana enfocada. */
export const COST_REFRESH_MS = 60_000

interface CostState {
  /** Último resumen de main; `null` hasta que llega el primero. */
  summary: CostSummary | null
  /** Pide `cost:summary`, se suscribe a `cost:changed` y repide cada minuto con la app enfocada. Devuelve la función para deshacerlo. */
  init(): () => void
}

export const useCost = create<CostState>((set) => ({
  summary: null,

  init() {
    const refresh = (): void => {
      void omni
        .invoke('cost:summary')
        .then((summary) => set({ summary }))
        .catch(() => undefined)
    }
    refresh()
    const off = omni.on('cost:changed', (summary) => set({ summary }))
    // `setInterval` pelado (no `window.`) y `document` opcional: el store también corre en los tests de Node.
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hasFocus()) refresh()
    }, COST_REFRESH_MS)
    return () => {
      off()
      clearInterval(timer)
    }
  }
}))
