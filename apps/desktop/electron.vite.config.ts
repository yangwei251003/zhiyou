import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const cspConnectSourceToken = '__BOSSHUNTER_RENDERER_CONNECT_SOURCE__'

const developmentConnectSource = [
  'http://127.0.0.1:*',
  'ws://127.0.0.1:*',
  'http://localhost:*',
  'ws://localhost:*',
].join(' ')

function rendererCspPlugin() {
  let connectSource = "'none'"

  return {
    name: 'bosshunter-renderer-csp',
    enforce: 'pre' as const,
    configResolved(config: { command: 'build' | 'serve' }) {
      connectSource = config.command === 'serve' ? developmentConnectSource : "'none'"
    },
    transformIndexHtml(html: string) {
      if (!html.includes(cspConnectSourceToken)) {
        throw new Error('Renderer CSP connect-src placeholder is missing')
      }

      return html.replace(cspConnectSourceToken, connectSource)
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          ingestWorker: resolve(import.meta.dirname, 'src/main/ingestWorker.ts'),
        },
        output: {
          entryFileNames: '[name].js',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(import.meta.dirname, 'src/renderer/src'),
        '@shared': resolve(import.meta.dirname, 'src/shared'),
      },
    },
    plugins: [rendererCspPlugin(), react()],
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/renderer/index.html'),
      },
    },
  },
})
