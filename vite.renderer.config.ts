// Browser-only dev server for the renderer (no Electron process), so the UI
// can be iterated on and screenshotted via a normal browser tab. Not used
// by the packaged app — `electron-vite dev`/`build` (electron.vite.config.ts)
// is the real build path. This just points plain Vite at the same renderer
// root so the browser-preview mock bridge (src/renderer/lib/mockBridge.ts)
// can be exercised directly.
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('src/renderer'),
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer'),
      '@shared': resolve('src/shared')
    }
  },
  plugins: [react()],
  server: {
    port: 5180
  }
})
