import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

/**
 * Publishes the demo tutorials as real web pages at /tutorials/*.html, so the
 * Chrome extension can be shown working on an ordinary page.
 */
function publishFixtures(): Plugin {
  return {
    name: 'ttm-publish-fixtures',
    apply: 'build',
    closeBundle() {
      cpSync(page('../../fixtures'), page('dist/tutorials'), { recursive: true, filter: (src) => !src.endsWith('.md') });
    },
  };
}

export default defineConfig({
  // One .env.local at the repo root is shared by the web app and the extension.
  envDir: '../..',
  plugins: [publishFixtures()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Two pages: the app (index.html) and the hybrid-inference diagnostics page.
    rolldownOptions: { input: { app: page('index.html'), diagnostics: page('diagnostics.html') } },
  },
  server: { port: 5173, strictPort: true },
});
