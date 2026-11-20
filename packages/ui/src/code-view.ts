/**
 * A code block with a marker gutter. Each line can show where it is in the
 * pipeline: 🟡 checking, 🔴 outdated, 🟢 ok, ⚪ unsure. Marked lines are
 * buttons, so they work with keyboard and screen readers.
 */
import type { CodeBlock } from '@ttm/core';
import { el } from './dom';

export type LineState = 'checking' | 'outdated' | 'ok' | 'unsure' | 'local' | 'skipped' | 'error';

export const MARKER: Record<LineState, { icon: string; label: string }> = {
  checking: { icon: '🟡', label: 'Checking this line…' },
  outdated: { icon: '🔴', label: 'Outdated. Click for the modern fix.' },
  ok: { icon: '🟢', label: 'Still current.' },
  unsure: { icon: '⚪', label: 'Could not tell. Click for details.' },
  local: { icon: '◦', label: 'Flagged on-device, but not sure enough to check in the cloud.' },
  skipped: { icon: '⏭', label: 'Not checked: the cloud budget for this page ran out.' },
  error: { icon: '⚠️', label: 'The check failed for this line. Click for details.' },
};

export class CodeView {
  readonly el: HTMLElement;
  private readonly rows: HTMLElement[] = [];
  private readonly status: HTMLElement;
  private selected: number | null = null;

  constructor(
    block: CodeBlock,
    private readonly onSelect: (lineNo: number) => void,
  ) {
    this.status = el('span', { class: 'ttm-code-status' });
    const head = el('div', { class: 'ttm-code-head' }, el('span', { text: block.language ?? 'code' }), this.status);
    const pre = el('pre', { class: 'ttm-code-body' });
    block.code.split('\n').forEach((text, i) => {
      const row = el(
        'div',
        { class: 'ttm-line' },
        el('span', { class: 'ttm-marker', attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'ttm-ln', text: String(i + 1) }),
        el('code', { text: text || ' ' }),
      );
      this.rows.push(row);
      pre.append(row);
    });
    this.el = el('figure', { class: 'ttm-code' }, head, pre);
  }

  setStatus(text: string, busy = false): void {
    this.status.textContent = text;
    this.el.classList.toggle('ttm-busy', busy);
  }

  setLine(lineNo: number, state: LineState | null): void {
    const row = this.rows[lineNo - 1];
    if (!row) return;
    const marker = row.querySelector<HTMLElement>('.ttm-marker')!;
    row.dataset.state = state ?? '';
    marker.textContent = state ? MARKER[state].icon : '';
    row.title = state ? MARKER[state].label : '';
    const interactive = state !== null && state !== 'checking' && state !== 'local';
    if (interactive) {
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Line ${lineNo}: ${MARKER[state].label}`);
      row.onclick = () => this.onSelect(lineNo);
      row.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.onSelect(lineNo);
        }
      };
      return;
    }
    row.removeAttribute('tabindex');
    row.removeAttribute('role');
    row.onclick = null;
    row.onkeydown = null;
    if (state) row.setAttribute('aria-label', `Line ${lineNo}: ${MARKER[state].label}`);
    else row.removeAttribute('aria-label');
  }

  select(lineNo: number | null): void {
    if (this.selected) this.rows[this.selected - 1]?.classList.remove('ttm-selected');
    this.selected = lineNo;
    if (!lineNo) return;
    const row = this.rows[lineNo - 1];
    row?.classList.add('ttm-selected');
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  reset(): void {
    this.rows.forEach((_, i) => this.setLine(i + 1, null));
    this.select(null);
    this.setStatus('');
  }
}
