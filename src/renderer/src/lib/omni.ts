/**
 * Fachada del puente IPC para el renderer. Los componentes no tocan `window.omni`
 * directamente: pasan por aquí o, mejor, por los stores.
 */
export const omni = window.omni
