import { defineConfig } from 'vite';

export default defineConfig({
  root: 'renderer',
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: '../dist', emptyOutDir: true },
});
