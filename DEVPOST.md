# Tutorial Time-Machine

**Tagline:** Coding tutorials age fast. See which lines are outdated, and the modern fix, while you read.

**Try it:** https://tutorial-time-machine.web.app · **Code:** https://github.com/Ruwiysis/tutorial-time-machine

---

## Inspiration

Every developer has done this: find a tutorial that looks perfect, copy the code, and lose an hour to `firebase is not defined`, `ReactDOM.render is not a function` or `module 'tensorflow' has no attribute 'Session'`. The tutorial isn't wrong. It's just old, and nothing on the page tells you so.

The fix is usually small and well known: `firebase.firestore()` becomes `getFirestore(app)`. What's missing is someone pointing at the right line while you read. That job fits hybrid AI well:
- a small local model can read *everything* for free;
- a cloud model with search knows *what's current*;
- a shared cache means each fix only has to be found once.

## What it does

Tutorial Time-Machine is a **Chrome extension** and a **web app**.

- Open any page with code. Each code block gets markers: 🟡 checking, 🔴 outdated, 🟢 still current.
- Click a 🔴 line for an old-vs-modern diff, a one-or-two-sentence explanation naming the versions involved, the sources, and **Copy fix**.
- A side panel shows the three steps of the check as they run and a **savings meter**: *"51 lines scanned on device · 0 sent to cloud · 13 served from cache"*.
- Every result carries a badge saying which path produced it: **⚡ On-device**, **📦 Cache** or **☁️ Cloud**.
- The web app runs the same pipeline on four demo tutorials or on code you paste, for anyone without the extension.

## How we built it: Firebase AI Logic hybrid inference

The pipeline has three steps, and each one runs where it makes the most sense.

1. **⚡ Scan on-device: Gemini Nano through Firebase AI Logic, `PREFER_ON_DEVICE`.**
   - Every code block on the page goes into a single structured-output prompt.
   - Nano returns the library plus "sure" and "maybe" lists of line numbers whose API might differ between major versions.
   - It's free, private (the page never leaves the browser) and has no network latency.
   - If Nano isn't available, the SDK runs the same request in the cloud, and the UI shows ☁️ instead of ⚡.
2. **📦 Shared cache in Firestore.**
   - Each flagged line is normalized and hashed (SHA-256 of library + line).
   - If any reader has already had it verified, the answer comes back in about a second with no model call.
3. **☁️ Verify in the cloud: Gemini, `ONLY_IN_CLOUD` with the Google Search tool.**
   - Only flagged, uncached lines are sent, batched by library (up to 8 lines per request), with a per-page budget from Remote Config.
   - Nano's knowledge is frozen at training time. In testing it confidently called `firebase.firestore()` "modern".
   - So the *judgement* belongs to a model that can check today's docs, and Nano only *points*.
   - Results are written back to the cache for the next reader.

**Other Firebase products:**
- **App Check:** reCAPTCHA Enterprise on the web, separate revocable debug tokens for localhost and the extension.
- **Anonymous Authentication:** cache entries record who created them. The extension uses the `web-extension` Auth build, which has no remote code.
- **Firestore security rules:** public read, create-only, schema-validated, immutable.
- **Remote Config:** cloud model, inference mode, confidence threshold, cloud budget, tracked libraries.
- **Hosting.**

**Stack:**
- TypeScript monorepo (npm workspaces): a shared `core` pipeline package and a framework-free `ui` package used by both front ends.
- Vite for the web app and the Manifest V3 extension.
- 118 Vitest tests, with Firebase mocked.

## Challenges we ran into

- **On-device speed.** The first version took **117 s** for a 51-line page: one prompt per code block, with a sentence of reasoning per flagged line. On-device latency is dominated by output tokens. Scanning the whole page in **one prompt** and having Nano answer with **line numbers only** brought it down to **~16 s**, with better recall. Warming the model up when the page opens hides the cold start.
- **Small models flag noise.** Nano flagged config values (`apiKey: '…'`) and built-ins (`console.error`, `list.appendChild`). Telling it "don't" didn't help. A small **deterministic filter** did: it strips string literals and requires a non-built-in call, member access or import. Nano proposes, code filters, the cloud decides.
- **A browser that pretends to have Nano.** One Chromium build exposes the Prompt API but only echoes the prompt back, and it reports itself as "available". The SDK routed to it, and the UI proudly showed ⚡ on garbage. We detect the echo with a one-off test prompt and route the scan to the cloud.
- **Free tier vs. grounding.** Google Search grounding isn't available on the free tier for Gemini 3.x models, and the first model we picked was closed to new projects. Because the model name is in **Remote Config**, we switched models twice without shipping code. When grounding returns 429, we retry without the Search tool, label the answer **"no Search"**, and cache it under a separate key so a Search-verified answer can still replace it.
- **Extensions aren't covered by Firebase's docs.** We built a feasibility check first. App Check debug tokens, the `web-extension` Auth build, Remote Config, the Prompt API and Firebase's on-device path all work in an MV3 side panel. All AI runs there, never in the content script or the service worker.
- **A leaked secret, caught and fenced.** Reading `import.meta.env` as one object made Vite inline *every* `VITE_*` variable, including the local App Check debug token, into the first production deploy. We found it by scanning our own deployed bundle, rotated the token, and added a build step that fails if any token value from `.env.local` appears in the output.

## Accomplishments that we're proud of

- The hybrid split is visible and honest everywhere: badges on every result, a live three-step strip, and a savings meter. On the second visit to a tutorial, **100% of lines stay on the device** and the cloud isn't called at all.
- The markers land on exactly the right line on real pages, including syntax-highlighted code and chained calls.
- One pipeline (`checkPage()`) and one set of UI components power both the web app and the extension.

## What we learned

- On-device models are great *filters* and poor *judges*. Design the prompt around what a small model does reliably.
- Output tokens are the on-device latency budget. Make the model answer with numbers, not prose.
- Every fallback should be visible in the UI, not just handled.

## What's next

- Write cache entries from a trusted backend (a Cloud Function that runs the verification) and enforce App Check on Firestore, to close the cache-poisoning gap. Add "report a wrong fix".
- Multi-line context for chained calls, so a whole statement is fixed at once.
- More ecosystems (Next.js, Angular, LangChain, pandas), with library hints from `package.json`/`requirements.txt` snippets on the page.
- Publish the extension on the Chrome Web Store.

## Built with

Firebase AI Logic (hybrid inference: Gemini Nano + Gemini, Google Search grounding) · Firebase App Check (reCAPTCHA Enterprise) · Firebase Authentication · Cloud Firestore · Firebase Remote Config · Firebase Hosting · Chrome Prompt API · Chrome Extensions (Manifest V3, Side Panel) · TypeScript · Vite · Vitest
