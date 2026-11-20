/**
 * Step 1 of the pipeline: the on-device scan.
 *
 * Gemini Nano reads the code on a page and points at the lines that are
 * *version-sensitive*: library APIs whose name, import or usage changed
 * between major versions. It does NOT decide whether a line is outdated.
 * Nano's knowledge is frozen at training time and it can't search, so that
 * judgement (and the explanation the user sees) comes from the grounded cloud
 * model in step 3. The scan is a cheap, private, local filter that keeps most
 * code away from the cloud.
 *
 * Design choices driven by the on-device model:
 *   - Speed is dominated by output tokens, so Nano answers with line numbers
 *     only: a "sure" list and a "maybe" list. (Measured: per-line labels and
 *     confidences made a 51-line page take ~80 s; Nano's numeric confidences
 *     were also just 0 or 1, so two lists lose nothing.)
 *   - Every prompt costs a new session, so the whole page goes into one
 *     prompt (all code blocks, numbered continuously) instead of one per block.
 *   - ~9,216-token context, so long pages are split into line chunks.
 *   - Single-turn, no system instruction on-device, so every prompt carries
 *     its own instructions.
 *   - Small models produce odd JSON at times, so parse defensively and take
 *     the code from the page, never from the model.
 */
import { Schema, type GenerativeModel } from 'firebase/ai';
import { servedByFromResponse, type ServedBy } from './models';
import type { RuntimeSettings } from './settings';

export interface PageContext {
  /** Page title, e.g. "Getting started with Cloud Firestore". */
  title?: string;
  /** Language of a single block (used by scanBlock). */
  language?: string;
}

export interface CodeBlock {
  code: string;
  /** From the block's class, e.g. "javascript", "python". */
  language?: string;
}

export interface FlaggedLine {
  /** 1-based line number within its code block. */
  lineNo: number;
  /** The exact source line (always taken from the page, never from the model). */
  code: string;
  /** Library this line uses, lower-case, or null if unknown. */
  library: string | null;
  /** Optional short label of the API involved (the on-device scan leaves it empty). */
  reason: string;
  /** 0..1. On-device: SURE_CONFIDENCE or MAYBE_CONFIDENCE. */
  confidence: number;
}

export interface ScanResult {
  /** Main library of the block, lower-case, or null if none was detected. */
  library: string | null;
  flagged: FlaggedLine[];
  /** Which path served the scan. 'cloud' if any of its chunks fell back to the cloud. */
  servedBy: ServedBy;
  /** Non-blank lines that were scanned (for the savings meter). */
  linesScanned: number;
  /** Chunks covering this block whose output could not be parsed. */
  failedChunks: number;
}

export interface PageScanResult {
  /** One result per input block, in the same order. */
  blocks: ScanResult[];
  servedBy: ServedBy;
  linesScanned: number;
  failedChunks: number;
  /** Number of model calls made (one per chunk). */
  prompts: number;
}

/** Confidence given to lines in the model's "sure" and "maybe" lists. */
export const SURE_CONFIDENCE = 0.9;
export const MAYBE_CONFIDENCE = 0.5;

/**
 * Shape the model must return, shared by the on-device and cloud paths.
 * Just numbers: every output token costs time on-device.
 */
export const SCAN_SCHEMA = Schema.object({
  properties: {
    lib: Schema.string({ description: 'Main library, lower-case, or "none".' }),
    sure: Schema.array({ items: Schema.integer(), description: 'Line numbers.' }),
    maybe: Schema.array({ items: Schema.integer(), description: 'Line numbers.' }),
  },
});

/** Objects and modules that belong to the language or the browser, not to a library. */
const PLATFORM_OBJECTS = new Set([
  // JavaScript / browser
  'console', 'document', 'window', 'globalThis', 'navigator', 'location', 'history', 'localStorage',
  'sessionStorage', 'Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Promise', 'Date',
  'RegExp', 'Map', 'Set', 'Symbol', 'Error', 'Reflect', 'Intl', 'performance', 'process', 'this', 'super',
  // Python standard library
  'os', 'sys', 'time', 'math', 're', 'json', 'random', 'datetime', 'pathlib', 'self', 'cls',
]);

/** Free functions and keywords that are followed by "(" but aren't library calls. */
const PLATFORM_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'async', 'new', 'with',
  'elif', 'not', 'and', 'or', 'in', 'print', 'len', 'range', 'open', 'str', 'int', 'float', 'list', 'dict',
  'set', 'tuple', 'bool', 'isinstance', 'enumerate', 'zip', 'sorted', 'min', 'max', 'sum', 'abs', 'round',
  'setTimeout', 'setInterval', 'clearTimeout', 'parseInt', 'parseFloat', 'fetch', 'alert', 'require',
]);

/** Well-known built-in members (DOM, Array, String, Promise, Python str/list/dict). */
const PLATFORM_MEMBERS = new Set([
  'log', 'error', 'warn', 'info', 'debug', 'length', 'push', 'pop', 'shift', 'unshift', 'slice', 'splice',
  'map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every', 'includes', 'indexOf', 'join', 'split',
  'concat', 'sort', 'reverse', 'keys', 'values', 'entries', 'trim', 'toLowerCase', 'toUpperCase', 'replace',
  'startsWith', 'endsWith', 'toString', 'then', 'catch', 'finally', 'appendChild', 'removeChild', 'append',
  'prepend', 'remove', 'textContent', 'innerHTML', 'innerText', 'value', 'style', 'classList', 'add',
  'querySelector', 'querySelectorAll', 'getElementById', 'createElement', 'addEventListener', 'setAttribute',
  'getAttribute', 'preventDefault', 'target', 'strip', 'lower', 'upper', 'format', 'items', 'get', 'append',
  'extend', 'read', 'write', 'close', 'astype',
]);

/**
 * Deterministic guard against the model's common false alarms: config values,
 * plain data, and language or browser built-ins (console.log, document.*,
 * list.forEach, …). A line counts as possible library use only if it is an
 * import/install line, or if, outside string literals, it accesses at least
 * one member or calls at least one function that is NOT a well-known built-in.
 * Cheap, predictable, and it doesn't rely on a small model obeying "skip X".
 */
export function couldUseLibraryApi(line: string): boolean {
  const code = line.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  if (/^\s*(import|from|export|npm|npx|yarn|pnpm|pip|pip3|conda|using|#include)\b|\brequire\s*\(\s*""/.test(code)) {
    return true;
  }
  // Member chains: root.a.b.c, or ".a.b" continuing a chained call. A chain is
  // built-in if its root is (console.error) or if every member is (list.forEach),
  // so openai.error.RateLimitError still counts as library use.
  for (const m of code.matchAll(/(?:([A-Za-z_$][\w$]*)|(?:^|[)\]])\s*)((?:\s*\.\s*[A-Za-z_$][\w$]*)+)/g)) {
    const [, root, chain] = m;
    if (root && PLATFORM_OBJECTS.has(root)) continue;
    const members = (chain ?? '').split('.').map((s) => s.trim()).filter(Boolean);
    if (members.every((name) => PLATFORM_MEMBERS.has(name))) continue;
    return true;
  }
  // bare calls: fn(...)  (not preceded by "." — those were handled above)
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!PLATFORM_CALLS.has(m[1]!)) return true;
  }
  return false;
}

/**
 * About 6,000 characters per chunk ≈ 1,500–2,000 tokens of code. With the
 * instructions and the answer that stays well under Nano's ~9,216-token window.
 */
export const MAX_CHUNK_CHARS = 6000;

/** One line of the page, numbered continuously across blocks for the prompt. */
export interface PageLine {
  /** Number shown to the model (1-based, continuous across the page). */
  n: number;
  /** Index of the code block this line belongs to. */
  block: number;
  /** 1-based line number within that block. */
  lineNo: number;
  text: string;
}

export type Chunk = PageLine[];

/** Flattens blocks into numbered lines. Blank lines keep their numbers but are never shown. */
export function pageLines(blocks: CodeBlock[]): PageLine[] {
  const out: PageLine[] = [];
  blocks.forEach((b, block) => {
    b.code
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .forEach((text, i) => out.push({ n: out.length + 1, block, lineNo: i + 1, text }));
  });
  return out;
}

/** Splits the page's non-blank lines into chunks of at most maxChars. */
export function chunkPage(blocks: CodeBlock[], maxChars = MAX_CHUNK_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Chunk = [];
  let size = 0;
  for (const line of pageLines(blocks)) {
    if (!line.text.trim()) continue;
    // A single overlong line becomes its own chunk, truncated, rather than being dropped.
    const text = line.text.length > maxChars ? line.text.slice(0, maxChars) : line.text;
    if (current.length && size + text.length + 1 > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push({ ...line, text });
    size += text.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function buildScanPrompt(
  chunk: Chunk,
  blocks: CodeBlock[],
  ctx: PageContext,
  trackedLibraries: string[],
): string {
  const code: string[] = [];
  let lastBlock = -1;
  for (const line of chunk) {
    if (line.block !== lastBlock) {
      const lang = blocks[line.block]?.language;
      code.push(`--- block ${line.block + 1}${lang ? ` (${lang})` : ''} ---`);
      lastBlock = line.block;
    }
    code.push(`${line.n}| ${line.text}`);
  }
  return [
    'Find lines in this tutorial code that use a library API which may differ between major versions of that library.',
    ...(ctx.title ? [`Page: ${ctx.title}`] : []),
    `Libraries of interest: ${trackedLibraries.join(', ')}.`,
    '',
    'Code (each line starts with its number and "|"):',
    ...code,
    '',
    'Flag: library installs with versions, imports, client setup, and calls to library functions or methods,',
    'including methods on objects the library created (for example db or auth).',
    'Skip: plain language features, config values, comments, and non-library code such as security rules.',
    'Answer with JSON only, line numbers only, no text:',
    'lib = main library (lower-case, "none" if none); sure = lines that clearly use such an API;',
    'maybe = lines that might. Use [] if none.',
  ].join('\n');
}

/**
 * Extracts the first balanced JSON object from model output. Handles code
 * fences, leading prose and trailing chatter.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null; // unbalanced: the answer was cut off
}

function parseLooseJson(text: string): Record<string, unknown> | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  for (const candidate of [json, json.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // try the next candidate (trailing commas removed)
    }
  }
  return null;
}

function toConfidence(value: unknown): number {
  let n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return 0.5; // model omitted it: neutral
  if (n > 1 && n <= 100) n /= 100; // "85" meaning 85%
  return Math.min(1, Math.max(0, n));
}

function toLibrary(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lib = value.trim().toLowerCase();
  return lib && !['none', 'unknown', 'n/a', 'null'].includes(lib) ? lib : null;
}

/** Accepts the short schema keys and the long names small models sometimes use instead. */
const pick = (o: Record<string, unknown>, ...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined);

export interface ParsedChunk {
  library: string | null;
  /** Flags keyed to page lines; `block`/`lineNo` say where each one lives. */
  flagged: (FlaggedLine & { block: number })[];
}

/**
 * Parses one chunk's model output. Returns null if no usable JSON was found.
 * Flags must point at a line that is in this chunk; the code comes from the page.
 */
export function parseScanResponse(text: string, chunk: Chunk): ParsedChunk | null {
  const raw = parseLooseJson(text);
  if (!raw) return null;
  const library = toLibrary(pick(raw, 'lib', 'library'));
  const byNumber = new Map(chunk.map((l) => [l.n, l]));
  const asArray = (v: unknown) => (Array.isArray(v) ? v : []);
  // Main format: {sure: [n], maybe: [n]}. Also accepted: {flagged: [{line, conf, ...}]},
  // which models sometimes produce when they ignore the schema (e.g. the cloud path).
  const items: unknown[] = [
    ...asArray(raw.sure).map((line) => ({ line, conf: SURE_CONFIDENCE })),
    ...asArray(raw.maybe).map((line) => ({ line, conf: MAYBE_CONFIDENCE })),
    ...asArray(pick(raw, 'flagged', 'flags')),
  ];

  const flagged: ParsedChunk['flagged'] = [];
  const seen = new Set<number>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const rawLine = pick(f, 'line', 'lineNo');
    const n = typeof rawLine === 'string' ? Number.parseInt(rawLine, 10) : rawLine;
    if (typeof n !== 'number' || !Number.isInteger(n) || seen.has(n)) continue;
    const line = byNumber.get(n);
    if (!line) continue; // not a line we showed (out of range, blank or hallucinated)
    seen.add(n); // first mention wins, so "sure" beats "maybe"
    if (!couldUseLibraryApi(line.text)) continue; // config value or plain data
    const api = pick(f, 'api', 'reason');
    flagged.push({
      block: line.block,
      lineNo: line.lineNo,
      code: line.text,
      library: toLibrary(pick(f, 'lib', 'library')) ?? library,
      reason: typeof api === 'string' ? api.trim() : '',
      confidence: toConfidence(pick(f, 'conf', 'confidence')),
    });
  }
  return { library, flagged };
}

/**
 * Scans all code blocks of a page with as few model calls as possible: one
 * single-turn prompt per chunk, run on the scan model (on-device when
 * available). Returns one result per block.
 */
export async function scanPage(
  model: GenerativeModel,
  blocks: CodeBlock[],
  ctx: Pick<PageContext, 'title'>,
  settings: Pick<RuntimeSettings, 'trackedLibraries'>,
): Promise<PageScanResult> {
  const chunks = chunkPage(blocks);
  const results: ScanResult[] = blocks.map((b) => ({
    library: null,
    flagged: [],
    servedBy: 'on-device',
    linesScanned: b.code.split('\n').filter((l) => l.trim()).length,
    failedChunks: 0,
  }));
  const votes = blocks.map(() => new Map<string, number>());
  const fallbackLibrary: (string | null)[] = blocks.map(() => null);
  let servedBy: ServedBy = 'on-device';
  let failedChunks = 0;

  for (const chunk of chunks) {
    const blocksInChunk = [...new Set(chunk.map((l) => l.block))];
    const { response } = await model.generateContent(buildScanPrompt(chunk, blocks, ctx, settings.trackedLibraries));
    // Hybrid bookkeeping: if any chunk fell back to the cloud, say so.
    if (servedByFromResponse(response) === 'cloud') {
      servedBy = 'cloud';
      blocksInChunk.forEach((b) => (results[b]!.servedBy = 'cloud'));
    }
    const parsed = parseScanResponse(response.text(), chunk);
    if (!parsed) {
      failedChunks++;
      blocksInChunk.forEach((b) => results[b]!.failedChunks++);
      continue;
    }
    for (const { block, ...flag } of parsed.flagged) {
      results[block]!.flagged.push(flag);
      if (flag.library) votes[block]!.set(flag.library, (votes[block]!.get(flag.library) ?? 0) + 1);
    }
    blocksInChunk.forEach((b) => (fallbackLibrary[b] ??= parsed.library));
  }

  results.forEach((r, i) => {
    r.flagged.sort((a, b) => a.lineNo - b.lineNo);
    // A block's library: what its own flagged lines use, else the chunk's main library.
    r.library = [...votes[i]!.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallbackLibrary[i] ?? null;
  });

  return {
    blocks: results,
    servedBy,
    linesScanned: results.reduce((n, r) => n + r.linesScanned, 0),
    failedChunks,
    prompts: chunks.length,
  };
}

/** Scans a single code block (a page with one block). */
export async function scanBlock(
  model: GenerativeModel,
  code: string,
  ctx: PageContext,
  settings: Pick<RuntimeSettings, 'trackedLibraries'>,
): Promise<ScanResult> {
  const page = await scanPage(model, [{ code, language: ctx.language }], ctx, settings);
  return page.blocks[0]!;
}

/**
 * Hybrid routing rule for step 3: which flagged lines go to the cloud.
 * Only lines the on-device model is reasonably sure about, highest confidence
 * first, capped per page so one long tutorial can't run up the bill (or, on
 * the free tier, use up the daily quota).
 */
export function selectLinesToVerify<T extends { confidence: number }>(
  flagged: T[],
  settings: Pick<RuntimeSettings, 'minConfidenceToVerify' | 'maxCloudCallsPerPage'>,
): T[] {
  return flagged
    .filter((f) => f.confidence >= settings.minConfidenceToVerify)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.max(0, settings.maxCloudCallsPerPage));
}
