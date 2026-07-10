import { z } from 'zod';

import type { SummaryMode } from '../types/domain';

const summaryModeSchema = z.custom<SummaryMode>(
  (value) =>
    typeof value === 'string' &&
    (value === 'tldr' ||
      value === 'action-items' ||
      value === 'timestamped-highlights' ||
      value === 'study-notes' ||
      value === 'due-diligence' ||
      value === 'thread-draft' ||
      value === 'creator-research' ||
      /^custom:.+$/.test(value)),
  {
    message: 'Invalid summary mode.',
  },
);
const providerSchema = z.enum(['openai', 'anthropic', 'gemini', 'ollama']);
const queuedVideoInputSchema = z.object({
  videoId: z.string().min(1),
  title: z.string().min(1),
  channel: z.string().min(1),
});
const scrapedTranscriptSegmentSchema = z.object({
  text: z.string().min(1),
  start_time: z.number().nonnegative(),
  duration: z.number().nonnegative().optional(),
});
const transcriptSourceSchema = z.enum([
  'youtube-active-caption-track',
  'youtube-watch-page',
  'youtube-player-endpoint-android',
  'youtube-player-endpoint-tv',
  'youtube-embed-page',
  'youtube-dom-scrape',
  'youtubei.js',
]);

export const ingestTranscriptRequestSchema = z.object({
  type: z.literal('briefly/ingest-transcript'),
  url: z.string().url(),
  forceRefresh: z.boolean().optional(),
  tabId: z.number().int().nonnegative().optional(),
});

export const generateSummaryRequestSchema = z.object({
  type: z.literal('briefly/generate-summary'),
  workspaceId: z.string(),
  videoIds: z.array(z.string()).min(1),
  summaryMode: summaryModeSchema,
  provider: providerSchema.optional(),
  tabId: z.number().int().nonnegative().optional(),
});

export const sendChatMessageRequestSchema = z.object({
  type: z.literal('briefly/send-chat-message'),
  workspaceId: z.string(),
  videoIds: z.array(z.string()).min(1),
  message: z.string().min(1),
  provider: providerSchema.optional(),
  tabId: z.number().int().nonnegative().optional(),
});

export const queueVideoRequestSchema = z.object({
  type: z.literal('briefly/queue-video'),
  videoId: z.string().min(1),
  forceRefresh: z.boolean().optional(),
  title: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
});

export const getActiveQueueRequestSchema = z.object({
  type: z.literal('briefly/get-active-queue'),
});

export const getPremiumStateRequestSchema = z.object({
  type: z.literal('briefly/get-premium-state'),
});

export const getClientConfigRequestSchema = z.object({
  type: z.literal('briefly/get-client-config'),
});

export const removeFromQueueRequestSchema = z.object({
  type: z.literal('briefly/remove-from-queue'),
  videoId: z.string().min(1),
});

export const clearQueueRequestSchema = z.object({
  type: z.literal('briefly/clear-queue'),
});

export const queueMultipleVideosRequestSchema = z.object({
  type: z.literal('briefly/queue-multiple-videos'),
  videos: z.array(queuedVideoInputSchema).min(1),
});

export const saveScrapedTranscriptRequestSchema = z.object({
  type: z.literal('briefly/save-scraped-transcript'),
  videoId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  channel: z.string().min(1),
  language: z.string().min(1).optional(),
  source: transcriptSourceSchema.optional(),
  segments: z.array(scrapedTranscriptSegmentSchema).min(1),
});

export const runtimeRequestSchema = z.discriminatedUnion('type', [
  ingestTranscriptRequestSchema,
  generateSummaryRequestSchema,
  sendChatMessageRequestSchema,
  queueVideoRequestSchema,
  getActiveQueueRequestSchema,
  getPremiumStateRequestSchema,
  getClientConfigRequestSchema,
  removeFromQueueRequestSchema,
  clearQueueRequestSchema,
  queueMultipleVideosRequestSchema,
  saveScrapedTranscriptRequestSchema,
]);

export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;

export type RuntimeResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
