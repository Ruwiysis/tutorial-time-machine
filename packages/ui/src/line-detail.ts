/**
 * The detail card for one checked line: old vs modern code, why, sources,
 * the Google Search suggestions widget and a "Copy fix" button.
 *
 * Grounding display rules (Gemini API terms): show the source links, and show
 * searchEntryPoint.renderedContent unmodified. It goes in a shadow root so the
 * page's CSS and the widget's CSS can't affect each other.
 */
import type { LineOutcome } from '@ttm/core';
import { pathBadge, statusBadge } from './badges';
import { el, safeLink } from './dom';

export function renderLineDetail(code: string, outcome: LineOutcome, where?: string): HTMLElement {
  const card = el('article', { class: 'ttm-detail' });

  if (outcome.status === 'skipped' || outcome.status === 'error') {
    const label = outcome.status === 'skipped' ? '⏭ Not checked' : '⚠️ Check failed';
    card.append(
      el('div', { class: 'ttm-detail-head' }, el('span', { class: 'ttm-badge ttm-status-error', text: label }), where && el('span', { class: 'ttm-muted', text: where })),
      el('pre', { class: 'ttm-diff ttm-old', text: code.trim() }),
      el('p', { class: 'ttm-muted', text: outcome.reason }),
    );
    return card;
  }

  const { entry, servedBy } = outcome;
  card.append(
    el(
      'div',
      { class: 'ttm-detail-head' },
      statusBadge(entry.status),
      pathBadge(servedBy, { grounded: entry.grounded }),
      el('span', { class: 'ttm-muted', text: [entry.library, where].filter(Boolean).join(' · ') }),
    ),
  );

  const diff = el('div', { class: 'ttm-diff-wrap' }, el('pre', { class: 'ttm-diff ttm-old', text: code.trim(), attrs: { 'aria-label': 'Tutorial code' } }));
  if (entry.modernCode) diff.append(el('pre', { class: 'ttm-diff ttm-new', text: entry.modernCode, attrs: { 'aria-label': 'Modern code' } }));
  card.append(diff);

  if (entry.explanation) card.append(el('p', { class: 'ttm-why', text: entry.explanation }));

  if (entry.modernCode) {
    const copy = el('button', { class: 'ttm-btn', text: '📋 Copy fix' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(entry.modernCode);
        copy.textContent = '✓ Copied';
      } catch {
        copy.textContent = 'Copy failed: select the code above';
      }
      setTimeout(() => (copy.textContent = '📋 Copy fix'), 2000);
    });
    card.append(el('div', { class: 'ttm-actions' }, copy));
  }

  if (!entry.grounded) {
    card.append(
      el('p', {
        class: 'ttm-note',
        text: 'Checked without Google Search (grounding was unavailable), so this answer comes from the model’s own knowledge and may be out of date.',
      }),
    );
  }

  const links = entry.sources.map((s) => safeLink(s.uri, s.title)).filter((a): a is HTMLAnchorElement => a !== null);
  if (links.length) {
    card.append(el('p', { class: 'ttm-sources-title', text: 'Sources' }), el('ul', { class: 'ttm-sources' }, ...links.map((a) => el('li', {}, a))));
  }
  if (entry.searchEntryPointHtml) {
    const host = el('div', { class: 'ttm-search-widget' });
    host.attachShadow({ mode: 'open' }).innerHTML = entry.searchEntryPointHtml;
    card.append(host);
  }
  return card;
}
