import { describe, expect, it } from 'vitest';
import { InferenceMode } from 'firebase/ai';
import { parseLibraryList, parseSettings, RC_DEFAULTS, RC_KEYS } from './settings';

const from = (values: Record<string, string>) => (k: string) => values[k];

describe('parseSettings', () => {
  it('uses defaults when nothing is set', () => {
    const s = parseSettings(() => undefined);
    expect(s.scanInferenceMode).toBe(InferenceMode.PREFER_ON_DEVICE);
    expect(s.minConfidenceToVerify).toBe(0.6);
    expect(s.maxCloudCallsPerPage).toBe(10);
    expect(s.cloudModelName).toBe(RC_DEFAULTS[RC_KEYS.cloudModelName]);
    expect(s.trackedLibraries).toContain('firebase');
  });

  it('parses the in-app defaults the same as unset values', () => {
    const s = parseSettings((k) => String(RC_DEFAULTS[k]));
    expect(s).toEqual(parseSettings(() => undefined));
  });

  it('accepts valid overrides', () => {
    const s = parseSettings(
      from({
        cloud_model_name: 'gemini-x',
        scan_inference_mode: 'ONLY_IN_CLOUD',
        min_confidence_to_verify: '0.8',
        max_cloud_calls_per_page: '3',
        tracked_libraries: '["Vue", "svelte"]',
      }),
    );
    expect(s).toEqual({
      cloudModelName: 'gemini-x',
      scanInferenceMode: InferenceMode.ONLY_IN_CLOUD,
      minConfidenceToVerify: 0.8,
      maxCloudCallsPerPage: 3,
      trackedLibraries: ['vue', 'svelte'],
    });
  });

  it('falls back or clamps on bad values', () => {
    const s = parseSettings(
      from({
        scan_inference_mode: 'turbo',
        min_confidence_to_verify: '7',
        max_cloud_calls_per_page: 'lots',
        cloud_model_name: '   ',
      }),
    );
    expect(s.scanInferenceMode).toBe(InferenceMode.PREFER_ON_DEVICE);
    expect(s.minConfidenceToVerify).toBe(1);
    expect(s.maxCloudCallsPerPage).toBe(10);
    expect(s.cloudModelName).toBe(RC_DEFAULTS[RC_KEYS.cloudModelName]);
  });
});

describe('parseLibraryList', () => {
  it('accepts comma-separated lists and dedupes', () => {
    expect(parseLibraryList('React, react ,openai,')).toEqual(['react', 'openai']);
  });
  it('falls back to defaults on empty or non-string arrays', () => {
    expect(parseLibraryList('[1,2]')).toContain('firebase');
    expect(parseLibraryList('')).toContain('firebase');
  });
});
