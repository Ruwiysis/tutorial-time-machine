import type { TtmInitOptions } from '@ttm/core';

/** Builds Firebase init options from Vite env vars (see .env.example). */
export function readEnvConfig(): TtmInitOptions {
  const e = import.meta.env;
  const firebase = {
    apiKey: e.VITE_FIREBASE_API_KEY,
    authDomain: e.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: e.VITE_FIREBASE_PROJECT_ID,
    storageBucket: e.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: e.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: e.VITE_FIREBASE_APP_ID,
  };
  const missing = Object.entries(firebase)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing Firebase config in .env.local: ${missing.join(', ')}`);
  }

  // App Check: localhost can't use reCAPTCHA (localhost must never be added to the
  // key's domains), so dev builds use the debug provider. If no token is set yet,
  // `true` makes the SDK print a new one in the console for you to register.
  // Production builds never include the debug token.
  const appCheckDebugToken = e.DEV ? e.VITE_APPCHECK_DEBUG_TOKEN || true : undefined;

  return {
    firebase,
    recaptchaSiteKey: e.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY || undefined,
    appCheckDebugToken,
    remoteConfigFetchIntervalMs: e.DEV ? 0 : 60 * 60 * 1000,
  };
}
