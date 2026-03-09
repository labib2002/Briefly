import type { TranscriptRecord, TranscriptSegment, VideoRecord } from '../types/domain';
import { normalizeYouTubeUrl } from '../utils/youtube';

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
    };
  };
  videoDetails?: {
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
  | 'youtube-player-endpoint'
  | 'youtube-embed-page';

type TranscriptAttempt = {
  source: TranscriptSource;
  playerResponse: PlayerResponse | null;
  track: CaptionTrack | null;
};

function getTimestamp(): number {
  return Date.now();
}

function getVideoUrl(videoId: string): string {
  return `${normalizeYouTubeUrl(videoId)}&hl=en`;
}

function getEmbedUrl(videoId: string): string {
  return `https://www.youtube.com/embed/${videoId}?hl=en`;
}

function getCaptionTrackName(track: CaptionTrack): string {
  if (track.name?.simpleText) {
    return track.name.simpleText;
  }

  return track.name?.runs?.map((run) => run.text ?? '').join('').trim() ?? '';
}

function normalizeSegmentText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
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

function selectCaptionTrack(
  tracks: CaptionTrack[] | undefined,
): CaptionTrack | null {
  if (!tracks?.length) {
    return null;
  }

  const rankedTracks = [...tracks].sort((left, right) => {
    const score = (track: CaptionTrack) => {
      const language = track.languageCode ?? '';
      const name = getCaptionTrackName(track).toLowerCase();
      let total = 0;

      if (language.startsWith('en')) {
        total += 4;
      }

      if (track.kind !== 'asr') {
        total += 3;
      }

      if (name.includes('english')) {
        total += 2;
      }

      if (track.vssId?.includes('.en')) {
        total += 1;
      }

      return total;
    };

    return score(right) - score(left);
  });

  return rankedTracks[0] ?? null;
}

function getCaptionTrackUrl(track: CaptionTrack): string {
  if (!track.baseUrl) {
    throw new Error('YouTube caption track is missing a base URL.');
  }

  const url = new URL(track.baseUrl);
  url.searchParams.set('fmt', 'json3');
  return url.toString();
}

function getRawCaptionTrackUrl(track: CaptionTrack): string {
  if (!track.baseUrl) {
    throw new Error('YouTube caption track is missing a base URL.');
  }

  const url = new URL(track.baseUrl);
  url.searchParams.delete('fmt');
  return url.toString();
}

function mapJson3EventsToSegments(payload: unknown): TranscriptSegment[] {
  if (!payload || typeof payload !== 'object' || !('events' in payload) || !Array.isArray(payload.events)) {
    return [];
  }

  return payload.events
    .map((event) => {
      if (!event || typeof event !== 'object') {
        return null;
      }

      const typedEvent = event as {
        tStartMs?: number;
        dDurationMs?: number;
        segs?: Array<{ utf8?: string }>;
      };
      const text = normalizeSegmentText(
        (typedEvent.segs ?? [])
          .map((segment) => segment.utf8 ?? '')
          .join(''),
      );

      if (!text) {
        return null;
      }

      return {
        text,
        start_time: Number(typedEvent.tStartMs ?? 0) / 1000,
        duration: Math.max(Number(typedEvent.dDurationMs ?? 0) / 1000, 0),
      } satisfies TranscriptSegment;
    })
    .filter((segment): segment is TranscriptSegment => Boolean(segment));
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num: string) => String.fromCodePoint(parseInt(num, 10)));
}

function parseXmlTranscriptSegments(payload: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;

  for (const match of payload.matchAll(pattern)) {
    const attributes = match[1] ?? '';
    const startMatch = attributes.match(/\bstart="([^"]+)"/);
    const durationMatch = attributes.match(/\bdur="([^"]+)"/);
    const rawText = decodeHtmlEntities(match[2] ?? '').replace(/<br\s*\/?>/gi, ' ');
    const text = normalizeSegmentText(rawText);

    if (!text) {
      continue;
    }

    segments.push({
      text,
      start_time: Number(startMatch?.[1] ?? 0),
      duration: Math.max(Number(durationMatch?.[1] ?? 0), 0),
    });
  }

  return segments;
}

function parseVttTimestamp(input: string): number {
  const normalized = input.trim().replace(',', '.');
  const parts = normalized.split(':').map((part) => Number(part));

  if (parts.some((value) => Number.isNaN(value))) {
    return 0;
  }

  if (parts.length === 3) {
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  }

  if (parts.length === 2) {
    return (parts[0] * 60) + parts[1];
  }

  return parts[0] ?? 0;
}

function parseVttTranscriptSegments(payload: string): TranscriptSegment[] {
  const blocks = payload
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const segments: TranscriptSegment[] = [];

  for (const block of blocks) {
    if (block.startsWith('WEBVTT')) {
      continue;
    }

    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingLine = lines.find((line) => line.includes('-->'));

    if (!timingLine) {
      continue;
    }

    const [startRaw, endRaw] = timingLine.split('-->').map((part) => part.trim());
    const textLines = lines.slice(lines.indexOf(timingLine) + 1);
    const text = normalizeSegmentText(textLines.join(' '));

    if (!text) {
      continue;
    }

    const start = parseVttTimestamp(startRaw);
    const end = parseVttTimestamp(endRaw.split(' ')[0] ?? endRaw);

    segments.push({
      text,
      start_time: start,
      duration: Math.max(end - start, 0),
    });
  }

  return segments;
}

function parseCaptionPayload(payload: string): TranscriptSegment[] {
  const trimmed = payload.trim();

  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('{')) {
    try {
      return mapJson3EventsToSegments(JSON.parse(trimmed) as unknown);
    } catch {
      return [];
    }
  }

  if (trimmed.startsWith('<')) {
    return parseXmlTranscriptSegments(trimmed);
  }

  if (trimmed.startsWith('WEBVTT')) {
    return parseVttTranscriptSegments(trimmed);
  }

  return [];
}

async function fetchCaptionPayload(url: string): Promise<string> {
  const response = await fetch(url, {
    credentials: 'omit',
    headers: {
      'Accept': 'application/json,text/plain,application/xml,text/xml,text/vtt,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    throw new Error(`Caption track request failed with ${response.status}.`);
  }

  return response.text();
}

async function fetchCaptionTrackSegments(track: CaptionTrack): Promise<TranscriptSegment[]> {
  const candidateUrls = [getCaptionTrackUrl(track), getRawCaptionTrackUrl(track)];
  const errors: string[] = [];

  for (const url of candidateUrls) {
    try {
      const payload = await fetchCaptionPayload(url);
      const segments = parseCaptionPayload(payload);

      if (segments.length) {
        return segments;
      }

      errors.push(`unparseable caption payload from ${new URL(url).searchParams.get('fmt') ?? 'raw'} format`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'caption fetch failed');
    }
  }

  throw new Error(errors.join(' | '));
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    credentials: 'omit',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    throw new Error(`HTML request failed with ${response.status}.`);
  }

  return response.text();
}

async function fetchPlayerResponse(
  videoId: string,
  config: YtConfig,
): Promise<PlayerResponse | null> {
  if (!config.apiKey || !config.clientVersion) {
    return null;
  }

  const response = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(config.apiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.youtube.com',
        'X-YouTube-Client-Name': config.clientNameHeader ?? '1',
        'X-YouTube-Client-Version': config.clientVersion,
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
            clientName: config.clientName ?? 'WEB',
            clientVersion: config.clientVersion,
            hl: config.hl ?? 'en',
            gl: config.gl ?? 'US',
            visitorData: config.visitorData,
          },
        },
      }),
    },
  );

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as PlayerResponse;
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
  attempts: TranscriptAttempt[],
): Promise<{
  video: VideoRecord;
  transcript: TranscriptRecord;
}> {
  const errors: string[] = [];
  const playerResponses = attempts.map((attempt) => attempt.playerResponse);

  for (const attempt of attempts) {
    if (!attempt.track) {
      errors.push(`${attempt.source}: no caption tracks`);
      continue;
    }

    try {
      const segments = await fetchCaptionTrackSegments(attempt.track);

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
      errors.push(
        `${attempt.source}: ${error instanceof Error ? error.message : 'caption track fetch failed'}`,
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
  const watchConfig = extractYtConfig(watchHtml);
  const endpointPlayerResponse = await fetchPlayerResponse(videoId, watchConfig);

  let embedPlayerResponse: PlayerResponse | null = null;
  try {
    const embedHtml = await fetchHtml(getEmbedUrl(videoId));
    embedPlayerResponse = parsePlayerResponseFromHtml(embedHtml);
  } catch (error) {
    console.warn('Briefly embed page transcript probe failed.', error);
  }

  return fetchTranscriptFromAttempts(videoId, [
    {
      source: 'youtube-watch-page',
      playerResponse: watchPlayerResponse,
      track: selectCaptionTrack(
        watchPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
      ),
    },
    {
      source: 'youtube-player-endpoint',
      playerResponse: endpointPlayerResponse,
      track: selectCaptionTrack(
        endpointPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
      ),
    },
    {
      source: 'youtube-embed-page',
      playerResponse: embedPlayerResponse,
      track: selectCaptionTrack(
        embedPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
      ),
    },
  ]);
}
