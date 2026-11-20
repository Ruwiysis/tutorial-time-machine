/**
 * Firebase bootstrap shared by the web app and the Chrome extension.
 *
 * Order matters:
 *   1. initializeApp
 *   2. App Check, which must exist before any other service makes a request.
 *      It is mandatory for Firebase AI Logic.
 *   3. Anonymous Auth (Firestore rules require a signed-in user to write cache entries)
 *   4. Remote Config (hybrid routing knobs)
 *   5. Firebase AI Logic (getAI with the Gemini Developer API backend)
 */
import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from 'firebase/app-check';
import { getAuth, signInAnonymously, type Auth, type User } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import {
  fetchAndActivate,
  getRemoteConfig,
  getValue,
  type RemoteConfig,
} from 'firebase/remote-config';
import { getAI, GoogleAIBackend, type AI } from 'firebase/ai';
import { parseSettings, RC_DEFAULTS, type RuntimeSettings } from './settings';

declare global {
  // Read by the App Check SDK. Set it before initializeAppCheck() to use the
  // debug provider (localhost and the Chrome extension).
  // eslint-disable-next-line no-var
  var FIREBASE_APPCHECK_DEBUG_TOKEN: boolean | string | undefined;
}

export interface TtmInitOptions {
  firebase: FirebaseOptions;
  /** reCAPTCHA Enterprise site key (production web app). */
  recaptchaSiteKey?: string;
  /**
   * App Check debug token. Use it only in dev builds or in the extension, where
   * reCAPTCHA cannot run. Pass `true` to have the SDK print a new token to
   * the console so you can register it.
   */
  appCheckDebugToken?: string | boolean;
  /** Replay-protected App Check tokens for AI Logic calls. Default true. */
  limitedUseAppCheckTokens?: boolean;
  /** Remote Config minimum fetch interval. Default: 1 hour. */
  remoteConfigFetchIntervalMs?: number;
}

export type AppCheckMode = 'recaptcha-enterprise' | 'debug-token';
export type RemoteConfigStatus = 'fetched' | 'defaults';

export interface TtmServices {
  app: FirebaseApp;
  appCheck: AppCheck;
  appCheckMode: AppCheckMode;
  auth: Auth;
  user: User;
  db: Firestore;
  remoteConfig: RemoteConfig;
  remoteConfigStatus: RemoteConfigStatus;
  settings: RuntimeSettings;
  ai: AI;
}

let servicesPromise: Promise<TtmServices> | undefined;

/** Initializes Firebase once per page. Later calls return the same instance. */
export function initTtm(options: TtmInitOptions): Promise<TtmServices> {
  servicesPromise ??= doInit(options).catch((err) => {
    servicesPromise = undefined; // allow a retry after e.g. a network failure
    throw err;
  });
  return servicesPromise;
}

async function doInit(options: TtmInitOptions): Promise<TtmServices> {
  const app = initializeApp(options.firebase);

  // App Check
  const useDebug = options.appCheckDebugToken !== undefined && options.appCheckDebugToken !== '';
  if (useDebug) {
    globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = options.appCheckDebugToken;
  } else if (!options.recaptchaSiteKey) {
    throw new Error(
      'App Check is required: set VITE_RECAPTCHA_ENTERPRISE_SITE_KEY or an App Check debug token.',
    );
  }
  const appCheck = initializeAppCheck(app, {
    // When a debug token is set, the SDK uses the debug provider and ignores
    // this one. Some provider is still required by the API.
    provider: new ReCaptchaEnterpriseProvider(options.recaptchaSiteKey ?? 'debug-mode'),
    isTokenAutoRefreshEnabled: true,
  });

  // Anonymous Auth
  const auth = getAuth(app);
  await auth.authStateReady();
  const user = auth.currentUser ?? (await signInAnonymously(auth)).user;

  // Remote Config
  const remoteConfig = getRemoteConfig(app);
  remoteConfig.defaultConfig = RC_DEFAULTS;
  remoteConfig.settings.minimumFetchIntervalMillis =
    options.remoteConfigFetchIntervalMs ?? 60 * 60 * 1000;
  let remoteConfigStatus: RemoteConfigStatus = 'defaults';
  try {
    await fetchAndActivate(remoteConfig);
    remoteConfigStatus = 'fetched';
  } catch (err) {
    // Offline or not yet configured. The defaults are safe, so keep going.
    console.warn('[ttm] Remote Config fetch failed, using defaults', err);
  }
  const settings = parseSettings((key) => getValue(remoteConfig, key).asString());

  // Firebase AI Logic
  const ai = getAI(app, {
    backend: new GoogleAIBackend(),
    useLimitedUseAppCheckTokens: options.limitedUseAppCheckTokens ?? true,
  });

  return {
    app,
    appCheck,
    appCheckMode: useDebug ? 'debug-token' : 'recaptcha-enterprise',
    auth,
    user,
    db: getFirestore(app),
    remoteConfig,
    remoteConfigStatus,
    settings,
    ai,
  };
}
