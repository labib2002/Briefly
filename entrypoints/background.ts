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
import { appendTranscriptDebugEntry } from '../src/services/transcript-debug';
import {
  saveScrapedTranscript,
} from '../src/services/transcript-ingestion';
import {
  clearQueueRunnerTabReference,
  ensureTranscriptForUrl,
  runTranscriptCanaryCheck,
} from '../src/services/transcript-orchestrator';
import {
  refreshTranscriptRuntimeConfig,
  TRANSCRIPT_CANARY_ALARM,
  TRANSCRIPT_CONFIG_ALARM,
  getTranscriptRuntimeConfig,
} from '../src/services/transcript-runtime';
import type { VideoRecord } from '../src/types/domain';
import { normalizeYouTubeUrl } from '../src/utils/youtube';
import { answerWorkspaceChat } from '../src/services/workspace-chat';
import { getSettings } from '../src/db/settings';

const STARTUP_CANARY_LAST_RUN_STORAGE_KEY = 'briefly.transcriptStartupCanaryLastRunAt';
const STARTUP_CANARY_MIN_INTERVAL_MS = 30 * 60 * 1000;

async function handleRuntimeMessage(
  message: RuntimeRequest,
  sender?: chrome.runtime.MessageSender,
): Promise<RuntimeResponse<unknown>> {
  try {
    switch (message.type) {
      case 'briefly/ingest-transcript': {
        const validated = ingestTranscriptRequestSchema.parse(message);
        const inferredTabId =
          validated.tabId ??
          (typeof sender?.tab?.id === 'number' ? sender.tab.id : undefined);
        await appendTranscriptDebugEntry({
          context: 'background',
          step: 'Received transcript ingest request.',
          data: {
            url: validated.url,
            tabId: inferredTabId,
            forceRefresh: validated.forceRefresh ?? false,
          },
        });
        const payload = await ensureTranscriptForUrl({
          url: validated.url,
          activeTabId: inferredTabId,
          forceRefresh: validated.forceRefresh,
        });
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
        const [settings, runtimeConfig] = await Promise.all([
          getSettings(),
          getTranscriptRuntimeConfig(),
        ]);
        return {
          ok: true,
          data: {
            isPremium: settings.isPremium,
            featureFlags: settings.featureFlags,
            selectorOverrides: runtimeConfig.selectorOverrides,
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
        await appendTranscriptDebugEntry({
          context: 'background',
          step: 'Persisting scraped transcript from content script.',
          data: {
            videoId: validated.videoId,
            segmentCount: validated.segments.length,
          },
        });
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
    const runStartupCanaryCheck = async () => {
      const stored = await chrome.storage.session.get(STARTUP_CANARY_LAST_RUN_STORAGE_KEY);
      const lastRunAt =
        typeof stored[STARTUP_CANARY_LAST_RUN_STORAGE_KEY] === 'number'
          ? stored[STARTUP_CANARY_LAST_RUN_STORAGE_KEY]
          : 0;

      if (Date.now() - lastRunAt < STARTUP_CANARY_MIN_INTERVAL_MS) {
        return;
      }

      await chrome.storage.session.set({
        [STARTUP_CANARY_LAST_RUN_STORAGE_KEY]: Date.now(),
      });
      await runTranscriptCanaryCheck();
    };

    const scheduleTranscriptRuntime = async () => {
      try {
        await chrome.alarms.create(TRANSCRIPT_CONFIG_ALARM, {
          periodInMinutes: 60,
        });
        await chrome.alarms.create(TRANSCRIPT_CANARY_ALARM, {
          periodInMinutes: 360,
        });
        await refreshTranscriptRuntimeConfig();
        await runStartupCanaryCheck();
      } catch (error) {
        console.error('Briefly failed to initialize transcript runtime.', error);
      }
    };

    const enableSidePanel = async () => {
      try {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      } catch (error) {
        console.error('Briefly failed to enable side panel behavior.', error);
      }
    };

    chrome.runtime.onInstalled.addListener(() => {
      void enableSidePanel();
      void scheduleTranscriptRuntime();
    });

    chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
      const parsed = runtimeRequestSchema.safeParse(rawMessage);

      if (!parsed.success) {
        sendResponse({
          ok: false,
          error: parsed.error.issues[0]?.message ?? 'Invalid runtime message.',
        });
        return false;
      }

      void handleRuntimeMessage(parsed.data, sender).then(sendResponse);
      return true;
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === TRANSCRIPT_CONFIG_ALARM) {
        void refreshTranscriptRuntimeConfig();
      }

      if (alarm.name === TRANSCRIPT_CANARY_ALARM) {
        void runTranscriptCanaryCheck();
      }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      void clearQueueRunnerTabReference(tabId);
    });

    chrome.webNavigation.onHistoryStateUpdated.addListener(
      (details) => {
        if (details.frameId !== 0 || !details.url?.includes('/watch?v=')) {
          return;
        }

        window.setTimeout(() => {
          void chrome.tabs
            .sendMessage(details.tabId, {
              type: 'briefly/proactive-sync-active-video',
            })
            .catch(async () => {
              try {
                await ensureTranscriptForUrl({
                  url: details.url!,
                  activeTabId: details.tabId,
                });
              } catch {
                // The content script path remains the preferred proactive sync surface.
              }
            });
        }, 600);
      },
      {
        url: [
          {
            hostContains: 'youtube.com',
            pathPrefix: '/watch',
          },
        ],
      },
    );

    void enableSidePanel();
    void scheduleTranscriptRuntime();
  },
});
