
<p align="center">
  <img src="icons/briefly-128.png" alt="Briefly logo" width="128">
</p>

# Briefly ⚡️ 

Right-click any YouTube link → instantly **copy its transcript** *or* launch a
ready-made **Gemini** summarisation in Google AI Studio.

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

---

## Features

| Action | What happens |
| ------ | ------------ |
| **Get & Copy Transcript** | Calls a tiny local Flask API → fetches the full transcript (with retries) → copies it to your clipboard via Chrome’s Offscreen API. |
| **Summarise in AI Studio** | Same fetch → opens `aistudio.google.com` → pastes a terse-but-complete prompt + transcript → selects <br> *Gemini Flash* → disables “Thinking mode” → clicks **Run**. |
---

| Feature | info         | 
| ------  | ------------ | 
| **Robust notifications** | API / network / automation errors bubble up clearly. | 
| **Cross-platform** | works on Chrome, Edge, Brave, etc. (Manifest v3). |

---

## Quick Start

### 1 ▪ Clone

```bash
git clone https://github.com/labib2002/briefly.git
cd briefly
```

### 2 ▪ Run the local API

```bash
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
python transcript-API.py                          # http://127.0.0.1:5678
```

### 3 ▪ Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** → select the project folder (`manifest.json` lives here)

---

## Usage

1. Keep the Flask window running.

2. Right-click any YouTube link → choose:

   * **Get & Copy Transcript Text**
   * **Automate Summary in AI Studio**

3. Read the notification; if you picked AI Studio, switch to the new tab and
   watch Gemini work its magic.

---

## Configuration

| File                             | What to tweak                                |
| -------------------------------- | -------------------------------------------- |
| **`transcript-API.py`**          | `preferred_langs`, retry counts, port number |
| **`background.js`**              | `promptText` template, AI Studio time-outs   |
| **`content_script_aistudio.js`** | CSS selectors & default model name           |

---

## Troubleshooting 🛠️

| Symptom                                                | Likely cause / fix                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **“Could not connect to the local transcript server”** | Flask not running, firewall blocking `127.0.0.1:5678`, or you changed the port without updating the extension.  |
| **Transcript unavailable**                             | Uploader disabled transcripts or none in your preferred languages.                                              |
| **Automation stalls in AI Studio**                     | Google’s UI changed – adjust selectors in `content_script_aistudio.js`. Use DevTools console to inspect errors. |
| **Clipboard error**                                    | Rare; open the extension’s *Service worker* console in `chrome://extensions` for details.                       |

---

* **Service worker logs** → `chrome://extensions` → *Service worker*.
* **Content-script logs** → DevTools console in the AI Studio tab.
* **API logs** → the terminal running `transcript-API.py`.


---

## Roadmap / Future Ideas

* [ ] **Direct Gemini API** – call Google’s public Gemini API (or Vertex AI) instead of driving the browser.
* [ ] **Popup / Options UI** – set preferred languages, edit the prompt, choose models, toggle features.
* [ ] **Summarise current video** – one-click action that grabs the tab’s video ID (no right-click).
* [ ] **All in one application** – an easier flow to get this entire app running without servers, extensions, etc..
* [ ] **Local LLM support** – send transcripts to an Ollama / GGUF model for offline summaries.
* [ ] **Internationalisation** – translate extension text & prompts.
* [ ] **Summarization switches / profiles** – Ability to switch between short summary and detailed summary.


*Pull-requests welcome – open an issue first so we don’t duplicate work!*

---

## Contributing

1. **Fork** → branch → PR (use [Conventional Commits](https://www.conventionalcommits.org)).
2. First-timers welcome – check **good-first-issue**.

---

## License

Released under the **MIT License** – see [`LICENSE.md`](LICENSE.md).

> Built on top of the amazing
> [`youtube-transcript-api`](https://github.com/jdepoix/youtube-transcript-api).
