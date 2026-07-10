import type { TranscriptRecord, TranscriptSegment, VideoRecord } from '../types/domain';
import { normalizeYouTubeUrl } from '../utils/youtube';
import {
  CaptionFetchError,
  fetchCaptionTrackSegments as fetchSharedCaptionTrackSegments,
} from './caption-payload';
import {
  resolveCaptionTrackSelection,
} from './caption-track-utils';
import { recordTranscriptNetworkRequest } from './transcript-health';

type CaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: {
    simpleText?: string;
    runs?: Array<{
      text?: string;
    }>;
  };
  vssId?: string;
};

type PlayerResponse = {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
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

type YtConfig = {
  apiKey?: string;
  clientName?: string;
  clientNameHeader?: string;
  clientVersion?: string;
  hl?: string;
  gl?: string;
  visitorData?: string;
};

type TranscriptSource =
  | 'youtube-watch-page'
  | 'youtube-player-endpoint-android'
  | 'youtube-player-endpoint-tv';

type TranscriptAttempt = {
  source: TranscriptSource;
  playerResponse: PlayerResponse | null;
  track: CaptionTrack | null;
  targetLanguageCode?: string;
};

function getTimestamp(): number {
  return Date.now();
}

function getVideoUrl(videoId: string): string {
  return `${normalizeYouTubeUrl(videoId)}&hl=en`;
}

function parseJsonObject<T>(input: string, marker: string): T | null {
  const markerIndex = input.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  const startIndex = input.indexOf('{', markerIndex + marker.length);

  if (startIndex === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex; index < input.length; index += 1) {
    const character = input[index];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (character === '\\') {
      isEscaped = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;

      if (depth === 0) {
        const candidate = input.slice(startIndex, index + 1);

        try {
          return JSON.parse(candidate) as T;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function parsePlayerResponseFromHtml(html: string): PlayerResponse | null {
  return (
    parseJsonObject<PlayerResponse>(html, 'var ytInitialPlayerResponse = ') ??
    parseJsonObject<PlayerResponse>(html, 'ytInitialPlayerResponse = ') ??
    parseJsonObject<PlayerResponse>(html, '"ytInitialPlayerResponse":')
  );
}

function extractConfigValue(html: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stringPattern = new RegExp(`"${escapedKey}":"([^"]+)"`);
  const numberPattern = new RegExp(`"${escapedKey}":(\\d+)`);
  const stringMatch = html.match(stringPattern);

  if (stringMatch?.[1]) {
    return stringMatch[1];
  }

  return html.match(numberPattern)?.[1];
}

function extractYtConfig(html: string): YtConfig {
  const ytcfg =
    parseJsonObject<Record<string, unknown>>(html, 'ytcfg.set(') ??
    parseJsonObject<Record<string, unknown>>(html, 'ytcfg = ');

  const getConfigString = (key: string): string | undefined => {
    const value = ytcfg?.[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : extractConfigValue(html, key);
  };

  return {
    apiKey: getConfigString('INNERTUBE_API_KEY'),
    clientName: getConfigString('INNERTUBE_CONTEXT_CLIENT_NAME') === '1' ? 'WEB' : undefined,
    clientNameHeader: getConfigString('INNERTUBE_CONTEXT_CLIENT_NAME') ?? '1',
    clientVersion: getConfigString('INNERTUBE_CONTEXT_CLIENT_VERSION') ?? getConfigString('INNERTUBE_CLIENT_VERSION'),
    hl: getConfigString('HL') ?? 'en',
    gl: getConfigString('GL') ?? 'US',
    visitorData: getConfigString('VISITOR_DATA') ?? getConfigString('visitorData'),
  };
}

async function fetchHtml(url: string): Promise<string> {
  await recordTranscriptNetworkRequest('youtube-html');
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    throw new Error(`HTML request failed with ${response.status}.`);
  }

  const html = await response.text();
  const normalized = html.toLowerCase();

  if (
    normalized.includes('consent.youtube.com') ||
    normalized.includes('before you continue to youtube')
  ) {
    throw new CaptionFetchError('CONSENT_WALL', 'YouTube returned a consent wall instead of the watch page.');
  }

  return html;
}

async function fetchPlayerResponse(
  videoId: string,
  config: YtConfig,
  client: 'android' | 'tv',
): Promise<PlayerResponse | null> {
  if (!config.apiKey) {
    return null;
  }

  const clientContext =
    client === 'android'
      ? {
          clientName: 'ANDROID',
          clientVersion: '20.10.38',
          clientNameHeader: '3',
          userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US)',
          extraClient: {
            androidSdkVersion: 34,
          },
        }
      : {
          clientName: 'TVHTML5',
          clientVersion: '7.20250305.16.00',
          clientNameHeader: '7',
          userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) TV Safari/537.36',
          extraClient: {
            userInterfaceTheme: 'USER_INTERFACE_THEME_LIGHT',
          },
        };

  await recordTranscriptNetworkRequest(`youtube-player-${client}`);
  const response = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(config.apiKey)}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.youtube.com',
        'User-Agent': clientContext.userAgent,
        'X-YouTube-Client-Name': clientContext.clientNameHeader,
        'X-YouTube-Client-Version': clientContext.clientVersion,
      },
      body: JSON.stringify({
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        playbackContext: {
          contentPlaybackContext: {
            html5Preference: 'HTML5_PREF_WANTS',
          },
        },
        context: {
          client: {
            clientName: clientContext.clientName,
            clientVersion: clientContext.clientVersion,
            hl: config.hl ?? 'en',
            gl: config.gl ?? 'US',
            visitorData: config.visitorData,
            ...clientContext.extraClient,
          },
        },
      }),
    },
  );

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as PlayerResponse;

  if (payload.videoDetails?.videoId && payload.videoDetails.videoId !== videoId) {
    return null;
  }

  return payload;
}

function buildVideoRecord(
  videoId: string,
  title: string,
  channel: string,
): VideoRecord {
  const timestamp = getTimestamp();

  return {
    id: videoId,
    url: normalizeYouTubeUrl(videoId),
    title,
    channel,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function buildTranscriptRecord(input: {
  videoId: string;
  title: string;
  channel: string;
  language?: string;
  segments: TranscriptSegment[];
  source: TranscriptRecord['metadata']['source'];
}): TranscriptRecord {
  return {
    videoId: input.videoId,
    segments: input.segments,
    metadata: {
      source: input.source,
      language: input.language,
      fetchedAt: getTimestamp(),
      title: input.title,
      channel: input.channel,
    },
  };
}

function resolveVideoTitle(playerResponses: Array<PlayerResponse | null>, videoId: string): string {
  for (const response of playerResponses) {
    const title = response?.videoDetails?.title?.trim();

    if (title) {
      return title;
    }
  }

  return `YouTube Video ${videoId}`;
}

function resolveVideoChannel(playerResponses: Array<PlayerResponse | null>): string {
  for (const response of playerResponses) {
    const author = response?.videoDetails?.author?.trim();

    if (author) {
      return author;
    }
  }

  return 'Unknown channel';
}

async function fetchTranscriptFromAttempts(
  videoId: string,
  attempts: Array<() => Promise<TranscriptAttempt>>,
): Promise<{
  video: VideoRecord;
  transcript: TranscriptRecord;
}> {
  const errors: string[] = [];
  const playerResponses: Array<PlayerResponse | null> = [];

  for (const resolveAttempt of attempts) {
    const attempt = await resolveAttempt();
    playerResponses.push(attempt.playerResponse);

    if (!attempt.track) {
      errors.push(`${attempt.source}: no caption tracks`);
      continue;
    }

    try {
      const segments = await fetchSharedCaptionTrackSegments(attempt.track, {
        credentials: 'include',
        expectedVideoId: videoId,
        targetLanguageCode: attempt.targetLanguageCode,
      });

      if (!segments.length) {
        errors.push(`${attempt.source}: transcript segments were empty`);
        continue;
      }

      const title = resolveVideoTitle(playerResponses, videoId);
      const channel = resolveVideoChannel(playerResponses);

      return {
        video: buildVideoRecord(videoId, title, channel),
        transcript: buildTranscriptRecord({
          videoId,
          title,
          channel,
          language: attempt.track.languageCode,
          segments,
          source: attempt.source,
        }),
      };
    } catch (error) {
      const detail =
        error instanceof CaptionFetchError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : 'caption track fetch failed';
      errors.push(
        `${attempt.source}: ${detail}`,
      );
    }
  }

  throw new Error(
    errors.length
      ? `No transcript could be loaded. ${errors.join(' | ')}`
      : 'No transcript could be loaded for this video.',
  );
}

// Background-only transcript probe for off-page or non-active video workflows.
// Active watch pages must use DOM scraping because timedtext requests can require ephemeral POT tokens.
export async function fetchTranscriptFromYouTube(videoId: string): Promise<{
  video: VideoRecord;
  transcript: TranscriptRecord;
}> {
  const watchHtml = await fetchHtml(getVideoUrl(videoId));
  const watchPlayerResponse = parsePlayerResponseFromHtml(watchHtml);

  if (
    watchPlayerResponse?.videoDetails?.videoId &&
    watchPlayerResponse.videoDetails.videoId !== videoId
  ) {
    throw new Error(
      `Watch page player response targeted ${watchPlayerResponse.videoDetails.videoId}, not ${videoId}.`,
    );
  }

  const watchConfig = extractYtConfig(watchHtml);

  return fetchTranscriptFromAttempts(videoId, [
    async () => {
      const selection = resolveCaptionTrackSelection(
        watchPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
        watchPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.translationLanguages,
      );

      return {
        source: 'youtube-watch-page',
        playerResponse: watchPlayerResponse,
        track: selection.track,
        targetLanguageCode: selection.targetLanguageCode,
      };
    },
    async () => {
      const androidPlayerResponse = await fetchPlayerResponse(videoId, watchConfig, 'android');
      const selection = resolveCaptionTrackSelection(
        androidPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
        androidPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.translationLanguages,
      );

      return {
        source: 'youtube-player-endpoint-android',
        playerResponse: androidPlayerResponse,
        track: selection.track,
        targetLanguageCode: selection.targetLanguageCode,
      };
    },
    async () => {
      const tvPlayerResponse = await fetchPlayerResponse(videoId, watchConfig, 'tv');
      const selection = resolveCaptionTrackSelection(
        tvPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
        tvPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.translationLanguages,
      );

      return {
        source: 'youtube-player-endpoint-tv',
        playerResponse: tvPlayerResponse,
        track: selection.track,
        targetLanguageCode: selection.targetLanguageCode,
      };
    },
  ]);
}
