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
import { scanPage, selectLinesToVerify, type CodeBlock, type FlaggedLine, type PageScanResult } from './scan';
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
  const { outcomes, stats } = await verifyFlagged(deps.verify, candidates, ctx, events.onVerifyProgress);
  const verifyMs = performance.now() - t1;
  // Emitted after the fact, in page order, so UIs can animate markers in sequence.
  for (const c of candidates) {
    const o = outcomes.get(c.id);
    if (o) events.onLine?.(o);
  }

  return { page, keptLocal, outcomes, stats, scanServedBy: page.servedBy, timings: { scanMs, verifyMs } };
}
