if (typeof window === 'undefined') {
  (globalThis as any).window = globalThis;
}

import { defineBackground } from 'wxt/sandbox';

import { db } from '../src/db';
import {
  addVideosToWorkspace,
  clearActiveQueueWorkspace,
  getOrCreateActiveQueueWorkspace,
  getOrCreateVideoWorkspace,
  removeVideoFromWorkspace,
} from '../src/db/workspaces';
import {
  clearQueueRequestSchema,
  getClientConfigRequestSchema,
  getActiveQueueRequestSchema,
  getPremiumStateRequestSchema,
  generateSummaryRequestSchema,
  ingestTranscriptRequestSchema,
  queueVideoRequestSchema,
  queueMultipleVideosRequestSchema,
  removeFromQueueRequestSchema,
  runtimeRequestSchema,
  saveScrapedTranscriptRequestSchema,
  sendChatMessageRequestSchema,
  type RuntimeRequest,
  type RuntimeResponse,
} from '../src/runtime/messages';
import { generateWorkspaceSummary } from '../src/services/summarization';
import { trackEvent } from '../src/services/telemetry';
import {
  type IngestedTranscriptPayload,
  ingestTranscriptFromUrl,
  saveScrapedTranscript,
} from '../src/services/transcript-ingestion';
import type { VideoRecord } from '../src/types/domain';
import { extractYouTubeVideoId, normalizeYouTubeUrl } from '../src/utils/youtube';
import { answerWorkspaceChat } from '../src/services/workspace-chat';
import { getSettings } from '../src/db/settings';

type ContentScriptResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

async function handleRuntimeMessage(
  message: RuntimeRequest,
): Promise<RuntimeResponse<unknown>> {
  try {
    switch (message.type) {
      case 'briefly/ingest-transcript': {
        const validated = ingestTranscriptRequestSchema.parse(message);
        const videoId = extractYouTubeVideoId(validated.url);
        let payload: IngestedTranscriptPayload | undefined;

        if (videoId && !validated.forceRefresh) {
          const [existingVideo, existingTranscript] = await Promise.all([
            db.videos.get(videoId),
            db.transcripts.get(videoId),
          ]);

          if (existingVideo && existingTranscript) {
            payload = {
              video: existingVideo,
              transcript: existingTranscript,
            };
          }
        }

        if (!payload && validated.tabId !== undefined) {
          try {
            const scrapeResult = (await chrome.tabs.sendMessage(validated.tabId, {
              type: 'briefly/scrape-active-transcript',
            })) as ContentScriptResponse<{ videoId: string }>;

            if (scrapeResult?.ok && scrapeResult.data.videoId) {
              const [video, transcript] = await Promise.all([
                db.videos.get(scrapeResult.data.videoId),
                db.transcripts.get(scrapeResult.data.videoId),
              ]);

              if (!video || !transcript) {
                throw new Error('Scraped transcript was saved incompletely.');
              }

              payload = {
                video,
                transcript,
              };
            } else if (scrapeResult && !scrapeResult.ok) {
              throw new Error(scrapeResult.error);
            }
          } catch (error) {
            throw new Error(
              `Active-tab transcript scraping failed: ${error instanceof Error ? error.message : 'unknown error'}`,
            );
          }
        }

        if (!payload) {
          payload = await ingestTranscriptFromUrl(validated.url, validated.forceRefresh);
        }
        const workspace = await getOrCreateVideoWorkspace(payload.video.id);
        return {
          ok: true,
          data: {
            ...payload,
            workspace,
          },
        };
      }
      case 'briefly/generate-summary': {
        const validated = generateSummaryRequestSchema.parse(message);
        const result = await generateWorkspaceSummary(validated);
        return {
          ok: true,
          data: result,
        };
      }
      case 'briefly/send-chat-message': {
        const validated = sendChatMessageRequestSchema.parse(message);
        const result = await answerWorkspaceChat(validated);
        return {
          ok: true,
          data: result,
        };
      }
      case 'briefly/queue-video': {
        const validated = queueVideoRequestSchema.parse(message);
        const timestamp = Date.now();
        const existingVideo = await db.videos.get(validated.videoId);
        const video: VideoRecord = {
          id: validated.videoId,
          url: normalizeYouTubeUrl(validated.videoId),
          title: validated.title ?? existingVideo?.title ?? 'Queued YouTube video',
          channel: validated.channel ?? existingVideo?.channel ?? 'Unknown channel',
          createdAt: existingVideo?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };

        await db.videos.put(video);
        const workspace = await addVideosToWorkspace(
          (await getOrCreateActiveQueueWorkspace()).id,
          [validated.videoId],
        );
        await trackEvent('video_queued', {
          videoId: validated.videoId,
          videoCount: 1,
          source: 'thumbnail',
        });
        return {
          ok: true,
          data: {
            workspace,
            video,
          },
        };
      }
      case 'briefly/get-active-queue': {
        getActiveQueueRequestSchema.parse(message);
        const workspace = await getOrCreateActiveQueueWorkspace();
        return {
          ok: true,
          data: {
            workspace,
          },
        };
      }
      case 'briefly/get-premium-state': {
        getPremiumStateRequestSchema.parse(message);
        const settings = await getSettings();
        return {
          ok: true,
          data: {
            isPremium: settings.isPremium,
          },
        };
      }
      case 'briefly/get-client-config': {
        getClientConfigRequestSchema.parse(message);
        const settings = await getSettings();
        return {
          ok: true,
          data: {
            isPremium: settings.isPremium,
            featureFlags: settings.featureFlags,
          },
        };
      }
      case 'briefly/remove-from-queue': {
        const validated = removeFromQueueRequestSchema.parse(message);
        const workspace = await removeVideoFromWorkspace(
          (await getOrCreateActiveQueueWorkspace()).id,
          validated.videoId,
        );
        return {
          ok: true,
          data: {
            workspace,
          },
        };
      }
      case 'briefly/clear-queue': {
        clearQueueRequestSchema.parse(message);
        const workspace = await clearActiveQueueWorkspace();
        return {
          ok: true,
          data: {
            workspace,
          },
        };
      }
      case 'briefly/queue-multiple-videos': {
        const validated = queueMultipleVideosRequestSchema.parse(message);
        const timestamp = Date.now();
        const existingVideos = await db.videos.bulkGet(validated.videos.map((video) => video.videoId));
        const existingVideosById = new Map(
          existingVideos
            .filter((video): video is VideoRecord => Boolean(video))
            .map((video) => [video.id, video]),
        );

        await db.videos.bulkPut(
          validated.videos.map((video) => {
            const existing = existingVideosById.get(video.videoId);

            return {
              id: video.videoId,
              url: normalizeYouTubeUrl(video.videoId),
              title: video.title,
              channel: video.channel,
              createdAt: existing?.createdAt ?? timestamp,
              updatedAt: timestamp,
            } satisfies VideoRecord;
          }),
        );

        const workspace = await addVideosToWorkspace(
          (await getOrCreateActiveQueueWorkspace()).id,
          validated.videos.map((video) => video.videoId),
        );
        await trackEvent('video_queued', {
          videoCount: validated.videos.length,
          source: 'playlist',
        });

        return {
          ok: true,
          data: {
            workspace,
            added: validated.videos.length,
          },
        };
      }
      case 'briefly/save-scraped-transcript': {
        const validated = saveScrapedTranscriptRequestSchema.parse(message);
        const payload = await saveScrapedTranscript(validated);
        const workspace = await getOrCreateVideoWorkspace(payload.video.id);
        return {
          ok: true,
          data: {
            ...payload,
            workspace,
          },
        };
      }
      default:
        return {
          ok: false,
          error: 'Unsupported message payload.',
        };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unexpected background error.',
    };
  }
}

export default defineBackground({
  type: 'module',
  main() {
    const enableSidePanel = async () => {
      try {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      } catch (error) {
        console.error('Briefly failed to enable side panel behavior.', error);
      }
    };

    chrome.runtime.onInstalled.addListener(() => {
      void enableSidePanel();
    });

    chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
      const parsed = runtimeRequestSchema.safeParse(rawMessage);

      if (!parsed.success) {
        sendResponse({
          ok: false,
          error: parsed.error.issues[0]?.message ?? 'Invalid runtime message.',
        });
        return false;
      }

      void handleRuntimeMessage(parsed.data).then(sendResponse);
      return true;
    });

    void enableSidePanel();
  },
});
