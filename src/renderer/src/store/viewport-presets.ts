import type { ViewportPreset } from '@shared/types'

/**
 * Presets del menú "Tamaño de viewport" (ARCHITECTURE §3.9). `null` = responsive (el hueco del pane).
 * Los móviles además emulan UA y pantalla en main (`browser:viewport`).
 */
export const VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  { id: 'iphone-14', name: 'iPhone 14', width: 390, height: 844, mobile: true },
  { id: 'iphone-se', name: 'iPhone SE', width: 375, height: 667, mobile: true },
  { id: 'ipad', name: 'iPad', width: 820, height: 1180, mobile: true },
  { id: 'desktop-1280', name: '1280 × 800', width: 1280, height: 800 },
  { id: 'desktop-1440', name: '1440 × 900', width: 1440, height: 900 },
  { id: 'desktop-1920', name: '1920 × 1080', width: 1920, height: 1080 }
]

/** El preset que alterna `browser.mobile` (Móvil `⇧⌘M`) contra responsive. */
export const MOBILE_PRESET: ViewportPreset = VIEWPORT_PRESETS[0]

export const RESPONSIVE_LABEL = 'Responsive'

/** Nombre para menús y ajustes: el del preset o "Responsive". */
export function viewportName(preset: ViewportPreset | null | undefined): string {
  return preset ? preset.name : RESPONSIVE_LABEL
}

/**
 * Lo que la barra de URL muestra a la derecha: `w × h` del preset si hay uno, si no el tamaño
 * medido del hueco (`viewports` en el store), y nada mientras no se midió.
 */
export function viewportLabel(preset: ViewportPreset | null | undefined, measured: { width: number; height: number } | undefined): string | undefined {
  if (preset) return `${preset.width} × ${preset.height}`
  return measured ? `${measured.width} × ${measured.height}` : undefined
}

/** Preset que sigue a `current` al alternar Móvil: responsive ↔ iPhone 14; desde otro preset, a responsive. */
export function toggledMobile(current: ViewportPreset | null | undefined): ViewportPreset | null {
  return current ? null : MOBILE_PRESET
}

export function findPreset(id: string): ViewportPreset | undefined {
  return VIEWPORT_PRESETS.find((p) => p.id === id)
}
