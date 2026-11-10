import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve('src/shared') }

/**
 * Sello del build del daemon: hash del código fuente de `src/daemon` y `src/shared` (lo único que
 * el daemon ejecuta). Main y daemon reciben el mismo valor; cambiar solo main o el renderer no lo
 * altera, así el daemon (y sus sesiones) sobrevive a los reinicios de dev (ARCHITECTURE §3.10).
 */
function buildStamp(): string {
  const hash = createHash('sha1')
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) hash.update(full).update(readFileSync(full))
    }
  }
  walk(resolve('src/daemon'))
  // Solo el protocolo compartido: cambiar tipos de UI en `src/shared` no debe relanzar el daemon
  // (relanzarlo mata las sesiones del usuario).
  hash.update(readFileSync(resolve('src/shared/daemon.ts')))
  return hash.digest('hex').slice(0, 12)
}

/** Reemplaza el placeholder de `src/daemon/build.ts` por el sello real en main y en el daemon. */
function buildStampPlugin(stamp: string): Plugin {
  return {
    name: 'omni-build-stamp',
    transform(code: string, id: string) {
      if (!id.includes('/src/daemon/build.ts')) return null
      return { code: code.replace('__OMNI_BUILD_STAMP__', stamp), map: null }
    }
  }
}

const stamp = buildStamp()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), buildStampPlugin(stamp)],
    resolve: { alias: shared },
    build: {
      // Dos entradas: la app (`index`) y `omni-daemon` (`daemon`), que main lanza como proceso aparte.
      rollupOptions: { input: { index: resolve('src/main/index.ts'), daemon: resolve('src/daemon/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src'), ...shared } },
    plugins: [react()]
  }
})
