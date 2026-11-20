/**
 * Demo tutorials from /fixtures, bundled at build time (no extra requests).
 * They are our own static files, so rendering their markup is safe.
 */
import type { CodeBlock } from '@ttm/core';

export const FIXTURES = import.meta.glob<string>('../../../fixtures/*.html', { query: '?raw', import: 'default', eager: true });

export interface FixtureInfo {
  id: string;
  label: string;
  library: string;
  year: string;
  /** The Firebase tutorial is the hero demo (the judges are the Firebase team). */
  hero?: boolean;
}

/** Card labels, in display order. */
export const FIXTURE_INFO: FixtureInfo[] = [
  { id: 'firebase-v8-firestore', label: 'Realtime chat with Firestore', library: 'Firebase JS SDK v8', year: '2021', hero: true },
  { id: 'react-17-render', label: 'Your first React counter', library: 'React 17', year: '2020' },
  { id: 'openai-legacy-completion', label: 'Summarize articles with GPT-3', library: 'openai-python 0.x', year: '2023' },
  { id: 'tensorflow-1-session', label: 'Linear regression from scratch', library: 'TensorFlow 1.x', year: '2018' },
];

export function fixtureHtml(id: string): string | undefined {
  return Object.entries(FIXTURES).find(([path]) => path.endsWith(`/${id}.html`))?.[1];
}

export function readFixture(html: string): { title: string; blocks: CodeBlock[]; doc: Document } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = [...doc.querySelectorAll('pre > code')].map((el) => ({
    language: /language-([\w-]+)/.exec(el.className)?.[1],
    code: el.textContent ?? '',
  }));
  return { title: doc.title, blocks, doc };
}
