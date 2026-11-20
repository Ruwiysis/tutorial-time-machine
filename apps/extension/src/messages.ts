/**
 * Messages between the content script (in the tutorial page) and the side
 * panel (where all AI runs). The content script never talks to Firebase.
 */
import type { CodeBlock, LineOutcome } from '@ttm/core';

export type MarkerState = 'checking' | 'outdated' | 'ok' | 'unsure' | 'skipped' | 'error';

export interface PageSnapshot {
  url: string;
  title: string;
  blocks: CodeBlock[];
}

/** Side panel → content script. */
export type ToContent =
  | { type: 'ttm:get-page' }
  | { type: 'ttm:reset' }
  | { type: 'ttm:marks'; marks: { id: string; state: MarkerState; code: string; outcome?: LineOutcome }[] }
  | { type: 'ttm:focus'; id: string };

/** Content script → side panel. */
export type ToPanel = { type: 'ttm:select'; id: string; url: string };

/** chrome.storage keys. */
export const STORAGE = {
  /** local: boolean, check pages automatically while the side panel is open (default true). */
  enabled: 'ttm:enabled',
  /** local: lifetime savings counters. */
  totals: 'ttm:totals',
  /** session: signed-in anonymous uid, so the popup can show it without starting Firebase. */
  uid: 'ttm:uid',
} as const;

export interface Totals {
  pages: number;
  linesScanned: number;
  sentToCloud: number;
  fromCache: number;
}

export const EMPTY_TOTALS: Totals = { pages: 0, linesScanned: 0, sentToCloud: 0, fromCache: 0 };
