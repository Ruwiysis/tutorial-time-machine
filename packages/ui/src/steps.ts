/**
 * The hybrid pipeline as three live steps. Makes the routing visible:
 * which step is running, which path served it, and why each step runs where
 * it does.
 */
import { el } from './dom';

export type StepId = 'scan' | 'cache' | 'cloud';
export type StepState = 'idle' | 'active' | 'done' | 'skipped' | 'error';

const STEPS: Record<StepId, { icon: string; title: string; why: string }> = {
  scan: {
    icon: '⚡',
    title: 'Scan on-device',
    why: 'Gemini Nano reads every code block in your browser: free, instant, and the page never leaves your machine.',
  },
  cache: {
    icon: '📦',
    title: 'Shared cache',
    why: 'Lines another reader already had verified come straight from Firestore, with no model call.',
  },
  cloud: {
    icon: '☁️',
    title: 'Verify in the cloud',
    why: 'Only flagged, uncached lines go to Gemini with Google Search, because Nano’s knowledge is frozen and APIs keep changing.',
  },
};

export class HybridSteps {
  readonly el: HTMLElement;
  private readonly items = new Map<StepId, { root: HTMLElement; detail: HTMLElement }>();

  constructor() {
    this.el = el('ol', { class: 'ttm-steps', attrs: { 'aria-label': 'How the check works' } });
    (Object.keys(STEPS) as StepId[]).forEach((id, i) => {
      const s = STEPS[id];
      const detail = el('span', { class: 'ttm-step-detail' });
      const root = el(
        'li',
        { class: 'ttm-step', attrs: { 'data-state': 'idle' } },
        el('span', { class: 'ttm-step-num', text: String(i + 1), attrs: { 'aria-hidden': 'true' } }),
        el('div', {}, el('strong', { text: `${s.icon} ${s.title}` }), el('p', { class: 'ttm-step-why', text: s.why }), detail),
      );
      this.items.set(id, { root, detail });
      this.el.append(root);
    });
  }

  set(id: StepId, state: StepState, detail = ''): void {
    const item = this.items.get(id);
    if (!item) return;
    item.root.dataset.state = state;
    item.detail.textContent = detail;
  }

  /** Marks whichever step is running as failed. */
  failActive(detail = 'Failed'): void {
    for (const [id, item] of this.items) if (item.root.dataset.state === 'active') this.set(id, 'error', detail);
  }

  reset(): void {
    for (const id of this.items.keys()) this.set(id, 'idle');
  }
}
