import { db } from '../db';
import { getOrCreateVideoWorkspace } from '../db/workspaces';
import type { TranscriptMetadata, TranscriptRecord, TranscriptSegment, VideoRecord } from '../types/domain';
import { extractYouTubeVideoId } from '../utils/youtube';
import { trackEvent } from './telemetry';
import { fetchTranscriptFromYouTube } from './youtube-client';

export type IngestedTranscriptPayload = {
  video: VideoRecord;
  transcript: TranscriptRecord;
};

const TRANSCRIPT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TRANSCRIPT_CACHE_MAX_ITEMS = 500;

async function cleanupTranscriptCache(): Promise<void> {
  const staleThreshold = Date.now() - TRANSCRIPT_CACHE_TTL_MS;
  const staleTranscripts = await db.transcripts
    .where('metadata.fetchedAt')
    .below(staleThreshold)
    .toArray();

  if (staleTranscripts.length) {
    await db.transcripts.bulkDelete(staleTranscripts.map((record) => record.videoId));
  }

  const allTranscripts = await db.transcripts
    .orderBy('metadata.fetchedAt')
    .reverse()
    .toArray();

  if (allTranscripts.length > TRANSCRIPT_CACHE_MAX_ITEMS) {
    const overflow = allTranscripts.slice(TRANSCRIPT_CACHE_MAX_ITEMS);
    await db.transcripts.bulkDelete(overflow.map((record) => record.videoId));
  }
}

export async function getStoredTranscriptPayload(
  videoId: string,
): Promise<IngestedTranscriptPayload | null> {
  const [existingVideo, existingTranscript] = await Promise.all([
    db.videos.get(videoId),
    db.transcripts.get(videoId),
  ]);

  if (!existingVideo || !existingTranscript) {
    return null;
  }

  if (Date.now() - existingTranscript.metadata.fetchedAt > TRANSCRIPT_CACHE_TTL_MS) {
    await db.transcripts.delete(videoId);
    return null;
  }

  return {
    video: existingVideo,
    transcript: existingTranscript,
  };
}

export async function persistTranscriptPayload(
  payload: IngestedTranscriptPayload,
): Promise<IngestedTranscriptPayload> {
  const existingVideo = await db.videos.get(payload.video.id);
  const video: VideoRecord = {
    ...payload.video,
    createdAt: existingVideo?.createdAt ?? payload.video.createdAt,
    updatedAt: Date.now(),
  };

  await db.videos.put(video);
  await db.transcripts.put(payload.transcript);
  await cleanupTranscriptCache();
  await getOrCreateVideoWorkspace(video.id);
  await trackEvent('transcript_synced', {
    videoId: video.id,
    source: payload.transcript.metadata.source,
    segmentCount: payload.transcript.segments.length,
  });

  return {
    video,
    transcript: payload.transcript,
  };
}

export async function ingestTranscriptByBackgroundProbe(
  videoId: string,
  forceRefresh = false,
): Promise<IngestedTranscriptPayload> {
  if (!forceRefresh) {
    const existing = await getStoredTranscriptPayload(videoId);

    if (existing) {
      return existing;
    }
  }

  const payload = await fetchTranscriptFromYouTube(videoId);
  return persistTranscriptPayload(payload);
}

export async function ingestTranscriptByVideoId(
  videoId: string,
  forceRefresh = false,
): Promise<IngestedTranscriptPayload> {
  return ingestTranscriptByBackgroundProbe(videoId, forceRefresh);
}

export async function ingestTranscriptFromUrl(
  url: string,
  forceRefresh = false,
): Promise<IngestedTranscriptPayload> {
  const videoId = extractYouTubeVideoId(url);

  if (!videoId) {
    throw new Error('Could not identify a YouTube video from the active tab.');
  }

  return ingestTranscriptByBackgroundProbe(videoId, forceRefresh);
}

export async function saveScrapedTranscript(input: {
  videoId: string;
  url: string;
  title: string;
  channel: string;
  language?: string;
  source?: TranscriptMetadata['source'];
  segments: Array<Pick<TranscriptSegment, 'text' | 'start_time'> & Partial<Pick<TranscriptSegment, 'duration'>>>;
}): Promise<IngestedTranscriptPayload> {
  const timestamp = Date.now();
  const existingVideo = await db.videos.get(input.videoId);
  const normalizedSegments = input.segments
    .map((segment) => ({
      text: segment.text.trim(),
      start_time: segment.start_time,
      duration: segment.duration ?? 0,
    }))
    .filter((segment) => segment.text.length > 0);

  if (!normalizedSegments.length) {
    throw new Error('Transcript scraping returned no usable segments.');
  }

  return persistTranscriptPayload({
    video: {
    id: input.videoId,
    url: input.url,
    title: input.title,
    channel: input.channel,
    createdAt: existingVideo?.createdAt ?? timestamp,
    updatedAt: timestamp,
    },
    transcript: {
      videoId: input.videoId,
      segments: normalizedSegments,
      metadata: {
        source: input.source ?? 'youtube-dom-scrape',
        language: input.language,
        fetchedAt: timestamp,
        title: input.title,
        channel: input.channel,
      },
    },
  });
}
