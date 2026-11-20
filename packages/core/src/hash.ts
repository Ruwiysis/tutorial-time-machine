/**
 * Cache keys for verified lines.
 *
 * The same outdated line appears in many tutorials with cosmetic differences
 * (indentation, spacing, a trailing semicolon). Normalizing before hashing
 * lets all of them share one cache entry, so a fix verified once in the cloud
 * is reused for every later reader, on any page.
 */

/** Removes differences that never change what a line means. */
export function normalizeCodeLine(code: string): string {
  return code
    .trim()
    .replace(/\s+/g, ' ') // indentation and spacing
    .replace(/\s*[;,]+$/, ''); // trailing ";" or "," (statement end, last object key)
}

export function normalizeLibrary(library: string): string {
  return library.trim().toLowerCase();
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Version of the verification prompt and answer format. Cache entries are
 * immutable (no client can edit or delete them), so when the prompt improves
 * we bump this and start a fresh key space; old answers are simply never
 * looked up again. v1 had no "judge only the line itself" rule.
 */
export const CACHE_VERSION = 2;

/**
 * Firestore document id for a verified line: 64 lowercase hex characters.
 *
 *   grounded:   SHA-256("v2\n" + library + "\n" + normalized line)
 *   ungrounded: SHA-256("v2\nungrounded\n" + library + "\n" + normalized line)
 *
 * Answers made without Google Search (e.g. when grounding is out of quota)
 * live under a different key, so they can never block a Search-verified
 * entry for the same line from being stored later.
 */
export function cacheKey(library: string, code: string, grounded = true): Promise<string> {
  const base = `${normalizeLibrary(library)}\n${normalizeCodeLine(code)}`;
  return sha256Hex(`v${CACHE_VERSION}\n${grounded ? '' : 'ungrounded\n'}${base}`);
}
