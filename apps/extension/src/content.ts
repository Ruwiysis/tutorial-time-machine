/**
 * Content script: runs in every tutorial page.
 *
 * It only reads code blocks and draws markers. It never calls an AI model or
 * Firebase: the side panel (an extension page) does that and sends verdicts
 * back here. Markers live in a shadow root so the page's CSS can't break them
 * and ours can't leak into the page.
 */
import uiCss from '@ttm/ui/src/ui.css?inline';
import { renderLineDetail } from '@ttm/ui';
import type { LineOutcome } from '@ttm/core';
import { findCodeBlocks, lineRect, type FoundBlock } from './extract';
import type { MarkerState, PageSnapshot, ToContent, ToPanel } from './messages';

const ICON: Record<MarkerState, string> = { checking: '🟡', outdated: '🔴', ok: '🟢', unsure: '⚪', skipped: '⏭', error: '⚠️' };
const LABEL: Record<MarkerState, string> = {
  checking: 'Tutorial Time-Machine is checking this line…',
  outdated: 'Outdated code. Click for the modern fix.',
  ok: 'Still current.',
  unsure: 'Could not tell. Click for details.',
  skipped: 'Not checked (cloud budget for this page used up).',
  error: 'The check failed for this line.',
};

const OVERLAY_CSS = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
.bar { position: fixed; pointer-events: none; border-left: 3px solid transparent; border-radius: 2px; }
.bar[data-state='checking'] { background: color-mix(in srgb, var(--ttm-warn) 14%, transparent); border-color: var(--ttm-warn); }
.bar[data-state='outdated'] { background: color-mix(in srgb, var(--ttm-err) 16%, transparent); border-color: var(--ttm-err); }
.bar[data-state='ok'] { background: color-mix(in srgb, var(--ttm-ok) 10%, transparent); border-color: var(--ttm-ok); }
.mk {
  position: fixed; width: 20px; height: 20px; padding: 0; display: grid; place-items: center;
  font: 11px/1 system-ui, sans-serif; border-radius: 50%; cursor: pointer; pointer-events: auto;
  background: var(--ttm-surface); border: 1px solid var(--ttm-border); box-shadow: 0 1px 4px rgb(0 0 0 / 0.25);
}
.mk[data-state='checking'] { cursor: default; animation: pulse 1s ease-in-out infinite; }
.mk:focus-visible { outline: 2px solid var(--ttm-accent); outline-offset: 2px; }
@keyframes pulse { 50% { opacity: 0.4; } }
.pop {
  position: fixed; width: min(440px, calc(100vw - 24px)); max-height: min(72vh, 600px); overflow: auto;
  pointer-events: auto; color: var(--ttm-fg); font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
  border-radius: 12px; box-shadow: 0 12px 32px rgb(0 0 0 / 0.28);
}
.pop .ttm-detail { margin: 0; border-radius: 12px 12px 0 0; }
.pop-foot { display: flex; justify-content: space-between; gap: 8px; padding: 8px 12px; background: var(--ttm-surface-2); border: 1px solid var(--ttm-border); border-top: 0; border-radius: 0 0 12px 12px; }
.pop-brand { font-size: 12px; color: var(--ttm-muted); align-self: center; }
.pop-foot .ttm-btn { padding: 6px 10px; font-size: 12px; }
@media (prefers-reduced-motion: reduce) { .mk[data-state='checking'] { animation: none; } }
`;

interface Mark {
  block: number;
  lineNo: number;
  state: MarkerState;
  code: string;
  outcome?: LineOutcome;
  marker: HTMLButtonElement;
  bar: HTMLElement;
}

let blocks: FoundBlock[] = [];
const marks = new Map<string, Mark>();
let layer: HTMLElement | undefined;
let pop: HTMLElement | undefined;
let openId: string | undefined;

function ensureLayer(): HTMLElement {
  if (layer) return layer;
  const host = document.createElement('div');
  host.id = 'ttm-overlay-host';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  // The shared UI tokens are written for :root; inside a shadow root they belong on :host.
  style.textContent = uiCss.replace(/:root/g, ':host') + OVERLAY_CSS;
  layer = document.createElement('div');
  layer.className = 'layer';
  root.append(style, layer);
  document.documentElement.append(host);
  return layer;
}

function snapshot(): PageSnapshot {
  blocks = findCodeBlocks();
  return { url: location.href, title: document.title, blocks: blocks.map((b) => ({ code: b.code, language: b.language })) };
}

function clearMarks() {
  for (const m of marks.values()) {
    m.marker.remove();
    m.bar.remove();
  }
  marks.clear();
  closePopover();
}

function upsertMark(id: string, state: MarkerState, code: string, outcome?: LineOutcome) {
  const [block, lineNo] = id.split(':').map(Number) as [number, number];
  if (!blocks[block]) return;
  let m = marks.get(id);
  if (!m) {
    const marker = document.createElement('button');
    marker.className = 'mk';
    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      if (marks.get(id)?.state !== 'checking') togglePopover(id);
    });
    const bar = document.createElement('div');
    bar.className = 'bar';
    ensureLayer().append(bar, marker);
    m = { block, lineNo, state, code, marker, bar };
    marks.set(id, m);
  }
  Object.assign(m, { state, code, outcome });
  m.marker.dataset.state = m.bar.dataset.state = state;
  m.marker.textContent = ICON[state];
  m.marker.title = LABEL[state];
  m.marker.setAttribute('aria-label', `Line ${lineNo}: ${LABEL[state]}`);
  if (openId === id) renderPopover(id);
}

// ── Layout: markers follow their lines through scrolling and reflow ─────────

let frame = 0;
function scheduleLayout() {
  if (!frame) frame = requestAnimationFrame(layout);
}

function layout() {
  frame = 0;
  for (const m of marks.values()) {
    const block = blocks[m.block];
    const rect = block && lineRect(block, m.lineNo);
    const box = block?.box.getBoundingClientRect();
    // Hide when the line isn't rendered or is scrolled out of its code box.
    const visible = rect && box && rect.top >= box.top - 2 && rect.bottom <= box.bottom + 2 && rect.height > 0;
    m.marker.hidden = m.bar.hidden = !visible;
    if (!visible || !rect || !box) continue;
    const left = box.left >= 26 ? box.left - 24 : box.left + 2;
    m.marker.style.left = `${left}px`;
    m.marker.style.top = `${rect.top + rect.height / 2 - 10}px`;
    Object.assign(m.bar.style, { left: `${box.left}px`, width: `${box.width}px`, top: `${rect.top - 1}px`, height: `${rect.height + 2}px` });
  }
  if (openId) positionPopover();
}

addEventListener('scroll', scheduleLayout, { capture: true, passive: true });
addEventListener('resize', scheduleLayout, { passive: true });
setInterval(() => marks.size && scheduleLayout(), 1000); // catches late layout shifts (images, fonts)

// ── Popover with the fix ────────────────────────────────────────────────────

function closePopover() {
  pop?.remove();
  pop = undefined;
  openId = undefined;
}

function togglePopover(id: string) {
  if (openId === id) return closePopover();
  openId = id;
  renderPopover(id);
}

function renderPopover(id: string) {
  const m = marks.get(id);
  if (!m?.outcome) return;
  pop?.remove();
  pop = document.createElement('div');
  pop.className = 'pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Tutorial Time-Machine: fix for this line');
  const where = blocks.length > 1 ? `block ${m.block + 1}, line ${m.lineNo}` : `line ${m.lineNo}`;
  const foot = document.createElement('div');
  foot.className = 'pop-foot';
  const brand = document.createElement('span');
  brand.className = 'pop-brand';
  brand.textContent = '⏳ Tutorial Time-Machine';
  const open = document.createElement('button');
  open.className = 'ttm-btn';
  open.textContent = 'Open in side panel';
  open.addEventListener('click', () => {
    const msg: ToPanel = { type: 'ttm:select', id, url: location.href };
    void chrome.runtime.sendMessage(msg).catch(() => {});
  });
  foot.append(brand, open);
  pop.append(renderLineDetail(m.code, m.outcome, where), foot);
  pop.addEventListener('click', (e) => e.stopPropagation());
  ensureLayer().append(pop);
  positionPopover();
}

function positionPopover() {
  const m = openId ? marks.get(openId) : undefined;
  if (!pop || !m) return;
  if (m.marker.hidden) {
    pop.hidden = true;
    return;
  }
  pop.hidden = false;
  const r = m.marker.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(12, Math.min(innerWidth - w - 12, r.left));
  const below = r.bottom + 8;
  const top = below + h <= innerHeight - 12 ? below : Math.max(12, r.top - h - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

addEventListener('click', () => openId && closePopover());
addEventListener('keydown', (e) => e.key === 'Escape' && openId && closePopover());

// ── Messages from the side panel ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ToContent, _sender, reply) => {
  switch (msg.type) {
    case 'ttm:get-page':
      clearMarks();
      reply(snapshot());
      return;
    case 'ttm:reset':
      clearMarks();
      return;
    case 'ttm:marks':
      for (const mk of msg.marks) upsertMark(mk.id, mk.state, mk.code, mk.outcome);
      scheduleLayout();
      return;
    case 'ttm:focus': {
      const m = marks.get(msg.id);
      const block = m && blocks[m.block];
      if (!m || !block) return;
      const rect = lineRect(block, m.lineNo);
      if (rect) scrollBy({ top: rect.top - innerHeight / 3, behavior: 'smooth' });
      setTimeout(() => {
        openId = msg.id;
        renderPopover(msg.id);
        scheduleLayout();
      }, 350);
      return;
    }
  }
});
