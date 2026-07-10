import type { TranscriptSegment } from '../types/domain';

import type { CaptionTrackLike } from './caption-track-utils';
import { recordTranscriptNetworkRequest } from './transcript-health';

export type CaptionFetchFailureCode =
  | 'EMPTY_200_RESPONSE'
  | 'RATE_LIMITED'
  | 'CONSENT_WALL'
  | 'AGE_RESTRICTED'
  | 'CAPTION_REQUEST_FAILED'
  | 'CAPTION_PAYLOAD_HTML'
  | 'CAPTION_PAYLOAD_PARSE_FAILED';

export class CaptionFetchError extends Error {
  code: CaptionFetchFailureCode;
  status?: number;
  contentType?: string;
  bodyLength?: number;

  constructor(
    code: CaptionFetchFailureCode,
    message: string,
    options: {
      status?: number;
      contentType?: string;
      bodyLength?: number;
    } = {},
  ) {
    super(message);
    this.name = 'CaptionFetchError';
    this.code = code;
    this.status = options.status;
    this.contentType = options.contentType;
    this.bodyLength = options.bodyLength;
  }
}

function normalizeSegmentText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
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

function parseXmlTranscriptSegments(payload: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const textPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  const paragraphPattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  const patterns = [textPattern, paragraphPattern];

  for (const pattern of patterns) {
    for (const match of payload.matchAll(pattern)) {
      const attributes = match[1] ?? '';
      const startMatch = attributes.match(/\b(?:start|t)="([^"]+)"/);
      const durationMatch = attributes.match(/\b(?:dur|d)="([^"]+)"/);
      const rawText = decodeHtmlEntities(match[2] ?? '').replace(/<br\s*\/?>/gi, ' ');
      const text = normalizeSegmentText(rawText.replace(/<[^>]+>/g, ' '));

      if (!text) {
        continue;
      }

      segments.push({
        text,
        start_time: Number(startMatch?.[1] ?? 0),
        duration: Math.max(Number(durationMatch?.[1] ?? 0), 0),
      });
    }

    if (segments.length) {
      return segments;
    }
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

export function parseCaptionPayload(payload: string): TranscriptSegment[] {
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

function classifyHtmlPayload(payload: string): CaptionFetchFailureCode {
  const normalized = payload.toLowerCase();

  if (normalized.includes('consent.youtube.com') || normalized.includes('before you continue to youtube')) {
    return 'CONSENT_WALL';
  }

  if (
    normalized.includes('sign in to confirm your age') ||
    normalized.includes('age-restricted') ||
    normalized.includes('content warning')
  ) {
    return 'AGE_RESTRICTED';
  }

  return 'CAPTION_PAYLOAD_HTML';
}

function buildCaptionTrackUrl(track: CaptionTrackLike, format: 'json3' | 'raw'): string {
  if (!track.baseUrl) {
    throw new CaptionFetchError(
      'CAPTION_REQUEST_FAILED',
      'YouTube caption track is missing a base URL.',
    );
  }

  const url = new URL(track.baseUrl);

  if (format === 'json3') {
    url.searchParams.set('fmt', 'json3');
  } else {
    url.searchParams.delete('fmt');
  }

  return url.toString();
}

async function fetchCaptionPayload(
  url: string,
  options: {
    credentials?: RequestCredentials;
  } = {},
): Promise<string> {
  await recordTranscriptNetworkRequest('caption-track');
  const response = await fetch(url, {
    credentials: options.credentials ?? 'include',
    headers: {
      'Accept': 'application/json,text/plain,application/xml,text/xml,text/vtt,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const contentType = response.headers.get('content-type') ?? '';
  const payload = await response.text();
  const trimmed = payload.trim();

  if (!response.ok) {
    throw new CaptionFetchError(
      response.status === 429 ? 'RATE_LIMITED' : 'CAPTION_REQUEST_FAILED',
      `Caption track request failed with ${response.status}.`,
      {
        status: response.status,
        contentType,
        bodyLength: payload.length,
      },
    );
  }

  if (!trimmed) {
    throw new CaptionFetchError(
      'EMPTY_200_RESPONSE',
      'Caption track request returned HTTP 200 with an empty body.',
      {
        status: response.status,
        contentType,
        bodyLength: payload.length,
      },
    );
  }

  if (
    contentType.includes('text/html') ||
    trimmed.startsWith('<!DOCTYPE html') ||
    trimmed.startsWith('<html')
  ) {
    const code = classifyHtmlPayload(trimmed);
    throw new CaptionFetchError(code, `Caption track request returned HTML instead of captions (${code}).`, {
      status: response.status,
      contentType,
      bodyLength: payload.length,
    });
  }

  return payload;
}

export function isCaptionFetchError(error: unknown): error is CaptionFetchError {
  return error instanceof CaptionFetchError;
}

export async function fetchCaptionTrackSegments(
  track: CaptionTrackLike,
  options: {
    credentials?: RequestCredentials;
    expectedVideoId?: string;
    targetLanguageCode?: string;
  } = {},
): Promise<TranscriptSegment[]> {
  const candidateUrls = [
    buildCaptionTrackUrl(
      {
        ...track,
        baseUrl: (() => {
          if (!track.baseUrl || !options.targetLanguageCode) {
            return track.baseUrl;
          }

          const translated = new URL(track.baseUrl);
          translated.searchParams.set('tlang', options.targetLanguageCode);
          return translated.toString();
        })(),
      },
      'json3',
    ),
    buildCaptionTrackUrl(
      {
        ...track,
        baseUrl: (() => {
          if (!track.baseUrl || !options.targetLanguageCode) {
            return track.baseUrl;
          }

          const translated = new URL(track.baseUrl);
          translated.searchParams.set('tlang', options.targetLanguageCode);
          return translated.toString();
        })(),
      },
      'raw',
    ),
  ];
  const errors: string[] = [];
  let firstError: CaptionFetchError | null = null;

  for (const url of candidateUrls) {
    try {
      if (options.expectedVideoId) {
        const resolvedVideoId = new URL(url).searchParams.get('v');

        if (resolvedVideoId && resolvedVideoId !== options.expectedVideoId) {
          throw new CaptionFetchError(
            'CAPTION_REQUEST_FAILED',
            `Caption track URL targeted ${resolvedVideoId}, not ${options.expectedVideoId}.`,
          );
        }
      }

      const payload = await fetchCaptionPayload(url, options);
      const segments = parseCaptionPayload(payload);

      if (segments.length) {
        return segments;
      }

      const error = new CaptionFetchError(
        'CAPTION_PAYLOAD_PARSE_FAILED',
        `Caption payload could not be parsed from ${new URL(url).searchParams.get('fmt') ?? 'raw'} format.`,
        {
          bodyLength: payload.length,
        },
      );
      firstError ??= error;
      errors.push(error.message);
    } catch (error) {
      const typedError =
        error instanceof CaptionFetchError
          ? error
          : new CaptionFetchError(
              'CAPTION_REQUEST_FAILED',
              error instanceof Error ? error.message : 'Caption fetch failed.',
            );
      firstError ??= typedError;
      errors.push(typedError.message);
    }
  }

  if (firstError) {
    throw new CaptionFetchError(
      firstError.code,
      errors.join(' | '),
      {
        status: firstError.status,
        contentType: firstError.contentType,
        bodyLength: firstError.bodyLength,
      },
    );
  }

  throw new CaptionFetchError(
    'CAPTION_REQUEST_FAILED',
    'Caption fetch failed with no usable response.',
  );
}
