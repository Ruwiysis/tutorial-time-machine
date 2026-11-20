import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';

// In-memory Firestore that behaves like our rules: create-only, no overwrite.
const store = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, col: string, id: string) => ({ path: `${col}/${id}`, id }),
  getDoc: async (ref: { path: string }) => ({ exists: () => store.has(ref.path), data: () => store.get(ref.path) }),
  setDoc: async (ref: { path: string }, data: Record<string, unknown>) => {
    if (store.has(ref.path)) throw new Error('permission-denied');
    store.set(ref.path, data);
  },
  serverTimestamp: () => 'SERVER_TIMESTAMP',
}));

import { fromCacheDoc, lookupCache, toCacheDoc, writeCache, type VerifiedLine } from './cache';
import { cacheKey, normalizeCodeLine } from './hash';

const db = {} as Firestore;

const entry = (over: Partial<VerifiedLine> = {}): VerifiedLine => ({
  library: 'firebase',
  code: 'const db = firebase.firestore();',
  status: 'outdated',
  modernCode: 'const db = getFirestore(app);',
  explanation: 'v9+ uses the modular API.',
  sources: [{ uri: 'https://firebase.google.com/docs/web/modular-upgrade', title: 'Upgrade' }],
  searchEntryPointHtml: '<div>chip</div>',
  model: 'gemini-3.5-flash-lite',
  grounded: true,
  ...over,
});

beforeEach(() => store.clear());

describe('normalizeCodeLine', () => {
  it('ignores indentation, spacing and trailing ; or ,', () => {
    expect(normalizeCodeLine('   const  db =\tfirebase.firestore();  ')).toBe('const db = firebase.firestore()');
    expect(normalizeCodeLine("  apiKey: 'x',")).toBe("apiKey: 'x'");
  });

  it('keeps meaningful differences', () => {
    expect(normalizeCodeLine('a.b()')).not.toBe(normalizeCodeLine('a.c()'));
  });
});

describe('cacheKey', () => {
  it('is 64 lowercase hex chars (what firestore.rules require)', async () => {
    expect(await cacheKey('firebase', 'x()')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('matches SHA-256 of library + "\\n" + normalized line', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('firebase\nconst db = firebase.firestore()'));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(await cacheKey(' Firebase ', '  const db = firebase.firestore();')).toBe(hex);
  });

  it('uses a different key for answers made without Search', async () => {
    expect(await cacheKey('firebase', 'x()', false)).not.toBe(await cacheKey('firebase', 'x()', true));
  });
});

describe('toCacheDoc', () => {
  it('produces exactly the fields the rules allow', () => {
    const d = toCacheDoc(entry(), 'uid1');
    expect(Object.keys(d).sort()).toEqual(
      ['code', 'createdAt', 'createdBy', 'explanation', 'grounded', 'library', 'model', 'modernCode', 'searchEntryPointHtml', 'sources', 'status'].sort(),
    );
    expect(d).toMatchObject({ createdBy: 'uid1', createdAt: 'SERVER_TIMESTAMP', grounded: true });
  });

  it('clamps to the rule limits and drops an oversized widget', () => {
    const d = toCacheDoc(
      entry({
        explanation: 'x'.repeat(5000),
        sources: Array.from({ length: 15 }, (_, i) => ({ uri: `https://a/${i}`, title: 't' })),
        searchEntryPointHtml: 'y'.repeat(30000),
      }),
      'u',
    );
    expect((d.explanation as string).length).toBe(2000);
    expect((d.sources as unknown[]).length).toBe(10);
    expect(d).not.toHaveProperty('searchEntryPointHtml');
  });
});

describe('fromCacheDoc', () => {
  it('round-trips an entry', () => {
    expect(fromCacheDoc(toCacheDoc(entry(), 'u'))).toEqual(entry());
  });

  it('rejects malformed documents and unsafe source links', () => {
    expect(fromCacheDoc(undefined)).toBeNull();
    expect(fromCacheDoc({ library: 'x', code: 'y', status: 'weird' })).toBeNull();
    const e = fromCacheDoc({
      ...toCacheDoc(entry(), 'u'),
      sources: [{ uri: 'javascript:alert(1)', title: 'x' }, { uri: 'https://ok', title: '' }, 'junk'],
    });
    expect(e?.sources).toEqual([{ uri: 'https://ok', title: 'https://ok' }]);
  });
});

describe('lookupCache / writeCache', () => {
  it('misses, then hits after a write (with a differently formatted line)', async () => {
    expect(await lookupCache(db, 'firebase', 'const db = firebase.firestore();')).toBeNull();
    expect(await writeCache(db, 'u', entry())).toBe(true);
    expect(await lookupCache(db, 'FIREBASE', '    const db = firebase.firestore()')).toEqual(entry());
  });

  it('falls back to an ungrounded entry, and prefers a grounded one', async () => {
    await writeCache(db, 'u', entry({ grounded: false, explanation: 'no search', sources: [], searchEntryPointHtml: undefined }));
    expect((await lookupCache(db, 'firebase', entry().code))?.explanation).toBe('no search');
    await writeCache(db, 'u', entry());
    expect((await lookupCache(db, 'firebase', entry().code))?.grounded).toBe(true);
  });

  it('does not cache "unsure" answers', async () => {
    expect(await writeCache(db, 'u', entry({ status: 'unsure' }))).toBe(false);
    expect(store.size).toBe(0);
  });

  it('treats a rejected write (entry already exists) as non-fatal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await writeCache(db, 'u', entry())).toBe(true);
    expect(await writeCache(db, 'u', entry())).toBe(false);
  });
});
