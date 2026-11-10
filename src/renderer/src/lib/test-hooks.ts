import { omni } from './omni'

/**
 * Ganchos para el harness e2e sobre la app empaquetada: allí no hay servidor de Vite y
 * `import('/src/store/x.ts')` no resuelve. Con `testMode` (solo con `OMNI_CDP_PORT`, que ya abre
 * el protocolo de depuración) se expone `window.__omniImport('/src/…')` sobre los mismos módulos del
 * bundle. Sin `testMode` no se expone nada.
 */
const modules = import.meta.glob(['../**/*.ts', '!../**/*.test.ts', '!../**/*.d.ts'])

declare global {
  interface Window {
    __omniImport?: (path: string) => Promise<unknown>
  }
}

export function installTestHooks(): void {
  if (!omni.testMode) return
  window.__omniImport = (path: string) => {
    const key = path.replace(/^\/src\//, '../')
    const load = modules[key]
    return load ? load() : Promise.reject(new Error(`módulo desconocido: ${path}`))
  }
}
