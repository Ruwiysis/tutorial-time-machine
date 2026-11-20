// Starts Vitest from a working directory whose Windows drive letter is uppercase.
//
// VS Code terminals on Windows often start in `c:\...` while Node resolves
// modules as `C:\...`. Vitest then loads two copies of itself and every
// `describe` fails with "Cannot read properties of undefined (reading 'config')".
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const upper = (p) => p.replace(/^[a-z]:/, (d) => d.toUpperCase());
const repoRoot = upper(fileURLToPath(new URL('..', import.meta.url)));
const cwd = upper(process.cwd());
const cli = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

const { status } = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { cwd, stdio: 'inherit' });
process.exit(status ?? 1);
