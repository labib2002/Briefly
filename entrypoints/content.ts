import { defineContentScript } from 'wxt/sandbox';

import { PREMIUM_PLACEHOLDER_URL } from '../src/constants/premium';
import { sendRuntimeRequest } from '../src/runtime/client';
import {
  fetchCaptionTrackSegments,
  isCaptionFetchError,
  parseCaptionPayload,
} from '../src/services/caption-payload';
import { resolveCaptionTrackSelection } from '../src/services/caption-track-utils';
import { appendTranscriptDebugEntry } from '../src/services/transcript-debug';
import type { FeatureFlags } from '../src/types/domain';
import { extractYouTubeVideoId } from '../src/utils/youtube';

const STYLE_ID = 'briefly-queue-style';
const BUTTON_SELECTOR = '[data-briefly-queue-button="true"]';
const PLAYLIST_BUTTON_SELECTOR = '[data-briefly-playlist-button="true"]';
const PLAYER_STATE_BRIDGE_EVENT = 'briefly:player-state';
const CAPTION_CAPTURE_BRIDGE_EVENT = 'briefly:caption-response';
const DEFAULT_TRANSCRIPT_TRIGGER_SELECTORS = [
  'ytd-video-description-transcript-section-renderer button',
  'ytd-video-description-transcript-section-renderer [role="button"]',
  'ytd-watch-metadata ytd-video-description-transcript-section-renderer button',
  'ytd-watch-metadata ytd-video-description-transcript-section-renderer [role="button"]',
  'button[aria-label="Show transcript"]',
  'button[aria-label*="transcript" i]',
];
const DEFAULT_DESCRIPTION_EXPAND_SELECTORS = [
  'ytd-watch-metadata #description-inline-expander tp-yt-paper-button#expand',
  'ytd-watch-metadata #description-inline-expander button#expand',
  'ytd-watch-metadata #description-inline-expander [role="button"]#expand',
  'ytd-watch-metadata tp-yt-paper-button#expand',
  'ytd-watch-metadata button#expand',
];
const DEFAULT_TRANSCRIPT_PANEL_SELECTORS = [
  'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]',
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
];
const DEFAULT_TRANSCRIPT_RENDERER_SELECTORS = [
  'ytd-transcript-renderer',
  'ytd-transcript-search-panel-renderer',
  'ytd-transcript-segment-list-renderer',
  '#segments-container',
];
const DEFAULT_TRANSCRIPT_ROW_SELECTORS = [
  'ytd-transcript-segment-renderer',
  'transcript-segment-view-model',
  '.ytwTranscriptSegmentViewModelHost',
  '#segments-container > *',
];
const DEFAULT_TRANSCRIPT_TIMESTAMP_SELECTORS = [
  '#start-offset',
  '.segment-timestamp',
  '[class*="segment-timestamp"]',
  '[class*="cue-group-start-offset"]',
  '.ytwTranscriptSegmentViewModelTimestamp',
  '[class*="TranscriptSegmentViewModelTimestamp"]',
];
const DEFAULT_TRANSCRIPT_TEXT_SELECTORS = [
  '#segment-text',
  '.segment-text',
  '[class*="segment-text"]',
  'yt-formatted-string.segment-text',
  'span.yt-core-attributed-string',
  '.yt-core-attributed-string',
];
const THUMBNAIL_HOST_SELECTORS = 'ytd-thumbnail, yt-lockup-view-model';
const INJECTION_SCAN_DELAY_MS = 120;
const DEBUG_PANEL_HTML_MAX_LENGTH = 2500;
const DEBUG_RENDERER_HTML_MAX_LENGTH = 4500;
const DEBUG_ROW_HTML_MAX_LENGTH = 1000;
const DEBUG_KEYWORD_NODE_LIMIT = 10;
const queuedVideoIds = new Set<string>();
const activeCaptionFetchInFlight = new Map<string, Promise<{ videoId: string; segmentCount: number }>>();
const transcriptScrapeInFlight = new Map<string, Promise<{ videoId: string }>>();
const passiveTranscriptCaptureTimestamps = new Map<string, number>();
const defaultFeatureFlags: FeatureFlags = {
  enableThumbnailInjection: true,
  enablePlaylistIngestion: true,
  autoSyncActiveVideo: true,
  enableTelemetry: true,
};
let premiumAccessEnabled = false;
let clientFeatureFlags: FeatureFlags = defaultFeatureFlags;
let scanTimeoutId: number | null = null;
let proactiveSyncTimeoutId: number | null = null;
let transcriptTriggerSelectors = [...DEFAULT_TRANSCRIPT_TRIGGER_SELECTORS];
let descriptionExpandSelectors = [...DEFAULT_DESCRIPTION_EXPAND_SELECTORS];
let transcriptPanelSelectors = [...DEFAULT_TRANSCRIPT_PANEL_SELECTORS];
let transcriptRendererSelectors = [...DEFAULT_TRANSCRIPT_RENDERER_SELECTORS];
let transcriptRowSelectors = [...DEFAULT_TRANSCRIPT_ROW_SELECTORS];
let transcriptTimestampSelectors = [...DEFAULT_TRANSCRIPT_TIMESTAMP_SELECTORS];
let transcriptTextSelectors = [...DEFAULT_TRANSCRIPT_TEXT_SELECTORS];
let latestBridgePlayerState: {
  url: string;
  pageVideoId: string | null;
  playerVideoId: string | null;
  title: string | null;
  channel: string | null;
  captionTracks: Array<{
    baseUrl?: string;
    languageCode?: string;
    kind?: string;
    name?: string;
    vssId?: string;
  }>;
  translationLanguageCodes: string[];
} | null = null;
type ThumbnailWrapper = HTMLElement & { dataset: DOMStringMap };
type ScrapedPlaylistVideo = {
  videoId: string;
  title: string;
  channel: string;
};
type ScrapedTranscriptSegment = {
  text: string;
  start_time: number;
  duration: number;
};
type QueueInjectionHost = {
  host: ThumbnailWrapper;
  anchor: HTMLAnchorElement;
  overflowTargets: HTMLElement[];
};
type ContentScriptResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
type ActiveCaptionTrackRequest = {
  type: 'briefly/fetch-active-caption-track';
  videoId: string;
  baseUrl: string;
  languageCode?: string;
  targetLanguageCode?: string;
  title?: string;
  channel?: string;
};

type SelectorOverrides = {
  transcriptTriggerSelectors?: string[];
  descriptionExpandSelectors?: string[];
  transcriptPanelSelectors?: string[];
  transcriptRendererSelectors?: string[];
  transcriptRowSelectors?: string[];
  transcriptTimestampSelectors?: string[];
  transcriptTextSelectors?: string[];
};

function dedupeSelectors(defaults: string[], overrides: string[] | undefined): string[] {
  return Array.from(
    new Set([
      ...defaults,
      ...(overrides ?? []).map((value) => value.trim()).filter(Boolean),
    ]),
  );
}

function applySelectorOverrides(overrides?: SelectorOverrides) {
  transcriptTriggerSelectors = dedupeSelectors(
    DEFAULT_TRANSCRIPT_TRIGGER_SELECTORS,
    overrides?.transcriptTriggerSelectors,
  );
  descriptionExpandSelectors = dedupeSelectors(
    DEFAULT_DESCRIPTION_EXPAND_SELECTORS,
    overrides?.descriptionExpandSelectors,
  );
  transcriptPanelSelectors = dedupeSelectors(
    DEFAULT_TRANSCRIPT_PANEL_SELECTORS,
    overrides?.transcriptPanelSelectors,
  );
  transcriptRendererSelectors = dedupeSelectors(
    DEFAULT_TRANSCRIPT_RENDERER_SELECTORS,
    overrides?.transcriptRendererSelectors,
  );
  transcriptRowSelectors = dedupeSelectors(
    DEFAULT_TRANSCRIPT_ROW_SELECTORS,
    overrides?.transcriptRowSelectors,
  );
  transcriptTimestampSelectors = dedupeSelectors(
    DEFAULT_TRANSCRIPT_TIMESTAMP_SELECTORS,
    overrides?.transcriptTimestampSelectors,
  );
  transcriptTextSelectors = dedupeSelectors(
    DEFAULT_TRANSCRIPT_TEXT_SELECTORS,
    overrides?.transcriptTextSelectors,
  );
}

function getTranscriptPanelSelectorQuery() {
  return transcriptPanelSelectors.join(', ');
}

function getTranscriptRendererSelectorQuery() {
  return transcriptRendererSelectors.join(', ');
}

function getTranscriptRowSelectorQuery() {
  return transcriptRowSelectors.join(', ');
}

function isSupportedPage(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/results') || pathname.startsWith('/playlist');
}

function isWatchPage(pathname: string): boolean {
  return pathname === '/watch';
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    ytd-thumbnail.briefly-queue-wrapper,
    yt-lockup-view-model.briefly-queue-wrapper {
      position: relative !important;
      overflow: visible !important;
    }

    .briefly-playlist-action-row {
      display: flex;
      justify-content: flex-start;
      margin-top: 12px;
    }

    .briefly-queue-button {
      position: absolute !important;
      top: 5px !important;
      right: 5px !important;
      left: auto !important;
      z-index: 999999 !important;
      pointer-events: auto !important;
      display: block !important;
      border: 1px solid rgba(17, 17, 17, 0.14);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.92);
      color: #111111;
      padding: 4px 10px;
      font: 600 11px/1.2 "Segoe UI", sans-serif;
      cursor: pointer;
      backdrop-filter: blur(12px);
      box-shadow: 0 8px 20px rgba(17, 17, 17, 0.12);
      transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 120ms ease;
    }

    .briefly-playlist-button {
      position: relative;
      z-index: 99;
      border: 1px solid rgba(17, 17, 17, 0.14);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.92);
      color: #111111;
      padding: 8px 14px;
      font: 700 12px/1.2 "Segoe UI", sans-serif;
      cursor: pointer;
      backdrop-filter: blur(12px);
      box-shadow: 0 8px 20px rgba(17, 17, 17, 0.12);
      transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 120ms ease;
    }

    .briefly-queue-button:hover {
      transform: translateY(-1px);
      background: rgba(255, 255, 255, 1);
    }

    .briefly-playlist-button:hover {
      transform: translateY(-1px);
      background: rgba(255, 255, 255, 1);
    }

    .briefly-queue-button[data-queued="true"] {
      background: rgba(18, 89, 53, 0.95);
      border-color: rgba(18, 89, 53, 1);
      color: #f2f7f3;
    }

    .briefly-queue-button[data-pending="true"] {
      cursor: progress;
      opacity: 0.7;
    }

    .briefly-playlist-button[data-pending="true"] {
      cursor: progress;
      opacity: 0.7;
    }

    .briefly-playlist-button[data-locked="true"] {
      background: rgba(255, 255, 255, 0.08);
      color: var(--muted, #9fb0c2);
      border-style: dashed;
    }
  `;

  (document.head ?? document.documentElement).append(style);
}

function injectMainWorldBridge() {
  const scriptId = 'briefly-youtube-bridge';

  if (document.getElementById(scriptId)) {
    return;
  }

  const script = document.createElement('script');
  script.id = scriptId;
  script.src = chrome.runtime.getURL('youtube-bridge.js');
  script.async = false;
  (document.head ?? document.documentElement).append(script);
}

function getLegacyQueueHosts(): QueueInjectionHost[] {
  return Array.from(document.querySelectorAll<ThumbnailWrapper>('ytd-thumbnail'))
    .map((host) => {
      const anchor = host.querySelector<HTMLAnchorElement>('a[href*="/watch?v="], a[href*="/shorts/"]');

      if (!anchor) {
        return null;
      }

      return {
        host,
        anchor,
        overflowTargets: [
          host,
          anchor,
          anchor.querySelector<HTMLElement>('img')?.parentElement ?? null,
        ].filter((target): target is HTMLElement => Boolean(target)),
      } satisfies QueueInjectionHost;
    })
    .filter((host): host is QueueInjectionHost => Boolean(host));
}

function getModernQueueHosts(): QueueInjectionHost[] {
  return Array.from(document.querySelectorAll<ThumbnailWrapper>('yt-lockup-view-model'))
    .map((host) => {
      const anchor = host.querySelector<HTMLAnchorElement>('a[href*="/watch?v="], a[href*="/shorts/"]');

      if (!anchor) {
        return null;
      }

      return {
        host,
        anchor,
        overflowTargets: [
          host,
          anchor,
          anchor.querySelector<HTMLElement>('yt-thumbnail-view-model') ?? null,
          anchor.querySelector<HTMLElement>('.ytThumbnailViewModelImage') ?? null,
        ].filter((target): target is HTMLElement => Boolean(target)),
      } satisfies QueueInjectionHost;
    })
    .filter((host): host is QueueInjectionHost => Boolean(host));
}

function getQueueHosts(): QueueInjectionHost[] {
  const hosts = [...getLegacyQueueHosts(), ...getModernQueueHosts()];
  const seen = new Set<HTMLElement>();

  return hosts.filter((candidate) => {
    if (seen.has(candidate.host)) {
      return false;
    }

    seen.add(candidate.host);
    return true;
  });
}

function isPlaylistPage(): boolean {
  return window.location.pathname.startsWith('/playlist') && new URLSearchParams(window.location.search).has('list');
}

function updateButtonState(button: HTMLButtonElement) {
  const videoId = button.dataset.videoId ?? '';
  const queued = queuedVideoIds.has(videoId);

  button.dataset.queued = queued ? 'true' : 'false';
  button.textContent = queued ? 'Queued' : 'Add to Briefly';
}

function updateAllButtonStates() {
  document.querySelectorAll<HTMLButtonElement>(BUTTON_SELECTOR).forEach((button) => {
    updateButtonState(button);
  });
}

function getNodeText(node: Element | null | undefined): string {
  return node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function isVisible(element: Element | null | undefined): element is HTMLElement {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseTimestampToSeconds(value: string): number | null {
  const normalized = value.trim();

  if (!normalized) {
    return null;
  }

  const parts = normalized
    .split(':')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((part) => Number.isFinite(part));

  if (!parts.length) {
    return null;
  }

  return parts.reduce((total, part) => total * 60 + part, 0);
}

function clickElement(element: HTMLElement): boolean {
  if (!isVisible(element)) {
    return false;
  }

  element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  element.click();
  return true;
}

async function syncQueueState() {
  try {
    const payload = await sendRuntimeRequest<{ workspace: { videoIds: string[] } }>({
      type: 'briefly/get-active-queue',
    });

    queuedVideoIds.clear();
    payload.workspace.videoIds.forEach((videoId) => queuedVideoIds.add(videoId));
    updateAllButtonStates();
  } catch (error) {
    console.warn('Briefly failed to sync queued video state.', error);
  }
}

function removeInjectedUI() {
  document.querySelectorAll(BUTTON_SELECTOR).forEach((button) => button.remove());
  document.querySelectorAll(PLAYLIST_BUTTON_SELECTOR).forEach((button) => {
    if (!clientFeatureFlags.enablePlaylistIngestion) {
      button.closest('.briefly-playlist-action-row')?.remove();
      button.remove();
    }
  });
}

async function syncClientConfig() {
  try {
    const payload = await sendRuntimeRequest<{
      isPremium: boolean;
      featureFlags: FeatureFlags;
      selectorOverrides?: SelectorOverrides;
    }>({
      type: 'briefly/get-client-config',
    });
    premiumAccessEnabled = payload.isPremium;
    clientFeatureFlags = {
      ...defaultFeatureFlags,
      ...payload.featureFlags,
    };
    applySelectorOverrides(payload.selectorOverrides);
    removeInjectedUI();
    updatePlaylistButtonState();
  } catch (error) {
    premiumAccessEnabled = false;
    clientFeatureFlags = defaultFeatureFlags;
    applySelectorOverrides();
    console.warn('Briefly failed to sync client config.', error);
  }
}

function extractQueueMetadata(host: QueueInjectionHost): Pick<ScrapedPlaylistVideo, 'title' | 'channel'> {
  const contextRoot =
    host.host.closest<HTMLElement>(
      [
        'yt-lockup-view-model',
        'ytd-rich-item-renderer',
        'ytd-rich-grid-media',
        'ytd-video-renderer',
        'ytd-compact-video-renderer',
        'ytd-playlist-video-renderer',
      ].join(', '),
    ) ?? host.host;

  const title =
    host.anchor.getAttribute('title')?.trim() ||
    getFirstText(contextRoot, [
      '#video-title',
      'a#video-title-link',
      '.yt-lockup-metadata-view-model__title',
      '.yt-lockup-view-model-wiz__title',
      'h3 a[href*="/watch?v="]',
      'a[href*="/watch?v="][title]',
    ]) ||
    'Queued YouTube video';
  const channel =
    getFirstText(contextRoot, [
      'ytd-channel-name a',
      '#channel-name a',
      '#byline a',
      '#metadata a[href*="/@"]',
      '#metadata a[href*="/channel/"]',
      '.yt-content-metadata-view-model__metadata-row a',
    ]) || 'Unknown channel';

  return {
    title,
    channel,
  };
}

function createQueueButton(
  videoId: string,
  metadata: Pick<ScrapedPlaylistVideo, 'title' | 'channel'>,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'briefly-queue-button';
  button.dataset.brieflyQueueButton = 'true';
  button.dataset.videoId = videoId;
  updateButtonState(button);

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (button.dataset.pending === 'true') {
      return;
    }

    button.dataset.pending = 'true';

    void sendRuntimeRequest<{ workspace: { videoIds: string[] } }>({
      type: 'briefly/queue-video',
      videoId,
      title: metadata.title,
      channel: metadata.channel,
    })
      .then((payload) => {
        queuedVideoIds.clear();
        payload.workspace.videoIds.forEach((queuedVideoId) => queuedVideoIds.add(queuedVideoId));
        updateAllButtonStates();
      })
      .catch((error) => {
        console.warn(`Briefly failed to queue video ${videoId}.`, error);
      })
      .finally(() => {
        button.dataset.pending = 'false';
      });
  });

  return button;
}

function forceQueueVisibility(host: QueueInjectionHost) {
  host.overflowTargets.forEach((target) => {
    target.style.setProperty('overflow', 'visible', 'important');
  });
  host.host.style.setProperty('position', 'relative', 'important');
  host.anchor.style.setProperty('position', 'relative', 'important');
}

function mutationTouchesInjectionSurface(mutations: MutationRecord[]): boolean {
  return mutations.some((mutation) => {
    if (mutation.type !== 'childList') {
      return false;
    }

    const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];

    return nodes.some((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      if (node.matches(BUTTON_SELECTOR) || node.matches(PLAYLIST_BUTTON_SELECTOR)) {
        return false;
      }

      return Boolean(
        node.matches(THUMBNAIL_HOST_SELECTORS) ||
          node.querySelector(THUMBNAIL_HOST_SELECTORS) ||
          node.matches('ytd-playlist-header-renderer') ||
          node.querySelector('ytd-playlist-header-renderer'),
      );
    });
  });
}

function scheduleScan() {
  if (scanTimeoutId !== null) {
    window.clearTimeout(scanTimeoutId);
  }

  scanTimeoutId = window.setTimeout(() => {
    scanTimeoutId = null;
    scanAndInject();
  }, INJECTION_SCAN_DELAY_MS);
}

function getFirstText(root: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    const element = root.querySelector<HTMLElement>(selector);
    const text = element?.textContent?.replace(/\s+/g, ' ').trim();

    if (text) {
      return text;
    }
  }

  return '';
}

function scrapePlaylistVideos(): ScrapedPlaylistVideo[] {
  const renderedRows = Array.from(
    document.querySelectorAll<HTMLElement>('ytd-playlist-video-renderer'),
  );
  const seenIds = new Set<string>();
  const videos: ScrapedPlaylistVideo[] = [];

  renderedRows.forEach((row) => {
    const anchor =
      row.querySelector<HTMLAnchorElement>('a#video-title[href]') ??
      row.querySelector<HTMLAnchorElement>('a.yt-simple-endpoint[href*="watch"]');
    const videoId = anchor?.href ? extractYouTubeVideoId(anchor.href) : null;

    if (!videoId || seenIds.has(videoId)) {
      return;
    }

    const title =
      anchor?.getAttribute('title')?.trim() ??
      anchor?.textContent?.replace(/\s+/g, ' ').trim() ??
      '';
    const channel =
      getFirstText(row, [
        'ytd-channel-name a',
        '#byline a',
        '#metadata a[href*="/@"]',
        '#metadata a[href*="/channel/"]',
      ]) || 'Unknown channel';

    if (!title) {
      return;
    }

    seenIds.add(videoId);
    videos.push({
      videoId,
      title,
      channel,
    });
  });

  return videos;
}

function createPlaylistQueueButton(header: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'briefly-playlist-button';
  button.dataset.brieflyPlaylistButton = 'true';
  button.textContent = premiumAccessEnabled ? 'Queue Entire Playlist' : 'Unlock Playlist Queue';
  button.dataset.locked = premiumAccessEnabled ? 'false' : 'true';

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (!premiumAccessEnabled) {
      window.open(PREMIUM_PLACEHOLDER_URL, '_blank', 'noopener,noreferrer');
      return;
    }

    if (button.dataset.pending === 'true') {
      return;
    }

    const videos = scrapePlaylistVideos();

    if (!videos.length) {
      button.textContent = 'No playlist items found';
      return;
    }

    button.dataset.pending = 'true';

    void sendRuntimeRequest<{ workspace: { videoIds: string[] }; added: number }>({
      type: 'briefly/queue-multiple-videos',
      videos,
    })
      .then((payload) => {
        queuedVideoIds.clear();
        payload.workspace.videoIds.forEach((videoId) => queuedVideoIds.add(videoId));
        updateAllButtonStates();
        button.textContent = `Queued ${payload.added} videos`;
      })
      .catch((error) => {
        console.warn('Briefly failed to queue the playlist.', error);
        button.textContent = 'Queue Entire Playlist';
      })
      .finally(() => {
        button.dataset.pending = 'false';
      });
  });

  return button;
}

function updatePlaylistButtonState() {
  document.querySelectorAll<HTMLButtonElement>(PLAYLIST_BUTTON_SELECTOR).forEach((button) => {
    button.dataset.locked = premiumAccessEnabled ? 'false' : 'true';
    if (button.dataset.pending !== 'true') {
      button.textContent = premiumAccessEnabled ? 'Queue Entire Playlist' : 'Unlock Playlist Queue';
    }
  });
}

function ensureQueueButton(host: QueueInjectionHost) {
  const videoId = extractYouTubeVideoId(host.anchor.href);

  if (!videoId || host.host.querySelector(BUTTON_SELECTOR)) {
    return;
  }

  forceQueueVisibility(host);
  host.host.classList.add('briefly-queue-wrapper');
  host.host.append(createQueueButton(videoId, extractQueueMetadata(host)));
}

function ensurePlaylistQueueButton() {
  if (!clientFeatureFlags.enablePlaylistIngestion || !isPlaylistPage()) {
    return;
  }

  const header = document.querySelector<HTMLElement>('ytd-playlist-header-renderer');

  if (!header || header.querySelector(PLAYLIST_BUTTON_SELECTOR)) {
    return;
  }

  const actionRow = document.createElement('div');
  actionRow.className = 'briefly-playlist-action-row';
  actionRow.append(createPlaylistQueueButton(header));
  header.append(actionRow);
}

function scanAndInject() {
  if (!isSupportedPage(window.location.pathname)) {
    return;
  }

  if (!clientFeatureFlags.enableThumbnailInjection) {
    document.querySelectorAll(BUTTON_SELECTOR).forEach((button) => button.remove());
  } else {
    getQueueHosts().forEach((host) => ensureQueueButton(host));
    updateAllButtonStates();
  }

  if (!clientFeatureFlags.enablePlaylistIngestion) {
    document.querySelectorAll(PLAYLIST_BUTTON_SELECTOR).forEach((button) => {
      button.closest('.briefly-playlist-action-row')?.remove();
      button.remove();
    });
  } else {
    ensurePlaylistQueueButton();
    updatePlaylistButtonState();
  }
}

function getWatchPageTitle(): string {
  return (
    getNodeText(
      document.querySelector(
        'ytd-watch-metadata h1 yt-formatted-string, ytd-watch-metadata h1, h1.ytd-watch-metadata',
      ),
    ) ||
    normalizeText(document.title.replace(/\s*-\s*YouTube$/i, '')) ||
    'YouTube video'
  );
}

function getWatchPageChannel(): string {
  return (
    getFirstText(document, [
      'ytd-watch-metadata ytd-channel-name a',
      'ytd-watch-metadata #channel-name a',
      '#owner #channel-name a',
      '#upload-info a',
    ]) || 'Unknown channel'
  );
}

function getTranscriptPanelCandidates(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(getTranscriptPanelSelectorQuery()),
  );
}

function getTranscriptRendererCandidates(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(getTranscriptRendererSelectorQuery()));
}

function getTranscriptPanel(): HTMLElement | null {
  const panels = getTranscriptPanelCandidates();

  const visiblePanel = panels.find((panel) => isVisible(panel));

  if (visiblePanel) {
    return visiblePanel;
  }

  const expandedPanel = panels.find((panel) => {
    const visibility = panel.getAttribute('visibility') ?? '';
    return visibility.toUpperCase().includes('EXPANDED');
  });

  if (expandedPanel) {
    return expandedPanel;
  }

  const rowBackedPanel = panels.find((panel) =>
    panel.querySelector('ytd-transcript-segment-renderer'),
  );

  if (rowBackedPanel) {
    return rowBackedPanel;
  }

  const rendererBackedPanel = panels.find((panel) =>
    panel.querySelector(getTranscriptRendererSelectorQuery()),
  );

  if (rendererBackedPanel) {
    return rendererBackedPanel;
  }

  const documentRenderer = getTranscriptRendererCandidates()[0];

  if (documentRenderer) {
    return (
      documentRenderer.closest<HTMLElement>('ytd-engagement-panel-section-list-renderer') ??
      documentRenderer
    );
  }

  return null;
}

function getTranscriptRows(): HTMLElement[] {
  const roots: ParentNode[] = [];
  const transcriptPanel = getTranscriptPanel();

  if (transcriptPanel) {
    roots.push(transcriptPanel);
  }

  roots.push(...getTranscriptRendererCandidates());

  if (document.body) {
    roots.push(document.body);
  }

  const seen = new Set<HTMLElement>();
  const rows: HTMLElement[] = [];

  roots.forEach((root) => {
    const directRows = Array.from(
      root.querySelectorAll<HTMLElement>(getTranscriptRowSelectorQuery()),
    );
    const fallbackRows =
      directRows.length > 0
        ? []
        : Array.from(root.querySelectorAll<HTMLElement>('#segments-container > *'));

    [...directRows, ...fallbackRows].forEach((row) => {
      if (seen.has(row)) {
        return;
      }

      seen.add(row);
      rows.push(row);
    });
  });

  const visibleRows = rows.filter((row) => isVisible(row));

  if (visibleRows.length) {
    return visibleRows;
  }

  return rows.filter((row) => normalizeText(row.textContent ?? '').length > 0);
}

function getTranscriptTriggers(): HTMLElement[] {
  const candidates = transcriptTriggerSelectors.flatMap((selector) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)),
  );
  const uniqueCandidates = candidates.filter(
    (candidate, index) => candidates.indexOf(candidate) === index,
  );

  return uniqueCandidates.filter((candidate) => isVisible(candidate));
}

function getDescriptionExpandButton(): HTMLElement | null {
  for (const selector of descriptionExpandSelectors) {
    const candidate = document.querySelector<HTMLElement>(selector);

    if (candidate && isVisible(candidate)) {
      return candidate;
    }
  }

  return null;
}

function truncateDebugString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 24))}...[truncated ${value.length - maxLength + 24} chars]`;
}

function getElementHtmlSnippet(
  element: Element | null | undefined,
  maxLength: number,
): string | null {
  if (!element) {
    return null;
  }

  return truncateDebugString(
    element.outerHTML.replace(/\s+/g, ' ').trim(),
    maxLength,
  );
}

function summarizeElementsForDebug(
  elements: Element[],
  maxLength: number,
  limit = DEBUG_KEYWORD_NODE_LIMIT,
) {
  return elements.slice(0, limit).map((element, index) => ({
    index,
    tagName: element.tagName.toLowerCase(),
    id: element.id || null,
    className:
      element instanceof HTMLElement && typeof element.className === 'string'
        ? element.className
        : null,
    visible: isVisible(element),
    text: normalizeText(element.textContent ?? '').slice(0, 160),
    htmlSnippet: getElementHtmlSnippet(element, maxLength),
  }));
}

function getDebugAncestorSnippet(
  element: Element | null | undefined,
  selector: string,
  maxLength: number,
) {
  if (!element) {
    return null;
  }

  return getElementHtmlSnippet(element.closest(selector), maxLength);
}

function getTranscriptDebugDomSnapshot(triggerElement?: HTMLElement | null) {
  const panels = getTranscriptPanelCandidates();
  const selectedPanel = getTranscriptPanel();
  const selectedPanelIndex = selectedPanel ? panels.indexOf(selectedPanel) : -1;
  const transcriptRenderer =
    selectedPanel?.querySelector<HTMLElement>('ytd-transcript-renderer') ??
    getTranscriptRendererCandidates()[0] ??
    document.querySelector<HTMLElement>('ytd-transcript-renderer');
  const transcriptSegmentContainer =
    selectedPanel?.querySelector<HTMLElement>(
      'ytd-transcript-segment-list-renderer, #segments-container',
    ) ??
    transcriptRenderer?.querySelector<HTMLElement>(
      'ytd-transcript-segment-list-renderer, #segments-container',
    ) ??
    null;
  const rowCandidates = Array.from(
    (
      selectedPanel ??
      transcriptRenderer ??
      document
    ).querySelectorAll<HTMLElement>(getTranscriptRowSelectorQuery()),
  ).slice(0, 5);
  const transcriptKeywordNodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      [
        'ytd-transcript-renderer',
        'ytd-transcript-search-panel-renderer',
        'ytd-transcript-segment-list-renderer',
        '#segments-container',
        '[target-id*="transcript"]',
        '[id*="transcript" i]',
        '[class*="transcript" i]',
        '[aria-label*="transcript" i]',
      ].join(', '),
    ),
  );
  const engagementPanels = Array.from(
    document.querySelectorAll<HTMLElement>('ytd-engagement-panel-section-list-renderer'),
  );
  const visibleInteractiveTranscriptElements = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, [role="button"], a, tp-yt-paper-button, yt-button-shape button',
    ),
  ).filter((element) => /transcript/i.test(element.textContent ?? element.getAttribute('aria-label') ?? ''));

  return {
    selectedTranscriptPanelIndex: selectedPanelIndex >= 0 ? selectedPanelIndex : null,
    activeElementHtml: getElementHtmlSnippet(document.activeElement, DEBUG_ROW_HTML_MAX_LENGTH),
    clickedTriggerHtml: getElementHtmlSnippet(triggerElement, DEBUG_ROW_HTML_MAX_LENGTH),
    clickedTriggerAncestorHtml: getDebugAncestorSnippet(
      triggerElement,
      'ytd-video-description-transcript-section-renderer, ytd-watch-metadata, ytd-engagement-panel-section-list-renderer',
      DEBUG_PANEL_HTML_MAX_LENGTH,
    ),
    transcriptPanelHtml: panels.map((panel, index) => ({
      index,
      targetId: panel.getAttribute('target-id'),
      visibility: panel.getAttribute('visibility'),
      visible: isVisible(panel),
      rowCount: panel.querySelectorAll('ytd-transcript-segment-renderer').length,
      htmlSnippet: getElementHtmlSnippet(panel, DEBUG_PANEL_HTML_MAX_LENGTH),
    })),
    engagementPanelCandidates: engagementPanels.slice(0, DEBUG_KEYWORD_NODE_LIMIT).map((panel, index) => ({
      index,
      targetId: panel.getAttribute('target-id'),
      visibility: panel.getAttribute('visibility'),
      visible: isVisible(panel),
      title:
        normalizeText(
          panel.querySelector('#title-text')?.textContent ??
            panel.querySelector('h2')?.textContent ??
            '',
        ) || null,
      htmlSnippet: getElementHtmlSnippet(panel, DEBUG_ROW_HTML_MAX_LENGTH),
    })),
    transcriptRendererHtml: getElementHtmlSnippet(
      transcriptRenderer,
      DEBUG_RENDERER_HTML_MAX_LENGTH,
    ),
    transcriptSegmentContainerHtml: getElementHtmlSnippet(
      transcriptSegmentContainer,
      DEBUG_RENDERER_HTML_MAX_LENGTH,
    ),
    transcriptRendererCandidates: getTranscriptRendererCandidates().map((candidate, index) => ({
      index,
      tagName: candidate.tagName.toLowerCase(),
      visible: isVisible(candidate),
      htmlSnippet: getElementHtmlSnippet(candidate, DEBUG_ROW_HTML_MAX_LENGTH),
    })),
    transcriptRowSelectorCounts: {
      legacyRows: document.querySelectorAll('ytd-transcript-segment-renderer').length,
      modernRows: document.querySelectorAll('transcript-segment-view-model').length,
      modernHostRows: document.querySelectorAll('.ytwTranscriptSegmentViewModelHost').length,
      segmentsContainerChildren: document.querySelectorAll('#segments-container > *').length,
    },
    transcriptKeywordNodes: summarizeElementsForDebug(
      transcriptKeywordNodes,
      DEBUG_ROW_HTML_MAX_LENGTH,
    ),
    visibleTranscriptInteractions: summarizeElementsForDebug(
      visibleInteractiveTranscriptElements,
      DEBUG_ROW_HTML_MAX_LENGTH,
      6,
    ),
    transcriptRowSamples: rowCandidates.map((row, index) => ({
      index,
      visible: isVisible(row),
      text: normalizeText(row.textContent ?? ''),
      htmlSnippet: getElementHtmlSnippet(row, DEBUG_ROW_HTML_MAX_LENGTH),
    })),
  };
}

function getTranscriptSurfaceSnapshot(options?: {
  includeDomSnapshot?: boolean;
  triggerElement?: HTMLElement | null;
}) {
  const panelCandidates = getTranscriptPanelCandidates().map((panel, index) => ({
    index,
    targetId: panel.getAttribute('target-id'),
    visibility: panel.getAttribute('visibility'),
    visible: isVisible(panel),
    rowCount: panel.querySelectorAll('ytd-transcript-segment-renderer').length,
  }));

  return {
    url: window.location.href,
    transcriptSectionCount: document.querySelectorAll(
      'ytd-video-description-transcript-section-renderer',
    ).length,
    transcriptTriggerCount: getTranscriptTriggers().length,
    transcriptPanelCount: panelCandidates.length,
    transcriptPanels: panelCandidates,
    descriptionExpandCount: descriptionExpandSelectors.reduce((count, selector) => {
      return count + document.querySelectorAll(selector).length;
    }, 0),
    ...(options?.includeDomSnapshot ? getTranscriptDebugDomSnapshot(options.triggerElement) : {}),
  };
}

async function waitForTranscriptRows(timeoutMs = 6000): Promise<HTMLElement[]> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const rows = getTranscriptRows();

    if (rows.length) {
      return rows;
    }

    await wait(150);
  }

  return [];
}

async function waitForTranscriptTrigger(timeoutMs = 5000): Promise<HTMLElement | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const trigger = getTranscriptTriggers()[0];

    if (trigger) {
      return trigger;
    }

    await wait(150);
  }

  return null;
}

async function expandDescriptionIfCollapsed(): Promise<boolean> {
  const expandButton = getDescriptionExpandButton();

  if (!expandButton) {
    await appendTranscriptDebugEntry({
      context: 'content',
      level: 'warn',
      step: 'No description expand button was found before transcript trigger retry.',
      data: getTranscriptSurfaceSnapshot(),
    });
    return false;
  }

  if (!clickElement(expandButton)) {
    await appendTranscriptDebugEntry({
      context: 'content',
      level: 'warn',
      step: 'Description expand button was found but could not be clicked.',
      data: getTranscriptSurfaceSnapshot(),
    });
    return false;
  }

  await appendTranscriptDebugEntry({
    context: 'content',
    step: 'Expanded watch-page description before transcript trigger retry.',
    data: getTranscriptSurfaceSnapshot(),
  });
  await wait(400);
  return true;
}

async function waitForTranscriptPanel(timeoutMs = 6000): Promise<HTMLElement | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const rows = getTranscriptRows();

    if (rows.length) {
      return (
        getTranscriptPanel() ??
        rows[0]?.closest<HTMLElement>('ytd-engagement-panel-section-list-renderer') ??
        rows[0]
      );
    }

    const panel = getTranscriptPanel();

    if (panel) {
      return panel;
    }

    await wait(150);
  }

  return null;
}

async function ensureTranscriptPanelOpen(): Promise<HTMLElement[]> {
  await appendTranscriptDebugEntry({
    context: 'content',
    step: 'Checking for existing transcript rows on watch page.',
    data: {
      url: window.location.href,
    },
  });
  const existingRows = await waitForTranscriptRows(500);

  if (existingRows.length) {
    await appendTranscriptDebugEntry({
      context: 'content',
      step: 'Transcript rows already visible.',
      data: {
        url: window.location.href,
        rowCount: existingRows.length,
      },
    });
    return existingRows;
  }

  let trigger = await waitForTranscriptTrigger(2500);

  if (!trigger) {
    await appendTranscriptDebugEntry({
      context: 'content',
      level: 'warn',
      step: 'Transcript trigger was not immediately visible. Trying description expansion.',
      data: getTranscriptSurfaceSnapshot(),
    });

    const expanded = await expandDescriptionIfCollapsed();

    if (expanded) {
      trigger = await waitForTranscriptTrigger(3000);
    }
  }

  if (!trigger) {
    await appendTranscriptDebugEntry({
      context: 'content',
      level: 'error',
      step: 'Transcript trigger button was not found.',
      data: getTranscriptSurfaceSnapshot({ includeDomSnapshot: true }),
    });
    throw new Error('SELECTOR_MISS: YouTube transcript trigger button was not found on the current watch page.');
  }

  if (!clickElement(trigger)) {
    await appendTranscriptDebugEntry({
      context: 'content',
      level: 'error',
      step: 'Transcript trigger button could not be clicked.',
      data: {
        url: window.location.href,
      },
    });
    throw new Error('SELECTOR_MISS: YouTube transcript trigger button could not be clicked.');
  }
  await appendTranscriptDebugEntry({
    context: 'content',
    step: 'Clicked transcript trigger button.',
    data: getTranscriptSurfaceSnapshot({
      includeDomSnapshot: true,
      triggerElement: trigger,
    }),
  });

  const panel = await waitForTranscriptPanel();

  if (!panel) {
    await appendTranscriptDebugEntry({
      context: 'content',
      level: 'error',
      step: 'Transcript panel did not appear after clicking trigger.',
      data: getTranscriptSurfaceSnapshot({
        includeDomSnapshot: true,
        triggerElement: trigger,
      }),
    });
    throw new Error('TRANSCRIPT_SCRAPE_EMPTY: YouTube transcript panel did not appear after clicking the transcript trigger.');
  }
  await appendTranscriptDebugEntry({
    context: 'content',
    step: 'Transcript panel appeared.',
    data: getTranscriptSurfaceSnapshot({
      includeDomSnapshot: true,
      triggerElement: trigger,
    }),
  });

  const rows = await waitForTranscriptRows();

  if (rows.length) {
    await appendTranscriptDebugEntry({
      context: 'content',
      step: 'Transcript rows loaded after opening panel.',
      data: {
        url: window.location.href,
        rowCount: rows.length,
      },
    });
    return rows;
  }

    await appendTranscriptDebugEntry({
      context: 'content',
      level: 'error',
      step: 'Transcript panel opened but no rows were readable.',
      data: getTranscriptSurfaceSnapshot({
        includeDomSnapshot: true,
        triggerElement: trigger,
      }),
    });
  throw new Error('TRANSCRIPT_SCRAPE_EMPTY: Could not open the YouTube transcript panel on the current page.');
}

function extractTranscriptText(row: HTMLElement): string {
  const directText =
    getFirstText(row, transcriptTextSelectors) || '';

  if (directText) {
    return directText;
  }

  const clone = row.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      '#start-offset, .segment-timestamp, [class*="segment-timestamp"], button, tp-yt-paper-tooltip',
    )
    .forEach((element) => element.remove());
  return normalizeText(clone.textContent ?? '');
}

function extractTranscriptSegments(rows: HTMLElement[]): ScrapedTranscriptSegment[] {
  const rawSegments = rows
    .map((row) => {
      const timestampText = getFirstText(row, transcriptTimestampSelectors) || '';
      const start_time = parseTimestampToSeconds(timestampText);
      const text = extractTranscriptText(row);

      if (start_time === null || !text) {
        return null;
      }

      return {
        text,
        start_time,
      };
    })
    .filter((segment): segment is { text: string; start_time: number } => Boolean(segment));

  return rawSegments.map((segment, index) => ({
    ...segment,
    duration:
      index < rawSegments.length - 1
        ? Math.max(0, rawSegments[index + 1].start_time - segment.start_time)
        : 0,
  }));
}

async function scrapeActiveTranscript(): Promise<{ videoId: string }> {
  const videoId = extractYouTubeVideoId(window.location.href);

  if (!videoId) {
    throw new Error('The current tab is not a YouTube watch page.');
  }

  await appendTranscriptDebugEntry({
    context: 'content',
    step: 'Starting active-page transcript scrape.',
    data: {
      url: window.location.href,
      videoId,
    },
  });
  const rows = await ensureTranscriptPanelOpen();
  const segments = extractTranscriptSegments(rows);

  if (!segments.length) {
    await appendTranscriptDebugEntry({
      context: 'content',
      level: 'error',
      step: 'Transcript rows were found but no usable segments were extracted.',
      data: {
        url: window.location.href,
        videoId,
        rowCount: rows.length,
      },
    });
    throw new Error('TRANSCRIPT_SCRAPE_EMPTY: Transcript panel opened, but no transcript segments were readable.');
  }

  await appendTranscriptDebugEntry({
    context: 'content',
    step: 'Persisting scraped transcript from watch page.',
    data: {
      url: window.location.href,
      videoId,
      segmentCount: segments.length,
    },
  });
  await sendRuntimeRequest({
    type: 'briefly/save-scraped-transcript',
    videoId,
    url: window.location.href,
    title: getWatchPageTitle(),
    channel: getWatchPageChannel(),
    segments,
  });
  await appendTranscriptDebugEntry({
    context: 'content',
    step: 'Active-page transcript scrape completed.',
    data: {
      url: window.location.href,
      videoId,
      segmentCount: segments.length,
    },
  });

  return {
    videoId,
  };
}

async function fetchActiveCaptionTrack(
  request: ActiveCaptionTrackRequest,
): Promise<{ videoId: string; segmentCount: number }> {
  const pageVideoId = extractYouTubeVideoId(window.location.href);

  if (!pageVideoId || pageVideoId !== request.videoId) {
    throw new Error(
      `Active-page caption fetch targeted ${request.videoId}, but the current page is ${pageVideoId ?? 'unknown'}.`,
    );
  }

  await appendTranscriptDebugEntry({
    context: 'content',
    step: 'Starting active-page caption track fetch.',
    data: {
      url: window.location.href,
      videoId: request.videoId,
      languageCode: request.languageCode,
      captionUrlHost: new URL(request.baseUrl).host,
    },
  });

  const segments = await fetchCaptionTrackSegments(
    {
      baseUrl: request.baseUrl,
      languageCode: request.languageCode,
    },
    {
      credentials: 'include',
      expectedVideoId: request.videoId,
      targetLanguageCode: request.targetLanguageCode,
    },
  );

  if (!segments.length) {
    throw new Error('Active-page caption track fetch returned no usable segments.');
  }

  await sendRuntimeRequest({
    type: 'briefly/save-scraped-transcript',
    videoId: request.videoId,
    url: window.location.href,
    title: request.title ?? getWatchPageTitle(),
    channel: request.channel ?? getWatchPageChannel(),
    language: request.languageCode,
    source: 'youtube-active-caption-track',
    segments,
  });

  await appendTranscriptDebugEntry({
    context: 'content',
    step: 'Active-page caption track fetch completed.',
    data: {
      url: window.location.href,
      videoId: request.videoId,
      segmentCount: segments.length,
      languageCode: request.languageCode,
      targetLanguageCode: request.targetLanguageCode,
    },
  });

  return {
    videoId: request.videoId,
    segmentCount: segments.length,
  };
}

async function persistPassiveCaptionCapture(detail: {
  url: string;
  payload: string;
  videoId?: string | null;
}): Promise<void> {
  const videoId = detail.videoId ?? extractYouTubeVideoId(detail.url);

  if (!videoId) {
    return;
  }

  const lastCapturedAt = passiveTranscriptCaptureTimestamps.get(videoId) ?? 0;

  if (Date.now() - lastCapturedAt < 15_000) {
    return;
  }

  const segments = parseCaptionPayload(detail.payload);

  if (!segments.length) {
    return;
  }

  passiveTranscriptCaptureTimestamps.set(videoId, Date.now());
  await appendTranscriptDebugEntry({
    context: 'content',
    step: 'Persisting passively intercepted caption payload from the page bridge.',
    data: {
      url: detail.url,
      videoId,
      segmentCount: segments.length,
    },
  });
  await sendRuntimeRequest({
    type: 'briefly/save-scraped-transcript',
    videoId,
    url: normalizeWatchUrl(videoId),
    title: latestBridgePlayerState?.title ?? getWatchPageTitle(),
    channel: latestBridgePlayerState?.channel ?? getWatchPageChannel(),
    source: 'youtube-active-caption-track',
    segments,
  });
}

function normalizeWatchUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function scheduleProactiveSync(reason: string) {
  if (!clientFeatureFlags.autoSyncActiveVideo || !isWatchPage(window.location.pathname)) {
    return;
  }

  if (proactiveSyncTimeoutId !== null) {
    window.clearTimeout(proactiveSyncTimeoutId);
  }

  proactiveSyncTimeoutId = window.setTimeout(() => {
    proactiveSyncTimeoutId = null;
    void runProactiveSync(reason).catch((error) => {
      void appendTranscriptDebugEntry({
        context: 'content',
        level: 'warn',
        step: 'Proactive transcript sync failed.',
        data: {
          url: window.location.href,
          reason,
          detail: error instanceof Error ? error.message : 'unknown error',
        },
      });
    });
  }, 650);
}

async function runProactiveSync(reason: string): Promise<void> {
  const videoId = extractYouTubeVideoId(window.location.href);

  if (!videoId || !clientFeatureFlags.autoSyncActiveVideo) {
    return;
  }

  const existingFetch = activeCaptionFetchInFlight.get(videoId);

  if (existingFetch) {
    return;
  }

  const pageState = latestBridgePlayerState;
  const selectedCaptionTrack =
    pageState &&
    (pageState.playerVideoId === videoId || pageState.pageVideoId === videoId)
      ? resolveCaptionTrackSelection(
          pageState.captionTracks,
          pageState.translationLanguageCodes.map((languageCode) => ({ languageCode })),
        )
      : null;

  if (selectedCaptionTrack?.track?.baseUrl) {
    await appendTranscriptDebugEntry({
      context: 'content',
      step: 'Running proactive active-page caption track sync from page bridge state.',
      data: {
        url: window.location.href,
        videoId,
        reason,
        languageCode: selectedCaptionTrack.track.languageCode,
        targetLanguageCode: selectedCaptionTrack.targetLanguageCode,
      },
    });

    const proactiveFetch = fetchActiveCaptionTrack({
      type: 'briefly/fetch-active-caption-track',
      videoId,
      baseUrl: selectedCaptionTrack.track.baseUrl,
      languageCode: selectedCaptionTrack.track.languageCode,
      targetLanguageCode: selectedCaptionTrack.targetLanguageCode,
      title: pageState?.title ?? undefined,
      channel: pageState?.channel ?? undefined,
    });

    activeCaptionFetchInFlight.set(videoId, proactiveFetch);

    await proactiveFetch.finally(() => {
      if (activeCaptionFetchInFlight.get(videoId) === proactiveFetch) {
        activeCaptionFetchInFlight.delete(videoId);
      }
    });

    return;
  }

  await appendTranscriptDebugEntry({
    context: 'content',
    level: 'warn',
    step: 'Falling back to runtime-driven proactive transcript sync because no bridge caption track was ready.',
    data: {
      url: window.location.href,
      videoId,
      reason,
    },
  });
  await sendRuntimeRequest({
    type: 'briefly/ingest-transcript',
    url: window.location.href,
  });
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_start',
  main() {
    injectMainWorldBridge();

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'briefly/fetch-active-caption-track') {
        const request = message as ActiveCaptionTrackRequest;
        const existingFetch = activeCaptionFetchInFlight.get(request.videoId);

        if (existingFetch) {
          void appendTranscriptDebugEntry({
            context: 'content',
            level: 'warn',
            step: 'Joining in-flight active-page caption track fetch.',
            data: {
              url: window.location.href,
              videoId: request.videoId,
            },
          });
        } else {
          void appendTranscriptDebugEntry({
            context: 'content',
            step: 'Received active-page caption track fetch request from extension runtime.',
            data: {
              url: window.location.href,
              videoId: request.videoId,
            },
          });
        }

        const fetchPromise = existingFetch ?? fetchActiveCaptionTrack(request);

        if (!existingFetch) {
          activeCaptionFetchInFlight.set(request.videoId, fetchPromise);
        }

        void fetchPromise
          .then((data) => {
            sendResponse({
              ok: true,
              data,
            } satisfies ContentScriptResponse<typeof data>);
          })
          .catch((error) => {
            const detail =
              isCaptionFetchError(error)
                ? `${error.code}: ${error.message}`
                : error instanceof Error
                  ? error.message
                  : 'Active-page caption fetch failed.';
            void appendTranscriptDebugEntry({
              context: 'content',
              level: 'error',
              step: 'Active-page caption track fetch failed.',
              data: {
                url: window.location.href,
                videoId: request.videoId,
                detail,
              },
            });
            sendResponse({
              ok: false,
              error: detail,
            } satisfies ContentScriptResponse<never>);
          })
          .finally(() => {
            if (activeCaptionFetchInFlight.get(request.videoId) === fetchPromise) {
              activeCaptionFetchInFlight.delete(request.videoId);
            }
          });

        return true;
      }

      if (message?.type === 'briefly/scrape-active-transcript') {
        void appendTranscriptDebugEntry({
          context: 'content',
          step: 'Received transcript scrape request from extension runtime.',
          data: {
            url: window.location.href,
          },
        });
        const videoId = extractYouTubeVideoId(window.location.href) ?? 'unknown-video';
        const existingScrape = transcriptScrapeInFlight.get(videoId);

        if (existingScrape) {
          void appendTranscriptDebugEntry({
            context: 'content',
            level: 'warn',
            step: 'Joining in-flight transcript scrape on the current page.',
            data: {
              url: window.location.href,
              videoId,
            },
          });
        }

        const scrapePromise = existingScrape ?? scrapeActiveTranscript();

        if (!existingScrape) {
          transcriptScrapeInFlight.set(videoId, scrapePromise);
        }

        void scrapePromise
          .then((data) => {
            void appendTranscriptDebugEntry({
              context: 'content',
              step: 'Transcript scrape request completed successfully.',
              data: {
                url: window.location.href,
                videoId: data.videoId,
              },
            });
            sendResponse({
              ok: true,
              data,
            } satisfies ContentScriptResponse<typeof data>);
          })
          .catch((error) => {
            void appendTranscriptDebugEntry({
              context: 'content',
              level: 'error',
              step: 'Transcript scrape request failed.',
              data: {
                url: window.location.href,
                detail: error instanceof Error ? error.message : 'Transcript scraping failed.',
              },
            });
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : 'Transcript scraping failed.',
            } satisfies ContentScriptResponse<never>);
          })
          .finally(() => {
            if (transcriptScrapeInFlight.get(videoId) === scrapePromise) {
              transcriptScrapeInFlight.delete(videoId);
            }
          });

        return true;
      }

      if (message?.type === 'briefly/proactive-sync-active-video') {
        scheduleProactiveSync('background-web-navigation');
        sendResponse({
          ok: true,
          data: {
            scheduled: true,
          },
        } satisfies ContentScriptResponse<{ scheduled: true }>);
        return false;
      }

      return false;
    });

    injectStyles();
    void syncQueueState();
    void syncClientConfig();
    scanAndInject();

    window.addEventListener(PLAYER_STATE_BRIDGE_EVENT, (event) => {
      const customEvent = event as CustomEvent<typeof latestBridgePlayerState>;

      if (!customEvent.detail) {
        return;
      }

      latestBridgePlayerState = customEvent.detail;
      scheduleProactiveSync('player-state-bridge');
    });

    window.addEventListener(CAPTION_CAPTURE_BRIDGE_EVENT, (event) => {
      const customEvent = event as CustomEvent<{
        url: string;
        payload: string;
        videoId?: string | null;
      }>;

      if (!customEvent.detail?.payload) {
        return;
      }

      void persistPassiveCaptionCapture(customEvent.detail).catch((error) => {
        void appendTranscriptDebugEntry({
          context: 'content',
          level: 'warn',
          step: 'Passive caption bridge payload could not be persisted.',
          data: {
            url: customEvent.detail.url,
            detail: error instanceof Error ? error.message : 'unknown error',
          },
        });
      });
    });

    const observer = new MutationObserver((mutations) => {
      if (!mutationTouchesInjectionSurface(mutations)) {
        return;
      }

      scheduleScan();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    window.addEventListener('yt-navigate-finish', () => {
      void syncQueueState();
      void syncClientConfig();
      scheduleScan();
      scheduleProactiveSync('yt-navigate-finish');
    });

    window.addEventListener('yt-page-data-updated', () => {
      void syncQueueState();
      void syncClientConfig();
      scheduleScan();
      scheduleProactiveSync('yt-page-data-updated');
    });
  },
});
