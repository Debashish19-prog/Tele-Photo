import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const src = resolve(import.meta.dirname, 'src');
const shim = (name: string) => resolve(src, 'engine/shims', name);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The one .env file lives at the top of the repo.
  envDir: resolve(import.meta.dirname, '..'),
  define: { global: 'globalThis' },
  resolve: {
    alias: [
      { find: '@', replacement: src },
      // GramJS is written for Node. Its browser build swaps these out in the same way.
      { find: /^crypto$/, replacement: 'telegram/crypto/crypto.js' },
      { find: /^path$/, replacement: 'path-browserify' },
      { find: /^os$/, replacement: shim('os.ts') },
      { find: /^util$/, replacement: shim('util.ts') },
      { find: /^(fs|net|socks|node-localstorage)$/, replacement: shim('empty.ts') },
    ],
  },
  server: { port: 5173 },
  // The one chunk over this is the HEIC decoder, which only loads if someone opens an iPhone photo on a browser that cannot.
  build: { outDir: 'dist', chunkSizeWarningLimit: 1100 },
});
