import type { TtmInitOptions } from '@ttm/core';

/**
 * Builds Firebase init options from Vite env vars (see .env.example).
 *
 * SECURITY: always read `import.meta.env.VITE_X` one property at a time.
 * Touching `import.meta.env` as a whole object (e.g. `const e = import.meta.env`)
 * makes Vite inline EVERY VITE_* variable into the bundle, which once shipped
 * the App Check debug token to production. scripts/check-dist.mjs now fails
 * the build if that ever happens again.
 */
export function readEnvConfig(): TtmInitOptions {
  const firebase = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };
  const missing = Object.entries(firebase)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing Firebase config in .env.local: ${missing.join(', ')}`);
  }

  return {
    firebase,
    recaptchaSiteKey: import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY || undefined,
    // App Check: localhost can't use reCAPTCHA (localhost must never be added to
    // the key's domains), so dev builds use the debug provider. If no token is
    // set yet, `true` makes the SDK print a new one to register. In production
    // builds `import.meta.env.DEV` is the literal `false`, so this whole branch,
    // token included, is removed from the bundle.
    appCheckDebugToken: import.meta.env.DEV ? import.meta.env.VITE_APPCHECK_DEBUG_TOKEN || true : undefined,
    remoteConfigFetchIntervalMs: import.meta.env.DEV ? 0 : 60 * 60 * 1000,
  };
}
