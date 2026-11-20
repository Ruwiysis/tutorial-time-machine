# Tutorial Time-Machine

A Chrome extension and web app that warn you, while you read, when a coding tutorial's code is outdated, and show the modern fix inline.

It is built on **Firebase AI Logic hybrid inference**:

- Gemini Nano on-device scans every code block.
- Cloud Gemini with Google Search grounding verifies only the lines that were flagged.

> 🚧 Work in progress (#BuildHybridAI 2026). The full documentation lands in milestone 7.

## Repo layout

```
packages/core   shared logic: Firebase init, hybrid models, settings, grounding
apps/web        hosted web app (Vite)
apps/extension  Chrome MV3 extension (milestone 5)
fixtures/       demo tutorial pages with known-outdated code
firestore.rules · firebase.json · remoteconfig.template.json
```

## Setup

### 1. Firebase console

1. **Create a project.** The Spark plan is fine.
2. **Register a Web app.** Go to Project settings → Add app → Web and copy the config.
3. **Turn on AI Logic.** Go to Build → AI Logic → Get started and choose the **Gemini Developer API**.
4. **Turn on anonymous sign-in.** Go to Build → Authentication → Sign-in method and enable **Anonymous**.
5. **Create Firestore.** Go to Build → Firestore Database → Create database and choose Production mode.
6. **Set up App Check** (required: AI Logic rejects requests without it):
   - In the Google Cloud console → Security → reCAPTCHA, create a score-based **Web** key. For domains, use `<project>.web.app` and `<project>.firebaseapp.com`. Don't add `localhost`.
   - In Firebase → Security → App Check → Apps, register the web app with **reCAPTCHA Enterprise** and the site key from the previous step.
   - Go to ⋮ → **Manage debug tokens** and generate one token for local dev and one for the Chrome extension.

### 2. Local

```bash
npm install
npm i -g firebase-tools && firebase login
firebase use --add                 # pick your project
cp .env.example .env.local         # fill in the values (see comments in the file)
npm run deploy:rules               # deploys Firestore rules + Remote Config template
npm run dev:web                    # http://localhost:5173
npm test
```

### App Check debug tokens

- **localhost:** set `VITE_APPCHECK_DEBUG_TOKEN` in `.env.local`. If you leave it empty, the SDK prints a new token in the browser console. Register that token in the console.
- **Production web builds:** these never include the debug token. They use reCAPTCHA Enterprise.
- **Chrome extension:** reCAPTCHA can't run in an extension, so it uses its own registered debug token. The hackathon rules accept debug tokens.

### On-device Gemini Nano (desktop Chrome)

1. Use Chrome 139 or later.
2. Set `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` to **Enabled**, then restart Chrome.
3. Check `await LanguageModel.availability()` in DevTools. If it returns `downloadable`, use the app's "Download on-device model" button.

Without Nano, `PREFER_ON_DEVICE` falls back to the cloud automatically, and the UI shows which path ran.

## License

[Apache-2.0](LICENSE)
