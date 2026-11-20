/**
 * Toolbar popup: on/off switch, on-device AI status, sign-in status, lifetime
 * savings, and a button to open the side panel. Deliberately light: it never
 * starts Firebase or runs a model (it reads what the side panel stored).
 */
import '@ttm/ui/src/ui.css';
import './popup.css';
import { EMPTY_TOTALS, STORAGE, type Totals } from './messages';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const DEVICE: Record<string, string> = {
  available: '⚡ Gemini Nano ready',
  downloadable: '⬇️ Supported, needs a one-time download (from the side panel)',
  downloading: '⏳ Gemini Nano is downloading',
  unavailable: '☁️ Not on this device: scans use the cloud',
};

async function main() {
  // Look up the window first: sidePanel.open() must run synchronously inside the click.
  const windowId = (await chrome.windows.getCurrent()).id;

  const toggle = $<HTMLInputElement>('enabled');
  toggle.checked = ((await chrome.storage.local.get(STORAGE.enabled))[STORAGE.enabled] as boolean | undefined) ?? true;
  toggle.addEventListener('change', () => void chrome.storage.local.set({ [STORAGE.enabled]: toggle.checked }));

  $('open').addEventListener('click', () => {
    if (windowId !== undefined) void chrome.sidePanel.open({ windowId }).then(() => window.close());
  });

  const uid = (await chrome.storage.session.get(STORAGE.uid))[STORAGE.uid] as string | undefined;
  $('auth').textContent = uid ? `✅ Anonymous (${uid.slice(0, 6)}…)` : 'Starts when you open the side panel';

  const t: Totals = { ...EMPTY_TOTALS, ...((await chrome.storage.local.get(STORAGE.totals))[STORAGE.totals] as Totals | undefined) };
  $('totals').textContent = t.pages
    ? `So far: ${t.pages} page${t.pages === 1 ? '' : 's'} · ⚡ ${t.linesScanned} lines scanned on device · 📦 ${t.fromCache} from cache · ☁️ ${t.sentToCloud} sent to cloud`
    : 'Open a coding tutorial and the side panel to start.';

  // Availability only (no test prompt here, to keep the popup instant).
  let status = 'unavailable';
  try {
    if (typeof LanguageModel !== 'undefined') {
      status = await LanguageModel.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
    }
  } catch {
    status = 'unavailable';
  }
  $('device').textContent = DEVICE[status] ?? DEVICE.unavailable!;
}

void main();
