import { db } from '../db';
import { extractYouTubeVideoId } from '../utils/youtube';
import { appendTranscriptDebugEntry } from './transcript-debug';
import {
  getStoredTranscriptPayload,
  ingestTranscriptByBackgroundProbe,
  type IngestedTranscriptPayload,
} from './transcript-ingestion';
import {
  getTranscriptRuntimeConfig,
  reportTranscriptFailure,
  reportTranscriptSuccess,
  saveTranscriptRuntimeConfig,
} from './transcript-runtime';
import { resolveCaptionTrackSelection, summarizeCaptionTrack } from './caption-track-utils';

const QUEUE_RUNNER_TAB_ID_STORAGE_KEY = 'briefly.queueRunnerTabId';
const QUEUE_RUNNER_PACING_STORAGE_KEY = 'briefly.queueRunnerPacingState';
const NO_RECEIVER_ERROR_FRAGMENT = 'Receiving end does not exist';
const transcriptInFlightRequests = new Map<string, Promise<IngestedTranscriptPayload>>();

type CaptionTrackSnapshot = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  vssId?: string;
  name?: string;
};

export type PlayerStateSnapshot = {
  url: string;
  pageVideoId: string | null;
  playerVideoId: string | null;
  title: string | null;
  channel: string | null;
  captionTrackCount: number;
  captionTracks: CaptionTrackSnapshot[];
  translationLanguageCodes: string[];
};

type ContentScriptResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

type QueueRunnerPacingState = {
  nextAllowedAt: number;
  currentBackoffMs: number;
};

function wait(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getRandomDelay(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) {
    return minMs;
  }

  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function summarizeCaptionTracksForLog(tracks: CaptionTrackSnapshot[]) {
  return tracks.map((track) => summarizeCaptionTrack(track));
}

function startServiceWorkerKeepAlive(): () => void {
  const intervalId = setInterval(() => {
    void chrome.runtime.getPlatformInfo();
  }, 20_000);

  return () => {
    clearInterval(intervalId);
  };
}

async function getQueueRunnerPacingState(): Promise<QueueRunnerPacingState> {
  const stored = await chrome.storage.session.get(QUEUE_RUNNER_PACING_STORAGE_KEY);
  const value = stored[QUEUE_RUNNER_PACING_STORAGE_KEY];

  if (!value || typeof value !== 'object') {
    return {
      nextAllowedAt: 0,
      currentBackoffMs: 0,
    };
  }

  const typed = value as Partial<QueueRunnerPacingState>;

  return {
    nextAllowedAt: typeof typed.nextAllowedAt === 'number' ? typed.nextAllowedAt : 0,
    currentBackoffMs: typeof typed.currentBackoffMs === 'number' ? typed.currentBackoffMs : 0,
  };
}

async function saveQueueRunnerPacingState(
  state: QueueRunnerPacingState,
): Promise<QueueRunnerPacingState> {
  await chrome.storage.session.set({
    [QUEUE_RUNNER_PACING_STORAGE_KEY]: state,
  });

  return state;
}

async function getStoredQueueRunnerTabId(): Promise<number | null> {
  const stored = await chrome.storage.session.get(QUEUE_RUNNER_TAB_ID_STORAGE_KEY);
  return typeof stored[QUEUE_RUNNER_TAB_ID_STORAGE_KEY] === 'number'
    ? stored[QUEUE_RUNNER_TAB_ID_STORAGE_KEY]
    : null;
}

async function setStoredQueueRunnerTabId(tabId: number | null): Promise<void> {
  if (typeof tabId === 'number') {
    await chrome.storage.session.set({
      [QUEUE_RUNNER_TAB_ID_STORAGE_KEY]: tabId,
    });
    return;
  }

  await chrome.storage.session.remove(QUEUE_RUNNER_TAB_ID_STORAGE_KEY);
}

export async function clearQueueRunnerTabReference(tabId: number): Promise<void> {
  const current = await getStoredQueueRunnerTabId();

  if (current === tabId) {
    await setStoredQueueRunnerTabId(null);
  }
}

export async function readPlayerStateFromTab(tabId: number): Promise<PlayerStateSnapshot | null> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const player = document.getElementById('movie_player') as
        | (HTMLElement & { getPlayerResponse?: () => unknown })
        | null;
      const response = player?.getPlayerResponse?.() as
        | {
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
          }
        | undefined;
      const captionTracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      const translationLanguageCodes =
        response?.captions?.playerCaptionsTracklistRenderer?.translationLanguages
          ?.map((language) => language.languageCode ?? '')
          .filter(Boolean) ?? [];
      const captionTrackSummaries = captionTracks.map((track) => ({
        languageCode: track.languageCode,
        kind: track.kind,
        vssId: track.vssId,
        baseUrl: track.baseUrl,
        name:
          track.name?.simpleText ??
          track.name?.runs?.map((run) => run.text ?? '').join('').trim() ??
          '',
      }));
      const pageVideoId = new URL(location.href).searchParams.get('v');

      return {
        url: location.href,
        pageVideoId,
        playerVideoId: response?.videoDetails?.videoId ?? null,
        title: response?.videoDetails?.title ?? null,
        channel: response?.videoDetails?.author ?? null,
        captionTrackCount: captionTrackSummaries.length,
        captionTracks: captionTrackSummaries,
        translationLanguageCodes,
      };
    },
  });

  return (result?.result as PlayerStateSnapshot | undefined) ?? null;
}

async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);

    if (tab.status === 'complete') {
      return;
    }

    await wait(200);
  }

  throw new Error('Tab did not complete loading before the timeout.');
}

async function waitForPlayerStateMatch(
  tabId: number,
  expectedVideoId: string,
  timeoutMs: number,
): Promise<PlayerStateSnapshot> {
  const startedAt = Date.now();
  let lastState: PlayerStateSnapshot | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const state = await readPlayerStateFromTab(tabId);

      if (state) {
        lastState = state;
      }

      if (state?.playerVideoId === expectedVideoId || state?.pageVideoId === expectedVideoId) {
        return state;
      }
    } catch {
      // The tab may still be hydrating or the scripting call may race with navigation.
    }

    await wait(250);
  }

  if (lastState) {
    throw new Error(
      `Player state did not match target video. Expected ${expectedVideoId}, saw ${lastState.playerVideoId ?? lastState.pageVideoId ?? 'unknown'}.`,
    );
  }

  throw new Error('Player state never became readable for the target video.');
}

async function loadTranscriptPayload(videoId: string): Promise<IngestedTranscriptPayload> {
  const [video, transcript] = await Promise.all([
    db.videos.get(videoId),
    db.transcripts.get(videoId),
  ]);

  if (!video || !transcript) {
    throw new Error('Transcript scrape completed, but the payload was not persisted.');
  }

  return {
    video,
    transcript,
  };
}

async function sendScrapeMessageToTab(tabId: number, videoId: string): Promise<IngestedTranscriptPayload> {
  await appendTranscriptDebugEntry({
    context: 'orchestrator',
    step: 'Sending transcript scrape message to tab.',
    data: {
      tabId,
      videoId,
    },
  });
  const response = await sendContentMessageToTab<{ videoId: string }>(tabId, videoId, {
    type: 'briefly/scrape-active-transcript',
  });

  if (!response?.ok) {
    throw new Error(response?.error ?? 'Transcript scrape message failed.');
  }

  if (response.data.videoId !== videoId) {
    throw new Error(`Transcript scrape saved the wrong video: ${response.data.videoId}`);
  }

  return loadTranscriptPayload(videoId);
}

async function sendContentMessageToTab<T>(
  tabId: number,
  videoId: string,
  message: unknown,
): Promise<ContentScriptResponse<T>> {
  const sendMessage = async () =>
    (await chrome.tabs.sendMessage(tabId, message)) as ContentScriptResponse<T>;

  let response: ContentScriptResponse<T>;

  try {
    response = await sendMessage();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';

    if (!message.includes(NO_RECEIVER_ERROR_FRAGMENT)) {
      throw error;
    }

    await appendTranscriptDebugEntry({
      context: 'orchestrator',
      level: 'warn',
      step: 'Transcript content script receiver was missing. Injecting content script and retrying.',
      data: {
        tabId,
        videoId,
      },
    });
    await reportTranscriptFailure('CONTENT_SCRIPT_RECEIVER_MISSING', {
      tabId,
      videoId,
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/content.js'],
    });
    await wait(250);

    response = await sendMessage();
  }

  return response as ContentScriptResponse<T>;
}

function classifyFailureCodeFromDetail(
  detail: string,
  fallback:
    | 'ACTIVE_PAGE_CAPTION_FETCH_FAILED'
    | 'TRANSCRIPT_SCRAPE_MESSAGE_FAILED'
    | 'QUEUE_TAB_NAV_TIMEOUT'
    | 'EXPERIMENTAL_BACKGROUND_FETCH_FAILED',
) {
  const knownCodes = [
    'EMPTY_200_RESPONSE',
    'RATE_LIMITED',
    'CONSENT_WALL',
    'AGE_RESTRICTED',
    'SELECTOR_MISS',
    'TRANSCRIPT_SCRAPE_EMPTY',
    'CONTENT_SCRIPT_RECEIVER_MISSING',
  ] as const;

  const matched = knownCodes.find((code) => detail.startsWith(`${code}:`) || detail.includes(`${code}:`));
  return matched ?? fallback;
}

async function fetchCaptionTrackFromExistingTab(
  tabId: number,
  videoId: string,
  playerState: PlayerStateSnapshot,
  source: 'active-tab-dom' | 'queue-runner-tab',
): Promise<IngestedTranscriptPayload | null> {
  const selection = resolveCaptionTrackSelection(
    playerState.captionTracks,
    playerState.translationLanguageCodes.map((languageCode) => ({ languageCode })),
  );
  const selectedTrack = selection.track;

  if (!selectedTrack?.baseUrl) {
    await appendTranscriptDebugEntry({
      context: 'orchestrator',
      level: 'warn',
      step: 'Skipped active-page caption track fetch because no usable baseUrl was available.',
      data: {
        source,
        tabId,
        videoId,
        captionTrackCount: playerState.captionTrackCount,
        captionTracks: summarizeCaptionTracksForLog(playerState.captionTracks),
      },
    });
    return null;
  }

  await appendTranscriptDebugEntry({
    context: 'orchestrator',
    step: 'Trying active-page caption track fetch before DOM scraping.',
    data: {
      source,
      tabId,
      videoId,
      selectedTrack: summarizeCaptionTrack(selectedTrack),
    },
  });

  const response = await sendContentMessageToTab<{ videoId: string; segmentCount: number }>(
    tabId,
    videoId,
    {
      type: 'briefly/fetch-active-caption-track',
      videoId,
      baseUrl: selectedTrack.baseUrl,
      languageCode: selectedTrack.languageCode,
      targetLanguageCode: selection.targetLanguageCode,
      title: playerState.title ?? undefined,
      channel: playerState.channel ?? undefined,
    },
  );

  if (!response?.ok) {
    const detail = response?.error ?? 'Active-page caption track fetch failed.';
    await reportTranscriptFailure(classifyFailureCodeFromDetail(detail, 'ACTIVE_PAGE_CAPTION_FETCH_FAILED'), {
      source,
      videoId,
      detail,
    });
    await appendTranscriptDebugEntry({
      context: 'orchestrator',
      level: 'warn',
      step: 'Active-page caption track fetch failed. Falling back to DOM transcript scraping.',
      data: {
        source,
        tabId,
        videoId,
        detail,
      },
    });
    return null;
  }

  const payload = await loadTranscriptPayload(videoId);
  await reportTranscriptSuccess(
    source === 'active-tab-dom' ? 'active-tab-caption-track' : 'queue-runner-caption-track',
    {
      videoId,
      captionTrackCount: playerState.captionTrackCount,
      title: playerState.title,
      channel: playerState.channel,
      segmentCount: response.data.segmentCount,
    },
  );
  return payload;
}

async function respectQueueRunnerPacing() {
  const config = await getTranscriptRuntimeConfig();
  const pacingState = await getQueueRunnerPacingState();
  const now = Date.now();
  const waitMs = Math.max(0, pacingState.nextAllowedAt - now);

  if (waitMs > 0) {
    await appendTranscriptDebugEntry({
      context: 'orchestrator',
      step: 'Waiting for queue-runner pacing window before next navigation.',
      data: {
        waitMs,
        backoffMs: pacingState.currentBackoffMs,
      },
    });
    await wait(waitMs);
  }

  await saveQueueRunnerPacingState({
    nextAllowedAt:
      Date.now() +
      getRandomDelay(
        config.queueRunnerInterVideoDelayMinMs,
        config.queueRunnerInterVideoDelayMaxMs,
      ),
    currentBackoffMs: pacingState.currentBackoffMs,
  });
}

async function scrapeTranscriptFromExistingTab(
  tabId: number,
  videoId: string,
  source: 'active-tab-dom' | 'queue-runner-tab',
): Promise<IngestedTranscriptPayload> {
  const config = await getTranscriptRuntimeConfig();
  await appendTranscriptDebugEntry({
    context: 'orchestrator',
    step: 'Waiting for player state to match target video.',
    data: {
      source,
      tabId,
      videoId,
      playerStateTimeoutMs: config.playerStateTimeoutMs,
    },
  });
  const playerState = await waitForPlayerStateMatch(tabId, videoId, config.playerStateTimeoutMs);
  await appendTranscriptDebugEntry({
    context: 'orchestrator',
    step: 'Read live player state snapshot.',
    data: {
      source,
      tabId,
      videoId,
      pageVideoId: playerState.pageVideoId,
      playerVideoId: playerState.playerVideoId,
      captionTrackCount: playerState.captionTrackCount,
      captionTracks: summarizeCaptionTracksForLog(playerState.captionTracks),
    },
  });

  if (playerState.playerVideoId && playerState.playerVideoId !== videoId) {
    await reportTranscriptFailure('PLAYER_STATE_VIDEO_MISMATCH', {
      source,
      expectedVideoId: videoId,
      actualVideoId: playerState.playerVideoId,
      pageVideoId: playerState.pageVideoId,
    });
    throw new Error('The live player state did not match the requested video.');
  }

  if (playerState.captionTrackCount === 0) {
    await reportTranscriptFailure('NO_CAPTIONS_IN_PLAYER_RESPONSE', {
      source,
      videoId,
      pageVideoId: playerState.pageVideoId,
    });
  }

  const activeCaptionPayload = await fetchCaptionTrackFromExistingTab(
    tabId,
    videoId,
    playerState,
    source,
  );

  if (activeCaptionPayload) {
    return activeCaptionPayload;
  }

  if (!config.allowDomScrape) {
    await reportTranscriptFailure('TRANSCRIPT_KILL_SWITCH', {
      source,
      videoId,
      reason: config.killSwitchReason ?? 'DOM transcript scraping is disabled.',
    });
    throw new Error(config.killSwitchReason ?? 'DOM transcript scraping is disabled.');
  }

  try {
    const payload = await sendScrapeMessageToTab(tabId, videoId);
    await reportTranscriptSuccess(source, {
      videoId,
      captionTrackCount: playerState.captionTrackCount,
      title: playerState.title,
      channel: playerState.channel,
    });
    return payload;
  } catch (error) {
    await reportTranscriptFailure('TRANSCRIPT_SCRAPE_MESSAGE_FAILED', {
      source,
      videoId,
      detail: error instanceof Error ? error.message : 'unknown error',
    });
    throw error;
  }
}

async function getOrCreateQueueRunnerTab(): Promise<chrome.tabs.Tab> {
  const storedTabId = await getStoredQueueRunnerTabId();

  if (storedTabId !== null) {
    try {
      const tab = await chrome.tabs.get(storedTabId);
      await appendTranscriptDebugEntry({
        context: 'orchestrator',
        step: 'Reusing existing queue-runner tab.',
        data: {
          tabId: storedTabId,
          url: tab.url,
        },
      });
      return tab;
    } catch {
      await setStoredQueueRunnerTabId(null);
    }
  }

  try {
    const tab = await chrome.tabs.create({
      url: 'https://www.youtube.com',
      active: false,
    });

    if (!tab.id) {
      throw new Error('Chrome did not return a queue-runner tab id.');
    }

    await chrome.tabs.update(tab.id, {
      autoDiscardable: false,
      muted: true,
    });
    await appendTranscriptDebugEntry({
      context: 'orchestrator',
      step: 'Created new queue-runner tab.',
      data: {
        tabId: tab.id,
      },
    });
    await setStoredQueueRunnerTabId(tab.id);
    return tab;
  } catch (error) {
    await reportTranscriptFailure('QUEUE_TAB_CREATE_FAILED', {
      detail: error instanceof Error ? error.message : 'unknown error',
    });
    throw error;
  }
}

async function scrapeTranscriptViaQueueRunner(videoId: string): Promise<IngestedTranscriptPayload> {
  const config = await getTranscriptRuntimeConfig();

  if (!config.allowQueueRunnerTab) {
    throw new Error('Queue-runner transcript ingestion is disabled.');
  }

  const queueRunnerTab = await getOrCreateQueueRunnerTab();

  if (!queueRunnerTab.id) {
    throw new Error('Queue-runner tab is missing an id.');
  }

  await respectQueueRunnerPacing();

  await chrome.tabs.update(queueRunnerTab.id, {
    url: `https://www.youtube.com/watch?v=${videoId}`,
    active: false,
    autoDiscardable: false,
    muted: true,
  });
  await appendTranscriptDebugEntry({
    context: 'orchestrator',
    step: 'Navigated queue-runner tab to target video.',
    data: {
      tabId: queueRunnerTab.id,
      videoId,
      settleDelayMs: config.queueRunnerSettleDelayMs,
    },
  });

  try {
    await waitForTabComplete(queueRunnerTab.id, config.playerStateTimeoutMs);
    await wait(config.queueRunnerSettleDelayMs);
    const payload = await scrapeTranscriptFromExistingTab(queueRunnerTab.id, videoId, 'queue-runner-tab');
    await saveQueueRunnerPacingState({
      nextAllowedAt: Date.now() + getRandomDelay(
        config.queueRunnerInterVideoDelayMinMs,
        config.queueRunnerInterVideoDelayMaxMs,
      ),
      currentBackoffMs: 0,
    });
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    const pacingState = await getQueueRunnerPacingState();
    const nextBackoffMs = Math.max(
      config.queueRunnerFailureBackoffMs,
      pacingState.currentBackoffMs > 0
        ? pacingState.currentBackoffMs * 2
        : config.queueRunnerFailureBackoffMs,
    );
    await saveQueueRunnerPacingState({
      nextAllowedAt: Date.now() + nextBackoffMs,
      currentBackoffMs: nextBackoffMs,
    });
    await reportTranscriptFailure(
      message.includes('did not match')
        ? 'QUEUE_TAB_WRONG_VIDEO_AFTER_NAV'
        : classifyFailureCodeFromDetail(message, 'QUEUE_TAB_NAV_TIMEOUT'),
      {
        videoId,
        detail: message,
        backoffMs: nextBackoffMs,
      },
    );
    throw error;
  }
}

async function shouldUseActiveTabForVideo(
  tabId: number,
  videoId: string,
): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return extractYouTubeVideoId(tab.url ?? '') === videoId;
  } catch {
    return false;
  }
}

export async function ensureTranscriptForVideoId(input: {
  videoId: string;
  activeTabId?: number;
  forceRefresh?: boolean;
  mode?: 'default' | 'canary';
}): Promise<IngestedTranscriptPayload> {
  const inFlightKey = `${input.videoId}:${input.forceRefresh ? 'refresh' : 'default'}`;
  const existingRequest = transcriptInFlightRequests.get(inFlightKey);

  if (existingRequest) {
    await appendTranscriptDebugEntry({
      context: 'orchestrator',
      level: 'warn',
      step: 'Joining in-flight transcript acquisition request.',
      data: {
        videoId: input.videoId,
        activeTabId: input.activeTabId,
        forceRefresh: input.forceRefresh ?? false,
        inFlightKey,
      },
    });
    return existingRequest;
  }

  const request = (async () => {
  const config = await getTranscriptRuntimeConfig();
  const attemptErrors: string[] = [];
  await appendTranscriptDebugEntry({
    context: 'orchestrator',
    step: 'Starting transcript acquisition.',
    data: {
      videoId: input.videoId,
      activeTabId: input.activeTabId,
      forceRefresh: input.forceRefresh ?? false,
      allowMainWorldBridge: config.allowMainWorldBridge,
      allowDomScrape: config.allowDomScrape,
      allowQueueRunnerTab: config.allowQueueRunnerTab,
      allowExperimentalBackgroundFetch: config.allowExperimentalBackgroundFetch,
      killSwitchEnabled: config.killSwitchEnabled,
    },
  });

  if (!input.forceRefresh) {
    const existing = await getStoredTranscriptPayload(input.videoId);

    if (existing) {
      await appendTranscriptDebugEntry({
        context: 'orchestrator',
        step: 'Transcript cache hit.',
        data: {
          videoId: input.videoId,
          source: existing.transcript.metadata.source,
          segmentCount: existing.transcript.segments.length,
        },
      });
      return existing;
    }
  }

  if (config.killSwitchEnabled) {
    await reportTranscriptFailure('TRANSCRIPT_KILL_SWITCH', {
      videoId: input.videoId,
      reason: config.killSwitchReason ?? 'Transcript pipeline is disabled.',
    });
    throw new Error(config.killSwitchReason ?? 'Transcript pipeline is disabled.');
  }

  const stopKeepAlive = startServiceWorkerKeepAlive();

  try {
    if (
      input.activeTabId &&
      config.allowMainWorldBridge &&
      (await shouldUseActiveTabForVideo(input.activeTabId, input.videoId))
    ) {
      await appendTranscriptDebugEntry({
        context: 'orchestrator',
        step: 'Trying active-tab DOM transcript path.',
        data: {
          videoId: input.videoId,
          activeTabId: input.activeTabId,
        },
      });
      try {
        return await scrapeTranscriptFromExistingTab(input.activeTabId, input.videoId, 'active-tab-dom');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        attemptErrors.push(`active-tab-dom: ${message}`);
        const code =
          message.includes(NO_RECEIVER_ERROR_FRAGMENT) || message.includes('Player state never became readable')
            ? 'PLAYER_STATE_UNAVAILABLE'
            : classifyFailureCodeFromDetail(message, 'TRANSCRIPT_SCRAPE_MESSAGE_FAILED');
        await reportTranscriptFailure(code, {
          videoId: input.videoId,
          detail: message,
          activeTabId: input.activeTabId,
        });
      }
    } else {
      await appendTranscriptDebugEntry({
        context: 'orchestrator',
        level: 'warn',
        step: 'Skipped active-tab DOM transcript path.',
        data: {
          videoId: input.videoId,
          activeTabId: input.activeTabId,
        },
      });
    }

    const shouldPreferBackgroundProbe =
      input.mode !== 'canary' && config.allowExperimentalBackgroundFetch;

    if (shouldPreferBackgroundProbe) {
      await appendTranscriptDebugEntry({
        context: 'orchestrator',
        level: 'warn',
        step: 'Trying experimental background transcript fetch.',
        data: {
          videoId: input.videoId,
        },
      });
      try {
        const payload = await ingestTranscriptByBackgroundProbe(input.videoId, input.forceRefresh);
        await reportTranscriptSuccess('experimental-background-fetch', {
          videoId: input.videoId,
          source: payload.transcript.metadata.source,
        });
        return payload;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error';
        attemptErrors.push(`experimental-background-fetch: ${detail}`);
        await reportTranscriptFailure(classifyFailureCodeFromDetail(detail, 'EXPERIMENTAL_BACKGROUND_FETCH_FAILED'), {
          videoId: input.videoId,
          detail,
        });
      }
    }

    if (config.allowQueueRunnerTab) {
      await appendTranscriptDebugEntry({
        context: 'orchestrator',
        step: 'Trying queue-runner transcript path.',
        data: {
          videoId: input.videoId,
        },
      });
      try {
        return await scrapeTranscriptViaQueueRunner(input.videoId);
      } catch (error) {
        attemptErrors.push(
          `queue-runner-tab: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        // Telemetry was already recorded inside the queue-runner path.
      }
    }

    if (!shouldPreferBackgroundProbe && config.allowExperimentalBackgroundFetch) {
      await appendTranscriptDebugEntry({
        context: 'orchestrator',
        level: 'warn',
        step: 'Trying experimental background transcript fetch.',
        data: {
          videoId: input.videoId,
        },
      });
      try {
        const payload = await ingestTranscriptByBackgroundProbe(input.videoId, input.forceRefresh);
        await reportTranscriptSuccess('experimental-background-fetch', {
          videoId: input.videoId,
          source: payload.transcript.metadata.source,
        });
        return payload;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error';
        attemptErrors.push(`experimental-background-fetch: ${detail}`);
        await reportTranscriptFailure(classifyFailureCodeFromDetail(detail, 'EXPERIMENTAL_BACKGROUND_FETCH_FAILED'), {
          videoId: input.videoId,
          detail,
        });
      }
    }

    await appendTranscriptDebugEntry({
      context: 'orchestrator',
      level: 'error',
      step: 'Transcript acquisition exhausted all strategies.',
      data: {
        videoId: input.videoId,
        attemptErrors,
      },
    });
    throw new Error(
      attemptErrors.length
        ? `No transcript acquisition strategy succeeded for this video. ${attemptErrors.join(' | ')}`
        : 'No transcript acquisition strategy succeeded for this video.',
    );
  } finally {
    stopKeepAlive();
  }
  })();

  transcriptInFlightRequests.set(inFlightKey, request);

  try {
    return await request;
  } finally {
    if (transcriptInFlightRequests.get(inFlightKey) === request) {
      transcriptInFlightRequests.delete(inFlightKey);
    }
  }
}

export async function ensureTranscriptForUrl(input: {
  url: string;
  activeTabId?: number;
  forceRefresh?: boolean;
  mode?: 'default' | 'canary';
}): Promise<IngestedTranscriptPayload> {
  const videoId = extractYouTubeVideoId(input.url);

  if (!videoId) {
    throw new Error('Could not identify a YouTube video from the provided URL.');
  }

  return ensureTranscriptForVideoId({
    videoId,
    activeTabId: input.activeTabId,
    forceRefresh: input.forceRefresh,
    mode: input.mode,
  });
}

export async function ensureTranscriptsForVideoIds(input: {
  videoIds: string[];
  activeTabId?: number;
  forceRefresh?: boolean;
  mode?: 'default' | 'canary';
}): Promise<IngestedTranscriptPayload[]> {
  const payloads: IngestedTranscriptPayload[] = [];

  for (const videoId of input.videoIds) {
    payloads.push(
      await ensureTranscriptForVideoId({
        videoId,
        activeTabId: input.activeTabId,
        forceRefresh: input.forceRefresh,
        mode: input.mode,
      }),
    );
  }

  return payloads;
}

export async function runTranscriptCanaryCheck(): Promise<void> {
  const config = await getTranscriptRuntimeConfig();

  if (!config.canaryVideoIds.length || config.killSwitchEnabled) {
    await appendTranscriptDebugEntry({
      context: 'orchestrator',
      step: 'Skipped transcript canary check.',
      data: {
        killSwitchEnabled: config.killSwitchEnabled,
        canaryCount: config.canaryVideoIds.length,
      },
    });
    return;
  }

  await appendTranscriptDebugEntry({
    context: 'orchestrator',
    step: 'Starting transcript canary check.',
    data: {
      canaryVideoIds: config.canaryVideoIds,
    },
  });
  let failureCount = 0;

  for (const videoId of config.canaryVideoIds) {
    try {
      await ensureTranscriptForVideoId({
        videoId,
        forceRefresh: true,
        mode: 'canary',
      });
    } catch (error) {
      failureCount += 1;
      await reportTranscriptFailure('CANARY_FAILED', {
        videoId,
        detail: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  if (
    failureCount > 0 &&
    failureCount === config.canaryVideoIds.length &&
    config.autoKillOnCanaryFailure
  ) {
    await saveTranscriptRuntimeConfig({
      killSwitchEnabled: true,
      killSwitchReason: 'All transcript canaries failed. The pipeline was auto-disabled.',
    });
  }
}
