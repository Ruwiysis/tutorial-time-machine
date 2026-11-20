import { describe, expect, it, vi } from 'vitest';
import { InferenceSource, type GenerativeModel } from 'firebase/ai';
import {
  buildScanPrompt,
  chunkPage,
  couldUseLibraryApi,
  MAYBE_CONFIDENCE,
  SURE_CONFIDENCE,
  extractJsonObject,
  MAX_CHUNK_CHARS,
  pageLines,
  parseScanResponse,
  scanBlock,
  scanPage,
  selectLinesToVerify,
  type CodeBlock,
} from './scan';
import { fixtureNames, loadFixture } from './test-utils/fixtures';

describe('pageLines / chunkPage', () => {
  const blocks: CodeBlock[] = [{ code: 'a\n\nb' }, { code: 'c' }];

  it('numbers lines continuously across blocks and keeps block-relative numbers', () => {
    expect(pageLines(blocks)).toEqual([
      { n: 1, block: 0, lineNo: 1, text: 'a' },
      { n: 2, block: 0, lineNo: 2, text: '' },
      { n: 3, block: 0, lineNo: 3, text: 'b' },
      { n: 4, block: 1, lineNo: 1, text: 'c' },
    ]);
  });

  it('puts a small page in one chunk without blank lines', () => {
    const chunks = chunkPage(blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.map((l) => l.n)).toEqual([1, 3, 4]);
  });

  it('splits long pages on line boundaries within the size budget', () => {
    const code = Array.from({ length: 30 }, (_, i) => `line ${i + 1} ${'x'.repeat(20)}`).join('\n');
    const chunks = chunkPage([{ code }], 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().map((l) => l.lineNo)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    for (const c of chunks) expect(c.map((l) => l.text).join('\n').length).toBeLessThanOrEqual(100);
  });

  it('truncates a single overlong line instead of dropping it', () => {
    const chunks = chunkPage([{ code: 'short\n' + 'y'.repeat(50) }], 20);
    expect(chunks.at(-1)).toEqual([{ n: 2, block: 0, lineNo: 2, text: 'y'.repeat(20) }]);
  });

  it('normalizes CRLF and returns nothing for blank pages', () => {
    expect(chunkPage([{ code: 'a\r\nb' }])[0]!.map((l) => l.text)).toEqual(['a', 'b']);
    expect(chunkPage([{ code: '   \n\n' }])).toEqual([]);
  });
});

describe('buildScanPrompt', () => {
  it('shows block headers and continuous numbers', () => {
    const blocks: CodeBlock[] = [{ code: 'foo()', language: 'js' }, { code: 'bar()' }];
    const prompt = buildScanPrompt(chunkPage(blocks)[0]!, blocks, { title: 'T' }, ['firebase']);
    expect(prompt).toContain('--- block 1 (js) ---\n1| foo()\n--- block 2 ---\n2| bar()');
    expect(prompt).toContain('Page: T');
    expect(prompt).toContain('firebase');
  });

  it('omits a missing title', () => {
    const blocks = [{ code: 'x' }];
    expect(buildScanPrompt(chunkPage(blocks)[0]!, blocks, {}, [])).not.toContain('Page:');
  });
});

describe('couldUseLibraryApi', () => {
  it.each([
    "import firebase from 'firebase/app';",
    "from openai import OpenAI",
    'npm install firebase@8.10.0',
    'pip install openai==0.27.0',
    'firebase.initializeApp(firebaseConfig);',
    "  .orderBy('createdAt')",
    'const db = getFirestore(app);',
    'X = tf.placeholder(tf.float32)',
    'auth.signInAnonymously().catch((error) => {',
    "  .onSnapshot((snapshot) => {",
    'except openai.error.RateLimitError:',
    'createdAt: firebase.firestore.FieldValue.serverTimestamp(),',
    "ReactDOM.hydrate(<Counter />, document.getElementById('root'));",
    'li.textContent = doc.data().text;',
    "const x = require('firebase');",
  ])('keeps library use: %s', (line) => expect(couldUseLibraryApi(line)).toBe(true));

  it.each([
    "  console.error('Sign-in failed', error);",
    "const li = document.createElement('li');",
    'list.appendChild(li);',
    'snapshot.forEach((doc) => {',
    'const trimmed = text.trim();',
    'if (user) {',
    "    with open(sys.argv[1], encoding=\"utf-8\") as f:",
    "return response['choices'][0]['text'].strip()",
    'print(len(items))',
  ])('drops built-in-only lines: %s', (line) => expect(couldUseLibraryApi(line)).toBe(false));

  it.each([
    "  apiKey: 'YOUR_API_KEY',",
    "  authDomain: 'your-app.firebaseapp.com',",
    '  projectId: "my.project",',
    'const x = 1;',
    '};',
    "  name: 'it\\'s.here',", // escaped quote inside the string literal
  ])('drops data-only lines: %s', (line) => expect(couldUseLibraryApi(line)).toBe(false));
});

describe('extractJsonObject', () => {
  it('finds JSON inside code fences and prose', () => {
    expect(extractJsonObject('Sure!\n```json\n{"a":1}\n```\nHope that helps')).toBe('{"a":1}');
  });

  it('ignores braces inside strings', () => {
    expect(extractJsonObject('{"r":"uses } and { and \\" quotes","n":1} tail')).toBe('{"r":"uses } and { and \\" quotes","n":1}');
  });

  it('returns null for missing or cut-off JSON', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('{"flagged":[{"line":1')).toBeNull();
  });
});

describe('parseScanResponse', () => {
  const blocks: CodeBlock[] = [{ code: "const db = firebase.firestore();\n\ndb.collection('x').get();" }, { code: 'ReactDOM.render(a, b);' }];
  const chunk = chunkPage(blocks)[0]!;

  it('maps page line numbers back to blocks and takes code from the page', () => {
    const out = parseScanResponse(
      JSON.stringify({
        lib: 'Firebase',
        flagged: [
          { line: 1, lib: 'firebase', api: 'firebase.firestore()', conf: 0.9, code: 'HALLUCINATED' },
          { line: 4, lib: 'React-DOM', api: 'ReactDOM.render', conf: 0.8 },
        ],
      }),
      chunk,
    );
    expect(out).toEqual({
      library: 'firebase',
      flagged: [
        { block: 0, lineNo: 1, code: 'const db = firebase.firestore();', library: 'firebase', reason: 'firebase.firestore()', confidence: 0.9 },
        { block: 1, lineNo: 1, code: 'ReactDOM.render(a, b);', library: 'react-dom', reason: 'ReactDOM.render', confidence: 0.8 },
      ],
    });
  });

  it('accepts long key names, fences, trailing commas and string numbers', () => {
    const out = parseScanResponse(
      '```json\n{"library":"firebase","flagged":[{"lineNo":"1","reason":"x","confidence":"0.7",},],}\n```',
      chunk,
    );
    expect(out?.flagged).toEqual([
      { block: 0, lineNo: 1, code: 'const db = firebase.firestore();', library: 'firebase', reason: 'x', confidence: 0.7 },
    ]);
  });

  it('reads the sure/maybe format, with sure winning over maybe', () => {
    const out = parseScanResponse('{"lib":"firebase","sure":[1],"maybe":[1,3]}', chunk);
    expect(out?.flagged.map((f) => [f.lineNo, f.confidence, f.library])).toEqual([
      [1, SURE_CONFIDENCE, 'firebase'],
      [3, MAYBE_CONFIDENCE, 'firebase'],
    ]);
  });

  it('drops flags on config values and plain data', () => {
    const code = ['const cfg = {', "  apiKey: 'YOUR_API_KEY',", "  authDomain: 'x.firebaseapp.com',", '};', 'firebase.initializeApp(cfg);'];
    const blocks2: CodeBlock[] = [{ code: code.join('\n') }];
    const out = parseScanResponse('{"lib":"firebase","sure":[2,3,5]}', chunkPage(blocks2)[0]!);
    expect(out?.flagged.map((f) => f.lineNo)).toEqual([5]);
  });

  it('falls back to the chunk library when a flag has none', () => {
    const out = parseScanResponse('{"lib":"firebase","flagged":[{"line":3}]}', chunk);
    expect(out?.flagged[0]?.library).toBe('firebase');
  });

  it('drops out-of-range, blank, duplicate and malformed flags', () => {
    const out = parseScanResponse(
      JSON.stringify({
        flagged: [
          { line: 0 },
          { line: 2 }, // blank line, never shown to the model
          { line: 99 },
          { line: 1.5 },
          { line: 'abc' },
          null,
          'junk',
          { line: 3, api: 'a' },
          { line: 3, api: 'duplicate' },
        ],
      }),
      chunk,
    );
    expect(out?.flagged.map((f) => [f.lineNo, f.reason])).toEqual([[3, 'a']]);
  });

  it('normalizes confidence values', () => {
    const out = parseScanResponse('{"flagged":[{"line":1,"conf":85},{"line":3,"conf":-2},{"line":4}]}', chunk);
    expect(out?.flagged.map((f) => f.confidence)).toEqual([0.85, 0, 0.5]);
  });

  it('maps "none"-like libraries to null and handles missing fields', () => {
    expect(parseScanResponse('{"lib":"none"}', chunk)).toEqual({ library: null, flagged: [] });
    expect(parseScanResponse('{}', chunk)).toEqual({ library: null, flagged: [] });
  });

  it('returns null when there is no usable JSON', () => {
    expect(parseScanResponse('I cannot help with that.', chunk)).toBeNull();
    expect(parseScanResponse('[1,2,3]', chunk)).toBeNull();
  });
});

/**
 * A stand-in for Gemini Nano: flags numbered lines that match known legacy
 * patterns, like a perfect model would. It lets us test the pipeline on the
 * real fixtures without Firebase.
 */
const LEGACY: [RegExp, string][] = [
  [/firebase\.(initializeApp|firestore|auth)\(|from 'firebase\/app'|\.collection\(|FieldValue|signInAnonymously|onAuthStateChanged/, 'firebase'],
  [/ReactDOM\.(render|hydrate)|from 'react-dom'/, 'react-dom'],
  [/openai\.(Completion|api_key|error)|engine=/, 'openai'],
  [/tf\.(placeholder|Session|train\.|global_variables_initializer)|feed_dict/, 'tensorflow'],
];

function fakeScanModel(source: (call: number) => 'on_device' | 'in_cloud' = () => 'on_device') {
  let call = 0;
  const generateContent = vi.fn(async (prompt: string) => {
    const hits = [...prompt.matchAll(/^(\d+)\| (.*)$/gm)].flatMap(([, n, code]) => {
      const hit = LEGACY.find(([re]) => re.test(code ?? ''));
      return hit ? [{ line: Number(n), lib: hit[1] }] : [];
    });
    return {
      response: {
        text: () => JSON.stringify({ lib: hits[0]?.lib ?? 'none', sure: hits.map((h) => h.line), maybe: [] }),
        inferenceSource: source(call++) === 'on_device' ? InferenceSource.ON_DEVICE : InferenceSource.IN_CLOUD,
      },
    };
  });
  return { model: { generateContent } as unknown as GenerativeModel, generateContent };
}

const settings = { trackedLibraries: ['firebase', 'react', 'openai', 'tensorflow'] };

describe('fixtures', () => {
  it('has the four demo pages, each with several code blocks', () => {
    const names = fixtureNames();
    expect(names).toHaveLength(4);
    for (const name of names) expect(loadFixture(name).blocks.length).toBeGreaterThan(1);
  });

  it('every fixture page fits in a single on-device prompt', () => {
    for (const name of fixtureNames()) {
      const { title, blocks } = loadFixture(name);
      const chunks = chunkPage(blocks);
      expect(chunks, name).toHaveLength(1);
      // ~4 chars per token is a conservative estimate for code; leave room for the answer.
      expect(buildScanPrompt(chunks[0]!, blocks, { title }, settings.trackedLibraries).length / 4).toBeLessThan(9216 / 2);
    }
  });
});

describe('scanPage', () => {
  it('scans a whole fixture page in one call, flags outdated lines and leaves current ones alone', async () => {
    for (const name of fixtureNames()) {
      const { title, blocks } = loadFixture(name);
      const { model, generateContent } = fakeScanModel();
      const page = await scanPage(model, blocks, { title }, settings);
      expect(generateContent, name).toHaveBeenCalledTimes(1);
      expect(page.prompts).toBe(1);
      expect(page.servedBy).toBe('on-device');
      expect(page.blocks).toHaveLength(blocks.length);

      const flagged = page.blocks.flatMap((r, i) =>
        r.flagged.map((f) => {
          expect(blocks[i]!.code.split('\n')[f.lineNo - 1]).toBe(f.code); // points at the real line
          return f.code.trim();
        }),
      );
      expect(flagged.length, name).toBeGreaterThan(1);
      // "No false alarms": lines that are still current must not be flagged.
      expect(flagged.some((c) => /useState|np\.random|tf\.Variable|rules_version|request\.auth|time\.sleep/.test(c)), name).toBe(false);
    }
  });

  it('hero fixture: flags the Firebase v8 init lines in the right block', async () => {
    const { title, blocks } = loadFixture('firebase-v8-firestore.html');
    const page = await scanPage(fakeScanModel().model, blocks, { title }, settings);
    const init = page.blocks[1]!;
    expect(init.library).toBe('firebase');
    expect(init.flagged.map((f) => f.code)).toEqual(
      expect.arrayContaining(['firebase.initializeApp(firebaseConfig);', 'const db = firebase.firestore();']),
    );
    expect(page.blocks.at(-1)!.flagged).toEqual([]); // security rules
    expect(page.linesScanned).toBe(blocks.reduce((n, b) => n + b.code.split('\n').filter((l) => l.trim()).length, 0));
  });

  it('keeps block-relative line numbers across chunks', async () => {
    const code = [...Array(400)].map((_, i) => `const v${i} = ${i}; // ${'pad '.repeat(10)}`);
    code[350] = 'ReactDOM.render(app, root);';
    const { model, generateContent } = fakeScanModel();
    const page = await scanPage(model, [{ code: 'x()' }, { code: code.join('\n') }], {}, settings);
    expect(generateContent.mock.calls.length).toBeGreaterThan(1);
    expect(page.blocks[1]!.flagged).toEqual([
      { lineNo: 351, code: 'ReactDOM.render(app, root);', library: 'react-dom', reason: '', confidence: SURE_CONFIDENCE },
    ]);
    expect(page.blocks[1]!.library).toBe('react-dom');
  });

  it('marks blocks and the page as cloud when a chunk fell back to the cloud', async () => {
    const code = [...Array(400)].map((_, i) => `x${i}(${'a'.repeat(40)})`).join('\n');
    const page = await scanPage(fakeScanModel((call) => (call === 1 ? 'in_cloud' : 'on_device')).model, [{ code }, { code: 'y()' }], {}, settings);
    expect(page.servedBy).toBe('cloud');
    expect(page.blocks[0]!.servedBy).toBe('cloud');
  });

  it('counts unparseable chunks instead of failing the whole page', async () => {
    const model = {
      generateContent: vi.fn(async () => ({
        response: { text: () => 'Sorry, I cannot do that.', inferenceSource: InferenceSource.ON_DEVICE },
      })),
    } as unknown as GenerativeModel;
    const page = await scanPage(model, [{ code: 'firebase.initializeApp(c);' }, { code: 'z()' }], {}, settings);
    expect(page.failedChunks).toBe(1);
    expect(page.blocks.map((b) => b.failedChunks)).toEqual([1, 1]);
    expect(page.blocks[0]).toMatchObject({ library: null, flagged: [], linesScanned: 1 });
  });

  it('makes no calls for a page without code', async () => {
    const { model, generateContent } = fakeScanModel();
    const page = await scanPage(model, [{ code: '\n  \n' }], {}, settings);
    expect(generateContent).not.toHaveBeenCalled();
    expect(page).toMatchObject({ prompts: 0, linesScanned: 0, servedBy: 'on-device' });
  });

  it('chunk size stays within the on-device budget', () => {
    expect(MAX_CHUNK_CHARS).toBeLessThanOrEqual(8000);
  });
});

describe('scanBlock', () => {
  it('scans a single block', async () => {
    const r = await scanBlock(fakeScanModel().model, "import ReactDOM from 'react-dom';\nconst x = 1;", { language: 'js' }, settings);
    expect(r.flagged.map((f) => f.lineNo)).toEqual([1]);
    expect(r.library).toBe('react-dom');
  });
});

describe('selectLinesToVerify', () => {
  const f = (confidence: number) => ({ confidence });

  it('keeps lines at or above the threshold, most confident first, up to the cap', () => {
    const out = selectLinesToVerify([f(0.5), f(0.9), f(0.6), f(0.7), f(0.95)], { minConfidenceToVerify: 0.6, maxCloudCallsPerPage: 3 });
    expect(out.map((x) => x.confidence)).toEqual([0.95, 0.9, 0.7]);
  });

  it('returns nothing for a zero or negative cap', () => {
    expect(selectLinesToVerify([f(1)], { minConfidenceToVerify: 0, maxCloudCallsPerPage: 0 })).toEqual([]);
    expect(selectLinesToVerify([f(1)], { minConfidenceToVerify: 0, maxCloudCallsPerPage: -1 })).toEqual([]);
  });
});
