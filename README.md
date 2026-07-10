# Briefly

**A persistent YouTube research copilot that lives in your Chrome side panel.**

Briefly turns YouTube videos, playlists, and research queues into a searchable, local-first knowledge base. Sync a video's transcript, generate structured summaries, chat with one video or a whole batch, and keep everything — transcripts, notes, chat history, tags — in workspace memory on your machine.

Bring your own API key. Your data never leaves your browser except for the AI calls you configure.

## Features

- **Side-panel copilot** — a persistent research UI that follows you across YouTube, built on the Chrome Side Panel API.
- **Resilient transcript pipeline** — a multi-strategy acquisition ladder that reads captions from the live page first and falls back progressively (details below).
- **Workspace memory per video** — summaries, chat threads, notes, tags, and pinned state persist in IndexedDB.
- **Batch queue and playlist ingestion** — queue videos from thumbnails or ingest an entire playlist, then synthesize across all of them at once.
- **Grounded chat** — ask questions against the transcripts of one or many videos; answers cite timestamps you can click to jump into the video.
- **Global search** — search across saved videos, transcripts, and chat history.
- **Prompt profiles** — built-in summary modes (TL;DR, action items, timestamped highlights, study notes, due diligence, thread draft, creator research) plus fully custom prompt profiles.
- **Provider-agnostic AI routing** — Google Gemini, OpenAI, Anthropic, or a local model via Ollama. Keys are stored locally and sent only to the provider you select.
- **Markdown export** — take a workspace (summary, chat, notes) out as clean Markdown.
- **Transcript health dashboard** — rolling success rate, failure taxonomy, request-pressure metrics, and a step-by-step debug log in Settings.

## Install

Briefly is not on the Chrome Web Store yet. To run it from source:

```bash
git clone <this repo>
cd briefly
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `.output/chrome-mv3`.

For iterative development with hot reload:

```bash
npm run dev
```

Type checking:

```bash
npm run compile
```

## Configure

Open the side panel (click the Briefly toolbar icon on any YouTube page), go to **Settings**, and add an API key for at least one provider:

| Provider | Default model | Notes |
| --- | --- | --- |
| Google Gemini | `gemini-3.5-flash` | |
| OpenAI | `gpt-4.1-mini` | Also powers optional TTS audio briefings (`gpt-4o-mini-tts`) |
| Anthropic | `claude-sonnet-5` | Sampling parameters are intentionally omitted (Sonnet 5 rejects non-default values) |
| Ollama | `llama3` | Local endpoint, default `http://localhost:11434` |

## Architecture

```
YouTube page (MAIN world)          Extension (isolated world / extension origin)
┌──────────────────────┐   events   ┌─────────────────┐  runtime msgs  ┌──────────────────┐
│ youtube-bridge.js    │──────────► │ content script  │◄─────────────► │ background (SW)  │
│ · player state       │            │ · queue buttons │                │ · zod-validated  │
│ · fetch/XHR caption  │            │ · DOM transcript│                │   message router │
│   interception       │            │   scraper       │                │ · transcript     │
└──────────────────────┘            │ · caption fetch │                │   orchestrator   │
                                    └─────────────────┘                │ · AI routing     │
                                                                       └────────┬─────────┘
                                    ┌─────────────────┐                         │
                                    │ side panel (UI) │◄────────────────────────┘
                                    │ React + Zustand │        Dexie / IndexedDB
                                    └─────────────────┘   (videos · transcripts · workspaces · settings)
```

### The transcript pipeline

YouTube increasingly protects caption endpoints with proof-of-origin parameters (`pot`/`potc`), which makes naive background `timedtext` fetching return empty 200s. Briefly's answer is a strategy ladder, orchestrated in `src/services/transcript-orchestrator.ts`:

1. **Local cache** — transcripts persist for 7 days (capped at 500 entries).
2. **Passive capture** — a page-context bridge (`entrypoints/youtube-bridge.ts`) intercepts YouTube's own caption requests and hands the payload to the extension for free.
3. **Active-tab caption fetch** — the bridge reads the live player response; the content script fetches the selected caption track with page cookies intact.
4. **Active-tab DOM scrape** — opens YouTube's own transcript panel and reads the rows (selectors are remotely overridable, so UI drift is patchable without shipping a new build).
5. **Background InnerTube probe** — watch-page parse, then ANDROID and TVHTML5 player-endpoint fallbacks, with English translation-track fallback for non-English videos.
6. **Queue-runner tab** — for off-page/batch videos, a hidden muted tab navigates to each video with jittered pacing and exponential backoff.

Every attempt is classified into a failure taxonomy (`CONSENT_WALL`, `RATE_LIMITED`, `AGE_RESTRICTED`, `EMPTY_200_RESPONSE`, `SELECTOR_MISS`, ...), recorded to a rolling health metric, and written to a debug log you can inspect and copy from Settings. A remote-config kill switch (plus optional canary checks) can disable risky strategies without an extension update.

### Layout

```
entrypoints/
  background.ts          MV3 service worker: message router, alarms, webNavigation hooks
  content.ts             YouTube UI injection + transcript scraping + bridge listener
  youtube-bridge.ts      Page-context (MAIN world) script: player state + caption interception
  sidepanel/             React app shell
src/
  services/              transcript orchestrator/runtime/health/debug, caption parsing,
                         AI router, summarization, workspace chat, telemetry, premium audio
  db/                    Dexie schema (videos, transcripts, workspaces, settings)
  runtime/               zod message contracts shared by all contexts
  ui/                    CopilotView, SearchView, SettingsView
  constants/ hooks/ state/ types/ utils/
docs/                    integration contracts, v3 roadmap, research notes
archive_legacy_v1/       the original popup-based v1, kept for reference
```

## Privacy

- Transcripts, workspaces, and settings live in IndexedDB on your machine.
- API keys are stored locally and sent only to the provider you configured.
- Telemetry is disabled by default: the event pipeline exists, but no endpoint is configured unless you build with `WXT_TELEMETRY_ENDPOINT` set (and the in-app toggle is respected either way).

## Honest status

This is a working v2, not a finished product. Known limits:

- **YouTube fragility** — DOM scraping and InnerTube endpoints break whenever YouTube ships changes. The selector-override and kill-switch machinery exists precisely because of this, but expect occasional breakage.
- **No automated tests yet** — verification is currently `tsc --noEmit`, `wxt build`, and manual testing in Chrome.
- **Placeholder monetization surfaces** — Google sign-in, premium entitlements, and checkout are stubs pending the backend described in `docs/INTEGRATION_CONTRACTS.md`.
- **Ollama CORS** — depending on your Ollama configuration you may need `OLLAMA_ORIGINS` to allow the extension origin.
- **Chrome only** — the queue-runner and side-panel surfaces are built against Chrome MV3; no Firefox build yet.

The roadmap is in [docs/V3_ROADMAP.md](docs/V3_ROADMAP.md).

## License

MIT — see [LICENSE.md](LICENSE.md).
