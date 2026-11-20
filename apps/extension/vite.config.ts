import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  // One .env.local at the repo root is shared with the web app.
  envDir: '../..',
  // Extension pages load files relative to the extension root.
  base: './',
  resolve: {
    alias: [
      // Manifest V3 forbids remotely hosted code. Firebase ships an Auth build
      // for extensions that never loads remote scripts (no reCAPTCHA/gapi).
      { find: /^firebase\/auth$/, replacement: 'firebase/auth/web-extension' },
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Extensions can't use eval-based source maps; keep builds readable instead.
    minify: false,
    rolldownOptions: {
      input: {
        sidepanel: here('sidepanel.html'),
        background: here('src/background.ts'),
      },
      output: {
        // The manifest refers to background.js by a fixed name.
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
