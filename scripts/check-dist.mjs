// Fails if a secret from .env.local ended up in a production build.
// Runs after `vite build` (see apps/web/package.json) and before every deploy.
//
// Checked values: every variable in .env.local whose name contains TOKEN or
// SECRET (App Check debug tokens in particular). Firebase web config values
// are public by design and are expected in the bundle.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(root, 'apps/web/dist');
const envFile = join(root, '.env.local');

if (!existsSync(envFile)) {
  console.log('check-dist: no .env.local, nothing to check.');
  process.exit(0);
}

const secrets = readFileSync(envFile, 'utf8')
  .split(/\r?\n/)
  .map((line) => /^\s*([A-Z0-9_]*(?:TOKEN|SECRET)[A-Z0-9_]*)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line))
  .filter((m) => m && m[2].length >= 8)
  .map((m) => ({ name: m[1], value: m[2] }));

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(dist);

let leaks = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const { name, value } of secrets) {
    if (text.includes(value) || text.includes(name)) {
      console.error(`check-dist: ${name} found in ${file}`);
      leaks++;
    }
  }
}
if (leaks) {
  console.error('check-dist: refusing to continue. A secret would be published.');
  process.exit(1);
}
console.log(`check-dist: ${files.length} files clean (${secrets.length} secret values checked).`);
