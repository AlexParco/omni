import { create } from 'zustand'
import type { UsageReport } from '@shared/types'
import { omni } from '@/lib/omni'

/** Con el widget abierto, el reporte se repide cada minuto (main cachea los topes ese mismo minuto). */
export const USAGE_REFRESH_MS = 60_000

interface UsageState {
  /** Último reporte; se conserva entre aperturas para pintar al toque mientras llega el nuevo. */
  report: UsageReport | null
  loading: boolean
  /** Pide `usage:get`; `force` vuelve a pedir los topes en vivo aunque main tenga cache. */
  refresh(force?: boolean): Promise<void>
}

export const useUsage = create<UsageState>((set, get) => ({
  report: null,
  loading: false,

  async refresh(force = false) {
    if (get().loading && !force) return
    set({ loading: true })
    try {
      set({ report: await omni.invoke('usage:get', force) })
    } catch {
      // main ocupado o cerrándose: se queda el último reporte.
    } finally {
      set({ loading: false })
    }
  }
}))
