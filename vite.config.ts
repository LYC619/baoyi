import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'
import { fileURLToPath, URL } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const resolveSrc = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// 主进程里通过 require 加载的原生 / 二进制依赖，必须排除在打包之外
const nativeDeps = ['better-sqlite3', '@napi-rs/canvas', 'electron']

export default defineConfig({
  resolve: {
    alias: { '@': resolveSrc('./src') }
  },
  plugins: [
    vue(),
    {
      name: 'local-pdf-assets',
      generateBundle() {
        for (const dir of ['cmaps','standard_fonts','wasm']) {
          const root = resolveSrc('./node_modules/pdfjs-dist/' + dir)
          for (const entry of readdirSync(root, {withFileTypes:true})) if (entry.isFile()) this.emitFile({type:'asset',fileName:`pdfjs/${dir}/${entry.name}`,source:readFileSync(path.join(root,entry.name))})
        }
      },
      configureServer(server) {
        server.middlewares.use('/pdfjs', (req, res, next) => {
          const relative = decodeURIComponent((req.url || '').split('?')[0])
          if (!/^\/(cmaps|standard_fonts|wasm)\/[\w.-]+$/.test(relative)) return next()
          try { res.setHeader('Content-Type',relative.endsWith('.wasm')?'application/wasm':'application/octet-stream');res.end(readFileSync(resolveSrc('./node_modules/pdfjs-dist'+relative))) } catch { next() }
        })
      }
    },
    electron({
      main: {
        entry: {main:'electron/main.ts','document-worker':'electron/workspace/document-extract-worker.ts','video-frame-worker':'electron/kinds/video/frame-worker.ts','video-frame-generation-worker':'electron/kinds/video/frame-generation-worker.ts','comic-verify-worker':'electron/kinds/image/comic-verify-worker.ts','image-thumbnail-worker':'electron/kinds/image/thumbnail-worker.ts'},
        vite: {
          build: {
            outDir: 'dist-electron',
            minify: true,
            rolldownOptions: { external: nativeDeps }
          }
        }
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            minify: true
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
