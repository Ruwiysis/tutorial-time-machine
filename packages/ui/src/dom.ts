/** Tiny DOM helper. Text is always set with textContent, never parsed as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; title?: string; attrs?: Record<string, string> } = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

/** Only http(s) links from model output are ever rendered as anchors. */
export function safeLink(uri: string, text: string): HTMLAnchorElement | null {
  if (!/^https?:\/\//i.test(uri)) return null;
  return el('a', { text, attrs: { href: uri, target: '_blank', rel: 'noopener noreferrer' } });
}
