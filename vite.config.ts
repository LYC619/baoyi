import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'
import { fileURLToPath, URL } from 'node:url'

const resolveSrc = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// 主进程里通过 require 加载的原生 / 二进制依赖，必须排除在打包之外
const nativeDeps = ['better-sqlite3', 'electron']

export default defineConfig({
  resolve: {
    alias: { '@': resolveSrc('./src') }
  },
  plugins: [
    vue(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            minify: false,
            rollupOptions: { external: nativeDeps }
          }
        }
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            minify: false,
            rollupOptions: { external: nativeDeps }
          }
        }
      }
    })
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500
  },
  server: {
    port: 5714,
    strictPort: false
  },
  clearScreen: false
})
