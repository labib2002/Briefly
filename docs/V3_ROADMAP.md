# Briefly V3 Roadmap

## Product Thesis

Briefly should compete as a research workflow product, not as a one-click summary button.

The durable value comes from:

- persistent memory
- batch synthesis
- grounded answers with timestamps
- exports and downstream integrations
- recurring monitoring workflows

## Product Tiers

### Free

- active-video transcript sync
- active-video summaries
- custom prompts
- local search over recent memory
- Ollama / local-model support

### Pro

- batch queue
- playlist ingestion
- exports
- full workspace memory
- cloud sync
- saved projects and tags
- advanced search

### Team

- shared workspaces
- shared prompt libraries
- comments and review flows
- recurring digests
- admin billing and seat management

## Execution Sequence

### Stage 1: Productization

- replace v1 documentation
- add workspace metadata: names, notes, tags, pinned state
- add provider health checks
- add operational kill switches for risky YouTube injection surfaces
- improve export structure

### Stage 2: Monetization Readiness

- real Google OAuth
- Stripe Checkout
- entitlement sync API
- subscription-aware feature gating
- telemetry pipeline

### Stage 3: Retention

- projects / collections
- channel watchlists
- recurring digests
- cross-device sync
- semantic search

### Stage 4: Team Expansion

- shared projects
- comments
- digest subscriptions
- admin controls

## Required External Systems

These cannot be fully completed inside the extension alone:

- Google OAuth credentials and approved extension origin
- Stripe products, prices, and webhook endpoint
- backend for entitlement sync and cloud persistence
- telemetry ingestion endpoint

The extension can and should keep local-first behavior even after those systems exist.

## Success Metrics

- activation: first successful transcript sync and first summary
- retention: repeat workspace opens within 7 and 30 days
- depth: videos processed per active user
- monetization: upgrade rate from free to pro
- batch adoption: queue and playlist usage
- export usage: markdown and future integrations
- reliability: transcript sync success rate and UI injection failure rate

## Product Principles

- active watch pages use DOM transcript scraping as the source of truth
- background transcript fetch is fallback-only for off-page workflows
- content script injection must stay narrowly scoped and easy to disable
- side panel is the main product surface
- local-first storage is non-negotiable
