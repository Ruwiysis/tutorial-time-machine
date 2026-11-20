/**
 * Runtime settings, sourced from Firebase Remote Config.
 *
 * Remote Config lets us retune the hybrid routing without shipping a new
 * extension build: e.g. switch the cloud model, force cloud-only scanning for
 * a demo, or tighten the cloud-call budget if costs spike.
 */
import { InferenceMode } from 'firebase/ai';

/** Remote Config keys (must match remoteconfig.template.json). */
export const RC_KEYS = {
  cloudModelName: 'cloud_model_name',
  scanInferenceMode: 'scan_inference_mode',
  minConfidenceToVerify: 'min_confidence_to_verify',
  maxCloudCallsPerPage: 'max_cloud_calls_per_page',
  trackedLibraries: 'tracked_libraries',
} as const;

export interface RuntimeSettings {
  /** Cloud Gemini model used for grounded verification (and scan fallback). */
  cloudModelName: string;
  /** Inference mode for the scan step. Normally PREFER_ON_DEVICE. */
  scanInferenceMode: InferenceMode;
  /** Only flagged lines at or above this confidence are sent to the cloud. */
  minConfidenceToVerify: number;
  /** Hard cap on cloud verification calls per page (cost guard). */
  maxCloudCallsPerPage: number;
  /** Libraries the scanner should pay attention to (lower-case). */
  trackedLibraries: string[];
}

export const DEFAULT_TRACKED_LIBRARIES = [
  'firebase',
  'react',
  'react-dom',
  'openai',
  'tensorflow',
  'next',
  'vue',
  'angular',
  'express',
  'langchain',
  'pandas',
  'numpy',
  'django',
  'flask',
];

/** In-app defaults, used until (or if) Remote Config fetch succeeds. */
export const RC_DEFAULTS: Record<string, string | number> = {
  [RC_KEYS.cloudModelName]: 'gemini-3.5-flash-lite',
  [RC_KEYS.scanInferenceMode]: InferenceMode.PREFER_ON_DEVICE,
  [RC_KEYS.minConfidenceToVerify]: 0.6,
  [RC_KEYS.maxCloudCallsPerPage]: 10,
  [RC_KEYS.trackedLibraries]: JSON.stringify(DEFAULT_TRACKED_LIBRARIES),
};

const VALID_MODES = new Set<string>(Object.values(InferenceMode));

function toNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Accepts a JSON string array or a comma-separated list. */
export function parseLibraryList(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [...DEFAULT_TRACKED_LIBRARIES];
  let items: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed : [];
  } catch {
    items = raw.split(',');
  }
  const libs = items
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return libs.length > 0 ? [...new Set(libs)] : [...DEFAULT_TRACKED_LIBRARIES];
}

/**
 * Turns raw Remote Config strings into validated settings. Any bad value
 * falls back to its default, so a typo in the console can't break the app.
 */
export function parseSettings(get: (key: string) => string | undefined): RuntimeSettings {
  const model = get(RC_KEYS.cloudModelName)?.trim();
  const mode = get(RC_KEYS.scanInferenceMode)?.trim().toLowerCase() ?? '';

  return {
    cloudModelName: model || String(RC_DEFAULTS[RC_KEYS.cloudModelName]),
    scanInferenceMode: VALID_MODES.has(mode)
      ? (mode as InferenceMode)
      : InferenceMode.PREFER_ON_DEVICE,
    minConfidenceToVerify: clamp(toNumber(get(RC_KEYS.minConfidenceToVerify), 0.6), 0, 1),
    maxCloudCallsPerPage: Math.round(
      clamp(toNumber(get(RC_KEYS.maxCloudCallsPerPage), 10), 0, 100),
    ),
    trackedLibraries: parseLibraryList(get(RC_KEYS.trackedLibraries)),
  };
}
