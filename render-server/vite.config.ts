import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'src-pricing'),
  build: {
    outDir: path.resolve(__dirname, 'public'),
    emptyOutDir: false,
    rollupOptions: {
      input: { pricing: path.resolve(__dirname, 'src-pricing/pricing.html') },
      output: {
        entryFileNames: 'pricing-bundle.js',
        assetFileNames: 'pricing-[name][extname]',
      }
    }
  }
})