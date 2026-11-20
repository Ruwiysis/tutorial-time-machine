/**
 * Google Search grounding display data.
 *
 * Google's terms for grounded results require two things on screen:
 *   1. the "Search suggestions" widget, rendered verbatim from
 *      searchEntryPoint.renderedContent (we put it inside a shadow DOM), and
 *   2. links to the sources (groundingChunks[].web).
 */
import type { EnhancedGenerateContentResponse } from 'firebase/ai';

export interface GroundingSource {
  uri: string;
  title: string;
}

export interface GroundingInfo {
  /** True when the response carries groundingMetadata with a searchEntryPoint. */
  grounded: boolean;
  /** HTML+CSS for the Search suggestions chip. Render it unmodified. */
  searchEntryPointHtml?: string;
  sources: GroundingSource[];
  webSearchQueries: string[];
}

export function extractGrounding(
  response: Pick<EnhancedGenerateContentResponse, 'candidates'>,
): GroundingInfo {
  const meta = response.candidates?.[0]?.groundingMetadata;
  const seen = new Set<string>();
  const sources: GroundingSource[] = [];
  for (const chunk of meta?.groundingChunks ?? []) {
    const uri = chunk.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ uri, title: chunk.web?.title || chunk.web?.domain || uri });
  }
  const html = meta?.searchEntryPoint?.renderedContent;
  return {
    grounded: Boolean(html),
    searchEntryPointHtml: html || undefined,
    sources,
    webSearchQueries: meta?.webSearchQueries ?? [],
  };
}
