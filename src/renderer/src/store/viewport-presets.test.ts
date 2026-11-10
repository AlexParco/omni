import { describe, expect, it } from 'vitest'
import { MOBILE_PRESET, VIEWPORT_PRESETS, findPreset, toggledMobile, viewportLabel, viewportName } from './viewport-presets'

describe('viewportLabel', () => {
  it('con preset muestra el tamaño del preset, aunque el hueco mida otra cosa', () => {
    expect(viewportLabel(findPreset('iphone-14'), { width: 1180, height: 640 })).toBe('390 × 844')
    expect(viewportLabel(findPreset('desktop-1920'), undefined)).toBe('1920 × 1080')
  })
  it('sin preset muestra lo medido, y nada si aún no se midió', () => {
    expect(viewportLabel(null, { width: 1180, height: 640 })).toBe('1180 × 640')
    expect(viewportLabel(undefined, undefined)).toBeUndefined()
  })
})

describe('presets', () => {
  it('los ids no se repiten y los móviles llevan la marca', () => {
    expect(new Set(VIEWPORT_PRESETS.map((p) => p.id)).size).toBe(VIEWPORT_PRESETS.length)
    expect(VIEWPORT_PRESETS.filter((p) => p.mobile).map((p) => p.name)).toEqual(['iPhone 14', 'iPhone SE', 'iPad'])
  })
  it('Móvil alterna responsive ↔ iPhone 14 y vuelve a responsive desde cualquier preset', () => {
    expect(toggledMobile(null)).toBe(MOBILE_PRESET)
    expect(MOBILE_PRESET.name).toBe('iPhone 14')
    expect(toggledMobile(MOBILE_PRESET)).toBeNull()
    expect(toggledMobile(findPreset('desktop-1440'))).toBeNull()
  })
  it('viewportName cae en Responsive sin preset', () => {
    expect(viewportName(null)).toBe('Responsive')
    expect(viewportName(findPreset('ipad'))).toBe('iPad')
  })
})
