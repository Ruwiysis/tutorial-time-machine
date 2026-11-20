/**
 * Milestone 1 diagnostics page. It proves the whole Firebase stack works end
 * to end: App Check → Auth → Remote Config → AI Logic hybrid inference. It
 * also shows which path (on-device or cloud) actually served each prompt.
 */
import {
  createScanModel,
  createVerifyModel,
  extractGrounding,
  generateVerify,
  getDeviceModelStatus,
  initTtm,
  servedByFromResponse,
  type DeviceModelStatus,
  type GenerativeModel,
  type ServedBy,
  type TtmServices,
  type VerifyModels,
} from '@ttm/core';
import { readEnvConfig } from './env';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const SAMPLE_LINE = "const db = firebase.firestore();";

const SCAN_PROMPT = `You review code from programming tutorials.
Library hint: firebase.
Line: ${SAMPLE_LINE}
In one sentence, say which library and API version style this line uses.`;

const VERIFY_PROMPT = `Using current official documentation, is this JavaScript line still the recommended API?
Line: ${SAMPLE_LINE}
Answer in two short sentences and give the modern equivalent.`;

const DEVICE_LABELS: Record<DeviceModelStatus, string> = {
  available: '✅ Available: scans will run on-device.',
  downloadable: '⬇️ Supported, but the model needs downloading. Click below.',
  downloading: '⏳ Model is downloading…',
  unavailable: '❌ Not available on this device. Scans will fall back to the cloud.',
  unsupported: '❌ This browser has no Prompt API. Scans will fall back to the cloud.',
  stub: '⚠️ This Chromium build has no real model (echo placeholder). Use Google Chrome for on-device; scans will use the cloud.',
};

const BADGES: Record<ServedBy, string> = {
  'on-device': '⚡ On-device',
  cloud: '☁️ Cloud',
  cache: '📦 Cache',
};

let services: TtmServices;
let scanModel: GenerativeModel;
let verifyModels: VerifyModels;

function renderStatus(rows: [string, string][]) {
  const dl = $('status');
  dl.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

async function refreshDeviceStatus() {
  const status = await getDeviceModelStatus();
  $('device-status').textContent = DEVICE_LABELS[status];
  $('btn-download').hidden = status !== 'downloadable';
  // Rebuild the scan model so the routing matches what the device can really do.
  if (services) scanModel = createScanModel(services.ai, services.settings, { deviceStatus: status });
  return status;
}

function addResult(opts: {
  title: string;
  badge: string;
  badgeClass: string;
  ms?: number;
  text: string;
}): HTMLElement {
  const box = document.createElement('div');
  box.className = 'result';
  const head = document.createElement('div');
  head.className = 'row';
  const badge = document.createElement('span');
  badge.className = `badge ${opts.badgeClass}`;
  badge.textContent = opts.badge;
  const title = document.createElement('strong');
  title.textContent = opts.title;
  const meta = document.createElement('span');
  meta.className = 'muted';
  meta.textContent = opts.ms !== undefined ? `${Math.round(opts.ms)} ms` : '';
  head.append(badge, title, meta);
  const pre = document.createElement('pre');
  pre.textContent = opts.text; // model output is always rendered as text, never HTML
  box.append(head, pre);
  $('results').prepend(box);
  return box;
}

function addError(title: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const hint = /\b429\b|quota/i.test(msg)
    ? '\n\nHint: the Gemini API quota for this model is used up. The free tier has small daily limits ' +
      '(and no Search grounding on Gemini 3.x). Try again later, or switch cloud_model_name in Remote Config.'
    : /app.?check|403|permission/i.test(msg)
      ? '\n\nHint: App Check rejected the request. Is your debug token registered in the console?'
      : '';
  addResult({ title, badge: 'Error', badgeClass: 'error', text: msg + hint });
  console.error(`[ttm] ${title}`, err);
}

async function runScan() {
  const t0 = performance.now();
  try {
    const result = await scanModel.generateContent(SCAN_PROMPT);
    const servedBy = servedByFromResponse(result.response);
    console.info('[ttm] scan inferenceSource =', result.response.inferenceSource);
    addResult({
      title: 'Scan model',
      badge: BADGES[servedBy],
      badgeClass: servedBy,
      ms: performance.now() - t0,
      text: result.response.text(),
    });
  } catch (err) {
    addError('Scan model failed', err);
  }
}

async function runVerify() {
  const t0 = performance.now();
  try {
    // Grounded first; on a grounding quota error, retry once without Search.
    const { response, grounded } = await generateVerify(verifyModels, VERIFY_PROMPT);
    const servedBy = servedByFromResponse(response);
    console.info('[ttm] verify inferenceSource =', response.inferenceSource, '· grounded =', grounded);
    const box = addResult({
      title: `Verify model (${services.settings.cloudModelName})`,
      badge: grounded ? `${BADGES[servedBy]} + Google Search` : `${BADGES[servedBy]} · not search-verified`,
      badgeClass: grounded ? servedBy : `${servedBy} unverified`,
      ms: performance.now() - t0,
      text: grounded
        ? response.text()
        : `${response.text()}

(Google Search grounding was out of quota, so this answer comes from the model's own knowledge and may be out of date.)`,
    });

    // Grounding display requirements: show the sources AND the Search
    // suggestions widget. The widget's HTML goes in unmodified, inside a
    // shadow root so its CSS stays isolated.
    const grounding = extractGrounding(response);
    if (grounding.sources.length) {
      const ul = document.createElement('ul');
      ul.className = 'sources';
      for (const s of grounding.sources) {
        if (!/^https?:\/\//i.test(s.uri)) continue;
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = s.uri;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = s.title;
        li.append(a);
        ul.append(li);
      }
      box.append(ul);
    }
    if (grounding.searchEntryPointHtml) {
      const host = document.createElement('div');
      host.attachShadow({ mode: 'open' }).innerHTML = grounding.searchEntryPointHtml;
      box.append(host);
    }
  } catch (err) {
    addError('Verify model failed', err);
  }
}

async function main() {
  const deviceStatus = await refreshDeviceStatus();

  try {
    services = await initTtm(readEnvConfig());
  } catch (err) {
    renderStatus([['Status', '❌ Initialization failed']]);
    addError('Firebase init failed', err);
    return;
  }

  const { settings } = services;
  renderStatus([
    ['Project', services.app.options.projectId ?? '?'],
    ['App Check', services.appCheckMode === 'debug-token' ? 'Debug token (dev)' : 'reCAPTCHA Enterprise'],
    ['Auth', `Anonymous · ${services.user.uid}`],
    ['Remote Config', services.remoteConfigStatus === 'fetched' ? 'Fetched' : 'Using in-app defaults'],
    ['Cloud model', settings.cloudModelName],
    ['Scan mode', settings.scanInferenceMode],
    ['Verify threshold', String(settings.minConfidenceToVerify)],
    ['Cloud calls / page', String(settings.maxCloudCallsPerPage)],
    ['On-device now', deviceStatus],
  ]);

  scanModel = createScanModel(services.ai, settings, { deviceStatus });
  verifyModels = {
    grounded: createVerifyModel(services.ai, settings),
    ungrounded: createVerifyModel(services.ai, settings, undefined, { grounded: false }),
  };

  const btnScan = $<HTMLButtonElement>('btn-scan');
  const btnVerify = $<HTMLButtonElement>('btn-verify');
  const btnDownload = $<HTMLButtonElement>('btn-download');
  const progress = $<HTMLProgressElement>('download-progress');

  const withBusy = (btn: HTMLButtonElement, fn: () => Promise<void>) => async () => {
    btn.disabled = true;
    try {
      await fn();
    } finally {
      btn.disabled = false;
    }
  };

  btnScan.addEventListener('click', withBusy(btnScan, runScan));
  btnVerify.addEventListener('click', withBusy(btnVerify, runVerify));

  // The model download must start from a user gesture (Prompt API requirement).
  btnDownload.addEventListener(
    'click',
    withBusy(btnDownload, async () => {
      progress.hidden = false;
      try {
        await scanModel.initializeDeviceModel((v) => (progress.value = v));
      } catch (err) {
        addError('On-device model download failed', err);
      }
      progress.hidden = true;
      await refreshDeviceStatus();
    }),
  );

  btnScan.disabled = false;
  btnVerify.disabled = false;
}

void main();
