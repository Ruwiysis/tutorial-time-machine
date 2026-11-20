/**
 * Pipeline test panel: runs the real steps on a demo fixture.
 *   1. scanPage (on-device) → flagged lines
 *   2–3. verifyFlagged → Firestore cache, then cloud + Google Search
 * Model output is always rendered as text. The only HTML inserted is
 * Google's Search suggestions widget, which must be shown unmodified and is
 * isolated in a shadow root.
 */
import {
  scanPage,
  selectLinesToVerify,
  SURE_CONFIDENCE,
  verifyFlagged,
  type CodeBlock,
  type GenerativeModel,
  type LineOutcome,
  type PageScanResult,
  type RuntimeSettings,
  type ScanResult,
  type VerifyCandidate,
  type VerifyDeps,
} from '@ttm/core';

import { FIXTURES, readFixture } from './fixtures';

/** The on-device scan reports two levels: "sure" (0.9) and "maybe" (0.5). */
const level = (confidence: number) => (confidence >= SURE_CONFIDENCE ? 'sure' : 'maybe');

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};

export function mountFixtureScan(
  root: HTMLElement,
  getModel: () => GenerativeModel,
  getSettings: () => RuntimeSettings,
  getVerifyDeps: () => VerifyDeps,
  onError: (title: string, err: unknown) => void,
) {
  const select = el('select');
  for (const path of Object.keys(FIXTURES).sort()) {
    const name = path.split('/').pop() ?? path;
    select.append(new Option(name.replace('.html', ''), path));
  }
  const button = el('button', '⚡ Scan fixture');
  const verifyButton = el('button', '☁️ Verify flagged lines (cache → cloud + Search)');
  verifyButton.hidden = true;
  const summary = el('p', '', 'muted');
  const meter = el('p', '', 'meter');
  const verifyOut = el('div');
  const out = el('div');
  const controls = el('div', '', 'row');
  controls.append(select, button, verifyButton);
  root.append(controls, summary, meter, verifyOut, out);

  let last: { title: string; page: PageScanResult; candidates: VerifyCandidate[] } | undefined;

  button.addEventListener('click', async () => {
    button.disabled = true;
    verifyButton.hidden = true;
    out.replaceChildren();
    verifyOut.replaceChildren();
    meter.textContent = '';
    const { title, blocks } = readFixture(FIXTURES[select.value] ?? '');
    const settings = getSettings();
    summary.textContent = `Scanning ${blocks.length} code blocks…`;
    const t0 = performance.now();
    try {
      const page = await scanPage(getModel(), blocks, { title }, settings);
      const ms = performance.now() - t0;

      // Page-level hybrid routing: which flagged lines are worth checking.
      const allFlagged = page.blocks.flatMap((r, b) => r.flagged.map((f) => ({ ...f, id: `${b + 1}:${f.lineNo}` })));
      const toVerify = selectLinesToVerify(allFlagged, settings);
      summary.textContent =
        `${page.linesScanned} lines scanned ${page.servedBy === 'on-device' ? '⚡ on-device' : '☁️ in the cloud'} ` +
        `in ${page.prompts} prompt(s), ${Math.round(ms)} ms · ${allFlagged.length} flagged · ` +
        `${toVerify.length} worth checking (confidence ≥ ${settings.minConfidenceToVerify})` +
        (page.failedChunks ? ` · ⚠️ ${page.failedChunks} chunk(s) unparseable` : '');

      last = {
        title,
        page,
        candidates: toVerify
          .filter((f) => f.library)
          .map((f) => ({ id: f.id, library: f.library!, code: f.code })),
      };
      verifyButton.hidden = last.candidates.length === 0;
      page.blocks.forEach((r, i) => out.append(renderBlock(i + 1, blocks[i]!, r)));
    } catch (err) {
      summary.textContent = '';
      onError('Fixture scan failed', err);
    }
    button.disabled = false;
  });

  verifyButton.addEventListener('click', async () => {
    if (!last) return;
    const { title, page, candidates } = last;
    verifyButton.disabled = button.disabled = true;
    verifyOut.replaceChildren();
    const t0 = performance.now();
    try {
      const { outcomes, stats } = await verifyFlagged(getVerifyDeps(), candidates, { title }, (p) => {
        meter.textContent =
          p.phase === 'cache' ? `📦 Checking the cache for ${p.total} lines…` : p.phase === 'cloud' ? `☁️ Cloud request ${p.done + 1} of ${p.total}…` : '';
      });
      // The savings meter: how much work stayed off the cloud.
      meter.textContent =
        `⚡ ${page.linesScanned} lines scanned on device · ☁️ ${stats.sentToCloud} sent to cloud ` +
        `(${stats.cloudCalls} request${stats.cloudCalls === 1 ? '' : 's'}, ${stats.groundedCalls} with Google Search) · ` +
        `📦 ${stats.fromCache} served from cache` +
        (stats.skipped ? ` · ${stats.skipped} over budget` : '') +
        ` · ${Math.round(performance.now() - t0)} ms`;
      verifyOut.append(el('h3', 'Results'), ...candidates.map((c) => renderOutcome(c, outcomes.get(c.id))));
    } catch (err) {
      onError('Verify failed', err);
    }
    verifyButton.disabled = button.disabled = false;
  });
}

function renderBlock(n: number, block: CodeBlock, r: ScanResult): HTMLElement {
  const box = el('div', '', 'result');
  const head = el('div', '', 'row');
  head.append(
    el('span', r.servedBy === 'on-device' ? '⚡ On-device' : '☁️ Cloud', `badge ${r.servedBy}`),
    el('strong', `Block ${n} · ${block.language ?? 'code'} · library: ${r.library ?? 'none'}`),
  );
  box.append(head);

  const flaggedByLine = new Map(r.flagged.map((f) => [f.lineNo, f]));
  const pre = el('pre', '', 'scan-code');
  block.code.split('\n').forEach((line, i) => {
    const f = flaggedByLine.get(i + 1);
    const row = el('div', '', f ? 'line flagged' : 'line');
    row.append(el('span', String(i + 1).padStart(3), 'ln'), el('span', ` ${line}`));
    if (f) row.title = `${level(f.confidence)} · ${f.library ?? 'unknown library'}`;
    pre.append(row);
  });
  box.append(pre);

  if (r.flagged.length) {
    const ul = el('ul', '', 'flags');
    for (const f of r.flagged) {
      ul.append(el('li', `line ${f.lineNo} · ${f.library ?? '?'} · ${level(f.confidence)}`));
    }
    box.append(ul);
  } else {
    box.append(el('p', '🟢 Nothing version-sensitive found.', 'muted'));
  }
  return box;
}

const STATUS_LABEL = { outdated: '🔴 Outdated', ok: '🟢 Still current', unsure: '🟡 Unsure' } as const;
const SOURCE_LABEL = { cloud: '☁️ Cloud', cache: '📦 Cache' } as const;

function renderOutcome(c: VerifyCandidate, o: LineOutcome | undefined): HTMLElement {
  const box = el('div', '', 'result');
  const head = el('div', '', 'row');
  box.append(head);
  if (!o || o.status === 'skipped' || o.status === 'error') {
    head.append(el('span', o?.status === 'skipped' ? '⏭ Skipped' : '⚠️ Error', 'badge error'), el('code', c.code.trim()));
    box.append(el('p', o?.reason ?? 'No result.', 'muted'));
    return box;
  }
  const { entry } = o;
  head.append(
    el('span', STATUS_LABEL[entry.status], `badge status-${entry.status}`),
    el(
      'span',
      `${SOURCE_LABEL[o.servedBy]}${entry.grounded ? ' + Google Search' : ' · not search-verified'}`,
      `badge ${o.servedBy}${entry.grounded ? '' : ' unverified'}`,
    ),
    el('span', `${entry.library} · line ${c.id}`, 'muted'),
  );

  // Old vs modern.
  const diff = el('div', '', 'diff');
  diff.append(el('pre', `- ${c.code.trim()}`, 'old'));
  if (entry.modernCode) diff.append(el('pre', entry.modernCode.split('\n').map((l) => `+ ${l}`).join('\n'), 'new'));
  box.append(diff);
  if (entry.explanation) box.append(el('p', entry.explanation));
  if (!entry.grounded) {
    box.append(el('p', 'Google Search grounding was unavailable, so this comes from the model\'s own knowledge and may be out of date.', 'muted'));
  }

  // Grounding display requirements: source links + the Search suggestions widget, unmodified.
  const links = entry.sources.filter((s) => /^https?:\/\//i.test(s.uri));
  if (links.length) {
    const ul = el('ul', '', 'sources');
    for (const s of links) {
      const a = el('a', s.title);
      a.href = s.uri;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const li = el('li');
      li.append(a);
      ul.append(li);
    }
    box.append(ul);
  }
  if (entry.searchEntryPointHtml) {
    const host = el('div');
    host.attachShadow({ mode: 'open' }).innerHTML = entry.searchEntryPointHtml;
    box.append(host);
  }
  return box;
}
