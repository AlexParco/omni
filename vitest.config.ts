import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** Tests unitarios del renderer: core y stores son puros, corren en Node sin DOM. */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
