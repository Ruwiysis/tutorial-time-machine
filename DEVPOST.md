# Tutorial Time-Machine

**Elevator pitch:** Stop debugging code that was outdated before you copied it. We mark stale lines in any coding tutorial and show the fix right next to them, checked on-device by Gemini Nano, verified in the cloud.

**Try it:** https://tutorial-time-machine.web.app · **Code:** https://github.com/Ruwiysis/tutorial-time-machine

---

## Inspiration

Most of us learn from tutorials, blog posts and old Stack Overflow answers. The problem is that libraries move on and the tutorials don't. You copy code that looks fine and get errors like `firebase is not defined` or `ReactDOM.render is not a function`. The fix is usually small, but nothing on the page tells you the code is old.

I wanted something that points at the outdated line while you're reading, and shows what it should be today.

## What it does

Tutorial Time-Machine is a Chrome extension and a web app.

- Open a page with code and the outdated lines get marked 🔴; lines that are still fine get 🟢.
- Click a marked line to see the old code next to the modern version, a short explanation, and a **Copy fix** button.
- Every result shows where it came from: **⚡ On-device**, **📦 Cache** or **☁️ Cloud**, and a savings meter shows how much of the work never left your browser.
- No extension? The web app does the same on four demo tutorials or on code you paste.

## How I built it

It's built on **Firebase AI Logic's hybrid inference**, and the whole idea is to use each kind of AI for what it's good at:

1. **⚡ Gemini Nano, on your device** (`PREFER_ON_DEVICE`): reads every code block on the page and points out lines that use a library API that might have changed. Free, private, no network.
2. **📦 Firestore cache:** if anyone already checked a line, the answer comes back instantly with no AI call at all.
3. **☁️ Gemini in the cloud** (`ONLY_IN_CLOUD`, with the Google Search tool): checks only the few flagged lines that aren't cached, and writes the result to the cache for the next reader.

Nano's knowledge is frozen, so it only points. The cloud model decides. Also used: **App Check** (reCAPTCHA Enterprise on the web, a debug token for the extension), **Anonymous Auth**, **Remote Config** (model name, thresholds and budget can change without a redeploy) and **Hosting**.

**Full disclosure:** I built this together with **Claude Code**, an AI coding assistant, which wrote most of the code. My part was steering it: deciding what to build and what mattered, setting up the Firebase project, choosing to stay on the free tier, testing every step in Chrome and reporting what broke, and pushing for fixes until it worked.

## Challenges I ran into

- **On-device was slow at first.** The first version took about **2 minutes** to scan one tutorial. Scanning the whole page in one prompt and having Nano answer with just line numbers brought it down to about **16–30 seconds**.
- **The small model flagged noise**, like config values and `console.log`. A simple code filter after the model fixed that better than prompt tweaks.
- **One browser faked having Nano.** It returned the prompt back instead of an answer. The app now detects that and uses the cloud instead.
- **Free-tier limits.** Google Search grounding isn't available on the free tier for the newer Gemini models, and the first model I picked wasn't open to new projects. Thanks to Remote Config, switching models didn't need a redeploy, and when Search isn't available the app still answers but clearly labels it "no Search".
- **I leaked a debug token**, and caught it. The first deploy accidentally included an App Check debug token. I found it by checking the live site, replaced the token, and added a build check so it can't happen again.

## What I learned

- Small on-device models are great at filtering and pointing, not at judging. Let the cloud do the judging.
- On-device speed depends mostly on how much text the model has to write.
- Fallbacks should be visible to the user, not hidden.
- AI coding tools are fast, but someone still has to test everything in a real browser.

## What's next

- Write cache entries from a trusted backend so nobody can store a wrong answer.
- Fix multi-line statements as one piece instead of line by line.
- Support more libraries, and publish the extension on the Chrome Web Store.

## Built with

Firebase AI Logic · Gemini Nano · Gemini · Firebase App Check · Firebase Authentication · Cloud Firestore · Firebase Remote Config · Firebase Hosting · Chrome Extensions (Manifest V3) · TypeScript · Vite · Claude Code
