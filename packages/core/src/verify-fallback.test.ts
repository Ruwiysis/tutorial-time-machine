import { describe, expect, it, vi } from 'vitest';
import { AIError, type GenerativeModel } from 'firebase/ai';
import { generateVerify, isQuotaError } from './models';

const quota = () =>
  new AIError('fetch-error', 'Error fetching from https://x: [429 ] You exceeded your current quota', { status: 429 });

const fakeModel = (impl: () => unknown) =>
  ({ generateContent: vi.fn(async () => ({ response: impl() })) }) as unknown as GenerativeModel;

const failing = (err: unknown) =>
  ({
    generateContent: vi.fn(async () => {
      throw err;
    }),
  }) as unknown as GenerativeModel;

describe('isQuotaError', () => {
  it('detects 429 from customErrorData', () => {
    expect(isQuotaError(quota())).toBe(true);
  });

  it('detects 429 from the message alone', () => {
    expect(isQuotaError(new Error('[429 ] You exceeded your current quota'))).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isQuotaError(new AIError('fetch-error', '[404 ] model not found', { status: 404 }))).toBe(false);
    expect(isQuotaError(new Error('network down'))).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });
});

describe('generateVerify', () => {
  it('uses the grounded model when it works', async () => {
    const ungrounded = fakeModel(() => ({ text: () => 'plain' }));
    const out = await generateVerify({ grounded: fakeModel(() => ({ text: () => 'grounded' })), ungrounded }, 'p');
    expect(out.grounded).toBe(true);
    expect(out.response.text()).toBe('grounded');
    expect(ungrounded.generateContent).not.toHaveBeenCalled();
  });

  it('falls back to the ungrounded model on a quota error', async () => {
    const out = await generateVerify(
      { grounded: failing(quota()), ungrounded: fakeModel(() => ({ text: () => 'plain' })) },
      'p',
    );
    expect(out.grounded).toBe(false);
    expect(out.response.text()).toBe('plain');
  });

  it('rethrows non-quota errors without retrying', async () => {
    const ungrounded = fakeModel(() => ({}));
    await expect(generateVerify({ grounded: failing(new Error('boom')), ungrounded }, 'p')).rejects.toThrow('boom');
    expect(ungrounded.generateContent).not.toHaveBeenCalled();
  });

  it('surfaces the second error when the fallback also hits quota', async () => {
    await expect(generateVerify({ grounded: failing(quota()), ungrounded: failing(quota()) }, 'p')).rejects.toThrow(
      /429/,
    );
  });
});
