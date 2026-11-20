import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Content scripts can't be ES modules, so content.ts is built separately as a
 * single self-contained IIFE. It must never pull in Firebase: it only reads
 * code blocks and draws markers (check: dist/content.js stays small).
 */
export default defineConfig({
  envDir: '../..',
  build: {
    outDir: 'dist',
    emptyOutDir: false, // runs after the main build
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('src/content.ts', import.meta.url)),
      formats: ['iife'],
      name: 'ttmContent',
      fileName: () => 'content.js',
    },
  },
});
