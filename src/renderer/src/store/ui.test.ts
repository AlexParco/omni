import { describe, expect, it, vi } from 'vitest'
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebarWidth, useUi } from './ui'

vi.mock('@/lib/omni', () => ({ omni: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(() => () => {}) } }))

describe('ancho del sidebar', () => {
  it('clampSidebarWidth recorta a los límites y redondea; lo que no es número vuelve al de por defecto', () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX)
    expect(clampSidebarWidth(321.6)).toBe(322)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT)
  })

  it('setSidebarWidth aplica el recorte; sin localStorage (Node) no rompe', () => {
    useUi.getState().setSidebarWidth(50)
    expect(useUi.getState().sidebarWidth).toBe(SIDEBAR_MIN)
    useUi.getState().setSidebarWidth(SIDEBAR_DEFAULT)
    expect(useUi.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT)
  })

  it('showHidden arranca apagado: los ocultos nunca quedan a la vista tras recargar', () => {
    expect(useUi.getState().showHidden).toBe(false)
  })
})
