import { defineUnlistedScript } from 'wxt/sandbox';

const BRIEFLY_BRIDGE_FLAG = '__brieflyYoutubeBridgeInstalled';
const PLAYER_STATE_BRIDGE_EVENT = 'briefly:player-state';
const CAPTION_CAPTURE_BRIDGE_EVENT = 'briefly:caption-response';

type PlayerBridgeResponse = {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        languageCode?: string;
        kind?: string;
        vssId?: string;
        baseUrl?: string;
        name?: {
          simpleText?: string;
          runs?: Array<{ text?: string }>;
        };
      }>;
      translationLanguages?: Array<{
        languageCode?: string;
      }>;
    };
  };
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
  };
};

function isTranscriptRequestUrl(url: string): boolean {
  return /\/api\/timedtext|\/youtubei\/v1\/get_transcript/i.test(url);
}

function readPlayerState() {
  const player = document.getElementById('movie_player') as
    | (HTMLElement & { getPlayerResponse?: () => unknown })
    | null;
  const response = player?.getPlayerResponse?.() as PlayerBridgeResponse | undefined;

  return {
    url: location.href,
    pageVideoId: new URL(location.href).searchParams.get('v'),
    playerVideoId: response?.videoDetails?.videoId ?? null,
    title: response?.videoDetails?.title ?? null,
    channel: response?.videoDetails?.author ?? null,
    captionTracks:
      response?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.map((track) => ({
        baseUrl: track.baseUrl,
        languageCode: track.languageCode,
        kind: track.kind,
        vssId: track.vssId,
        name:
          track.name?.simpleText ??
          track.name?.runs?.map((run) => run.text ?? '').join('').trim() ??
          '',
      })) ?? [],
    translationLanguageCodes:
      response?.captions?.playerCaptionsTracklistRenderer?.translationLanguages
        ?.map((language) => language.languageCode ?? '')
        .filter(Boolean) ?? [],
  };
}

function dispatchBridgeEvent(name: string, detail: unknown) {
  window.dispatchEvent(
    new CustomEvent(name, {
      detail,
    }),
  );
}

function emitPlayerState(source: string) {
  dispatchBridgeEvent(PLAYER_STATE_BRIDGE_EVENT, {
    ...readPlayerState(),
    source,
    emittedAt: Date.now(),
  });
}

function emitCaptionCapture(detail: {
  source: 'fetch' | 'xhr';
  url: string;
  payload: string;
  status?: number;
  contentType?: string | null;
}) {
  dispatchBridgeEvent(CAPTION_CAPTURE_BRIDGE_EVENT, {
    ...detail,
    videoId: (() => {
      try {
        return new URL(detail.url).searchParams.get('v');
      } catch {
        return null;
      }
    })(),
    capturedAt: Date.now(),
  });
}

export default defineUnlistedScript({
  main() {
    if (
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      typeof XMLHttpRequest === 'undefined'
    ) {
      return;
    }

    const globalWindow = window as Window & {
      [BRIEFLY_BRIDGE_FLAG]?: boolean;
    };

    if (globalWindow[BRIEFLY_BRIDGE_FLAG]) {
      return;
    }

    globalWindow[BRIEFLY_BRIDGE_FLAG] = true;

    const emitSoon = (source: string) => {
      window.setTimeout(() => emitPlayerState(source), 0);
      window.setTimeout(() => emitPlayerState(`${source}:settled`), 600);
      window.setTimeout(() => emitPlayerState(`${source}:late`), 1800);
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);

      if (isTranscriptRequestUrl(url)) {
        try {
          const payload = await response.clone().text();
          emitCaptionCapture({
            source: 'fetch',
            url,
            payload,
            status: response.status,
            contentType: response.headers.get('content-type'),
          });
        } catch {
          // Ignore bridge capture failures to avoid breaking the page.
        }
      }

      return response;
    };

    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function open(
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      (this as XMLHttpRequest & { __brieflyUrl?: string }).__brieflyUrl = String(url);
      return originalXhrOpen.call(this, method, url, async ?? true, username, password);
    };

    XMLHttpRequest.prototype.send = function send(body?: XMLHttpRequestBodyInit | null) {
      this.addEventListener('load', function onLoad() {
        const xhr = this as XMLHttpRequest & { __brieflyUrl?: string };
        const url = xhr.__brieflyUrl;

        if (!url || !isTranscriptRequestUrl(url) || typeof xhr.responseText !== 'string') {
          return;
        }

        emitCaptionCapture({
          source: 'xhr',
          url,
          payload: xhr.responseText,
          status: xhr.status,
          contentType: xhr.getResponseHeader('content-type'),
        });
      });

      return originalXhrSend.call(this, body);
    };

    document.addEventListener('yt-navigate-finish', () => emitSoon('yt-navigate-finish'));
    document.addEventListener('yt-page-data-updated', () => emitSoon('yt-page-data-updated'));
    window.addEventListener('load', () => emitSoon('window-load'));
    emitSoon('document-start');
  },
});
