import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIError, InferenceSource, type GenerativeModel } from 'firebase/ai';
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

import { buildVerifyPrompt, parseVerifyResponse, VERIFY_BATCH_SIZE, verifyFlagged, type VerifyCandidate } from './verify';

const db = {} as Firestore;

/** A cloud model that answers "outdated" for every numbered line, with grounding metadata. */
function fakeCloud(opts: { grounded?: boolean; fail?: unknown; skipLine?: number } = {}) {
  const grounded = opts.grounded ?? true;
  return vi.fn(async (prompt: string) => {
    if (opts.fail) throw opts.fail;
    const lines = [...prompt.matchAll(/^(\d+)\| (.*)$/gm)].map((m) => Number(m[1]));
    const results = lines
      .filter((n) => n !== opts.skipLine)
      .map((n) => ({ n, status: 'outdated', modernCode: `modern ${n}`, explanation: `why ${n}` }));
    return {
      response: {
        text: () => 'Here you go:\n```json\n' + JSON.stringify({ results }) + '\n```',
        inferenceSource: InferenceSource.IN_CLOUD,
        candidates: [
          {
            groundingMetadata: grounded
              ? {
                  searchEntryPoint: { renderedContent: '<div>chip</div>' },
                  groundingChunks: [{ web: { uri: 'https://docs.example/upgrade', title: 'Upgrade guide' } }],
                }
              : undefined,
          },
        ],
      },
    };
  });
}

function deps(grounded = fakeCloud(), ungrounded = fakeCloud({ grounded: false }), maxCloudCallsPerPage = 10) {
  return {
    deps: {
      db,
      uid: 'u1',
      models: {
        grounded: { generateContent: grounded } as unknown as GenerativeModel,
        ungrounded: { generateContent: ungrounded } as unknown as GenerativeModel,
      },
      settings: { cloudModelName: 'gemini-test', maxCloudCallsPerPage },
    },
    grounded,
    ungrounded,
  };
}

const cand = (id: string, code: string, library = 'firebase'): VerifyCandidate => ({ id, library, code });

beforeEach(() => store.clear());

describe('buildVerifyPrompt', () => {
  it('numbers the lines and names the library', () => {
    const p = buildVerifyPrompt('firebase', ['  a();', 'b();'], { title: 'T' });
    expect(p).toContain('"firebase"');
    expect(p).toContain('1| a();\n2| b();');
    expect(p).toContain('Tutorial: T');
  });
});

describe('parseVerifyResponse', () => {
  it('reads {results:[...]} inside prose and fences', () => {
    const m = parseVerifyResponse(
      'Sure:\n```json\n{"results":[{"n":1,"status":"Outdated","modernCode":" x ","explanation":"e"},{"n":2,"status":"ok","modernCode":"ignored"}]}\n```',
      2,
    );
    expect(m.get(1)).toEqual({ status: 'outdated', modernCode: 'x', explanation: 'e' });
    expect(m.get(2)).toEqual({ status: 'ok', modernCode: '', explanation: '' });
  });

  it('also accepts a bare array, string numbers and "deprecated"', () => {
    const m = parseVerifyResponse('[{"n":"1","status":"deprecated","modernCode":"y"},]', 1);
    expect(m.get(1)?.status).toBe('outdated');
  });

  it('maps unknown statuses to unsure and drops bad line numbers', () => {
    const m = parseVerifyResponse('{"results":[{"n":1,"status":"maybe"},{"n":0},{"n":5},{"n":1,"status":"ok"}]}', 2);
    expect([...m.keys()]).toEqual([1]);
    expect(m.get(1)?.status).toBe('unsure');
  });

  it('returns an empty map for unusable output', () => {
    expect(parseVerifyResponse('I could not find anything.', 3).size).toBe(0);
  });
});

describe('verifyFlagged', () => {
  it('verifies misses in the cloud, writes the cache, then serves the next reader from it', async () => {
    const first = deps();
    const lines = [cand('a', 'const db = firebase.firestore();'), cand('b', 'firebase.initializeApp(cfg);')];
    const r1 = await verifyFlagged(first.deps, lines, { title: 'T' });
    expect(first.grounded).toHaveBeenCalledTimes(1); // both lines in one request
    expect(r1.stats).toMatchObject({ unique: 2, fromCache: 0, sentToCloud: 2, cloudCalls: 1, groundedCalls: 1, skipped: 0 });
    const a = r1.outcomes.get('a');
    expect(a).toMatchObject({ status: 'outdated', servedBy: 'cloud' });
    expect(a?.status === 'outdated' && a.entry).toMatchObject({
      modernCode: 'modern 1',
      grounded: true,
      sources: [{ uri: 'https://docs.example/upgrade', title: 'Upgrade guide' }],
      searchEntryPointHtml: '<div>chip</div>',
      model: 'gemini-test',
    });
    expect(store.size).toBe(2);

    // A second reader (different formatting) gets everything from the cache.
    const second = deps();
    const r2 = await verifyFlagged(second.deps, [cand('x', '   const db = firebase.firestore()'), lines[1]!]);
    expect(second.grounded).not.toHaveBeenCalled();
    expect(r2.stats).toMatchObject({ fromCache: 2, cloudCalls: 0 });
    expect(r2.outcomes.get('x')).toMatchObject({ status: 'outdated', servedBy: 'cache' });
  });

  it('dedupes identical lines on a page', async () => {
    const d = deps();
    const r = await verifyFlagged(d.deps, [cand('1', 'db.collection("m")'), cand('2', '  db.collection("m");')]);
    expect(r.stats).toMatchObject({ candidates: 2, unique: 1, sentToCloud: 1 });
    expect(r.outcomes.get('1')).toMatchObject({ servedBy: 'cloud' });
    expect(r.outcomes.get('2')).toMatchObject({ servedBy: 'cloud' });
  });

  it('batches per library and caps the number of cloud calls', async () => {
    const many = Array.from({ length: VERIFY_BATCH_SIZE + 2 }, (_, i) => cand(`f${i}`, `firebase.call${i}()`));
    const d = deps(fakeCloud(), fakeCloud({ grounded: false }), 2);
    const r = await verifyFlagged(d.deps, [...many, cand('r', 'ReactDOM.render(a, b)', 'react-dom')]);
    // firebase: 2 batches (8 + 2), react-dom: 1 batch → 3 batches, budget 2.
    expect(r.stats).toMatchObject({ cloudCalls: 2, skipped: 1 });
    expect(r.outcomes.get('r')).toMatchObject({ status: 'skipped' });
    for (const [prompt] of d.grounded.mock.calls) expect(prompt).not.toMatch(/ReactDOM/);
  });

  it('falls back to no-Search answers on a grounding quota error, and caches them separately', async () => {
    const quota = new AIError('fetch-error' as never, '[429 ] quota', { status: 429 });
    const d = deps(fakeCloud({ fail: quota }));
    const r = await verifyFlagged(d.deps, [cand('a', 'firebase.auth()')]);
    expect(d.ungrounded).toHaveBeenCalledTimes(1);
    expect(r.stats.groundedCalls).toBe(0);
    const a = r.outcomes.get('a');
    expect(a?.status === 'outdated' && a.entry).toMatchObject({ grounded: false, sources: [] });
    expect(a?.status === 'outdated' && a.entry.searchEntryPointHtml).toBeUndefined();
    expect(store.size).toBe(1);
  });

  it('reports per-batch errors without losing other batches', async () => {
    const d = deps(fakeCloud({ fail: new Error('network down') }));
    const r = await verifyFlagged(d.deps, [cand('a', 'firebase.auth()')]);
    expect(r.outcomes.get('a')).toEqual({ id: 'a', status: 'error', reason: 'network down' });
    expect(store.size).toBe(0);
  });

  it('marks lines the model did not answer as errors and does not cache them', async () => {
    const d = deps(fakeCloud({ skipLine: 2 }));
    const r = await verifyFlagged(d.deps, [cand('a', 'firebase.auth()'), cand('b', 'firebase.firestore()')]);
    expect(r.outcomes.get('b')).toMatchObject({ status: 'error' });
    expect(store.size).toBe(1);
  });

  it('makes no calls when there is nothing to verify', async () => {
    const d = deps();
    const r = await verifyFlagged(d.deps, []);
    expect(d.grounded).not.toHaveBeenCalled();
    expect(r.stats).toMatchObject({ candidates: 0, cloudCalls: 0 });
  });
});
