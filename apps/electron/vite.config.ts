import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import pkg from './package.json' with { type: 'json' }
import { COPIS_HTTP_API_DEVELOPMENT_PORT } from '@copis/shared/config'

const httpApiPort = process.env.COPIS_HTTP_API_PORT?.trim() || String(COPIS_HTTP_API_DEVELOPMENT_PORT)

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@/types': resolve(__dirname, 'src/types'),
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    // Chromium can resolve localhost to IPv4 while Vite binds only ::1 on macOS.
    // Use the same explicit IPv4 loopback address as Electron's dev windows.
    host: '127.0.0.1',
    port: 5174,
    strictPort: true, // 确保使用指定端口，如被占用则报错
    open: false,
    // 浏览器 Renderer 通过同源地址访问，避免浏览器环境与 Electron 主进程的回环地址不一致。
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${httpApiPort}`,
        changeOrigin: false,
      },
    },
  },
})
