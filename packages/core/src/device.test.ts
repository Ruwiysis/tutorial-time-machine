import { describe, expect, it } from 'vitest';
import { InferenceMode } from 'firebase/ai';
import { isEchoStubResponse } from './device';
import { effectiveScanMode } from './models';

describe('isEchoStubResponse', () => {
  it("detects Chromium's echo placeholder", () => {
    expect(
      isEchoStubResponse(
        'On-device model is not available in Chromium, this API is just echoing back the input:\nReply with OK.',
      ),
    ).toBe(true);
  });

  it('accepts real model output', () => {
    expect(isEchoStubResponse('OK')).toBe(false);
    expect(isEchoStubResponse('This line uses the Firebase v8 namespaced API.')).toBe(false);
  });
});

describe('effectiveScanMode', () => {
  it('keeps the configured mode for real devices', () => {
    expect(effectiveScanMode(InferenceMode.PREFER_ON_DEVICE, 'available')).toBe(InferenceMode.PREFER_ON_DEVICE);
    expect(effectiveScanMode(InferenceMode.PREFER_ON_DEVICE, undefined)).toBe(InferenceMode.PREFER_ON_DEVICE);
  });

  it('forces the cloud on an echo stub', () => {
    expect(effectiveScanMode(InferenceMode.PREFER_ON_DEVICE, 'stub')).toBe(InferenceMode.ONLY_IN_CLOUD);
    expect(effectiveScanMode(InferenceMode.PREFER_IN_CLOUD, 'stub')).toBe(InferenceMode.ONLY_IN_CLOUD);
  });

  it('respects an explicit only-on-device setting', () => {
    expect(effectiveScanMode(InferenceMode.ONLY_ON_DEVICE, 'stub')).toBe(InferenceMode.ONLY_ON_DEVICE);
  });
});
