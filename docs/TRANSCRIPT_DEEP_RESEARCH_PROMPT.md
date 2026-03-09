# Transcript Deep Research Prompt

Use this prompt when you want to research robust YouTube transcript extraction strategies without guessing:

```text
You are analyzing how to build a production-grade YouTube transcript extraction system for a Chrome MV3 extension.

Current architecture:
- Active watch pages use a content script and can access the live DOM.
- Off-page videos may be processed later from a background/service-worker context.
- YouTube now uses proof-of-origin / proof-of-work style parameters such as `pot` / `potc` on some caption requests, so naive background `api/timedtext` fetching can return empty 200 responses.
- The extension already proved that the watch page can expose transcript UI and transcript rows even when direct background timedtext fetch fails.

Research goals:
1. Determine the most reliable way to extract transcripts for the ACTIVE YouTube watch page in 2026.
2. Determine the most reliable fallback for OFF-PAGE queued videos where the user is not currently on the watch page.
3. Identify YouTube UI selectors, engagement panel selectors, transcript row selectors, and player-response sources that are currently stable.
4. Compare these strategies:
   - scraping transcript rows from the open transcript panel
   - reading transcript-related player response data from page context
   - reproducing YouTube caption network requests with required parameters
   - navigating queued videos sequentially in-page and scraping each transcript
5. Identify risks:
   - locale issues
   - SPA stale globals such as `ytInitialPlayerResponse`
   - shadow DOM / custom element changes
   - rate limits
   - caption availability for auto-generated vs manual captions
   - account / cookie / consent / age-restriction effects
6. Recommend an architecture split between:
   - active-page DOM extraction
   - queued-video ingestion
   - caching/persistence
   - telemetry and error diagnosis

Deliverables:
- A recommended architecture with primary path, fallback path, and kill-switch strategy
- Concrete selectors and DOM hooks to test
- Concrete network endpoints/params worth testing, if any
- Example failure taxonomy for logging
- Advice specific to Chrome Extension MV3 constraints

Do not give generic advice. Use current, concrete, source-backed findings and prioritize approaches that survive YouTube SPA changes.
```
