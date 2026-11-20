/**
 * The three paths of the hybrid pipeline, as badges. Every result in the UI
 * carries one, so it's always visible which path served it.
 */
import type { ServedBy, VerifyStatus } from '@ttm/core';
import { el } from './dom';

export const PATH = {
  'on-device': { icon: '⚡', label: 'On-device', hint: 'Gemini Nano in your browser. Free, instant, private.' },
  cloud: { icon: '☁️', label: 'Cloud', hint: 'Gemini in the cloud via Firebase AI Logic.' },
  cache: { icon: '📦', label: 'Cache', hint: 'Already verified for an earlier reader (Firestore).' },
} as const satisfies Record<ServedBy, { icon: string; label: string; hint: string }>;

export function pathBadge(servedBy: ServedBy, opts: { grounded?: boolean } = {}): HTMLElement {
  const p = PATH[servedBy];
  let label = `${p.icon} ${p.label}`;
  let hint: string = p.hint;
  if (servedBy !== 'on-device' && opts.grounded === true) label += ' + Google Search';
  if (servedBy !== 'on-device' && opts.grounded === false) {
    label += ' · no Search';
    hint += ' Answered without Google Search (unavailable), so it may be out of date.';
  }
  const cls = `ttm-badge ttm-path-${servedBy}${opts.grounded === false ? ' ttm-unverified' : ''}`;
  return el('span', { class: cls, text: label, title: hint });
}

export const STATUS = {
  outdated: { icon: '🔴', label: 'Outdated' },
  ok: { icon: '🟢', label: 'Still current' },
  unsure: { icon: '⚪', label: 'Unsure' },
} as const satisfies Record<VerifyStatus, { icon: string; label: string }>;

export function statusBadge(status: VerifyStatus): HTMLElement {
  const s = STATUS[status];
  return el('span', { class: `ttm-badge ttm-status-${status}`, text: `${s.icon} ${s.label}` });
}
