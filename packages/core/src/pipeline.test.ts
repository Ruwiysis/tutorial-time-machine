import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InferenceSource, type GenerativeModel } from 'firebase/ai';
import type { Firestore } from 'firebase/firestore';

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

import { checkPage } from './pipeline';
import { RC_DEFAULTS, parseSettings } from './settings';
import { loadFixture } from './test-utils/fixtures';

const settings = parseSettings((k) => String(RC_DEFAULTS[k as keyof typeof RC_DEFAULTS] ?? ''));

/** Nano stand-in: "sure" for Firebase v8 calls, "maybe" for the auth state listener. */
const scanModel = {
  generateContent: vi.fn(async (prompt: string) => {
    const lines = [...prompt.matchAll(/^(\d+)\| (.*)$/gm)];
    const sure = lines.filter(([, , c]) => /firebase\.(initializeApp|firestore)\(/.test(c ?? '')).map(([, n]) => Number(n));
    const maybe = lines.filter(([, , c]) => /onAuthStateChanged/.test(c ?? '')).map(([, n]) => Number(n));
    return { response: { text: () => JSON.stringify({ lib: 'firebase', sure, maybe }), inferenceSource: InferenceSource.ON_DEVICE } };
  }),
} as unknown as GenerativeModel;

const cloud = vi.fn(async (prompt: string) => {
  const results = [...prompt.matchAll(/^(\d+)\| /gm)].map(([, n]) => ({ n: Number(n), status: 'outdated', modernCode: 'x', explanation: 'y' }));
  return { response: { text: () => JSON.stringify({ results }), inferenceSource: InferenceSource.IN_CLOUD, candidates: [{}] } };
});

const deps = () => ({
  scanModel,
  settings,
  verify: {
    db: {} as Firestore,
    uid: 'u',
    settings,
    models: {
      grounded: { generateContent: cloud } as unknown as GenerativeModel,
      ungrounded: { generateContent: cloud } as unknown as GenerativeModel,
    },
  },
});

beforeEach(() => {
  store.clear();
  cloud.mockClear();
});

describe('checkPage', () => {
  it('runs scan → cache → cloud on the hero fixture and emits events in order', async () => {
    const { title, blocks } = loadFixture('firebase-v8-firestore.html');
    const events: string[] = [];
    const r = await checkPage(deps(), blocks, { title }, {
      onScanned: (_page, toVerify) => events.push(`scanned:${toVerify.join(',')}`),
      onLine: (o) => events.push(`line:${o.id}:${o.status}`),
    });

    expect(r.scanServedBy).toBe('on-device');
    expect(r.keptLocal.map((f) => f.code.trim())).toEqual(['auth.onAuthStateChanged((user) => {']); // "maybe" stays local
    expect(events[0]).toBe('scanned:1:11,1:13'); // block index 1 (init block), lines 11 and 13
    expect(events.slice(1)).toEqual(['line:1:11:outdated', 'line:1:13:outdated']);
    expect(r.stats).toMatchObject({ sentToCloud: 2, cloudCalls: 1, fromCache: 0 });

    // Second reader: same page, all from cache, no cloud call.
    cloud.mockClear();
    const again = await checkPage(deps(), blocks, { title });
    expect(cloud).not.toHaveBeenCalled();
    expect(again.stats).toMatchObject({ fromCache: 2, cloudCalls: 0 });
    expect([...again.outcomes.values()].every((o) => o.status === 'outdated' && o.servedBy === 'cache')).toBe(true);
  });

  it('cache-assisted recall: lines Nano misses on a later run still get their cached verdict', async () => {
    const { title, blocks } = loadFixture('firebase-v8-firestore.html');
    await checkPage(deps(), blocks, { title }); // first reader fills the cache (lines 1:11 and 1:13)
    cloud.mockClear();

    // Later run: Nano recognises the library but flags nothing at all.
    const forgetful = {
      generateContent: vi.fn(async () => ({
        response: { text: () => '{"lib":"firebase","sure":[],"maybe":[]}', inferenceSource: InferenceSource.ON_DEVICE },
      })),
    } as unknown as GenerativeModel;
    const lines: string[] = [];
    const r = await checkPage({ ...deps(), scanModel: forgetful }, blocks, { title }, { onLine: (o) => lines.push(o.id) });

    expect(cloud).not.toHaveBeenCalled(); // recall never goes to the cloud
    expect(lines).toEqual(['1:11', '1:13']);
    expect(r.stats).toMatchObject({ fromCache: 2, recalled: 2, cloudCalls: 0 });
    expect(r.outcomes.get('1:13')).toMatchObject({ status: 'outdated', servedBy: 'cache' });
  });
});
