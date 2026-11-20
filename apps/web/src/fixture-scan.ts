/**
 * Milestone 2 test panel: runs the real scan step (scanPage) on a demo
 * fixture and shows what was flagged and which lines would be sent on to the
 * cloud verifier. Everything is rendered as text.
 */
import {
  scanPage,
  selectLinesToVerify,
  SURE_CONFIDENCE,
  type CodeBlock,
  type GenerativeModel,
  type RuntimeSettings,
  type ScanResult,
} from '@ttm/core';

// Bundled at build time, so the hosted app needs no extra requests.
const FIXTURES = import.meta.glob<string>('../../../fixtures/*.html', { query: '?raw', import: 'default', eager: true });

function readFixture(html: string): { title: string; blocks: CodeBlock[] } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = [...doc.querySelectorAll('pre > code')].map((el) => ({
    language: /language-([\w-]+)/.exec(el.className)?.[1],
    code: el.textContent ?? '',
  }));
  return { title: doc.title, blocks };
}

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
  onError: (title: string, err: unknown) => void,
) {
  const select = el('select');
  for (const path of Object.keys(FIXTURES).sort()) {
    const name = path.split('/').pop() ?? path;
    select.append(new Option(name.replace('.html', ''), path));
  }
  const button = el('button', '⚡ Scan fixture');
  const summary = el('p', '', 'muted');
  const out = el('div');
  const controls = el('div', '', 'row');
  controls.append(select, button);
  root.append(controls, summary, out);

  button.addEventListener('click', async () => {
    button.disabled = true;
    out.replaceChildren();
    const { title, blocks } = readFixture(FIXTURES[select.value] ?? '');
    const settings = getSettings();
    summary.textContent = `Scanning ${blocks.length} code blocks…`;
    const t0 = performance.now();
    try {
      const page = await scanPage(getModel(), blocks, { title }, settings);
      const ms = performance.now() - t0;

      // Page-level hybrid routing: which flagged lines would go to the cloud.
      const allFlagged = page.blocks.flatMap((r) => r.flagged);
      const toVerify = selectLinesToVerify(allFlagged, settings);
      summary.textContent =
        `${page.linesScanned} lines scanned ${page.servedBy === 'on-device' ? '⚡ on-device' : '☁️ in the cloud'} ` +
        `in ${page.prompts} prompt(s), ${Math.round(ms)} ms · ${allFlagged.length} flagged · ` +
        `${toVerify.length} would be sent to the cloud (confidence ≥ ${settings.minConfidenceToVerify}, max ${settings.maxCloudCallsPerPage})` +
        (page.failedChunks ? ` · ⚠️ ${page.failedChunks} chunk(s) unparseable` : '');

      if (toVerify.length) {
        const list = el('ol', '', 'verify-list');
        for (const f of toVerify) list.append(el('li', `[${f.library ?? '?'}] ${f.code.trim()}  (${level(f.confidence)})`));
        out.append(el('h3', 'Would verify in the cloud'), list);
      }
      page.blocks.forEach((r, i) => out.append(renderBlock(i + 1, blocks[i]!, r)));
    } catch (err) {
      summary.textContent = '';
      onError('Fixture scan failed', err);
    }
    button.disabled = false;
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
