/**
 * Finds code blocks on a page and maps their lines back to screen positions.
 * Runs in the content script; no AI and no network here.
 */

export const MAX_BLOCKS = 40;
export const MAX_LINES_PER_BLOCK = 500;

export interface FoundBlock {
  /** The element whose text is the code (the <code> inside a <pre>, or the <pre>). */
  root: HTMLElement;
  /** The visible box of the block, used to clip markers. */
  box: HTMLElement;
  code: string;
  language?: string;
  /** Text nodes in order, with their start offset in `code`. */
  nodes: { node: Text; start: number }[];
}

/** Reads "language-js", "lang-python", "highlight-source-ts" style class names. */
export function languageFromClass(className: string): string | undefined {
  const m = /(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/i.exec(className);
  return m?.[1]?.toLowerCase();
}

function readText(root: HTMLElement): { code: string; nodes: FoundBlock['nodes'] } {
  const nodes: FoundBlock['nodes'] = [];
  let code = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      nodes.push({ node: n as Text, start: code.length });
      code += (n as Text).data;
    } else if ((n as Element).tagName === 'BR') {
      code += '\n';
    }
  }
  return { code: code.replace(/\r\n?/g, '\n').replace(/\n+$/, ''), nodes };
}

export function findCodeBlocks(doc: Document = document): FoundBlock[] {
  const blocks: FoundBlock[] = [];
  for (const pre of doc.querySelectorAll('pre')) {
    if (blocks.length >= MAX_BLOCKS) break;
    if (pre.closest('[contenteditable=""], [contenteditable="true"], textarea, #ttm-overlay-host')) continue;
    if (!pre.getClientRects().length) continue; // hidden
    const root = (pre.querySelector(':scope > code') as HTMLElement | null) ?? pre;
    const { code, nodes } = readText(root);
    const lines = code.split('\n');
    if (code.trim().length < 10 || lines.length > MAX_LINES_PER_BLOCK) continue;
    const language =
      languageFromClass(root.className) ?? languageFromClass(pre.className) ?? languageFromClass(pre.parentElement?.className ?? '');
    blocks.push({ root, box: pre, code, language, nodes });
  }
  return blocks;
}

/** Offset in `code` where line `lineNo` (1-based) starts. */
export function lineStartOffset(code: string, lineNo: number): number {
  let offset = 0;
  for (let i = 1; i < lineNo; i++) {
    const next = code.indexOf('\n', offset);
    if (next < 0) return -1;
    offset = next + 1;
  }
  return offset;
}

/**
 * Screen rectangle of a line's first visible character, or null if the line
 * is empty or not rendered.
 */
export function lineRect(block: FoundBlock, lineNo: number): DOMRect | null {
  let offset = lineStartOffset(block.code, lineNo);
  if (offset < 0) return null;
  // Skip leading indentation so the rect sits on real text.
  while (block.code[offset] === ' ' || block.code[offset] === '\t') offset++;
  if (block.code[offset] === '\n' || offset >= block.code.length) return null;
  const hit = block.nodes.find(({ node, start }) => offset >= start && offset < start + node.data.length);
  if (!hit) return null;
  const range = document.createRange();
  range.setStart(hit.node, offset - hit.start);
  range.setEnd(hit.node, offset - hit.start + 1);
  return range.getClientRects()[0] ?? null;
}
