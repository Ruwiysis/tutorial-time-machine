/**
 * Tutorial Time-Machine web app: the judge-friendly version of the extension.
 * Pick a demo tutorial (or paste code) and the same hybrid pipeline runs:
 * ⚡ on-device scan → 📦 Firestore cache → ☁️ cloud + Google Search.
 */
import '@ttm/ui/src/ui.css';
import './app.css';
import {
  checkPage,
  createScanModel,
  createVerifyModel,
  getDeviceModelStatus,
  initTtm,
  isQuotaError,
  lineId,
  SCAN_SCHEMA,
  type CodeBlock,
  type DeviceModelStatus,
  type GenerativeModel,
  type LineOutcome,
  type PageCheckResult,
  type TtmServices,
  type VerifyModels,
} from '@ttm/core';
import { CodeView, el, HybridSteps, pathBadge, renderLineDetail, renderSavingsMeter, STATUS, type LineState } from '@ttm/ui';
import { readEnvConfig } from './env';
import { FIXTURE_INFO, fixtureHtml, readFixture } from './fixtures';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let services: TtmServices | undefined;
let deviceStatus: DeviceModelStatus = 'unsupported';
let scanModel: GenerativeModel | undefined;
let verifyModels: VerifyModels | undefined;
let running = false;

interface OpenDoc {
  title: string;
  blocks: CodeBlock[];
  views: CodeView[];
}
let current: OpenDoc | undefined;
let result: PageCheckResult | undefined;
let selectedId: string | undefined;

const steps = new HybridSteps();
$('steps').append(steps.el);

// ── Firebase models ─────────────────────────────────────────────────────────

/**
 * The scan model follows the device: PREFER_ON_DEVICE normally, forced to the
 * cloud when Chrome only has the echo stub (see effectiveScanMode).
 */
function buildModels() {
  if (!services) return;
  scanModel = createScanModel(services.ai, services.settings, { deviceStatus, responseSchema: SCAN_SCHEMA });
  verifyModels = {
    grounded: createVerifyModel(services.ai, services.settings),
    ungrounded: createVerifyModel(services.ai, services.settings, undefined, { grounded: false }),
  };
}

// ── Banner + on-device status ───────────────────────────────────────────────

function showBanner(kind: 'info' | 'warn' | 'error', text: string, ...extra: HTMLElement[]) {
  const banner = $('banner');
  banner.className = `banner banner-${kind}`;
  banner.replaceChildren(el('p', { text }), ...extra);
  banner.hidden = false;
}
const hideBanner = () => ($('banner').hidden = true);

const DEVICE_LABEL: Record<DeviceModelStatus, string> = {
  available: 'Gemini Nano is ready in this browser.',
  downloadable: 'Gemini Nano needs a one-time download.',
  downloading: 'Gemini Nano is downloading…',
  unavailable: 'Gemini Nano isn’t available here, so this step runs in the cloud.',
  unsupported: 'Gemini Nano isn’t available here, so this step runs in the cloud.',
  stub: 'This browser has no real on-device model, so this step runs in the cloud.',
};

async function refreshDevice() {
  deviceStatus = await getDeviceModelStatus();
  buildModels();
  if (!running) steps.set('scan', 'idle', DEVICE_LABEL[deviceStatus]);

  if (deviceStatus === 'available') return hideBanner();
  if (deviceStatus === 'downloadable') {
    const button = el('button', { class: 'ttm-btn ttm-btn-primary', text: '⬇️ Download Gemini Nano' });
    const progress = el('progress', { attrs: { max: '1', value: '0', 'aria-label': 'Download progress' } });
    progress.hidden = true;
    button.addEventListener('click', async () => {
      // Must start from a user gesture (Prompt API rule).
      button.disabled = true;
      progress.hidden = false;
      try {
        await scanModel?.initializeDeviceModel((v) => (progress.value = v));
      } catch (err) {
        showBanner('error', `The download didn’t finish: ${message(err)}`);
        return;
      }
      await refreshDevice();
    });
    return showBanner('info', 'Run step 1 on your own device: Chrome can download Gemini Nano once (a few GB). Until then, scans run in the cloud.', button, progress);
  }
  if (deviceStatus === 'downloading') return showBanner('info', 'Gemini Nano is downloading in the background. Scans use the cloud until it’s ready.');
  showBanner(
    'warn',
    'Gemini Nano isn’t available in this browser, so step 1 falls back to the cloud (you’ll see ☁️ instead of ⚡). ' +
      'For the full on-device experience, use desktop Chrome 139+ with a supported GPU.',
  );
}

// ── Picker ──────────────────────────────────────────────────────────────────

function renderPicker() {
  const picker = $('picker');
  const cards = FIXTURE_INFO.map((f) =>
    el(
      'button',
      { class: `pick${f.hero ? ' pick-hero' : ''}`, attrs: { type: 'button', 'data-id': f.id, 'aria-pressed': 'false' } },
      el('span', { class: 'pick-lib', text: f.library }),
      el('span', { class: 'pick-title', text: f.label }),
      el('span', { class: 'pick-meta', text: `Tutorial from ${f.year}` }),
    ),
  );
  const paste = el(
    'button',
    { class: 'pick pick-paste', attrs: { type: 'button', 'data-id': 'paste', 'aria-pressed': 'false' } },
    el('span', { class: 'pick-lib', text: 'Your code' }),
    el('span', { class: 'pick-title', text: 'Paste a snippet' }),
    el('span', { class: 'pick-meta', text: 'From any tutorial or answer' }),
  );
  picker.replaceChildren(...cards, paste);
  picker.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button.pick');
    if (!button || button.disabled) return;
    picker.querySelectorAll('.pick').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    const id = button.dataset.id!;
    $('paste-form').hidden = id !== 'paste';
    if (id === 'paste') {
      $<HTMLTextAreaElement>('paste-code').focus();
      return;
    }
    history.replaceState(null, '', `?demo=${id}`);
    openFixture(id);
  });

  $('paste-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $<HTMLTextAreaElement>('paste-code').value.replace(/\s+$/, '');
    if (!code.trim()) return $<HTMLTextAreaElement>('paste-code').focus();
    history.replaceState(null, '', location.pathname);
    openDoc('Pasted code', [{ code, language: $<HTMLSelectElement>('paste-lang').value || undefined }]);
  });
}

function setBusy(busy: boolean) {
  running = busy;
  document.querySelectorAll<HTMLButtonElement>('.pick, #paste-form button').forEach((b) => (b.disabled = busy || !services));
}

// ── Tutorial view ───────────────────────────────────────────────────────────

function openFixture(id: string) {
  const html = fixtureHtml(id);
  if (!html) return;
  const { title, blocks, doc } = readFixture(html);
  const article = document.adoptNode(doc.querySelector('article') ?? doc.body);
  article.classList.add('tutorial-article');
  const views = blocks.map((b, i) => new CodeView(b, (lineNo) => selectLine(lineId(i, lineNo))));
  // Swap each <pre><code> in the tutorial for a code view with a marker gutter.
  article.querySelectorAll('pre > code').forEach((code, i) => code.parentElement?.replaceWith(views[i]!.el));
  mountDoc({ title, blocks, views }, article);
}

function openDoc(title: string, blocks: CodeBlock[]) {
  const views = blocks.map((b, i) => new CodeView(b, (lineNo) => selectLine(lineId(i, lineNo))));
  mountDoc({ title, blocks, views }, el('article', { class: 'tutorial-article' }, el('h1', { text: title }), ...views.map((v) => v.el)));
}

function mountDoc(doc: OpenDoc, article: HTMLElement) {
  current = doc;
  $('tutorial').replaceChildren(article);
  $('workspace').hidden = false;
  void run();
}

// ── Running the pipeline ────────────────────────────────────────────────────

const STATE: Record<LineOutcome['status'], LineState> = {
  outdated: 'outdated',
  ok: 'ok',
  unsure: 'unsure',
  skipped: 'skipped',
  error: 'error',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function run() {
  if (!services || !scanModel || !verifyModels || !current || running) return;
  const doc = current;
  setBusy(true);
  result = undefined;
  selectedId = undefined;
  $('meter').replaceChildren();
  $('detail').replaceChildren();
  $('results').replaceChildren();
  $('summary').textContent = '';
  if ($('banner').classList.contains('banner-error')) hideBanner();
  steps.reset();
  const onDevice = deviceStatus === 'available';
  steps.set('scan', 'active', onDevice ? 'Gemini Nano is reading the code…' : 'Reading the code in the cloud…');
  steps.set('cache', 'idle');
  steps.set('cloud', 'idle');
  doc.views.forEach((v) => {
    v.reset();
    v.setStatus(onDevice ? '⚡ Scanning on-device…' : '☁️ Scanning…', true);
  });
  setSummary(el('p', { class: 'ttm-muted', text: 'Step 1: scanning every line…' }));
  const t0 = performance.now();

  try {
    const r = await checkPage(
      { scanModel, verify: { db: services.db, uid: services.user.uid, models: verifyModels, settings: services.settings }, settings: services.settings },
      doc.blocks,
      { title: doc.title },
      {
        onScanned(page, toVerify) {
          const flagged = page.blocks.reduce((n, b) => n + b.flagged.length, 0);
          const where = page.servedBy === 'on-device' ? '⚡ on-device' : '☁️ in the cloud';
          steps.set('scan', 'done', `${page.linesScanned} lines ${where} in ${secs(performance.now() - t0)} · ${flagged} flagged`);
          const pending = new Set(toVerify);
          page.blocks.forEach((b, i) => {
            const view = doc.views[i]!;
            view.setStatus(b.flagged.length ? `${plural(b.flagged.length, 'line')} flagged` : 'Nothing flagged');
            for (const f of b.flagged) view.setLine(f.lineNo, pending.has(lineId(i, f.lineNo)) ? 'checking' : 'local');
          });
          if (toVerify.length) {
            steps.set('cache', 'active', `Looking up ${plural(toVerify.length, 'line')}…`);
            setSummary(el('p', { class: 'ttm-muted', text: `Checking ${plural(toVerify.length, 'flagged line')}…` }));
          } else {
            steps.set('cache', 'skipped', 'Nothing to look up');
            steps.set('cloud', 'skipped', 'Not needed');
          }
        },
        onVerifyProgress(p) {
          if (p.phase === 'cloud' && p.total > 0) {
            steps.set('cache', 'done');
            steps.set('cloud', 'active', `Request ${Math.min(p.done + 1, p.total)} of ${p.total}…`);
          }
        },
        onLine(o) {
          const [b, n] = o.id.split(':').map(Number);
          doc.views[b!]?.setLine(n!, STATE[o.status]);
        },
      },
    );
    if (current !== doc) return; // the user opened something else meanwhile
    result = r;
    showResults(doc, r);
  } catch (err) {
    console.error('[ttm] check failed', err);
    steps.failActive();
    doc.views.forEach((v) => v.setStatus('', false));
    setSummary(el('p', { class: 'error-text', text: friendlyError(err) }));
  } finally {
    setBusy(false);
  }
}

function showResults(doc: OpenDoc, r: PageCheckResult) {
  const { stats } = r;
  if (stats.unique) {
    steps.set('cache', 'done', `${stats.fromCache} of ${plural(stats.unique, 'line')} already verified`);
  }
  const all = [...r.outcomes.values()];
  const cloudTried = all.filter((o) => o.status === 'error' || (o.status !== 'skipped' && o.servedBy === 'cloud'));
  const failed = cloudTried.filter((o) => o.status === 'error');
  if (stats.cloudCalls && failed.length && failed.length === cloudTried.length) {
    steps.set('cloud', 'error', `All ${plural(stats.cloudCalls, 'request')} failed`);
  } else if (stats.cloudCalls) {
    const search = stats.groundedCalls ? ' with Google Search' : ' (Google Search unavailable)';
    const failures = failed.length ? ` · ${failed.length} failed` : '';
    steps.set('cloud', 'done', `${plural(stats.sentToCloud, 'line')} in ${plural(stats.cloudCalls, 'request')}${search} · ${secs(r.timings.verifyMs)}${failures}`);
  } else if (stats.unique) {
    steps.set('cloud', 'skipped', stats.skipped ? 'Budget used up' : 'Not needed: everything came from the cache');
  }

  const firstFailure = failed[0];
  if (firstFailure?.status === 'error') showBanner('error', friendlyMessage(firstFailure.reason));

  $('meter').replaceChildren(renderSavingsMeter({ linesScanned: r.page.linesScanned, scanServedBy: r.scanServedBy, stats }));

  const outcomes = [...r.outcomes.values()].sort((a, b) => compareIds(a.id, b.id));
  const count = (s: LineOutcome['status']) => outcomes.filter((o) => o.status === s).length;
  const parts = [
    count('outdated') && `${STATUS.outdated.icon} ${count('outdated')} outdated`,
    count('ok') && `${STATUS.ok.icon} ${count('ok')} still current`,
    count('unsure') && `${STATUS.unsure.icon} ${count('unsure')} unsure`,
    (count('skipped') || count('error')) && `⚠️ ${count('skipped') + count('error')} not checked`,
    r.keptLocal.length && `◦ ${r.keptLocal.length} kept local`,
  ].filter(Boolean) as string[];

  if (!outcomes.length) {
    setSummary(
      el(
        'div',
        { class: 'empty' },
        el('p', { class: 'empty-title', text: '🟢 No outdated code found' }),
        el('p', { class: 'ttm-muted', text: 'Gemini Nano didn’t flag any version-sensitive library calls on this page, so nothing was sent to the cloud.' }),
      ),
    );
    return;
  }
  setSummary(el('p', { class: 'summary-counts', text: parts.join(' · ') }));

  const list = $('results');
  list.replaceChildren(
    ...outcomes.map((o) => {
      const code = lineCode(doc, o.id);
      const status = o.status === 'skipped' || o.status === 'error' ? '⚠️' : STATUS[o.status].icon;
      const button = el(
        'button',
        { class: 'result-item', attrs: { type: 'button', 'data-id': o.id } },
        el('span', { class: 'result-icon', text: status, attrs: { 'aria-hidden': 'true' } }),
        el('code', { class: 'result-code', text: code.trim() }),
        o.status !== 'skipped' && o.status !== 'error' ? pathBadge(o.servedBy, { grounded: o.entry.grounded }) : null,
      );
      button.addEventListener('click', () => selectLine(o.id));
      return el('li', {}, button);
    }),
  );
  const first = outcomes.find((o) => o.status === 'outdated') ?? outcomes[0];
  if (first) selectLine(first.id, false);
}

function selectLine(id: string, scroll = true) {
  if (!current || !result) return;
  const outcome = result.outcomes.get(id);
  if (!outcome) return;
  selectedId = id;
  const [b, n] = id.split(':').map(Number);
  current.views.forEach((v, i) => v.select(i === b ? n! : null));
  const where = current.blocks.length > 1 ? `block ${b! + 1}, line ${n}` : `line ${n}`;
  $('detail').replaceChildren(renderLineDetail(lineCode(current, id), outcome, where));
  $('results')
    .querySelectorAll<HTMLElement>('.result-item')
    .forEach((item) => item.classList.toggle('active', item.dataset.id === selectedId));
  if (scroll && matchMedia('(max-width: 960px)').matches) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function setSummary(node: HTMLElement) {
  $('summary').replaceChildren(node);
}

function lineCode(doc: OpenDoc, id: string): string {
  const [b, n] = id.split(':').map(Number);
  return doc.blocks[b!]?.code.split('\n')[n! - 1] ?? '';
}

function compareIds(a: string, b: string): number {
  const [ab, an] = a.split(':').map(Number);
  const [bb, bn] = b.split(':').map(Number);
  return ab! - bb! || an! - bn!;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function friendlyError(err: unknown): string {
  return isQuotaError(err) ? friendlyMessage('[429]') : friendlyMessage(message(err));
}

/** Turns SDK error text into something a reader can act on. */
function friendlyMessage(msg: string): string {
  if (/\b429\b|quota|RESOURCE_EXHAUSTED/i.test(msg)) {
    return 'The free Gemini quota for this demo is used up for now. Please try again in a minute, or pick a tutorial someone already checked (it comes from the cache).';
  }
  if (/app.?check|attestation|recaptcha/i.test(msg)) {
    return 'The cloud step was blocked because this browser didn’t pass Firebase App Check (reCAPTCHA). The on-device scan and the cache still work. Try reloading the page.';
  }
  return `The cloud check failed: ${msg}`;
}

/**
 * Loads Gemini Nano into memory while the reader is still choosing a tutorial,
 * so the first real scan doesn't pay the cold start. On-device only: free,
 * and nothing leaves the browser. The SDK keeps the last session alive, which
 * keeps the model loaded. Failures are ignored; the real scan will retry.
 */
function warmUpDeviceModel() {
  if (deviceStatus !== 'available' || !scanModel) return;
  const t0 = performance.now();
  scanModel
    .generateContent('Reply with JSON only: {"lib":"none","sure":[],"maybe":[]}')
    .then(() => console.info(`[ttm] Gemini Nano warmed up in ${Math.round(performance.now() - t0)} ms`))
    .catch(() => {});
}

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  renderPicker();
  setBusy(true);
  steps.set('scan', 'idle', 'Looking for Gemini Nano…');
  deviceStatus = await getDeviceModelStatus();
  try {
    services = await initTtm(readEnvConfig());
  } catch (err) {
    console.error('[ttm] init failed', err);
    showBanner('error', `Couldn’t connect to Firebase: ${message(err)}`);
    setBusy(false);
    return;
  }
  await refreshDevice();
  setBusy(false);
  warmUpDeviceModel();

  // Deep link for demos: /?demo=firebase-v8-firestore opens and runs that tutorial.
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo && FIXTURE_INFO.some((f) => f.id === demo)) {
    $('picker').querySelector<HTMLButtonElement>(`[data-id="${demo}"]`)?.click();
  }
}

void main();
