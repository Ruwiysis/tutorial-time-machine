/**
 * Step 2 (and the end of step 3): the shared Firestore cache.
 *
 * Before anything goes to the cloud we look the line up in
 * `verifiedLines/{hash}`. If another reader already had it verified, the
 * answer comes back instantly with no model call at all. After a cloud
 * verification we write the result, so the next reader gets it from here.
 *
 * Entries are public-read and create-only (see firestore.rules). Writes are
 * best-effort: a failed write never breaks the check the user is waiting for.
 */
import { doc, getDoc, serverTimestamp, setDoc, type Firestore } from 'firebase/firestore';
import type { GroundingSource } from './grounding';
import { cacheKey } from './hash';

export const CACHE_COLLECTION = 'verifiedLines';

export type VerifyStatus = 'outdated' | 'ok' | 'unsure';

export interface VerifiedLine {
  library: string;
  code: string;
  status: VerifyStatus;
  /** Replacement code ("" when the line is fine). */
  modernCode: string;
  explanation: string;
  sources: GroundingSource[];
  /** Google Search suggestions widget HTML, required with grounded results. */
  searchEntryPointHtml?: string;
  /** Cloud model that produced the answer. */
  model: string;
  /** True if the answer was made with Google Search grounding. */
  grounded: boolean;
}

// Limits from firestore.rules. Clamping here keeps writes from being rejected.
const LIMITS = { library: 64, code: 2000, modernCode: 4000, explanation: 2000, sources: 10, html: 20000, model: 100 };

const STATUSES: readonly VerifyStatus[] = ['outdated', 'ok', 'unsure'];

/** Builds the Firestore document for an entry, matching the security rules. */
export function toCacheDoc(entry: VerifiedLine, uid: string): Record<string, unknown> {
  const data: Record<string, unknown> = {
    library: entry.library.slice(0, LIMITS.library),
    code: entry.code.slice(0, LIMITS.code),
    status: entry.status,
    modernCode: entry.modernCode.slice(0, LIMITS.modernCode),
    explanation: entry.explanation.slice(0, LIMITS.explanation),
    sources: entry.sources.slice(0, LIMITS.sources).map(({ uri, title }) => ({ uri, title })),
    model: entry.model.slice(0, LIMITS.model),
    grounded: entry.grounded,
    createdBy: uid,
    createdAt: serverTimestamp(),
  };
  // The widget must be shown unmodified, so it's stored whole or not at all.
  if (entry.searchEntryPointHtml && entry.searchEntryPointHtml.length <= LIMITS.html) {
    data.searchEntryPointHtml = entry.searchEntryPointHtml;
  }
  return data;
}

/** Reads a cache document defensively (anyone could have written it). */
export function fromCacheDoc(data: Record<string, unknown> | undefined): VerifiedLine | null {
  if (!data) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const status = STATUSES.find((s) => s === data.status);
  if (!status || !str(data.library) || !str(data.code)) return null;
  const sources = Array.isArray(data.sources)
    ? data.sources
        .filter((s): s is GroundingSource => !!s && typeof s.uri === 'string' && /^https?:\/\//i.test(s.uri))
        .map((s) => ({ uri: s.uri, title: str(s.title) || s.uri }))
    : [];
  return {
    library: str(data.library),
    code: str(data.code),
    status,
    modernCode: str(data.modernCode),
    explanation: str(data.explanation),
    sources,
    searchEntryPointHtml: str(data.searchEntryPointHtml) || undefined,
    model: str(data.model),
    grounded: data.grounded === true,
  };
}

/**
 * Looks a line up in the cache. Prefers a Search-verified entry, and falls
 * back to one made without Search.
 */
export async function lookupCache(db: Firestore, library: string, code: string): Promise<VerifiedLine | null> {
  for (const grounded of [true, false]) {
    const snap = await getDoc(doc(db, CACHE_COLLECTION, await cacheKey(library, code, grounded)));
    const entry = snap.exists() ? fromCacheDoc(snap.data()) : null;
    if (entry) return entry;
  }
  return null;
}

/**
 * Stores a verified line. Best-effort: if the entry already exists (another
 * reader won the race) or the write is rejected, we log and carry on.
 * Answers marked "unsure" are not cached, so a later check can do better.
 */
export async function writeCache(db: Firestore, uid: string, entry: VerifiedLine): Promise<boolean> {
  if (entry.status === 'unsure') return false;
  try {
    const key = await cacheKey(entry.library, entry.code, entry.grounded);
    await setDoc(doc(db, CACHE_COLLECTION, key), toCacheDoc(entry, uid));
    return true;
  } catch (err) {
    console.warn('[ttm] cache write skipped', err);
    return false;
  }
}
