import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'safari15', chunkSizeWarningLimit: 900 },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
