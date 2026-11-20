# Demo video script (target 2:45, hard limit 3:00)

**Setup before recording**
- Desktop Chrome with Gemini Nano **available**. Check the extension popup: "⚡ Gemini Nano ready".
- The extension is loaded, pinned, and its side panel is closed.
- The Firebase demo tutorial is **not yet cached for this take**. Use a fresh line or bump `CACHE_VERSION` before the take, or film the first-reader shot once and keep it.
- Open the side panel once beforehand so Nano is warmed up, then close it.
- Tab 1: https://tutorial-time-machine.web.app/tutorials/firebase-v8-firestore.html
- Tab 2: a terminal or StackBlitz showing the v8 snippet failing (optional; a screenshot is fine).
- Tab 3: https://tutorial-time-machine.web.app
- Browser zoom at 110–125% so code is readable. Hide bookmarks.

---

### 0:00–0:15 · Hook

**On screen:** a Firebase chat tutorial; copy its init code; the console shows `TypeError: firebase.initializeApp is not a function` (or `firebase is not defined`).

**Voice:** "You found the perfect Firebase tutorial. You copy the code, and it doesn't run. The tutorial isn't wrong. It's from 2021, and Firebase changed. Nothing on the page warns you."

### 0:15–0:45 · Open it with Tutorial Time-Machine

**On screen:** click the toolbar icon → popup ("⚡ Gemini Nano ready") → **Open side panel**. Yellow 🟡 markers appear on lines in the tutorial. The side panel's step 1 lights up: **"⚡ Scan on-device … Gemini Nano is reading the code"**.

**Voice:** "With the extension, Gemini Nano, running right here in Chrome through Firebase AI Logic's hybrid inference, reads every code block on the page. It's free, it's instant, and the page never leaves my machine. Nano doesn't decide what's outdated, because its knowledge is frozen. It just points at the lines that depend on a library version."

### 0:45–1:20 · Grounded fix in the cloud

**On screen:** step 2 (cache) shows misses, step 3 lights up, **"☁️ Verify in the cloud"**; markers turn 🔴. Click the 🔴 next to `const db = firebase.firestore();` → card: old vs. new (`getFirestore(app)`), explanation, **Copy fix**, badge. Click **Copy fix**.

**Voice:** "Only those few flagged lines go to Gemini in the cloud, with Google Search, so it checks against today's docs. Here's the modern modular-SDK version, why it changed, and a copy button."
*(If Search sources are shown, point at them: "with the sources it used." If the badge says "no Search", say: "On the free tier, Search grounding isn't available, so the app says so instead of pretending.")*

### 1:20–1:50 · The second reader

**On screen:** close the tab, open the same tutorial again (or click **↻ Check again**). The markers go 🔴 almost immediately. Step 2: **"📦 13 of 13 lines already verified"**, step 3: **"Not needed: all from the cache"**. Every badge says **📦 Cache**.

**Voice:** "Now I'm the next person to read this tutorial. Every fix comes straight from a shared Firestore cache, with no model call at all. Each fix only has to be found once, for everyone."

### 1:50–2:10 · Savings meter

**On screen:** zoom on the meter: **⚡ 51 scanned on device · 📦 13 from cache · ☁️ 0 sent to cloud**, the bar at **100%**.

**Voice:** "This is the point of hybrid. 51 lines were read on-device. On the first visit, 13 went to the cloud. On every visit after that, none do: 100% of the work stays in the browser."

### 2:10–2:35 · Web app for everyone

**On screen:** Tab 3, the web app. Click **Your first React counter**. The three steps animate; `ReactDOM.render` turns 🔴 → `createRoot`. Briefly show the **Paste a snippet** card.

**Voice:** "No extension? The web app runs the same pipeline on demo tutorials, or on any code you paste: React, OpenAI, TensorFlow, Firebase. And if your browser doesn't have Gemini Nano, the SDK falls back to the cloud and the badges tell you."

### 2:35–2:50 · Close

**On screen:** the logo, the GitHub URL and the web app URL. Optionally the README's architecture diagram for a second.

**Voice:** "Tutorial Time-Machine: on-device AI to read everything, cloud AI to know what's current, and Firebase to share each fix with everyone. Old tutorials, modern code."

---

**Checklist for the upload:** under 3:00 · audio levels even · show the ⚡ / 📦 / ☁️ badges clearly at least once each · mention "Firebase AI Logic" and "hybrid inference" by name · the public GitHub link and the live URL appear on screen.
