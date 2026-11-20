import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  // One .env.local at the repo root is shared by the web app and the extension.
  envDir: '../..',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Two pages: the app (index.html) and the hybrid-inference diagnostics page.
    rolldownOptions: { input: { app: page('index.html'), diagnostics: page('diagnostics.html') } },
  },
  server: { port: 5173, strictPort: true },
});
