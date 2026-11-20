/**
 * On-device (Gemini Nano) availability, read from Chrome's Prompt API.
 *
 * The Firebase SDK performs a similar check internally to decide between
 * on-device and cloud. We expose it separately so the UI can tell the user
 * up front which path will run, and offer a model download if needed.
 */
export type DeviceModelStatus =
  | 'available' // Nano is ready, and scans will run on-device
  | 'downloadable' // supported, but the model must be downloaded (needs a user click)
  | 'downloading'
  | 'unavailable' // the browser has the API, but this device can't run Nano
  | 'unsupported' // there is no Prompt API in this browser or context
  | 'stub'; // the API exists, but it's Chromium's echo placeholder with no real model

const ENGLISH_TEXT = [{ type: 'text' as const, languages: ['en'] }];

/**
 * Non-Chrome Chromium builds (and some Chromium-based browsers) ship the Prompt
 * API wired to an "echo" model. It reports `available`, so the Firebase SDK
 * would happily route PREFER_ON_DEVICE requests to it, and the reply is just
 * the prompt echoed back under this banner.
 */
const ECHO_STUB_MARKER = /^\s*On-device model is not available in Chromium/i;

export function isEchoStubResponse(text: string): boolean {
  return ECHO_STUB_MARKER.test(text);
}

let probeResult: Promise<boolean> | undefined;

/**
 * Sends one tiny prompt to the local model to check it's real. Runs at most
 * once per page load, and only when the API already says `available`
 * (creating a session in any other state could trigger a model download).
 */
function probeIsEchoStub(): Promise<boolean> {
  probeResult ??= (async () => {
    let session: LanguageModel | undefined;
    try {
      session = await LanguageModel.create({ expectedInputs: ENGLISH_TEXT, expectedOutputs: ENGLISH_TEXT });
      return isEchoStubResponse(await session.prompt('Reply with the single word OK.'));
    } catch {
      return false; // a failing probe isn't proof of a stub; let the SDK decide
    } finally {
      session?.destroy();
    }
  })();
  return probeResult;
}

export async function getDeviceModelStatus(): Promise<DeviceModelStatus> {
  if (typeof LanguageModel === 'undefined' || typeof LanguageModel.availability !== 'function') {
    return 'unsupported';
  }
  let status: DeviceModelStatus;
  try {
    status = await LanguageModel.availability({
      expectedInputs: ENGLISH_TEXT,
      expectedOutputs: ENGLISH_TEXT,
    });
  } catch {
    return 'unavailable';
  }
  if (status === 'available' && (await probeIsEchoStub())) return 'stub';
  return status;
}
