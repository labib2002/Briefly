import { trackEvent } from './telemetry';
import { appendTranscriptDebugEntry } from './transcript-debug';
import { recordTranscriptPipelineOutcome } from './transcript-health';

export const TRANSCRIPT_CONFIG_STORAGE_KEY = 'briefly.transcriptRuntimeConfig';
export const TRANSCRIPT_CONFIG_ALARM = 'briefly-sync-transcript-config';
export const TRANSCRIPT_CANARY_ALARM = 'briefly-run-transcript-canary';
const transcriptRuntimeEnv = (import.meta as ImportMeta & {
  env?: {
    WXT_TRANSCRIPT_REMOTE_CONFIG_URL?: string;
    WXT_TRANSCRIPT_CANARY_VIDEO_IDS?: string;
    WXT_TRANSCRIPT_AUTO_KILL_ON_CANARY_FAILURE?: string;
  };
}).env;
const DEFAULT_TRANSCRIPT_CANARY_VIDEO_IDS =
  transcriptRuntimeEnv?.WXT_TRANSCRIPT_CANARY_VIDEO_IDS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean) ?? ['D5QPgCG-C58'];

export type TranscriptFailureCode =
  | 'TRANSCRIPT_KILL_SWITCH'
  | 'PLAYER_STATE_UNAVAILABLE'
  | 'PLAYER_STATE_VIDEO_MISMATCH'
  | 'NO_CAPTIONS_IN_PLAYER_RESPONSE'
  | 'ACTIVE_PAGE_CAPTION_FETCH_FAILED'
  | 'TRANSCRIPT_SCRAPE_MESSAGE_FAILED'
  | 'TRANSCRIPT_SCRAPE_EMPTY'
  | 'CONTENT_SCRIPT_RECEIVER_MISSING'
  | 'QUEUE_TAB_CREATE_FAILED'
  | 'QUEUE_TAB_NAV_TIMEOUT'
  | 'QUEUE_TAB_WRONG_VIDEO_AFTER_NAV'
  | 'EXPERIMENTAL_BACKGROUND_FETCH_FAILED'
  | 'EMPTY_200_RESPONSE'
  | 'RATE_LIMITED'
  | 'CONSENT_WALL'
  | 'AGE_RESTRICTED'
  | 'SELECTOR_MISS'
  | 'INNERTUBE_SCHEMA_CHANGE'
  | 'REMOTE_CONFIG_FETCH_FAILED'
  | 'CANARY_FAILED';

export type TranscriptRuntimeConfig = {
  killSwitchEnabled: boolean;
  killSwitchReason?: string;
  allowMainWorldBridge: boolean;
  allowDomScrape: boolean;
  allowQueueRunnerTab: boolean;
  allowExperimentalBackgroundFetch: boolean;
  remoteConfigUrl: string;
  canaryVideoIds: string[];
  autoKillOnCanaryFailure: boolean;
  playerStateTimeoutMs: number;
  queueRunnerSettleDelayMs: number;
  queueRunnerInterVideoDelayMinMs: number;
  queueRunnerInterVideoDelayMaxMs: number;
  queueRunnerFailureBackoffMs: number;
  selectorOverrides: {
    transcriptTriggerSelectors?: string[];
    descriptionExpandSelectors?: string[];
    transcriptPanelSelectors?: string[];
    transcriptRendererSelectors?: string[];
    transcriptRowSelectors?: string[];
    transcriptTimestampSelectors?: string[];
    transcriptTextSelectors?: string[];
  };
};

export const DEFAULT_TRANSCRIPT_RUNTIME_CONFIG: TranscriptRuntimeConfig = {
  killSwitchEnabled: false,
  killSwitchReason: undefined,
  allowMainWorldBridge: true,
  allowDomScrape: true,
  allowQueueRunnerTab: true,
  allowExperimentalBackgroundFetch: true,
  remoteConfigUrl: transcriptRuntimeEnv?.WXT_TRANSCRIPT_REMOTE_CONFIG_URL?.trim() ?? '',
  canaryVideoIds: DEFAULT_TRANSCRIPT_CANARY_VIDEO_IDS,
  autoKillOnCanaryFailure:
    transcriptRuntimeEnv?.WXT_TRANSCRIPT_AUTO_KILL_ON_CANARY_FAILURE === 'true',
  playerStateTimeoutMs: 8000,
  queueRunnerSettleDelayMs: 2200,
  queueRunnerInterVideoDelayMinMs: 2500,
  queueRunnerInterVideoDelayMaxMs: 5000,
  queueRunnerFailureBackoffMs: 30000,
  selectorOverrides: {},
};

function isRuntimeConfig(value: unknown): value is Partial<TranscriptRuntimeConfig> {
  return typeof value === 'object' && value !== null;
}

function normalizeRuntimeConfig(value: Partial<TranscriptRuntimeConfig> | undefined): TranscriptRuntimeConfig {
  const next = {
    ...DEFAULT_TRANSCRIPT_RUNTIME_CONFIG,
    ...(value ?? {}),
  };

  return {
    ...next,
    remoteConfigUrl: next.remoteConfigUrl?.trim() ?? '',
    canaryVideoIds: Array.isArray(next.canaryVideoIds) ? next.canaryVideoIds.filter(Boolean) : [],
    playerStateTimeoutMs:
      typeof next.playerStateTimeoutMs === 'number' && next.playerStateTimeoutMs > 0
        ? next.playerStateTimeoutMs
        : DEFAULT_TRANSCRIPT_RUNTIME_CONFIG.playerStateTimeoutMs,
    queueRunnerSettleDelayMs:
      typeof next.queueRunnerSettleDelayMs === 'number' && next.queueRunnerSettleDelayMs >= 0
        ? next.queueRunnerSettleDelayMs
        : DEFAULT_TRANSCRIPT_RUNTIME_CONFIG.queueRunnerSettleDelayMs,
    queueRunnerInterVideoDelayMinMs:
      typeof next.queueRunnerInterVideoDelayMinMs === 'number' && next.queueRunnerInterVideoDelayMinMs >= 0
        ? next.queueRunnerInterVideoDelayMinMs
        : DEFAULT_TRANSCRIPT_RUNTIME_CONFIG.queueRunnerInterVideoDelayMinMs,
    queueRunnerInterVideoDelayMaxMs:
      typeof next.queueRunnerInterVideoDelayMaxMs === 'number' &&
      next.queueRunnerInterVideoDelayMaxMs >= next.queueRunnerInterVideoDelayMinMs
        ? next.queueRunnerInterVideoDelayMaxMs
        : Math.max(
            next.queueRunnerInterVideoDelayMinMs,
            DEFAULT_TRANSCRIPT_RUNTIME_CONFIG.queueRunnerInterVideoDelayMaxMs,
          ),
    queueRunnerFailureBackoffMs:
      typeof next.queueRunnerFailureBackoffMs === 'number' && next.queueRunnerFailureBackoffMs >= 0
        ? next.queueRunnerFailureBackoffMs
        : DEFAULT_TRANSCRIPT_RUNTIME_CONFIG.queueRunnerFailureBackoffMs,
    selectorOverrides:
      next.selectorOverrides && typeof next.selectorOverrides === 'object'
        ? {
            transcriptTriggerSelectors: Array.isArray(next.selectorOverrides.transcriptTriggerSelectors)
              ? next.selectorOverrides.transcriptTriggerSelectors.filter(Boolean)
              : undefined,
            descriptionExpandSelectors: Array.isArray(next.selectorOverrides.descriptionExpandSelectors)
              ? next.selectorOverrides.descriptionExpandSelectors.filter(Boolean)
              : undefined,
            transcriptPanelSelectors: Array.isArray(next.selectorOverrides.transcriptPanelSelectors)
              ? next.selectorOverrides.transcriptPanelSelectors.filter(Boolean)
              : undefined,
            transcriptRendererSelectors: Array.isArray(next.selectorOverrides.transcriptRendererSelectors)
              ? next.selectorOverrides.transcriptRendererSelectors.filter(Boolean)
              : undefined,
            transcriptRowSelectors: Array.isArray(next.selectorOverrides.transcriptRowSelectors)
              ? next.selectorOverrides.transcriptRowSelectors.filter(Boolean)
              : undefined,
            transcriptTimestampSelectors: Array.isArray(next.selectorOverrides.transcriptTimestampSelectors)
              ? next.selectorOverrides.transcriptTimestampSelectors.filter(Boolean)
              : undefined,
            transcriptTextSelectors: Array.isArray(next.selectorOverrides.transcriptTextSelectors)
              ? next.selectorOverrides.transcriptTextSelectors.filter(Boolean)
              : undefined,
          }
        : {},
  };
}

export async function getTranscriptRuntimeConfig(): Promise<TranscriptRuntimeConfig> {
  const stored = await chrome.storage.local.get(TRANSCRIPT_CONFIG_STORAGE_KEY);
  const current = stored[TRANSCRIPT_CONFIG_STORAGE_KEY];

  if (!isRuntimeConfig(current)) {
    return DEFAULT_TRANSCRIPT_RUNTIME_CONFIG;
  }

  return normalizeRuntimeConfig(current);
}

export async function saveTranscriptRuntimeConfig(
  update: Partial<TranscriptRuntimeConfig>,
): Promise<TranscriptRuntimeConfig> {
  const current = await getTranscriptRuntimeConfig();
  const next = normalizeRuntimeConfig({
    ...current,
    ...update,
  });

  await chrome.storage.local.set({
    [TRANSCRIPT_CONFIG_STORAGE_KEY]: next,
  });

  return next;
}

export async function refreshTranscriptRuntimeConfig(): Promise<TranscriptRuntimeConfig> {
  const current = await getTranscriptRuntimeConfig();

  if (!current.remoteConfigUrl) {
    await appendTranscriptDebugEntry({
      context: 'runtime',
      step: 'Skipped remote transcript config refresh because no URL is configured.',
    });
    return current;
  }

  try {
    await appendTranscriptDebugEntry({
      context: 'runtime',
      step: 'Fetching remote transcript runtime config.',
      data: {
        remoteConfigUrl: current.remoteConfigUrl,
      },
    });
    const response = await fetch(current.remoteConfigUrl, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Remote config returned ${response.status}`);
    }

    const payload = (await response.json()) as Partial<TranscriptRuntimeConfig>;
    const next = await saveTranscriptRuntimeConfig(payload);
    await appendTranscriptDebugEntry({
      context: 'runtime',
      step: 'Remote transcript runtime config refreshed.',
      data: {
        remoteConfigUrl: current.remoteConfigUrl,
        killSwitchEnabled: next.killSwitchEnabled,
        allowQueueRunnerTab: next.allowQueueRunnerTab,
        allowExperimentalBackgroundFetch: next.allowExperimentalBackgroundFetch,
      },
    });
    await trackEvent('transcript_runtime_config_refreshed', {
      remoteConfigUrl: current.remoteConfigUrl,
      killSwitchEnabled: next.killSwitchEnabled,
    });
    return next;
  } catch (error) {
    await reportTranscriptFailure('REMOTE_CONFIG_FETCH_FAILED', {
      remoteConfigUrl: current.remoteConfigUrl,
      detail: error instanceof Error ? error.message : 'unknown error',
    });
    return current;
  }
}

export async function reportTranscriptFailure(
  code: TranscriptFailureCode,
  properties: Record<string, unknown> = {},
): Promise<void> {
  await appendTranscriptDebugEntry({
    context: 'runtime',
    level: 'error',
    step: `Transcript failure: ${code}`,
    data: properties,
  });
  await trackEvent('transcript_failure', {
    code,
    ...properties,
  });
  await recordTranscriptPipelineOutcome({
    success: false,
    code,
  });
}

export async function reportTranscriptSuccess(
  method:
    | 'active-tab-caption-track'
    | 'active-tab-dom'
    | 'queue-runner-caption-track'
    | 'queue-runner-tab'
    | 'experimental-background-fetch',
  properties: Record<string, unknown> = {},
): Promise<void> {
  await appendTranscriptDebugEntry({
    context: 'runtime',
    step: `Transcript pipeline success: ${method}`,
    data: properties,
  });
  await trackEvent('transcript_pipeline_success', {
    method,
    ...properties,
  });
  await recordTranscriptPipelineOutcome({
    success: true,
    method,
  });
}
