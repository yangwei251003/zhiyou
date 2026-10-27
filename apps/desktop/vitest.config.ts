import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(import.meta.dirname, 'src/renderer/src'),
      '@shared': resolve(import.meta.dirname, 'src/shared'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/renderer/src/test/setup.ts'],
    css: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/test/**', 'src/shared/contracts.ts'],
    },
  },
})
