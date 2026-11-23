import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '../server');
const stubs = path.resolve(here, 'src/local/stubs');

// Versão local (roda inteira no iPhone, sem servidor): VITE_LOCAL=1 npm run build
const LOCAL = process.env.VITE_LOCAL === '1';

// Troca módulos que só funcionam no Node por equivalentes do navegador.
function localStubs() {
  const map = {
    [path.join(server, 'config.js')]: path.join(stubs, 'config.js'),
    [path.join(server, 'nlp/llm.js')]: path.join(stubs, 'llm.js'),
  };
  return {
    name: 'local-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'node:crypto') return path.join(stubs, 'node-crypto.js');
      if (importer && source.startsWith('.')) {
        const abs = path.resolve(path.dirname(importer), source);
        if (map[abs]) return map[abs];
      }
      return null;
    },
  };
}

export default defineConfig({
  root: here,
  base: './',
  plugins: [react(), ...(LOCAL ? [localStubs()] : [])],
  define: { 'import.meta.env.VITE_LOCAL': JSON.stringify(LOCAL ? '1' : '') },
  build: { outDir: 'dist', emptyOutDir: true, target: 'safari15', chunkSizeWarningLimit: 1200 },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
