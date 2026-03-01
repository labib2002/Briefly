<p align="center">
  <img src="icons/briefly-128.png" alt="Briefly logo" width="128">
</p>

# Briefly ⚡️

Summarize YouTube videos instantly — right from your browser.

Skip the video, keep the value. With one right-click or through the extension popup, Briefly pulls the transcript for the current YouTube video. It can copy the transcript to your clipboard or auto-summarize it using Google’s Gemini in AI Studio. Perfect for research, note-taking, or just staying informed — without the watch time.

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

---

## Features

| Action | What happens |
| ------ | ------------ |
| **Get & Copy Transcript** | Uses a bundled JavaScript library (based on `youtube-transcript-api`) directly in the extension → fetches the full transcript (with preferred language logic) → copies it to your clipboard via Chrome’s Offscreen API. |
| **Summarise in AI Studio** | Same transcript fetching method → opens `aistudio.google.com` → pastes a pre-defined prompt + transcript → attempts to select preferred model → disables/enables preferred “Thinking mode” → clicks **Run**. |

---

| Feature | Info         |
| ------  | ------------ |
| **Popup Interface** | Access core actions (copy, summarize) for the active YouTube tab directly from the extension icon. |
| **Robust notifications** | API / network / automation errors bubble up clearly. |
| **Cross-platform** | works on Chrome, Edge, Brave, etc. (Manifest v3). |

---

## Quick Start

### 1 ▪ Clone

```bash
git clone https://github.com/labib2002/briefly.git
cd briefly
```

### 2 ▪ Load the extension

1. Open `chrome://extensions` (or the equivalent for your browser, e.g., `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** → select the `briefly` project folder (the one containing `manifest.json`).

---

## Usage

1.  Navigate to a YouTube video page (`youtube.com/watch?...`, `youtu.be/...`, `youtube.com/shorts/...`).
2.  **Option 1: Context Menu**
    *   Right-click any YouTube video link on a webpage.
    *   Choose:
        *   **Briefly: Get & Copy Transcript Text**
        *   **Briefly: Automate Summary in AI Studio**
3.  **Option 2: Extension Popup**
    *   While on a YouTube video page, click the Briefly extension icon in your browser toolbar.
    *   Click either **Copy Transcript** or **Summarize in AI Studio**.
4.  Read the notification that appears. If you picked AI Studio, switch to the new tab and watch Gemini work its magic.

---

## Configuration

| File                             | What to tweak                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------- |
| **`background.js`**              | `PREFERRED_LANGUAGES` array, `promptText` template for AI Studio, AI Studio automation time-outs. |
| **`content_script_aistudio.js`** | CSS selectors for AI Studio elements & default model name string (e.g., "Gemini 2.5 Flash Preview"). |

---

## Troubleshooting 🛠️

| Symptom                                                | Likely cause / fix                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Transcript unavailable / error fetching transcript** | Uploader disabled transcripts, no transcripts in your `PREFERRED_LANGUAGES` (see `background.js`), or a temporary YouTube issue. Check the Service Worker console. |
| **Automation stalls or fails in AI Studio**            | Google’s AI Studio UI might have changed – adjust selectors in `content_script_aistudio.js`. Use DevTools console in the AI Studio tab to inspect errors. The target model ("Gemini 2.5 Flash Preview") might also be unavailable or renamed. |
| **Clipboard error**                                    | Rare; open the extension’s *Service worker* console in `chrome://extensions` for details.                       |
| **Buttons in popup are disabled**                      | Ensure you are on an active YouTube video page (`youtube.com/watch`, `youtu.be`, `youtube.com/shorts`).        |

---

* **Service worker logs (for background tasks, transcript fetching)** → `chrome://extensions` → find Briefly → click *Service worker*.
* **Content-script logs (for AI Studio automation)** → Open DevTools (F12) console in the AI Studio tab.
* **Popup logs (for popup UI issues)** → Right-click the extension icon → *Inspect popup* → Console tab.

---

## Strategic Assessment & Roadmap / Future Ideas

### Strategic Assessment (2026)

### Is Briefly still useful after YouTube + Gemini “Summarize this video”?

Yes — but the core value has shifted. A single-video summary button is becoming a commodity. Briefly still has room if it focuses on **workflow depth** rather than just “one-click summarize.”

### Current strengths

* Fast transcript extraction and copy flow from the active tab.
* Works even when users want to summarize outside YouTube’s native UI.
* Prompt/model control potential (currently manual in code, expandable via settings).
* Browser-native distribution (low friction install/use).

### Current weaknesses / risk areas

* AI Studio UI automation is fragile when selectors/UI change.
* No persistence layer (history, saved outputs, reusable prompts).
* No batch workflows (playlist or multi-video summaries).
* No in-product engagement loops (follow-up questions, compare videos, revisit prior summaries).

### User engagement factors that can create real value

* **Time compression at scale**: summarize many videos, not just one.
* **Continuity**: keep summaries in a local/project workspace users can return to.
* **Interactivity**: chat with transcript/summaries for follow-up questions and extraction tasks.
* **Control**: summary modes (TL;DR, study notes, action items, bias check, etc.).

## Recommended Pivot Direction

Keep the extension as the primary surface, and evolve into a **YouTube knowledge workflow tool**.

### Highest-value features to build first

1. **Playlist summary**
   * Detect playlist context and summarize all (or selected) videos.
   * Return: per-video short summary + cross-video “meta-summary”.
2. **Batch from active tabs**
   * Let users select multiple open YouTube tabs and summarize in one run.
3. **Persistent workspace**
   * Save transcript + summary history (local-first via extension storage).
   * Add pin/favorite/export actions.
4. **In-page chat panel**
   * Follow-up Q&A grounded in transcript/summaries.
   * Quick prompts: “key claims”, “action items”, “what changed from video A to B”.
5. **Multiple summary modes**
   * TL;DR, detailed, bullet notes, exam prep, newsletter-ready, timestamp-focused.

### Platform strategy (extension vs pivot)

* **Near-term best approach**: stay as browser extension (fastest iteration, best YouTube context access).
* **Mid-term hardening**: add direct Gemini API/Vertex option to reduce AI Studio automation fragility.
* **Long-term expansion options**:
  * Web app companion for cross-device history and team sharing.
  * Multi-platform ingestion (podcasts, course platforms, docs/videos in one workspace).

* [ ] **Direct Gemini API Integration** – Add option for Google’s public Gemini API (or Vertex AI) directly, bypassing AI Studio UI automation for a faster and more reliable summarization.
* [ ] **Enhanced Popup / Options UI** – Allow users to customize preferred languages, edit the AI Studio prompt, select different summarization models, and toggle other features through a dedicated options page or an enhanced popup.
* [X] **Process Current Video via Popup** – One-click actions in the extension popup to process the video in the active tab (Implemented in v1.4).
* [ ] **Standalone Application** – Package Briefly as a desktop application, removing the need for a browser extension (e.g., using Electron or similar).
* [ ] **Local LLM Support** – Send transcripts to a locally running LLM (e.g., via Ollama / GGUF models) for offline summaries.
* [ ] **Internationalisation (i18n)** – Translate extension UI text and default prompts into multiple languages.
* [ ] **Customizable Summarization Profiles** – Allow users to define and switch between different summarization styles or lengths (e.g., "brief overview," "detailed points," "key takeaways").
* [ ] **Support for more video platforms** – Extend transcript and summarization capabilities to other platforms beyond YouTube.

*Pull-requests welcome – open an issue first so we don’t duplicate work!*

---

## Contributing

1. **Fork** → branch → PR (use [Conventional Commits](https://www.conventionalcommits.org)).
2. First-timers welcome – check **good-first-issue**.

---

## License

Released under the **MIT License** – see [`LICENSE.md`](LICENSE.md).

> The core logic for fetching YouTube transcripts is derived from the excellent
[youtube-transcript-api](https://pypi.org/project/youtube-transcript-api/) Py library, adapted for direct use within the browser extension.
