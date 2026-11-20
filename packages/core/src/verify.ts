/**
 * Steps 2 and 3 of the pipeline: cache lookup, then cloud verification.
 *
 *   flagged lines (from the on-device scan)
 *     → dedupe (same library + same normalized line = one check)
 *     → step 2: Firestore cache. Hits are answered instantly, no model call.
 *     → step 3: cloud model + Google Search, for the misses only. Lines of
 *       the same library go in one request (up to VERIFY_BATCH_SIZE), so a
 *       page needs a handful of calls, not one per line. The number of calls
 *       per page is capped by Remote Config (max_cloud_calls_per_page).
 *     → results written back to the cache for the next reader.
 *
 * Why the cloud, and why Search: Nano's knowledge is frozen at training time,
 * so "is this API still current?" needs a model that can read today's docs.
 */
import type { Firestore } from 'firebase/firestore';
import { lookupCache, writeCache, type VerifiedLine, type VerifyStatus } from './cache';
import { extractGrounding, type GroundingInfo } from './grounding';
import { normalizeCodeLine, normalizeLibrary } from './hash';
import { generateVerify, servedByFromResponse, type VerifyModels } from './models';
import { extractJsonArray, extractJsonObject, parseJsonLenient } from './scan';
import type { RuntimeSettings } from './settings';

/** Lines per cloud request. Small enough for focused answers, big enough to save calls. */
export const VERIFY_BATCH_SIZE = 8;

export interface VerifyCandidate {
  /** Caller's id for this line (e.g. "block:line"); results are keyed by it. */
  id: string;
  library: string;
  code: string;
}

export type LineOutcome =
  | { id: string; status: VerifyStatus; servedBy: 'cache' | 'cloud'; entry: VerifiedLine }
  | { id: string; status: 'skipped'; reason: string }
  | { id: string; status: 'error'; reason: string };

type OutcomeWithoutId = LineOutcome extends infer O ? (O extends LineOutcome ? Omit<O, 'id'> : never) : never;

export interface VerifyStats {
  /** Lines handed in (already flagged on-device and above the confidence threshold). */
  candidates: number;
  /** Distinct lines after deduplication. */
  unique: number;
  /** Distinct lines answered from the Firestore cache. */
  fromCache: number;
  /** Distinct lines sent to the cloud model. */
  sentToCloud: number;
  /** Cloud requests made. */
  cloudCalls: number;
  /** Cloud requests that used Google Search grounding. */
  groundedCalls: number;
  /** Distinct lines not checked because the per-page cloud budget ran out. */
  skipped: number;
}

export interface VerifyDeps {
  db: Firestore;
  /** Signed-in user's uid, recorded on cache entries. */
  uid: string;
  models: VerifyModels;
  settings: Pick<RuntimeSettings, 'cloudModelName' | 'maxCloudCallsPerPage'>;
}

export interface VerifyProgress {
  phase: 'cache' | 'cloud' | 'done';
  done: number;
  total: number;
}

interface Answer {
  status: VerifyStatus;
  modernCode: string;
  explanation: string;
}

export function buildVerifyPrompt(library: string, lines: string[], ctx: { title?: string } = {}): string {
  return [
    `You check code from a programming tutorial against the CURRENT official documentation of the "${library}" library.`,
    `Search the web for the current ${library} documentation before answering.`,
    ...(ctx.title ? [`Tutorial: ${ctx.title}`] : []),
    '',
    'Lines to check (numbered):',
    ...lines.map((code, i) => `${i + 1}| ${code.trim()}`),
    '',
    'For each line decide its status. Judge only that line itself, not the code around it:',
    '- "outdated": the API it uses is deprecated, removed or replaced in the current major version.',
    '- "ok": the line would still work unchanged in the current version (even if nearby code must change).',
    '- "unsure": you cannot tell.',
    'Reply with JSON only, in this form:',
    '{"results":[{"n":1,"status":"outdated","modernCode":"...","explanation":"..."}]}',
    'modernCode: the current equivalent of that line (a few lines at most, include needed imports), or "" if ok.',
    'explanation: one or two sentences that name the versions involved.',
  ].join('\n');
}

/** Parses the verifier's JSON. Returns answers keyed by line number (1-based). */
export function parseVerifyResponse(text: string, lineCount: number): Map<number, Answer> {
  const fromObject = extractJsonObject(text);
  const objectValue = fromObject ? parseJsonLenient(fromObject) : undefined;
  let items: unknown =
    objectValue && typeof objectValue === 'object' && !Array.isArray(objectValue)
      ? (objectValue as Record<string, unknown>).results
      : undefined;
  if (!Array.isArray(items)) {
    const fromArray = extractJsonArray(text);
    items = fromArray ? parseJsonLenient(fromArray) : undefined;
  }

  const answers = new Map<number, Answer>();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const n = typeof r.n === 'string' ? Number.parseInt(r.n, 10) : r.n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > lineCount || answers.has(n)) continue;
    const raw = typeof r.status === 'string' ? r.status.trim().toLowerCase() : '';
    const status: VerifyStatus = raw === 'outdated' || raw === 'deprecated' ? 'outdated' : raw === 'ok' ? 'ok' : 'unsure';
    answers.set(n, {
      status,
      modernCode: status === 'ok' || typeof r.modernCode !== 'string' ? '' : r.modernCode.trim(),
      explanation: typeof r.explanation === 'string' ? r.explanation.trim() : '',
    });
  }
  return answers;
}

/** One grounded cloud request for several lines of the same library. */
export async function verifyBatch(
  models: VerifyModels,
  library: string,
  lines: string[],
  ctx: { title?: string } = {},
): Promise<{ answers: Map<number, Answer>; grounding: GroundingInfo; grounded: boolean }> {
  const { response, grounded } = await generateVerify(models, buildVerifyPrompt(library, lines, ctx));
  if (servedByFromResponse(response) !== 'cloud') {
    throw new Error('Verification must run in the cloud (it needs Google Search).');
  }
  return { answers: parseVerifyResponse(response.text(), lines.length), grounding: extractGrounding(response), grounded };
}

/**
 * Runs the cache + cloud steps for the lines the on-device scan flagged.
 * Every candidate gets exactly one outcome; failures are per batch, so one
 * bad request never hides the results of the others.
 */
export async function verifyFlagged(
  deps: VerifyDeps,
  candidates: VerifyCandidate[],
  ctx: { title?: string } = {},
  onProgress?: (p: VerifyProgress) => void,
): Promise<{ outcomes: Map<string, LineOutcome>; stats: VerifyStats }> {
  // Dedupe: the same line (after normalization) is checked once per page.
  const groups = new Map<string, { library: string; code: string; ids: string[] }>();
  for (const c of candidates) {
    const library = normalizeLibrary(c.library);
    const key = `${library}\n${normalizeCodeLine(c.code)}`;
    const g = groups.get(key) ?? { library, code: c.code.trim(), ids: [] };
    g.ids.push(c.id);
    groups.set(key, g);
  }
  const unique = [...groups.values()];
  const outcomes = new Map<string, LineOutcome>();
  const set = (ids: string[], outcome: OutcomeWithoutId) =>
    ids.forEach((id) => outcomes.set(id, { ...outcome, id } as LineOutcome));
  const stats: VerifyStats = {
    candidates: candidates.length,
    unique: unique.length,
    fromCache: 0,
    sentToCloud: 0,
    cloudCalls: 0,
    groundedCalls: 0,
    skipped: 0,
  };

  // Step 2: cache. Lookups run in parallel; a failed lookup just counts as a miss.
  onProgress?.({ phase: 'cache', done: 0, total: unique.length });
  const cached = await Promise.all(unique.map((g) => lookupCache(deps.db, g.library, g.code).catch(() => null)));
  const misses: typeof unique = [];
  unique.forEach((g, i) => {
    const entry = cached[i];
    if (entry) {
      stats.fromCache++;
      set(g.ids, { status: entry.status, servedBy: 'cache', entry });
    } else {
      misses.push(g);
    }
  });

  // Step 3: cloud, for cache misses only, batched per library and capped per page.
  const byLibrary = new Map<string, typeof unique>();
  for (const g of misses) byLibrary.set(g.library, [...(byLibrary.get(g.library) ?? []), g]);
  const batches: (typeof unique)[] = [];
  for (const lines of byLibrary.values()) {
    for (let i = 0; i < lines.length; i += VERIFY_BATCH_SIZE) batches.push(lines.slice(i, i + VERIFY_BATCH_SIZE));
  }
  const budget = Math.max(0, deps.settings.maxCloudCallsPerPage);
  for (const batch of batches.slice(budget)) {
    stats.skipped += batch.length;
    batch.forEach((g) => set(g.ids, { status: 'skipped', reason: 'Cloud budget for this page used up.' }));
  }

  const toRun = batches.slice(0, budget);
  let done = 0;
  onProgress?.({ phase: 'cloud', done, total: toRun.length });
  for (const batch of toRun) {
    const library = batch[0]!.library;
    stats.cloudCalls++;
    stats.sentToCloud += batch.length;
    try {
      const { answers, grounding, grounded } = await verifyBatch(
        deps.models,
        library,
        batch.map((g) => g.code),
        ctx,
      );
      if (grounded) stats.groundedCalls++;
      await Promise.all(
        batch.map(async (g, i) => {
          const answer = answers.get(i + 1);
          if (!answer) {
            set(g.ids, { status: 'error', reason: 'The cloud model returned no answer for this line.' });
            return;
          }
          const entry: VerifiedLine = {
            library,
            code: g.code,
            ...answer,
            // Search results back the whole request, so every line in it shares them.
            sources: grounded ? grounding.sources : [],
            searchEntryPointHtml: grounded ? grounding.searchEntryPointHtml : undefined,
            model: deps.settings.cloudModelName,
            grounded,
          };
          set(g.ids, { status: entry.status, servedBy: 'cloud', entry });
          await writeCache(deps.db, deps.uid, entry);
        }),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      batch.forEach((g) => set(g.ids, { status: 'error', reason }));
    }
    onProgress?.({ phase: 'cloud', done: ++done, total: toRun.length });
  }

  onProgress?.({ phase: 'done', done: unique.length, total: unique.length });
  return { outcomes, stats };
}
