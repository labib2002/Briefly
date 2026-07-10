export const TRANSCRIPT_DEBUG_LOG_STORAGE_KEY = 'briefly.transcriptDebugLog';
const TRANSCRIPT_DEBUG_LOG_LIMIT = 400;

export type TranscriptDebugLevel = 'info' | 'warn' | 'error';
export type TranscriptDebugContext =
  | 'background'
  | 'content'
  | 'runtime'
  | 'orchestrator';

export type TranscriptDebugEntry = {
  id: string;
  timestamp: number;
  level: TranscriptDebugLevel;
  context: TranscriptDebugContext;
  step: string;
  data?: Record<string, unknown>;
};

function createEntryId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  } catch {
    return {
      note: 'Debug payload could not be serialized cleanly.',
    };
  }
}

function formatConsolePrefix(entry: TranscriptDebugEntry): string {
  return `[Briefly transcript][${entry.context}][${entry.level}] ${entry.step}`;
}

export async function appendTranscriptDebugEntry(input: {
  context: TranscriptDebugContext;
  step: string;
  level?: TranscriptDebugLevel;
  data?: Record<string, unknown>;
}): Promise<TranscriptDebugEntry> {
  const entry: TranscriptDebugEntry = {
    id: createEntryId(),
    timestamp: Date.now(),
    level: input.level ?? 'info',
    context: input.context,
    step: input.step,
    data: sanitizeData(input.data),
  };

  const logger =
    entry.level === 'error'
      ? console.error
      : entry.level === 'warn'
        ? console.warn
        : console.log;

  logger(formatConsolePrefix(entry), entry.data ?? {});

  const stored = await chrome.storage.local.get(TRANSCRIPT_DEBUG_LOG_STORAGE_KEY);
  const current = Array.isArray(stored[TRANSCRIPT_DEBUG_LOG_STORAGE_KEY])
    ? (stored[TRANSCRIPT_DEBUG_LOG_STORAGE_KEY] as TranscriptDebugEntry[])
    : [];

  const next = [...current, entry].slice(-TRANSCRIPT_DEBUG_LOG_LIMIT);
  await chrome.storage.local.set({
    [TRANSCRIPT_DEBUG_LOG_STORAGE_KEY]: next,
  });

  return entry;
}

export async function getTranscriptDebugEntries(): Promise<TranscriptDebugEntry[]> {
  const stored = await chrome.storage.local.get(TRANSCRIPT_DEBUG_LOG_STORAGE_KEY);
  return Array.isArray(stored[TRANSCRIPT_DEBUG_LOG_STORAGE_KEY])
    ? (stored[TRANSCRIPT_DEBUG_LOG_STORAGE_KEY] as TranscriptDebugEntry[])
    : [];
}

export async function clearTranscriptDebugEntries(): Promise<void> {
  await chrome.storage.local.set({
    [TRANSCRIPT_DEBUG_LOG_STORAGE_KEY]: [],
  });
}
