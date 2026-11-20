/**
 * The savings meter: how much of the work never needed the cloud.
 * "51 lines scanned on device · 2 sent to cloud · 11 served from cache"
 */
import type { ServedBy, VerifyStats } from '@ttm/core';
import { el } from './dom';

export interface MeterData {
  linesScanned: number;
  scanServedBy: ServedBy;
  stats: Pick<VerifyStats, 'sentToCloud' | 'cloudCalls' | 'groundedCalls' | 'fromCache' | 'skipped'>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function renderSavingsMeter({ linesScanned, scanServedBy, stats }: MeterData): HTMLElement {
  const onDevice = scanServedBy === 'on-device';
  const stayedLocal = onDevice ? Math.max(0, linesScanned - stats.sentToCloud) : 0;
  const pct = linesScanned ? Math.round((stayedLocal / linesScanned) * 100) : 0;

  const stat = (cls: string, icon: string, value: number, label: string, hint: string) =>
    el('div', { class: `ttm-stat ${cls}`, title: hint }, el('span', { class: 'ttm-stat-value', text: `${icon} ${value}` }), el('span', { class: 'ttm-stat-label', text: label }));

  const sentences = [
    `${plural(linesScanned, 'line')} scanned ${onDevice ? 'on device' : 'in the cloud (Gemini Nano unavailable)'}`,
    `${stats.sentToCloud} sent to cloud`,
    `${stats.fromCache} served from cache`,
  ];
  if (stats.skipped) sentences.push(`${stats.skipped} over budget`);

  const bar = el('div', { class: 'ttm-bar', attrs: { role: 'img', 'aria-label': `${pct}% of lines never left your device` } }, el('span', { class: 'ttm-bar-fill' }));
  (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;

  return el(
    'section',
    { class: 'ttm-meter', attrs: { 'aria-label': 'Savings meter' } },
    el(
      'div',
      { class: 'ttm-stats' },
      stat('ttm-path-on-device', onDevice ? '⚡' : '☁️', linesScanned, onDevice ? 'scanned on device' : 'scanned in cloud', 'Step 1: every line, read by Gemini Nano in your browser.'),
      stat('ttm-path-cache', '📦', stats.fromCache, 'from cache', 'Step 2: lines an earlier reader already had verified. No model call.'),
      stat(
        'ttm-path-cloud',
        '☁️',
        stats.sentToCloud,
        `sent to cloud · ${plural(stats.cloudCalls, 'request')}`,
        `Step 3: flagged, uncached lines checked by Gemini${stats.groundedCalls ? ' with Google Search' : ''}.`,
      ),
    ),
    bar,
    el('p', { class: 'ttm-meter-caption', text: onDevice ? `${pct}% of lines never left your device · ${sentences.join(' · ')}` : sentences.join(' · ') }),
  );
}
