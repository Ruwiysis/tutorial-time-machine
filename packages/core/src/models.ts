/**
 * The two models behind the hybrid pipeline.
 *
 *   scan model   → PREFER_ON_DEVICE. Gemini Nano in Chrome reads every code
 *                  block on every page. This is free, instant and private, because
 *                  page content never leaves the machine. If Nano is unavailable,
 *                  the SDK transparently falls back to the cloud model.
 *
 *   verify model → ONLY_IN_CLOUD + Google Search grounding. Nano's knowledge
 *                  is frozen at training time and it cannot use tools, so
 *                  "is this API still current?" must be answered by a cloud
 *                  model that can search today's docs. It only ever sees the
 *                  few lines the scan flagged, never the whole page.
 */
import {
  getGenerativeModel,
  InferenceMode,
  InferenceSource,
  type AI,
  type EnhancedGenerateContentResponse,
  type GenerativeModel,
  type ObjectSchema,
} from 'firebase/ai';
import type { DeviceModelStatus } from './device';
import type { RuntimeSettings } from './settings';

/** Which path produced a result. Shown in the UI as a badge. */
export type ServedBy = 'on-device' | 'cloud' | 'cache';

const ENGLISH_TEXT = [{ type: 'text' as const, languages: ['en'] }];

export interface ScanModelOptions {
  systemInstruction?: string;
  /** JSON schema, enforced on-device via responseConstraint and in-cloud via responseSchema. */
  responseSchema?: ObjectSchema;
  /** Result of getDeviceModelStatus(), used to catch on-device paths the SDK can't detect. */
  deviceStatus?: DeviceModelStatus;
}

/**
 * Hybrid routing decision for the scan step.
 *
 * Normally we hand the Remote Config mode straight to the SDK, which picks
 * on-device or cloud per request. The one case the SDK can't detect is
 * Chromium's echo stub: it claims to be available, but returns the prompt
 * instead of an answer. Then we force the cloud so the scan still works,
 * and the UI honestly shows "Cloud" instead of a fake "On-device".
 */
export function effectiveScanMode(mode: InferenceMode, deviceStatus?: DeviceModelStatus): InferenceMode {
  if (deviceStatus !== 'stub') return mode;
  // ONLY_ON_DEVICE is kept as-is: it's an explicit "never use the cloud" setting.
  return mode === InferenceMode.ONLY_ON_DEVICE ? mode : InferenceMode.ONLY_IN_CLOUD;
}

export function createScanModel(
  ai: AI,
  settings: RuntimeSettings,
  options: ScanModelOptions = {},
): GenerativeModel {
  const { systemInstruction, responseSchema, deviceStatus } = options;
  return getGenerativeModel(ai, {
    // PREFER_ON_DEVICE unless Remote Config overrides it or the device is a stub.
    mode: effectiveScanMode(settings.scanInferenceMode, deviceStatus),
    onDeviceParams: {
      createOptions: { expectedInputs: ENGLISH_TEXT, expectedOutputs: ENGLISH_TEXT },
      ...(responseSchema && { promptOptions: { responseConstraint: responseSchema } }),
    },
    // Used only when on-device is unavailable (or Remote Config forces cloud).
    inCloudParams: {
      model: settings.cloudModelName,
      systemInstruction,
      generationConfig: {
        temperature: 0,
        ...(responseSchema && { responseMimeType: 'application/json', responseSchema }),
      },
    },
  });
}

export function createVerifyModel(
  ai: AI,
  settings: RuntimeSettings,
  systemInstruction?: string,
  { grounded = true }: { grounded?: boolean } = {},
): GenerativeModel {
  return getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD, // grounding is cloud-only, never on-device
    inCloudParams: {
      model: settings.cloudModelName,
      systemInstruction,
      ...(grounded && { tools: [{ googleSearch: {} }] }),
      // No responseSchema here: we don't rely on grounding + strict JSON
      // working together. The prompt asks for JSON and we parse defensively.
      generationConfig: { temperature: 0.2 },
    },
  });
}

/** Maps the SDK's inferenceSource to our badge value. */
export function servedByFromResponse(response: EnhancedGenerateContentResponse): ServedBy {
  return response.inferenceSource === InferenceSource.ON_DEVICE ? 'on-device' : 'cloud';
}

/** True when the Gemini API rejected a request for quota or rate-limit reasons (HTTP 429). */
export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { customErrorData?: { status?: number } }).customErrorData?.status;
  if (status === 429) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /\[429\b|RESOURCE_EXHAUSTED/.test(message);
}

export interface VerifyModels {
  /** Cloud model with the googleSearch tool (preferred). */
  grounded: GenerativeModel;
  /** Same cloud model without tools, used only when grounding is out of quota. */
  ungrounded: GenerativeModel;
}

/**
 * Runs the verify step, preferring Google Search grounding.
 *
 * Search grounding has its own, much smaller quota (on the free tier it may be
 * zero). Rather than failing the whole check, we retry once on the same model
 * without the tool. That answer comes from the model's own knowledge, so
 * callers must label it "not search-verified" and must not cache it as if it
 * had been grounded.
 */
export async function generateVerify(
  models: VerifyModels,
  prompt: string,
): Promise<{ response: EnhancedGenerateContentResponse; grounded: boolean }> {
  try {
    const { response } = await models.grounded.generateContent(prompt);
    return { response, grounded: true };
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    console.warn('[ttm] Search grounding hit a quota limit; retrying without Search.', err);
    try {
      const { response } = await models.ungrounded.generateContent(prompt);
      return { response, grounded: false };
    } catch (retryErr) {
      if (isQuotaError(retryErr) && retryErr instanceof Error) {
        retryErr.message = `Grounded call and the retry without Search both hit a quota limit. ${retryErr.message}`;
      }
      throw retryErr;
    }
  }
}
