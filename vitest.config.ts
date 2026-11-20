import { defineConfig } from 'vitest/config';

// Run tests via `npm test` (scripts/vitest.mjs), which normalizes the Windows
// drive-letter case of the working directory before starting Vitest.
export default defineConfig({
  test: { include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'], environment: 'node' },
});
