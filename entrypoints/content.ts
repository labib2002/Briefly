import { defineContentScript } from 'wxt/sandbox';

import { PREMIUM_PLACEHOLDER_URL } from '../src/constants/premium';
import { sendRuntimeRequest } from '../src/runtime/client';
import type { FeatureFlags } from '../src/types/domain';
import { extractYouTubeVideoId } from '../src/utils/youtube';

const STYLE_ID = 'briefly-queue-style';
const BUTTON_SELECTOR = '[data-briefly-queue-button="true"]';
const PLAYLIST_BUTTON_SELECTOR = '[data-briefly-playlist-button="true"]';
const TRANSCRIPT_TRIGGER_SELECTOR = 'ytd-video-description-transcript-section-renderer button';
const TRANSCRIPT_PANEL_SELECTORS = [
  'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]',
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
].join(', ');
const THUMBNAIL_HOST_SELECTORS = 'ytd-thumbnail, yt-lockup-view-model';
const INJECTION_SCAN_DELAY_MS = 120;
const queuedVideoIds = new Set<string>();
const defaultFeatureFlags: FeatureFlags = {
  enableThumbnailInjection: true,
  enablePlaylistIngestion: true,
  autoSyncActiveVideo: true,
  enableTelemetry: true,
};
let premiumAccessEnabled = false;
let clientFeatureFlags: FeatureFlags = defaultFeatureFlags;
let scanTimeoutId: number | null = null;
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
};
type ContentScriptResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function isSupportedPage(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/results') || pathname.startsWith('/playlist');
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

  document.head.append(style);
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
    const payload = await sendRuntimeRequest<{ isPremium: boolean; featureFlags: FeatureFlags }>({
      type: 'briefly/get-client-config',
    });
    premiumAccessEnabled = payload.isPremium;
    clientFeatureFlags = {
      ...defaultFeatureFlags,
      ...payload.featureFlags,
    };
    removeInjectedUI();
    updatePlaylistButtonState();
  } catch (error) {
    premiumAccessEnabled = false;
    clientFeatureFlags = defaultFeatureFlags;
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

function getTranscriptPanel(): HTMLElement | null {
  const panel = document.querySelector<HTMLElement>(TRANSCRIPT_PANEL_SELECTORS);

  return panel && isVisible(panel) ? panel : null;
}

function getTranscriptRows(): HTMLElement[] {
  const panel = getTranscriptPanel();

  if (!panel) {
    return [];
  }

  return Array.from(panel.querySelectorAll<HTMLElement>('ytd-transcript-segment-renderer')).filter((row) =>
    isVisible(row),
  );
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
    const trigger = document.querySelector<HTMLElement>(TRANSCRIPT_TRIGGER_SELECTOR);

    if (trigger && isVisible(trigger)) {
      return trigger;
    }

    await wait(150);
  }

  return null;
}

async function waitForTranscriptPanel(timeoutMs = 6000): Promise<HTMLElement | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const panel = getTranscriptPanel();

    if (panel) {
      return panel;
    }

    await wait(150);
  }

  return null;
}

async function ensureTranscriptPanelOpen(): Promise<HTMLElement[]> {
  const existingRows = await waitForTranscriptRows(500);

  if (existingRows.length) {
    return existingRows;
  }

  const trigger = await waitForTranscriptTrigger();

  if (!trigger) {
    throw new Error('YouTube transcript trigger button was not found on the current watch page.');
  }

  if (!clickElement(trigger)) {
    throw new Error('YouTube transcript trigger button could not be clicked.');
  }

  const panel = await waitForTranscriptPanel();

  if (!panel) {
    throw new Error('YouTube transcript panel did not appear after clicking the transcript trigger.');
  }

  const rows = await waitForTranscriptRows();

  if (rows.length) {
    return rows;
  }

  throw new Error('Could not open the YouTube transcript panel on the current page.');
}

function extractTranscriptText(row: HTMLElement): string {
  const directText =
    getFirstText(row, [
      '#segment-text',
      '.segment-text',
      '[class*="segment-text"]',
      'yt-formatted-string.segment-text',
    ]) || '';

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
      const timestampText =
        getFirstText(row, [
          '#start-offset',
          '.segment-timestamp',
          '[class*="segment-timestamp"]',
          '[class*="cue-group-start-offset"]',
        ]) || '';
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

  const rows = await ensureTranscriptPanelOpen();
  const segments = extractTranscriptSegments(rows);

  if (!segments.length) {
    throw new Error('Transcript panel opened, but no transcript segments were readable.');
  }

  await sendRuntimeRequest({
    type: 'briefly/save-scraped-transcript',
    videoId,
    url: window.location.href,
    title: getWatchPageTitle(),
    channel: getWatchPageChannel(),
    segments,
  });

  return {
    videoId,
  };
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'briefly/scrape-active-transcript') {
        return false;
      }

      void scrapeActiveTranscript()
        .then((data) => {
          sendResponse({
            ok: true,
            data,
          } satisfies ContentScriptResponse<typeof data>);
        })
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Transcript scraping failed.',
          } satisfies ContentScriptResponse<never>);
        });

      return true;
    });

    injectStyles();
    void syncQueueState();
    void syncClientConfig();
    scanAndInject();

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
    });
  },
});
