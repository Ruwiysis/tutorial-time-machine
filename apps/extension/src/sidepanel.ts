/**
 * Milestone 5, step 1: feasibility check inside an extension page.
 * Firebase's docs don't cover extensions, so before building the real side
 * panel we prove each piece works here: App Check (debug token), anonymous
 * Auth (web-extension build), Remote Config, the on-device scan through
 * Firebase AI Logic, and the grounded cloud check.
 */
import '@ttm/ui/src/ui.css';
import './sidepanel.css';
import {
  createScanModel,
  createVerifyModel,
  generateVerify,
  getDeviceModelStatus,
  initTtm,
  SCAN_SCHEMA,
  scanBlock,
  servedByFromResponse,
  type DeviceModelStatus,
  type GenerativeModel,
  type TtmServices,
  type VerifyModels,
} from '@ttm/core';
import { el, pathBadge } from '@ttm/ui';
import { readEnvConfig } from './env';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SAMPLE = "import firebase from 'firebase/app';\nfirebase.initializeApp(config);\nconst db = firebase.firestore();";

let services: TtmServices;
let deviceStatus: DeviceModelStatus;
let scanModel: GenerativeModel;
let verifyModels: VerifyModels;

function status(rows: [string, string][]) {
  $('status').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
}

function show(title: string, badge: HTMLElement | null, ms: number, text: string) {
  $('out').prepend(
    el('div', { class: 'sp-result' }, el('div', { class: 'sp-row' }, badge, el('strong', { text: title }), el('span', { class: 'ttm-muted', text: `${Math.round(ms)} ms` })), el('pre', { text })),
  );
}

function fail(title: string, err: unknown) {
  console.error(`[ttm] ${title}`, err);
  show(title, el('span', { class: 'ttm-badge ttm-status-error', text: '⚠️ Error' }), 0, err instanceof Error ? err.message : String(err));
}

async function main() {
  deviceStatus = await getDeviceModelStatus();
  try {
    services = await initTtm(readEnvConfig());
  } catch (err) {
    status([['Firebase', '❌ init failed']]);
    fail('Firebase init', err);
    return;
  }
  scanModel = createScanModel(services.ai, services.settings, { deviceStatus, responseSchema: SCAN_SCHEMA });
  verifyModels = {
    grounded: createVerifyModel(services.ai, services.settings),
    ungrounded: createVerifyModel(services.ai, services.settings, undefined, { grounded: false }),
  };
  status([
    ['Context', location.protocol === 'chrome-extension:' ? 'Extension page ✅' : location.protocol],
    ['App Check', services.appCheckMode === 'debug-token' ? 'Debug token ✅' : services.appCheckMode],
    ['Auth', `Anonymous · ${services.user.uid.slice(0, 8)}… ✅`],
    ['Remote Config', services.remoteConfigStatus === 'fetched' ? 'Fetched ✅' : 'Defaults'],
    ['Cloud model', services.settings.cloudModelName],
    ['Prompt API here', typeof LanguageModel === 'undefined' ? '❌ not exposed' : '✅ exposed'],
    ['On-device model', deviceStatus],
  ]);

  if (deviceStatus === 'downloadable') {
    const btn = $<HTMLButtonElement>('btn-download');
    btn.hidden = false;
    btn.onclick = async () => {
      btn.disabled = true;
      $('progress').hidden = false;
      try {
        await scanModel.initializeDeviceModel((v) => ($<HTMLProgressElement>('progress').value = v));
        location.reload();
      } catch (err) {
        fail('Download', err);
      }
    };
  }

  const scan = $<HTMLButtonElement>('btn-scan');
  const verify = $<HTMLButtonElement>('btn-verify');
  scan.disabled = verify.disabled = false;

  scan.onclick = async () => {
    scan.disabled = true;
    const t0 = performance.now();
    try {
      const r = await scanBlock(scanModel, SAMPLE, { language: 'javascript' }, services.settings);
      const lines = r.flagged.map((f) => `line ${f.lineNo}: ${f.code}`).join('\n') || '(nothing flagged)';
      show('Scan', pathBadge(r.servedBy), performance.now() - t0, `library: ${r.library ?? 'none'}\n${lines}`);
    } catch (err) {
      fail('Scan', err);
    }
    scan.disabled = false;
  };

  verify.onclick = async () => {
    verify.disabled = true;
    const t0 = performance.now();
    try {
      const { response, grounded } = await generateVerify(
        verifyModels,
        'Is this Firebase JS line still current? Answer in one sentence.\nconst db = firebase.firestore();',
      );
      show('Cloud check', pathBadge(servedByFromResponse(response), { grounded }), performance.now() - t0, response.text());
    } catch (err) {
      fail('Cloud check', err);
    }
    verify.disabled = false;
  };
}

void main();
