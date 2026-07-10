export const TRANSCRIPT_HEALTH_STORAGE_KEY = 'briefly.transcriptHealth';
const MAX_RECENT_ATTEMPTS = 50;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const REQUEST_WARNING_THRESHOLD = 250;

type TranscriptAttemptRecord = {
  timestamp: number;
  success: boolean;
  method?: string;
  code?: string;
};

type TranscriptRequestRecord = {
  timestamp: number;
  kind: string;
};

type TranscriptHealthState = {
  recentAttempts: TranscriptAttemptRecord[];
  recentRequests: TranscriptRequestRecord[];
  lastUpdatedAt: number;
};

export type TranscriptHealthSummary = {
  rollingSuccessRate: number | null;
  recentAttemptCount: number;
  recentFailureCount: number;
  recentRequestCountLastHour: number;
  requestWarningThresholdPerHour: number;
  lastUpdatedAt: number | null;
};

const DEFAULT_TRANSCRIPT_HEALTH_STATE: TranscriptHealthState = {
  recentAttempts: [],
  recentRequests: [],
  lastUpdatedAt: 0,
};

function normalizeHealthState(value: unknown): TranscriptHealthState {
  if (!value || typeof value !== 'object') {
    return DEFAULT_TRANSCRIPT_HEALTH_STATE;
  }

  const typed = value as Partial<TranscriptHealthState>;

  return {
    recentAttempts: Array.isArray(typed.recentAttempts)
      ? typed.recentAttempts
          .filter(
            (entry): entry is TranscriptAttemptRecord =>
              Boolean(entry) &&
              typeof entry.timestamp === 'number' &&
              typeof entry.success === 'boolean',
          )
          .slice(-MAX_RECENT_ATTEMPTS)
      : [],
    recentRequests: Array.isArray(typed.recentRequests)
      ? typed.recentRequests
          .filter(
            (entry): entry is TranscriptRequestRecord =>
              Boolean(entry) &&
              typeof entry.timestamp === 'number' &&
              typeof entry.kind === 'string',
          )
          .filter((entry) => Date.now() - entry.timestamp <= REQUEST_WINDOW_MS)
      : [],
    lastUpdatedAt:
      typeof typed.lastUpdatedAt === 'number' && typed.lastUpdatedAt > 0
        ? typed.lastUpdatedAt
        : 0,
  };
}

async function getTranscriptHealthState(): Promise<TranscriptHealthState> {
  const stored = await chrome.storage.local.get(TRANSCRIPT_HEALTH_STORAGE_KEY);
  return normalizeHealthState(stored[TRANSCRIPT_HEALTH_STORAGE_KEY]);
}

async function saveTranscriptHealthState(state: TranscriptHealthState): Promise<void> {
  await chrome.storage.local.set({
    [TRANSCRIPT_HEALTH_STORAGE_KEY]: state,
  });
}

export async function recordTranscriptPipelineOutcome(input: {
  success: boolean;
  method?: string;
  code?: string;
}): Promise<void> {
  const current = await getTranscriptHealthState();
  const next: TranscriptHealthState = {
    recentAttempts: [
      ...current.recentAttempts,
      {
        timestamp: Date.now(),
        success: input.success,
        method: input.method,
        code: input.code,
      },
    ].slice(-MAX_RECENT_ATTEMPTS),
    recentRequests: current.recentRequests.filter(
      (entry) => Date.now() - entry.timestamp <= REQUEST_WINDOW_MS,
    ),
    lastUpdatedAt: Date.now(),
  };

  await saveTranscriptHealthState(next);
}

export async function recordTranscriptNetworkRequest(kind: string): Promise<void> {
  const current = await getTranscriptHealthState();
  const next: TranscriptHealthState = {
    recentAttempts: current.recentAttempts,
    recentRequests: [
      ...current.recentRequests.filter(
        (entry) => Date.now() - entry.timestamp <= REQUEST_WINDOW_MS,
      ),
      {
        timestamp: Date.now(),
        kind,
      },
    ],
    lastUpdatedAt: Date.now(),
  };

  await saveTranscriptHealthState(next);
}

export async function getTranscriptHealthSummary(): Promise<TranscriptHealthSummary> {
  const state = await getTranscriptHealthState();
  const recentAttempts = state.recentAttempts.slice(-MAX_RECENT_ATTEMPTS);
  const recentFailureCount = recentAttempts.filter((entry) => !entry.success).length;
  const recentRequestCountLastHour = state.recentRequests.filter(
    (entry) => Date.now() - entry.timestamp <= REQUEST_WINDOW_MS,
  ).length;

  return {
    rollingSuccessRate: recentAttempts.length
      ? Number(
          (
            ((recentAttempts.length - recentFailureCount) / recentAttempts.length) *
            100
          ).toFixed(1),
        )
      : null,
    recentAttemptCount: recentAttempts.length,
    recentFailureCount,
    recentRequestCountLastHour,
    requestWarningThresholdPerHour: REQUEST_WARNING_THRESHOLD,
    lastUpdatedAt: state.lastUpdatedAt || null,
  };
}
