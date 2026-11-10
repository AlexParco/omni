import { create } from 'zustand'

/**
 * Reloj de la UI: `now` avanza cada segundo. Todo lo que muestre tiempo relativo o
 * estado derivado por actividad lee de aquí, así ningún componente se queda viejo.
 */
export const useClock = create<{ now: number }>(() => ({ now: Date.now() }))

setInterval(() => useClock.setState({ now: Date.now() }), 1000)
