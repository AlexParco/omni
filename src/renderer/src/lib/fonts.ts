/**
 * ¿Está instalada esta familia? Chromium no lo expone; se mide un texto con la familia y un respaldo
 * genérico, y se compara con el respaldo solo: si con dos respaldos distintos mide igual que ellos,
 * la familia no existe y el navegador cayó al respaldo.
 */
const SAMPLE = 'mmmmmmmmmmlli10OO@#'
let canvas: HTMLCanvasElement | null = null

function width(font: string): number {
  canvas ??= document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return 0
  ctx.font = font
  return ctx.measureText(SAMPLE).width
}

export function fontInstalled(family: string): boolean {
  return ['monospace', 'serif'].some((generic) => width(`40px "${family}", ${generic}`) !== width(`40px ${generic}`))
}
