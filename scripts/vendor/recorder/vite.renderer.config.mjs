// Loam Recorder renderer-only build. Copied into the upstream checkout by
// build-recorder.mjs. Unlike upstream vite.config.ts it does NOT build the
// Electron main/preload (Loam main hosts the Recorder) and emits relative
// asset URLs so the dist can be served from the loamrecorder:// scheme.
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = process.cwd();

export default defineConfig({
  root,
  base: './',
  cacheDir: path.resolve(root, '.vite-cache'),
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(root, 'src') },
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  build: {
    outDir: path.resolve(root, 'dist-recorder'),
    emptyOutDir: true,
    target: 'esnext',
    minify: 'terser',
    sourcemap: false,
    terserOptions: {
      compress: { drop_console: true, drop_debugger: true, pure_funcs: ['console.log', 'console.debug'] },
      format: { comments: false },
    },
    chunkSizeWarningLimit: 4000,
  },
});
