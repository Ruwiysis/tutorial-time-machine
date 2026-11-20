import { describe, expect, it } from 'vitest';
import { languageFromClass, lineStartOffset } from './extract';

describe('languageFromClass', () => {
  it.each([
    ['language-javascript', 'javascript'],
    ['hljs lang-Python', 'python'],
    ['highlight highlight-source-ts', 'ts'],
    ['language-c++ other', 'c++'],
  ])('%s → %s', (cls, lang) => expect(languageFromClass(cls)).toBe(lang));

  it('returns undefined without a language class', () => {
    expect(languageFromClass('hljs code-block')).toBeUndefined();
  });
});

describe('lineStartOffset', () => {
  const code = 'a\nbb\n\nccc';
  it('finds the start of each 1-based line', () => {
    expect([1, 2, 3, 4].map((n) => lineStartOffset(code, n))).toEqual([0, 2, 5, 6]);
  });
  it('returns -1 past the end', () => {
    expect(lineStartOffset(code, 6)).toBe(-1);
  });
});
