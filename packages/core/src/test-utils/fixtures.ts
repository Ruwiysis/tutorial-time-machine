/**
 * Test helper: reads the demo fixtures and pulls out their code blocks.
 * (The browser apps use the DOM for this; tests run in Node, and the fixtures
 * have a known simple shape, so a regex is enough here.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));

export interface FixtureBlock {
  language: string | undefined;
  code: string;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

export function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR).filter((f: string) => f.endsWith('.html'));
}

export function loadFixture(name: string): { title: string; blocks: FixtureBlock[] } {
  const html = readFileSync(FIXTURES_DIR + name, 'utf8');
  const title = decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '');
  const blocks = [...html.matchAll(/<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g)].map(
    (m) => ({ language: m[1], code: decode(m[2] ?? "") }),
  );
  return { title, blocks };
}
