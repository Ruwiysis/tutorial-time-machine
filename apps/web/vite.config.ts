import { defineConfig } from 'vite';

export default defineConfig({
  // One .env.local at the repo root is shared by the web app and the extension.
  envDir: '../..',
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
