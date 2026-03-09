# Briefly

Briefly is a persistent Chrome side-panel extension for turning YouTube videos, playlists, and queued research sets into a searchable local knowledge base.

The product has moved beyond the legacy popup summarizer. The current architecture is built around:

- `WXT + React + TypeScript`
- `Chrome Side Panel API`
- `Dexie / IndexedDB` for local-first persistence
- `provider-agnostic AI routing` for `Gemini`, `OpenAI`, `Anthropic`, and `Ollama`
- `page-context transcript scraping` for active YouTube videos

## Current Product Surface

- Active-video transcript sync from the live YouTube page
- Persistent workspace memory for each video
- Batch queue for multi-video synthesis
- Playlist ingestion from YouTube
- Global search across saved videos, transcripts, and chat history
- Custom prompt profiles
- Markdown export
- Premium gating groundwork
- Local-model support through Ollama

## What Briefly Is Becoming

Briefly is being productized into a YouTube research OS for:

- students processing lecture playlists
- founders and analysts tracking markets and competitors
- creators studying channels and recurring topics
- knowledge workers building reusable research memory from video

The end-state is not "summarize this one video." The end-state is:

- ingest
- synthesize
- search
- cite
- export
- monitor

## Architecture

### Extension runtime

- `entrypoints/background.ts`
  Handles runtime messages, transcript ingestion, summarization requests, queue management, and workspace orchestration.
- `entrypoints/content.ts`
  Injects queue controls into YouTube and scrapes active-watch-page transcripts directly from the DOM.
- `entrypoints/sidepanel/*`
  Hosts the persistent research UI.

### Data model

- `videos`
- `transcripts`
- `workspaces`
- `settings`

The storage model is local-first and structured so a future sync layer can mirror records to a backend without redefining the core entities.

## Local Development

```bash
npm install
npm run compile
npm run build
```

For iterative development:

```bash
npm run dev
```

Then load the generated extension in `chrome://extensions`.

## Providers

Briefly currently supports:

- Google Gemini
- OpenAI
- Anthropic
- Ollama

Cloud API keys remain local to the extension database. Ollama runs against a local endpoint such as `http://localhost:11434`.

## Current Limits

Some surfaces are intentionally still placeholders:

- Google sign-in is not wired to real OAuth yet
- Premium upgrade is not wired to real Stripe Checkout yet
- Premium entitlement sync is not backed by a real server yet
- Telemetry is structured but still uses a local stub transport

Those are productization tasks, not architectural unknowns.

## Roadmap

The concrete v3 roadmap is in [docs/V3_ROADMAP.md](/C:/Users/lenovo/Downloads/Briefly-main/docs/V3_ROADMAP.md).

The external auth, billing, sync, and telemetry contracts are in [docs/INTEGRATION_CONTRACTS.md](/C:/Users/lenovo/Downloads/Briefly-main/docs/INTEGRATION_CONTRACTS.md).

## Legacy v1

The original popup-based implementation was archived to [archive_legacy_v1](/C:/Users/lenovo/Downloads/Briefly-main/archive_legacy_v1) for reference.
