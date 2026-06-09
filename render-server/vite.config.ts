import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: 'src-pricing',          // TSX source lives here
  build: {
    outDir: path.resolve(__dirname, 'public'),
    emptyOutDir: false,          // don't wipe dashboard.html
    rollupOptions: {
      input: { pricing: 'src-pricing/pricing.html' },
      output: {
        entryFileNames: 'pricing-bundle.js',
        assetFileNames: 'pricing-[name][extname]',
      }
    }
  }
})