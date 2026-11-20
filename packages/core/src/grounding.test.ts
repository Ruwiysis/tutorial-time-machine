import { describe, expect, it } from 'vitest';
import { extractGrounding } from './grounding';

describe('extractGrounding', () => {
  it('returns ungrounded for a plain response', () => {
    expect(extractGrounding({ candidates: undefined })).toEqual({
      grounded: false,
      searchEntryPointHtml: undefined,
      sources: [],
      webSearchQueries: [],
    });
  });

  it('extracts the entry point and deduped sources', () => {
    const info = extractGrounding({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ type: 'text', text: 'x' }] },
          groundingMetadata: {
            searchEntryPoint: { renderedContent: '<div>chip</div>' },
            webSearchQueries: ['firebase modular sdk'],
            groundingChunks: [
              { web: { uri: 'https://a.example', title: 'A' } },
              { web: { uri: 'https://a.example', title: 'A again' } },
              { web: { uri: 'https://b.example', domain: 'b.example' } },
              {},
            ],
          },
        },
      ],
    });
    expect(info.grounded).toBe(true);
    expect(info.searchEntryPointHtml).toBe('<div>chip</div>');
    expect(info.sources).toEqual([
      { uri: 'https://a.example', title: 'A' },
      { uri: 'https://b.example', title: 'b.example' },
    ]);
    expect(info.webSearchQueries).toEqual(['firebase modular sdk']);
  });
});
