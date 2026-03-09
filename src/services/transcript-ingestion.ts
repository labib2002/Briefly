import { db } from '../db';
import { getOrCreateVideoWorkspace } from '../db/workspaces';
import type { TranscriptRecord, TranscriptSegment, VideoRecord } from '../types/domain';
import { extractYouTubeVideoId } from '../utils/youtube';
import { trackEvent } from './telemetry';
import { fetchTranscriptFromYouTube } from './youtube-client';

export type IngestedTranscriptPayload = {
  video: VideoRecord;
  transcript: TranscriptRecord;
};

export async function ingestTranscriptByVideoId(
  videoId: string,
  forceRefresh = false,
): Promise<IngestedTranscriptPayload> {
  if (!forceRefresh) {
    const [existingVideo, existingTranscript] = await Promise.all([
      db.videos.get(videoId),
      db.transcripts.get(videoId),
    ]);

    if (existingVideo && existingTranscript) {
      return {
        video: existingVideo,
        transcript: existingTranscript,
      };
    }
  }

  const { video, transcript } = await fetchTranscriptFromYouTube(videoId);
  const existingVideo = await db.videos.get(videoId);

  await db.videos.put({
    ...video,
    createdAt: existingVideo?.createdAt ?? video.createdAt,
    updatedAt: Date.now(),
  });
  await db.transcripts.put(transcript);
  await getOrCreateVideoWorkspace(videoId);
  await trackEvent('transcript_synced', {
    videoId,
    source: transcript.metadata.source,
    segmentCount: transcript.segments.length,
  });

  return {
    video,
    transcript,
  };
}

export async function ingestTranscriptFromUrl(
  url: string,
  forceRefresh = false,
): Promise<IngestedTranscriptPayload> {
  const videoId = extractYouTubeVideoId(url);

  if (!videoId) {
    throw new Error('Could not identify a YouTube video from the active tab.');
  }

  return ingestTranscriptByVideoId(videoId, forceRefresh);
}

export async function saveScrapedTranscript(input: {
  videoId: string;
  url: string;
  title: string;
  channel: string;
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

  const video: VideoRecord = {
    id: input.videoId,
    url: input.url,
    title: input.title,
    channel: input.channel,
    createdAt: existingVideo?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  const transcript: TranscriptRecord = {
    videoId: input.videoId,
    segments: normalizedSegments,
    metadata: {
      source: 'youtube-dom-scrape',
      fetchedAt: timestamp,
      title: input.title,
      channel: input.channel,
    },
  };

  await db.videos.put(video);
  await db.transcripts.put(transcript);
  await getOrCreateVideoWorkspace(input.videoId);
  await trackEvent('transcript_synced', {
    videoId: input.videoId,
    source: transcript.metadata.source,
    segmentCount: transcript.segments.length,
  });

  return {
    video,
    transcript,
  };
}
