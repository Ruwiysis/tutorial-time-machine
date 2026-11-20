import type { TtmInitOptions } from '@ttm/core';

/**
 * Firebase options for the extension (see .env.example).
 *
 * App Check: reCAPTCHA can't run inside an extension, so the extension uses
 * its own App Check debug token, which is built into the extension. That is
 * the documented trade-off for extensions; the token is separate from the web
 * app's, so it can be revoked on its own (Firebase console > App Check).
 *
 * Read `import.meta.env.VITE_X` one property at a time: touching
 * `import.meta.env` as a whole would inline every VITE_* variable.
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
  if (missing.length) throw new Error(`Missing Firebase config in .env.local: ${missing.join(', ')}`);

  const token = import.meta.env.VITE_EXTENSION_APPCHECK_DEBUG_TOKEN;
  if (!token) throw new Error('Missing VITE_EXTENSION_APPCHECK_DEBUG_TOKEN in .env.local (App Check debug token for the extension).');

  return {
    firebase,
    appCheckDebugToken: token,
    remoteConfigFetchIntervalMs: 60 * 60 * 1000,
  };
}
