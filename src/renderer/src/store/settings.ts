import { create } from 'zustand'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { prefixLabel } from '@/core/keys/chord'
import { omni } from '@/lib/omni'

interface SettingsState {
  settings: Settings
  /** `true` cuando ya llegaron los ajustes reales de main (antes se usan los defaults). */
  loaded: boolean
  /** Pide los ajustes a main y se suscribe a sus cambios. Devuelve la función para desuscribirse. */
  init(): Promise<() => void>
  /** Manda un parche a main; el estado se actualiza con lo que main devuelve (ya validado). */
  update(patch: Partial<Settings>): Promise<void>
}

/**
 * Espejo de los ajustes del usuario. Main es la fuente de verdad: aquí nunca se "cree" un valor
 * hasta que main lo confirme, así el archivo editado a mano y la app no se desincronizan.
 */
export const useSettings = create<SettingsState>((set) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,
  async init() {
    const unsubscribe = omni.on('settings:changed', (settings) => set({ settings, loaded: true }))
    set({ settings: await omni.invoke('settings:get'), loaded: true })
    return unsubscribe
  },
  async update(patch) {
    set({ settings: await omni.invoke('settings:set', patch) })
  }
}))

/** Prefijo actual, para quien lo necesita fuera de React (terminal-host, keybindings). */
export const currentPrefix = (): string => useSettings.getState().settings.prefix

/** Etiqueta del prefijo (`C-a`) para títulos y hints en React. */
export const usePrefixLabel = (): string => useSettings((s) => prefixLabel(s.settings.prefix))
