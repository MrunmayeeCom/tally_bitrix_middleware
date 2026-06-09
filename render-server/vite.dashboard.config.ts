import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'src-dashboard',
  build: {
    outDir: path.resolve(__dirname, 'public'),
    emptyOutDir: false,
    rollupOptions: {
      input: { dashboard: 'src-dashboard/index.html' },
      output: {
        entryFileNames: 'dashboard-bundle.js',
        assetFileNames: 'dashboard-[name][extname]',
      }
    }
  },
  define: {
    'import.meta.env.VITE_LMS_BASE_URL':  JSON.stringify(process.env.VITE_LMS_BASE_URL),
    'import.meta.env.VITE_LMS_API_KEY':   JSON.stringify(process.env.VITE_LMS_API_KEY),
    'import.meta.env.VITE_APP_BASE_URL':  JSON.stringify(process.env.VITE_APP_BASE_URL),
    'import.meta.env.VITE_PRODUCT_ID':    JSON.stringify(process.env.VITE_PRODUCT_ID),
    'import.meta.env.VITE_RAZORPAY_KEY_ID': JSON.stringify(process.env.VITE_RAZORPAY_KEY_ID),
  }
});