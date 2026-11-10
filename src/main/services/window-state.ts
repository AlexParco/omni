import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '../paths'

/** Tamaño y posición de la ventana principal, en px de pantalla (como `BrowserWindow.getNormalBounds`). */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Lo que se recuerda entre aperturas: los bounds "normales" (sin maximizar) y si estaba maximizada o a pantalla completa. */
export interface WindowState {
  bounds: WindowBounds
  maximized: boolean
  fullscreen: boolean
}

/** Área útil de un monitor (`Display.workArea`). */
export type WorkArea = WindowBounds

/** Mínimos de la ventana (los mismos que `createWindow`): un estado guardado más chico se agranda. */
export const MIN_WIDTH = 900
export const MIN_HEIGHT = 560
/** Cuánto de la ventana tiene que caer en algún monitor para restaurarla donde estaba. */
const MIN_VISIBLE = 100

const DEFAULT_FILE = join(CONFIG_DIR, 'window.json')

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** Deja solo lo que tiene forma; `null` si no hay nada aprovechable. Exportado para tests. */
export function sanitizeWindowState(raw: unknown): WindowState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const b = r.bounds as Record<string, unknown> | undefined
  if (!b || !isNum(b.x) || !isNum(b.y) || !isNum(b.width) || !isNum(b.height)) return null
  return {
    bounds: { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(MIN_WIDTH, Math.round(b.width)), height: Math.max(MIN_HEIGHT, Math.round(b.height)) },
    maximized: r.maximized === true,
    fullscreen: r.fullscreen === true
  }
}

function overlap(a: WindowBounds, b: WorkArea): { w: number; h: number } {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { w: Math.max(0, w), h: Math.max(0, h) }
}

/**
 * Bounds a restaurar con los monitores de ahora: si la ventana guardada sigue asomando lo bastante en
 * alguno, va donde estaba (recortada a ese monitor si no cabe); si el monitor ya no existe, se centra
 * en el principal con el tamaño guardado. Exportado para tests.
 */
export function fitToDisplays(bounds: WindowBounds, areas: readonly WorkArea[]): WindowBounds {
  if (areas.length === 0) return bounds
  const host = areas.find((a) => {
    const o = overlap(bounds, a)
    return o.w >= MIN_VISIBLE && o.h >= MIN_VISIBLE
  })
  const area = host ?? areas[0]
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  if (!host) return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height }
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

/** Lee `~/.config/omni/window.json`; `null` si no existe o está roto (se abre con el tamaño por defecto). */
export function loadWindowState(file = DEFAULT_FILE): WindowState | null {
  if (!existsSync(file)) return null
  try {
    return sanitizeWindowState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/** Escribe el estado de forma atómica (tmp + rename). Un fallo de disco no rompe el cierre: se ignora. */
export function saveWindowState(state: WindowState, file = DEFAULT_FILE): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
    renameSync(tmp, file)
  } catch (err) {
    console.warn('[omni] no se pudo guardar window.json:', err)
  }
}
