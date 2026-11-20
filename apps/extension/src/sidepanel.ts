/**
 * Side panel: the only place the extension runs AI.
 *
 * It follows the active tab, asks the content script for the page's code
 * blocks, runs the hybrid pipeline (⚡ on-device scan → 📦 cache → ☁️ cloud +
 * Google Search) and sends each verdict back so the page shows markers.
 * Running here, in an extension page, is deliberate: MV3 service workers can
 * be stopped at any time, and content scripts run in the page's world.
 */
import '@ttm/ui/src/ui.css';
import './sidepanel.css';
import {
  checkPage,
  createScanModel,
  createVerifyModel,
  getDeviceModelStatus,
  initTtm,
  isQuotaError,
  SCAN_SCHEMA,
  type DeviceModelStatus,
  type GenerativeModel,
  type LineOutcome,
  type PageCheckResult,
  type TtmServices,
  type VerifyModels,
} from '@ttm/core';
import { el, HybridSteps, pathBadge, renderLineDetail, renderSavingsMeter, STATUS } from '@ttm/ui';
import { readEnvConfig } from './env';
import { EMPTY_TOTALS, STORAGE, type MarkerState, type PageSnapshot, type ToContent, type ToPanel, type Totals } from './messages';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let services: TtmServices | undefined;
let deviceStatus: DeviceModelStatus = 'unsupported';
let scanModel: GenerativeModel | undefined;
let verifyModels: VerifyModels | undefined;
let enabled = true;

interface TabCheck {
  tabId: number;
  snapshot: PageSnapshot;
  result?: PageCheckResult;
  error?: string;
  running: boolean;
}
/** Latest check per tab, so switching tabs back and forth doesn't re-run anything. */
const checks = new Map<number, TabCheck>();
let activeTabId: number | undefined;
let selectedId: string | undefined;
let busy = false;

const steps = new HybridSteps();
$('steps').append(steps.el);

// ── Talking to the page ─────────────────────────────────────────────────────

function send(tabId: number, msg: ToContent): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => undefined);
}

const MARK_STATE: Record<LineOutcome['status'], MarkerState> = { outdated: 'outdated', ok: 'ok', unsure: 'unsure', skipped: 'skipped', error: 'error' };

function lineCode(snapshot: PageSnapshot, id: string): string {
  const [b, n] = id.split(':').map(Number);
  return snapshot.blocks[b!]?.code.split('\n')[n! - 1] ?? '';
}

function sendOutcomes(check: TabCheck, outcomes: Iterable<LineOutcome>) {
  const marks = [...outcomes].map((o) => ({ id: o.id, state: MARK_STATE[o.status], code: lineCode(check.snapshot, o.id), outcome: o }));
  if (marks.length) void send(check.tabId, { type: 'ttm:marks', marks });
}

// ── Following the active tab ────────────────────────────────────────────────

async function refresh(force = false) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  activeTabId = tab.id;
  selectedId = undefined;

  const snapshot = (await chrome.tabs.sendMessage(tab.id, { type: 'ttm:get-page' } satisfies ToContent).catch(() => null)) as PageSnapshot | null;
  if (!snapshot) {
    checks.delete(tab.id);
    return renderUnreachable(tab.id);
  }

  const previous = checks.get(tab.id);
  const same = previous && previous.snapshot.url === snapshot.url && sameBlocks(previous.snapshot, snapshot);
  // While paused, pages stay unmarked unless the user asks ("Check this page").
  if (same && !force && (previous.result || previous.running) && (enabled || previous.running)) {
    previous.snapshot = snapshot;
    if (previous.result) sendOutcomes(previous, previous.result.outcomes.values()); // get-page cleared the markers
    return render(previous);
  }

  const check: TabCheck = { tabId: tab.id, snapshot, running: false };
  checks.set(tab.id, check);
  if (!snapshot.blocks.length || !enabled || !services) return render(check);
  await run(check);
}

function sameBlocks(a: PageSnapshot, b: PageSnapshot): boolean {
  return a.blocks.length === b.blocks.length && a.blocks.every((x, i) => x.code === b.blocks[i]!.code);
}

// ── Running the pipeline ────────────────────────────────────────────────────

async function run(check: TabCheck) {
  if (!services || !scanModel || !verifyModels) return;
  if (busy) return; // one check at a time; the next refresh picks this tab up again
  busy = true;
  check.running = true;
  check.result = undefined;
  check.error = undefined;
  render(check);
  const onDevice = deviceStatus === 'available';
  steps.reset();
  steps.set('scan', 'active', onDevice ? 'Gemini Nano is reading the code…' : 'Reading the code in the cloud…');
  const t0 = performance.now();
  const isActive = () => activeTabId === check.tabId;

  try {
    check.result = await checkPage(
      { scanModel, verify: { db: services.db, uid: services.user.uid, models: verifyModels, settings: services.settings }, settings: services.settings },
      check.snapshot.blocks,
      { title: check.snapshot.title },
      {
        onScanned(page, toVerify) {
          // Yellow markers while the cache and the cloud are consulted.
          const marks = toVerify.map((id) => ({ id, state: 'checking' as const, code: lineCode(check.snapshot, id) }));
          if (marks.length) void send(check.tabId, { type: 'ttm:marks', marks });
          if (!isActive()) return;
          const flagged = page.blocks.reduce((n, b) => n + b.flagged.length, 0);
          const where = page.servedBy === 'on-device' ? '⚡ on-device' : '☁️ in the cloud';
          steps.set('scan', 'done', `${page.linesScanned} lines ${where} in ${secs(performance.now() - t0)} · ${flagged} flagged`);
          if (toVerify.length) steps.set('cache', 'active', `Looking up ${plural(toVerify.length, 'line')}…`);
          else {
            steps.set('cache', 'skipped', 'Nothing to look up');
            steps.set('cloud', 'skipped', 'Not needed');
          }
        },
        onVerifyProgress(p) {
          if (!isActive() || p.phase !== 'cloud' || !p.total) return;
          steps.set('cache', 'done');
          steps.set('cloud', 'active', `Request ${Math.min(p.done + 1, p.total)} of ${p.total}…`);
        },
        onLine(o) {
          sendOutcomes(check, [o]);
        },
      },
    );
    await addTotals(check.result);
  } catch (err) {
    console.error('[ttm] check failed', err);
    check.error = friendlyMessage(err);
    if (isActive()) steps.failActive();
    void send(check.tabId, { type: 'ttm:reset' });
  } finally {
    check.running = false;
    busy = false;
  }
  if (isActive()) render(check);
  else void refresh(); // the user moved on while we were busy
}

// ── Rendering ───────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function clearResults() {
  $('meter').replaceChildren();
  $('summary').replaceChildren();
  $('detail').replaceChildren();
  $('results').replaceChildren();
}

function renderPage(snapshot: PageSnapshot, line: string) {
  $('page').replaceChildren(el('p', { class: 'sp-title', text: snapshot.title || 'Untitled page' }), el('p', { class: 'ttm-muted', text: `${hostOf(snapshot.url)} · ${line}` }));
}

function renderUnreachable(tabId: number) {
  clearResults();
  steps.reset();
  $('btn-rerun').hidden = true;
  const reload = el('button', { class: 'ttm-btn', text: '↻ Reload this page' });
  reload.addEventListener('click', () => void chrome.tabs.reload(tabId));
  $('page').replaceChildren(
    el('p', { class: 'sp-title', text: 'This page can’t be checked' }),
    el('p', { class: 'ttm-muted', text: 'Browser pages (chrome://, the Web Store) are off limits. If this is a normal page that was open before the extension was installed, reload it. For local files, turn on “Allow access to file URLs” in chrome://extensions.' }),
    reload,
  );
}

function render(check: TabCheck) {
  if (check.tabId !== activeTabId) return;
  const { snapshot, result } = check;
  $('btn-rerun').hidden = check.running || !snapshot.blocks.length || !services;
  clearResults();

  if (!snapshot.blocks.length) {
    steps.reset();
    renderPage(snapshot, 'no code blocks');
    return setSummary(el('div', { class: 'sp-empty' }, el('p', { class: 'sp-empty-title', text: 'No code on this page' }), el('p', { class: 'ttm-muted', text: 'Open a coding tutorial, blog post or Q&A answer with code blocks, and it’s checked automatically.' })));
  }
  renderPage(snapshot, plural(snapshot.blocks.length, 'code block'));

  if (!enabled && !result && !check.running) {
    steps.reset();
    const btn = el('button', { class: 'ttm-btn ttm-btn-primary', text: 'Check this page' });
    btn.addEventListener('click', () => void run(check));
    return setSummary(el('div', { class: 'sp-empty' }, el('p', { class: 'sp-empty-title', text: 'Automatic checks are paused' }), el('p', { class: 'ttm-muted', text: 'Turn them back on in the toolbar popup, or check just this page.' }), btn));
  }
  if (check.running) return setSummary(el('p', { class: 'ttm-muted', text: 'Checking this page…' }));
  if (check.error) return setSummary(el('p', { class: 'sp-error', text: check.error }));
  if (!result) return;

  renderSteps(result);
  $('meter').replaceChildren(renderSavingsMeter({ linesScanned: result.page.linesScanned, scanServedBy: result.scanServedBy, stats: result.stats }));

  const outcomes = [...result.outcomes.values()].sort((a, b) => compareIds(a.id, b.id));
  if (!outcomes.length) {
    return setSummary(el('div', { class: 'sp-empty' }, el('p', { class: 'sp-empty-title', text: '🟢 No outdated code found' }), el('p', { class: 'ttm-muted', text: 'Gemini Nano didn’t flag any version-sensitive library calls here, so nothing went to the cloud.' })));
  }
  const count = (s: LineOutcome['status']) => outcomes.filter((o) => o.status === s).length;
  const failed = count('error') + count('skipped');
  setSummary(
    el(
      'p',
      { class: 'sp-counts' },
      [count('outdated') && `${STATUS.outdated.icon} ${count('outdated')} outdated`, count('ok') && `${STATUS.ok.icon} ${count('ok')} current`, count('unsure') && `${STATUS.unsure.icon} ${count('unsure')} unsure`, failed && `⚠️ ${failed} not checked`]
        .filter(Boolean)
        .join(' · '),
    ),
  );
  const firstError = outcomes.find((o) => o.status === 'error');
  if (firstError?.status === 'error') $('summary').append(el('p', { class: 'sp-error', text: friendlyMessage(firstError.reason) }));

  $('results').replaceChildren(
    ...outcomes.map((o) => {
      const icon = o.status === 'skipped' || o.status === 'error' ? '⚠️' : STATUS[o.status].icon;
      const item = el(
        'button',
        { class: 'sp-item', attrs: { type: 'button', 'data-id': o.id } },
        el('span', { text: icon, attrs: { 'aria-hidden': 'true' } }),
        el('code', { text: lineCode(snapshot, o.id).trim() }),
        o.status !== 'skipped' && o.status !== 'error' ? pathBadge(o.servedBy, { grounded: o.entry.grounded }) : null,
      );
      item.addEventListener('click', () => select(o.id, true));
      return el('li', {}, item);
    }),
  );
  const first = selectedId && result.outcomes.has(selectedId) ? selectedId : (outcomes.find((o) => o.status === 'outdated') ?? outcomes[0])?.id;
  if (first) select(first, false);
}

function renderSteps(result: PageCheckResult) {
  const { stats, page } = result;
  const flagged = page.blocks.reduce((n, b) => n + b.flagged.length, 0);
  steps.set('scan', 'done', `${page.linesScanned} lines ${result.scanServedBy === 'on-device' ? '⚡ on-device' : '☁️ in the cloud'} in ${secs(result.timings.scanMs)} · ${flagged} flagged`);
  const looked = stats.unique + (stats.recalled ?? 0);
  if (!looked) {
    steps.set('cache', 'skipped', 'Nothing to look up');
    steps.set('cloud', 'skipped', 'Not needed');
    return;
  }
  steps.set('cache', 'done', `${stats.fromCache} of ${plural(looked, 'line')} found in the cache`);
  const all = [...result.outcomes.values()];
  const tried = all.filter((o) => o.status === 'error' || (o.status !== 'skipped' && o.servedBy === 'cloud'));
  const failed = tried.filter((o) => o.status === 'error').length;
  if (stats.cloudCalls && failed && failed === tried.length) steps.set('cloud', 'error', `All ${plural(stats.cloudCalls, 'request')} failed`);
  else if (stats.cloudCalls) {
    steps.set('cloud', 'done', `${plural(stats.sentToCloud, 'line')} in ${plural(stats.cloudCalls, 'request')}${stats.groundedCalls ? ' with Google Search' : ' (no Search available)'} · ${secs(result.timings.verifyMs)}`);
  } else steps.set('cloud', 'skipped', stats.skipped ? 'Budget used up' : 'Not needed: all from the cache');
}

function select(id: string, focusPage: boolean) {
  const check = activeTabId !== undefined ? checks.get(activeTabId) : undefined;
  const outcome = check?.result?.outcomes.get(id);
  if (!check || !outcome) return;
  selectedId = id;
  const [b, n] = id.split(':').map(Number);
  const where = check.snapshot.blocks.length > 1 ? `block ${b! + 1}, line ${n}` : `line ${n}`;
  $('detail').replaceChildren(renderLineDetail(lineCode(check.snapshot, id), outcome, where));
  document.querySelectorAll<HTMLElement>('.sp-item').forEach((i) => i.classList.toggle('active', i.dataset.id === id));
  if (focusPage) void send(check.tabId, { type: 'ttm:focus', id });
}

function setSummary(node: HTMLElement) {
  $('summary').replaceChildren(node);
}

function compareIds(a: string, b: string): number {
  const [ab, an] = a.split(':').map(Number);
  const [bb, bn] = b.split(':').map(Number);
  return ab! - bb! || an! - bn!;
}

function friendlyMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (isQuotaError(err) || /\b429\b|quota|RESOURCE_EXHAUSTED/i.test(msg)) return 'The free Gemini quota is used up for now. Try again in a minute; lines someone already checked still come from the cache.';
  if (/app.?check|attestation/i.test(msg)) return 'The cloud step was blocked by Firebase App Check. Is the extension’s debug token registered in the Firebase console?';
  return `The cloud check failed: ${msg}`;
}

function banner(kind: 'info' | 'warn' | 'error', text: string, ...extra: HTMLElement[]) {
  const b = $('banner');
  b.className = `sp-banner sp-banner-${kind}`;
  b.replaceChildren(el('p', { text }), ...extra);
  b.hidden = false;
}

// ── Lifetime totals (shown in the popup) ────────────────────────────────────

async function addTotals(r: PageCheckResult) {
  const stored = (await chrome.storage.local.get(STORAGE.totals))[STORAGE.totals] as Totals | undefined;
  const t = { ...EMPTY_TOTALS, ...stored };
  await chrome.storage.local.set({
    [STORAGE.totals]: {
      pages: t.pages + 1,
      linesScanned: t.linesScanned + r.page.linesScanned,
      sentToCloud: t.sentToCloud + r.stats.sentToCloud,
      fromCache: t.fromCache + r.stats.fromCache,
    } satisfies Totals,
  });
}

// ── On-device model ─────────────────────────────────────────────────────────

function buildModels() {
  if (!services) return;
  scanModel = createScanModel(services.ai, services.settings, { deviceStatus, responseSchema: SCAN_SCHEMA });
  verifyModels = {
    grounded: createVerifyModel(services.ai, services.settings),
    ungrounded: createVerifyModel(services.ai, services.settings, undefined, { grounded: false }),
  };
}

async function refreshDevice() {
  deviceStatus = await getDeviceModelStatus();
  buildModels();
  if (deviceStatus === 'available') return ($('banner').hidden = true);
  if (deviceStatus === 'downloadable') {
    const btn = el('button', { class: 'ttm-btn ttm-btn-primary', text: '⬇️ Download Gemini Nano' });
    const progress = el('progress', { attrs: { max: '1', value: '0', 'aria-label': 'Download progress' } });
    progress.hidden = true;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      progress.hidden = false;
      try {
        await scanModel?.initializeDeviceModel((v) => (progress.value = v)); // needs this click (user gesture)
        await refreshDevice();
      } catch (err) {
        banner('error', `The download didn’t finish: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return banner('info', 'Scan on your own device: Chrome can download Gemini Nano once. Until then, scans run in the cloud.', btn, progress);
  }
  if (deviceStatus === 'downloading') return banner('info', 'Gemini Nano is downloading. Scans use the cloud until it’s ready.');
  banner('warn', 'Gemini Nano isn’t available on this device, so step 1 runs in the cloud (☁️ instead of ⚡).');
}

/** Loads Nano into memory before the first scan (on-device only, free). */
function warmUp() {
  if (deviceStatus !== 'available' || !scanModel) return;
  scanModel.generateContent('Reply with JSON only: {"lib":"none","sure":[],"maybe":[]}').catch(() => {});
}

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  enabled = ((await chrome.storage.local.get(STORAGE.enabled))[STORAGE.enabled] as boolean | undefined) ?? true;
  steps.set('scan', 'idle', 'Looking for Gemini Nano…');
  deviceStatus = await getDeviceModelStatus();
  try {
    services = await initTtm(readEnvConfig());
    await chrome.storage.session.set({ [STORAGE.uid]: services.user.uid });
  } catch (err) {
    console.error('[ttm] init failed', err);
    banner('error', `Couldn’t connect to Firebase: ${err instanceof Error ? err.message : String(err)}`);
  }
  await refreshDevice();
  warmUp();

  $('btn-rerun').addEventListener('click', () => void refresh(true));
  chrome.tabs.onActivated.addListener(() => void refresh());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId === activeTabId && info.status === 'complete') void refresh();
  });
  chrome.windows.onFocusChanged.addListener(() => void refresh());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(STORAGE.enabled in changes)) return;
    enabled = changes[STORAGE.enabled]!.newValue !== false;
    if (!enabled && activeTabId !== undefined) void send(activeTabId, { type: 'ttm:reset' });
    void refresh(enabled);
  });
  chrome.runtime.onMessage.addListener((msg: ToPanel, sender) => {
    if (msg.type === 'ttm:select' && sender.tab?.id === activeTabId) select(msg.id, false);
  });

  await refresh();
}

void main();
