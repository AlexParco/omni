import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIN_HEIGHT, MIN_WIDTH, fitToDisplays, loadWindowState, sanitizeWindowState, saveWindowState } from './window-state'

const MAIN = { x: 0, y: 25, width: 1440, height: 875 }
const SIDE = { x: 1440, y: 0, width: 1920, height: 1080 }

describe('sanitizeWindowState', () => {
  it('redondea, aplica los mínimos y descarta lo que no tiene forma', () => {
    expect(sanitizeWindowState({ bounds: { x: 10.4, y: 20.6, width: 300, height: 1000 }, maximized: true })).toEqual({
      bounds: { x: 10, y: 21, width: MIN_WIDTH, height: 1000 },
      maximized: true,
      fullscreen: false
    })
    expect(sanitizeWindowState({ bounds: { x: 0, y: 0, width: 1000, height: 100 } })?.bounds.height).toBe(MIN_HEIGHT)
    expect(sanitizeWindowState(null)).toBeNull()
    expect(sanitizeWindowState({ bounds: { x: 'a', y: 0, width: 1, height: 1 } })).toBeNull()
    expect(sanitizeWindowState({ maximized: true })).toBeNull()
  })
})

describe('fitToDisplays', () => {
  it('se queda donde estaba si asoma en un monitor; recortada si no cabe', () => {
    expect(fitToDisplays({ x: 100, y: 100, width: 1200, height: 700 }, [MAIN, SIDE])).toEqual({ x: 100, y: 100, width: 1200, height: 700 })
    expect(fitToDisplays({ x: 1600, y: 50, width: 1200, height: 800 }, [MAIN, SIDE])).toEqual({ x: 1600, y: 50, width: 1200, height: 800 })
    // Sobresale por la derecha del principal: se mete dentro.
    expect(fitToDisplays({ x: 1300, y: 25, width: 1200, height: 800 }, [MAIN])).toEqual({ x: 240, y: 25, width: 1200, height: 800 })
    // Más grande que el monitor: se recorta a su área.
    expect(fitToDisplays({ x: 0, y: 25, width: 3000, height: 2000 }, [MAIN])).toEqual(MAIN)
  })

  it('el monitor ya no existe: centrada en el principal con su tamaño', () => {
    expect(fitToDisplays({ x: 1600, y: 50, width: 1200, height: 800 }, [MAIN])).toEqual({ x: 120, y: 63, width: 1200, height: 800 })
    expect(fitToDisplays({ x: 5, y: 5, width: 1000, height: 600 }, [])).toEqual({ x: 5, y: 5, width: 1000, height: 600 })
  })
})

describe('load / save', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-window-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('ida y vuelta; un archivo roto o ausente es null', () => {
    const file = join(dir, 'window.json')
    expect(loadWindowState(file)).toBeNull()
    const state = { bounds: { x: 1, y: 2, width: 1000, height: 700 }, maximized: false, fullscreen: true }
    saveWindowState(state, file)
    expect(loadWindowState(file)).toEqual(state)
    writeFileSync(file, '{roto')
    expect(loadWindowState(file)).toBeNull()
  })
})
