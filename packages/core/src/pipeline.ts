/**
 * The whole hybrid pipeline for one page, as one call:
 *
 *   1. ⚡ scan        on-device (Gemini Nano), every code block, free and private
 *   2. 📦 cache       Firestore lookup of lines someone already verified
 *   3. ☁️ verify      cloud Gemini + Google Search, only flagged + uncached lines
 *
 * The web app and the Chrome extension both call checkPage() and render the
 * events it emits, so the two front ends behave identically.
 */
import type { GenerativeModel } from 'firebase/ai';
import type { ServedBy } from './models';
import { lookupCache } from './cache';
import { couldUseLibraryApi, scanPage, selectLinesToVerify, type CodeBlock, type FlaggedLine, type PageScanResult } from './scan';
import type { RuntimeSettings } from './settings';
import { verifyFlagged, type LineOutcome, type VerifyDeps, type VerifyProgress, type VerifyStats } from './verify';

/** Stable id of a line on the page: "<block index, 0-based>:<line number, 1-based>". */
export const lineId = (block: number, lineNo: number) => `${block}:${lineNo}`;

export interface PageCheckEvents {
  /** Step 1 finished. `toVerify` are the line ids that go on to steps 2–3. */
  onScanned?: (page: PageScanResult, toVerify: string[]) => void;
  onVerifyProgress?: (p: VerifyProgress) => void;
  /** A verdict for one line is available (from the cache or the cloud). */
  onLine?: (outcome: LineOutcome) => void;
}

export interface PageCheckResult {
  page: PageScanResult;
  /** Flagged lines kept local because the on-device model was not sure enough. */
  keptLocal: (FlaggedLine & { id: string })[];
  outcomes: Map<string, LineOutcome>;
  stats: VerifyStats;
  /** Where step 1 ran: 'on-device' or, when Nano is unavailable, 'cloud'. */
  scanServedBy: ServedBy;
  timings: { scanMs: number; verifyMs: number };
}

export interface PageCheckDeps {
  scanModel: GenerativeModel;
  verify: VerifyDeps;
  settings: RuntimeSettings;
}

export async function checkPage(
  deps: PageCheckDeps,
  blocks: CodeBlock[],
  ctx: { title?: string } = {},
  events: PageCheckEvents = {},
): Promise<PageCheckResult> {
  const t0 = performance.now();
  const page = await scanPage(deps.scanModel, blocks, ctx, deps.settings);
  const scanMs = performance.now() - t0;

  // Hybrid routing: only lines the on-device model is sure about, with a known
  // library, continue to the cache and the cloud.
  const flagged = page.blocks.flatMap((r, b) => r.flagged.map((f) => ({ ...f, id: lineId(b, f.lineNo) })));
  const selected = new Set(selectLinesToVerify(flagged, deps.settings).filter((f) => f.library));
  const candidates = [...selected].map((f) => ({ id: f.id, library: f.library!, code: f.code }));
  const keptLocal = flagged.filter((f) => !selected.has(f));
  events.onScanned?.(page, candidates.map((c) => c.id));

  const t1 = performance.now();
  const recallCandidates = cacheRecallCandidates(blocks, page, new Set(candidates.map((c) => c.id)));
  const [{ outcomes, stats }, recalled] = await Promise.all([
    verifyFlagged(deps.verify, candidates, ctx, events.onVerifyProgress),
    recallFromCache(deps.verify, recallCandidates),
  ]);
  const verifyMs = performance.now() - t1;
  for (const o of recalled) outcomes.set(o.id, o);
  stats.fromCache += recalled.length;
  stats.recalled = recalled.length;

  // Emitted after the fact, in page order, so UIs can animate markers in sequence.
  for (const o of [...outcomes.values()].sort((a, b) => compareLineIds(a.id, b.id))) events.onLine?.(o);

  return { page, keptLocal, outcomes, stats, scanServedBy: page.servedBy, timings: { scanMs, verifyMs } };
}

/** Upper bound on extra cache lookups per page (each is 1–2 Firestore reads). */
export const MAX_CACHE_RECALL = 60;

/**
 * Cache-assisted recall. Small on-device models don't flag exactly the same
 * lines on every run. Any library-looking line Nano did NOT send on is still
 * looked up in the shared cache (never sent to the cloud), so once one reader
 * has a line verified, every later reader gets its marker even if Nano misses
 * it this time. Costs a few Firestore reads and no model calls.
 */
export function cacheRecallCandidates(
  blocks: CodeBlock[],
  page: PageScanResult,
  alreadyChecked: Set<string>,
): { id: string; library: string; code: string }[] {
  // Library: the block's own, else the page's most common one.
  const votes = new Map<string, number>();
  for (const b of page.blocks) if (b.library) votes.set(b.library, (votes.get(b.library) ?? 0) + 1);
  const pageLibrary = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const out: { id: string; library: string; code: string }[] = [];
  blocks.forEach((block, b) => {
    const library = page.blocks[b]?.library ?? pageLibrary;
    if (!library) return;
    block.code.split('\n').forEach((code, i) => {
      const id = lineId(b, i + 1);
      if (!code.trim() || alreadyChecked.has(id) || !couldUseLibraryApi(code)) return;
      out.push({ id, library, code });
    });
  });
  return out.slice(0, MAX_CACHE_RECALL);
}

async function recallFromCache(deps: VerifyDeps, candidates: { id: string; library: string; code: string }[]): Promise<LineOutcome[]> {
  const hits = await Promise.all(
    candidates.map(async (c) => {
      const entry = await lookupCache(deps.db, c.library, c.code).catch(() => null);
      return entry ? ({ id: c.id, status: entry.status, servedBy: 'cache', entry } satisfies LineOutcome) : null;
    }),
  );
  return hits.filter((h): h is NonNullable<typeof h> => h !== null);
}

function compareLineIds(a: string, b: string): number {
  const [ab, an] = a.split(':').map(Number);
  const [bb, bn] = b.split(':').map(Number);
  return ab! - bb! || an! - bn!;
}
