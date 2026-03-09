import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { SETTINGS_RECORD_ID } from '../db/settings';
import { db } from '../db';
import {
  ACTIVE_QUEUE_WORKSPACE_ID,
  createVideoWorkspaceId,
  deleteWorkspace,
  updateWorkspaceMetadata,
} from '../db/workspaces';
import { PREMIUM_PLACEHOLDER_URL } from '../constants/premium';
import { useActiveYouTubeTab } from '../hooks/use-active-youtube-tab';
import { sendRuntimeRequest } from '../runtime/client';
import { useUIStore } from '../state/ui-store';
import type {
  CustomPromptProfile,
  SummaryMode,
  TranscriptRecord,
  VideoRecord,
  WorkspaceRecord,
} from '../types/domain';
import {
  createWorkspaceMarkdownFilename,
  formatWorkspaceAsMarkdown,
} from '../utils/export-markdown';
import { formatTimestamp } from '../utils/time';
import { normalizeYouTubeUrl } from '../utils/youtube';
import { trackEvent } from '../services/telemetry';

const SUMMARY_MODES: { id: SummaryMode; label: string }[] = [
  { id: 'tldr', label: 'TL;DR' },
  { id: 'action-items', label: 'Action Items' },
  { id: 'timestamped-highlights', label: 'Highlights' },
  { id: 'study-notes', label: 'Study Notes' },
  { id: 'due-diligence', label: 'Due Diligence' },
  { id: 'thread-draft', label: 'Thread Draft' },
  { id: 'creator-research', label: 'Creator Research' },
];

function formatFetchTime(timestamp: number | undefined): string {
  if (!timestamp) {
    return 'Not synced yet';
  }

  return new Date(timestamp).toLocaleString();
}

function downloadMarkdownFile(filename: string, content: string) {
  const blob = new Blob([content], {
    type: 'text/markdown;charset=utf-8',
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

async function loadRecords<T extends VideoRecord | TranscriptRecord>(
  table: 'videos' | 'transcripts',
  ids: string[],
): Promise<T[]> {
  if (!ids.length) {
    return [];
  }

  const records = await db[table].bulkGet(ids);
  return records.filter((record): record is T => Boolean(record));
}

type QueueOptimisticState = {
  videoIds: string[];
  clearMessages: boolean;
} | null;

type WorkspaceMetadataDraft = {
  name: string;
  notes: string;
  tags: string;
};

function createCustomPromptMode(promptId: string): SummaryMode {
  return `custom:${promptId}`;
}

function mapCustomPromptsToModes(
  customPrompts: CustomPromptProfile[],
): Array<{ id: SummaryMode; label: string }> {
  return customPrompts.map((prompt) => ({
    id: createCustomPromptMode(prompt.id),
    label: prompt.label,
  }));
}

export function CopilotView() {
  const activeTab = useActiveYouTubeTab();
  const focusedWorkspaceId = useUIStore((state) => state.focusedWorkspaceId);
  const setFocusedWorkspaceId = useUIStore((state) => state.setFocusedWorkspaceId);
  const setActiveView = useUIStore((state) => state.setActiveView);
  const settings = useLiveQuery(() => db.settings.get(SETTINGS_RECORD_ID), []);
  const currentVideo = useLiveQuery(
    () => (activeTab.videoId ? db.videos.get(activeTab.videoId) : undefined),
    [activeTab.videoId],
  );
  const currentTranscript = useLiveQuery(
    () => (activeTab.videoId ? db.transcripts.get(activeTab.videoId) : undefined),
    [activeTab.videoId],
  );
  const currentWorkspace = useLiveQuery(
    () => (activeTab.videoId ? db.workspaces.get(createVideoWorkspaceId(activeTab.videoId)) : undefined),
    [activeTab.videoId],
  );
  const queueWorkspace = useLiveQuery(
    () => db.workspaces.get(ACTIVE_QUEUE_WORKSPACE_ID),
    [],
  );
  const focusedWorkspace = useLiveQuery(
    () => (focusedWorkspaceId ? db.workspaces.get(focusedWorkspaceId) : undefined),
    [focusedWorkspaceId],
  );
  const queueIdsKey = queueWorkspace?.videoIds.join('|') ?? '';
  const focusedIdsKey = focusedWorkspace?.videoIds.join('|') ?? '';
  const queueVideos = useLiveQuery(
    () => loadRecords<VideoRecord>('videos', queueWorkspace?.videoIds ?? []),
    [queueIdsKey],
  );
  const queueTranscripts = useLiveQuery(
    () => loadRecords<TranscriptRecord>('transcripts', queueWorkspace?.videoIds ?? []),
    [queueIdsKey],
  );
  const focusedVideos = useLiveQuery(
    () => loadRecords<VideoRecord>('videos', focusedWorkspace?.videoIds ?? []),
    [focusedIdsKey],
  );
  const focusedTranscripts = useLiveQuery(
    () => loadRecords<TranscriptRecord>('transcripts', focusedWorkspace?.videoIds ?? []),
    [focusedIdsKey],
  );
  const [workspaceView, setWorkspaceView] = useState<'video' | 'queue'>('video');
  const [draftMessage, setDraftMessage] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queueOptimisticState, setQueueOptimisticState] = useState<QueueOptimisticState>(null);
  const [pendingAction, setPendingAction] = useState<'sync' | 'summary' | 'chat' | 'export' | null>(null);
  const [upgradePrompt, setUpgradePrompt] = useState<string | null>(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [workspaceMetaDraft, setWorkspaceMetaDraft] = useState<WorkspaceMetadataDraft>({
    name: '',
    notes: '',
    tags: '',
  });
  const [isSavingWorkspaceMeta, setIsSavingWorkspaceMeta] = useState(false);
  const lastSyncedUrlRef = useRef<string | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);

  const effectiveQueueWorkspace =
    queueWorkspace && queueOptimisticState
      ? {
          ...queueWorkspace,
          videoIds: queueOptimisticState.videoIds,
          primaryVideoId: queueOptimisticState.videoIds[0],
          messages: queueOptimisticState.clearMessages ? [] : queueWorkspace.messages,
        }
      : queueWorkspace;
  const effectiveQueueVideoIds = effectiveQueueWorkspace?.videoIds ?? [];
  const queueVideoIdSet = new Set(effectiveQueueVideoIds);
  const effectiveQueueVideos = (queueVideos ?? []).filter((video) => queueVideoIdSet.has(video.id));
  const effectiveQueueTranscripts = (queueTranscripts ?? []).filter((transcript) =>
    queueVideoIdSet.has(transcript.videoId),
  );
  const hasQueueWorkspace = Boolean(effectiveQueueVideoIds.length);
  const hasAccount = Boolean(settings?.user);
  const isPremium = settings?.isPremium ?? false;
  const canUseBatchWorkflows = isPremium && hasAccount;
  const hasUnlockedQueueWorkspace = canUseBatchWorkflows && hasQueueWorkspace;
  const hasFocusedWorkspace = Boolean(focusedWorkspaceId && focusedWorkspace);
  const selectedWorkspace: WorkspaceRecord | undefined =
    hasFocusedWorkspace
      ? focusedWorkspace
      : workspaceView === 'queue' && hasUnlockedQueueWorkspace
      ? effectiveQueueWorkspace
      : currentWorkspace ?? (hasUnlockedQueueWorkspace ? effectiveQueueWorkspace : undefined);
  const selectedVideos =
    hasFocusedWorkspace
      ? focusedVideos ?? []
      : workspaceView === 'queue' && hasUnlockedQueueWorkspace
      ? effectiveQueueVideos
      : currentVideo
        ? [currentVideo]
        : [];
  const selectedTranscripts =
    hasFocusedWorkspace
      ? focusedTranscripts ?? []
      : workspaceView === 'queue' && hasUnlockedQueueWorkspace
      ? effectiveQueueTranscripts
      : currentTranscript
        ? [currentTranscript]
        : [];
  const selectedVideoIds = selectedWorkspace?.videoIds ?? [];
  const transcriptByVideoId = new Map(selectedTranscripts.map((transcript) => [transcript.videoId, transcript]));
  const selectedProvider = settings?.selectedProvider ?? 'gemini';
  const activeProviderKey =
    settings?.apiKeys[selectedProvider] ?? settings?.apiKey ?? '';
  const isProviderConfigured =
    selectedProvider === 'ollama'
      ? Boolean(settings?.ollamaEndpoint?.trim() && settings?.ollamaModel?.trim())
      : Boolean(activeProviderKey);
  const customSummaryModes = mapCustomPromptsToModes(settings?.customPrompts ?? []);
  const summaryModes = [...SUMMARY_MODES, ...customSummaryModes];
  const summaryModeLabels = new Map(summaryModes.map((mode) => [mode.id, mode.label]));
  const latestAssistantMessage = [...(selectedWorkspace?.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'assistant');
  const premiumPromptHeading = hasAccount
    ? 'Unlock Batch Workflows & Exports with Premium'
    : 'Sign in & Upgrade';
  const autoSyncActiveVideo = settings?.featureFlags.autoSyncActiveVideo ?? true;
  const canUsePremiumAudio = isPremium && hasAccount;
  const selectedScopeLabel =
    hasFocusedWorkspace
      ? 'Saved Workspace'
      : workspaceView === 'queue' && hasUnlockedQueueWorkspace
        ? 'Batch Queue'
        : 'Active Video';
  const workspaceDisplayTitle =
    selectedWorkspace?.name?.trim() ||
    (hasFocusedWorkspace
      ? selectedVideos[0]?.title ?? selectedWorkspace?.id ?? 'Saved workspace'
      : workspaceView === 'queue' && hasUnlockedQueueWorkspace
        ? `Batch Queue (${selectedVideos.length})`
        : currentVideo?.title ?? activeTab.tab?.title ?? 'Syncing video...');

  useEffect(() => {
    if (!canUseBatchWorkflows && workspaceView === 'queue') {
      setWorkspaceView('video');
    }
  }, [canUseBatchWorkflows, workspaceView]);

  useEffect(() => {
    if (hasFocusedWorkspace) {
      return;
    }

    if (!activeTab.videoId && hasUnlockedQueueWorkspace) {
      setWorkspaceView('queue');
      return;
    }

    if (!hasUnlockedQueueWorkspace && workspaceView === 'queue') {
      setWorkspaceView('video');
    }
  }, [activeTab.videoId, hasUnlockedQueueWorkspace, workspaceView, hasFocusedWorkspace]);

  useEffect(() => {
    if (!queueWorkspace) {
      setQueueOptimisticState(null);
      return;
    }

    if (
      queueOptimisticState &&
      queueWorkspace.videoIds.join('|') === queueOptimisticState.videoIds.join('|') &&
      (queueWorkspace.videoIds.length > 0 || queueWorkspace.messages.length === 0 || !queueOptimisticState.clearMessages)
    ) {
      setQueueOptimisticState(null);
    }
  }, [queueWorkspace, queueOptimisticState]);

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [selectedWorkspace?.id, selectedWorkspace?.messages.length, pendingAction]);

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    setWorkspaceMetaDraft({
      name: selectedWorkspace?.name ?? '',
      notes: selectedWorkspace?.notes ?? '',
      tags: selectedWorkspace?.tags.join(', ') ?? '',
    });
  }, [selectedWorkspace?.id, selectedWorkspace?.name, selectedWorkspace?.notes, selectedWorkspace?.tags]);

  useEffect(() => {
    if (!activeTab.url || !activeTab.videoId) {
      lastSyncedUrlRef.current = null;
      return;
    }

    if (!autoSyncActiveVideo) {
      return;
    }

    if (lastSyncedUrlRef.current === activeTab.url) {
      return;
    }

    let cancelled = false;
    lastSyncedUrlRef.current = activeTab.url;
    setPendingAction('sync');
    setError(null);
    setStatus('Syncing transcript into local memory...');

    void sendRuntimeRequest<unknown>({
      type: 'briefly/ingest-transcript',
      url: activeTab.url,
      tabId: activeTab.tab?.id,
    })
      .then(() => {
        if (!cancelled) {
          setStatus('Transcript synced to local memory.');
        }
      })
      .catch((syncError) => {
        if (!cancelled) {
          setError(syncError instanceof Error ? syncError.message : 'Failed to sync transcript.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPendingAction(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab.url, activeTab.videoId, autoSyncActiveVideo]);

  const handleRefresh = async () => {
    if (!activeTab.url) {
      return;
    }

    setPendingAction('sync');
    setError(null);
    setStatus('Refreshing transcript from YouTube...');

    try {
      await sendRuntimeRequest<unknown>({
        type: 'briefly/ingest-transcript',
        url: activeTab.url,
        forceRefresh: true,
        tabId: activeTab.tab?.id,
      });
      setStatus('Transcript refreshed.');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Failed to refresh transcript.');
    } finally {
      setPendingAction(null);
    }
  };

  const handleSummary = async (summaryMode: SummaryMode) => {
    if (!selectedWorkspace || !selectedVideoIds.length) {
      return;
    }

    const summaryLabel = summaryModeLabels.get(summaryMode) ?? summaryMode;
    setPendingAction('summary');
    setError(null);
    setStatus(
      selectedVideoIds.length > 1
        ? `Generating ${summaryLabel} summaries and cross-video synthesis...`
        : `Generating ${summaryLabel} summary...`,
    );

    try {
      await sendRuntimeRequest<unknown>({
        type: 'briefly/generate-summary',
        workspaceId: selectedWorkspace.id,
        videoIds: selectedVideoIds,
        summaryMode,
      });
      setStatus(
        selectedVideoIds.length > 1
          ? 'Per-video summaries and cross-video synthesis saved.'
          : 'Summary saved into the workspace.',
      );
    } catch (summaryError) {
      setError(summaryError instanceof Error ? summaryError.message : 'Failed to generate summary.');
    } finally {
      setPendingAction(null);
    }
  };

  const showUpgradePrompt = (feature: string) => {
    setUpgradePrompt(
      hasAccount
        ? `Unlock Batch Workflows & Exports with Premium to use ${feature}.`
        : `Sign in & Upgrade to unlock ${feature}. Premium access is account-bound so Lemon Squeezy entitlements can sync back to this extension.`,
    );
  };

  const openPremiumPortal = () => {
    if (!hasAccount) {
      setActiveView('settings');
      return;
    }

    window.open(PREMIUM_PLACEHOLDER_URL, '_blank', 'noopener,noreferrer');
  };

  const handleSend = async () => {
    if (!selectedWorkspace || !selectedVideoIds.length || !draftMessage.trim()) {
      return;
    }

    setPendingAction('chat');
    setError(null);
    setStatus('Sending question to the copilot...');

    try {
      await sendRuntimeRequest<unknown>({
        type: 'briefly/send-chat-message',
        workspaceId: selectedWorkspace.id,
        videoIds: selectedVideoIds,
        message: draftMessage.trim(),
      });
      setDraftMessage('');
      setStatus('Answer saved to the workspace.');
    } catch (chatError) {
      setError(chatError instanceof Error ? chatError.message : 'Failed to send message.');
    } finally {
      setPendingAction(null);
    }
  };

  const handleExport = async () => {
    if (!selectedWorkspace || !selectedVideos.length || !selectedTranscripts.length) {
      return;
    }

    setPendingAction('export');
    setError(null);

    try {
      const markdown = formatWorkspaceAsMarkdown({
        workspace: selectedWorkspace,
        videos: selectedVideos,
        transcripts: selectedTranscripts,
      });

      downloadMarkdownFile(createWorkspaceMarkdownFilename(selectedWorkspace), markdown);
      await trackEvent('markdown_exported', {
        workspaceId: selectedWorkspace.id,
        videoCount: selectedVideos.length,
      });
      setStatus('Markdown export downloaded.');
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Failed to export workspace.');
    } finally {
      setPendingAction(null);
    }
  };

  const handleRemoveFromQueue = async (videoId: string) => {
    if (!effectiveQueueWorkspace) {
      return;
    }

    const nextVideoIds = effectiveQueueWorkspace.videoIds.filter((candidate) => candidate !== videoId);
    setQueueOptimisticState({
      videoIds: nextVideoIds,
      clearMessages: false,
    });
    setError(null);

    try {
      await sendRuntimeRequest<unknown>({
        type: 'briefly/remove-from-queue',
        videoId,
      });
      setStatus('Video removed from the batch queue.');
    } catch (removeError) {
      setQueueOptimisticState(null);
      setError(removeError instanceof Error ? removeError.message : 'Failed to remove video from queue.');
    }
  };

  const handleClearQueue = async () => {
    if (!effectiveQueueWorkspace) {
      return;
    }

    setQueueOptimisticState({
      videoIds: [],
      clearMessages: true,
    });
    setError(null);

    try {
      await sendRuntimeRequest<unknown>({
        type: 'briefly/clear-queue',
      });
      setStatus('Batch queue cleared.');
    } catch (clearError) {
      setQueueOptimisticState(null);
      setError(clearError instanceof Error ? clearError.message : 'Failed to clear queue.');
    }
  };

  const handleSaveWorkspaceMetadata = async () => {
    if (!selectedWorkspace) {
      return;
    }

    setIsSavingWorkspaceMeta(true);
    setError(null);

    try {
      const tags = workspaceMetaDraft.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);

      await updateWorkspaceMetadata(selectedWorkspace.id, {
        name: workspaceMetaDraft.name.trim() || undefined,
        notes: workspaceMetaDraft.notes.trim(),
        tags,
      });
      setStatus('Workspace details saved.');
    } catch (metadataError) {
      setError(
        metadataError instanceof Error
          ? metadataError.message
          : 'Failed to save workspace details.',
      );
    } finally {
      setIsSavingWorkspaceMeta(false);
    }
  };

  const handleTogglePinWorkspace = async () => {
    if (!selectedWorkspace) {
      return;
    }

    setIsSavingWorkspaceMeta(true);
    setError(null);

    try {
      await updateWorkspaceMetadata(selectedWorkspace.id, {
        isPinned: !selectedWorkspace.isPinned,
      });
      setStatus(selectedWorkspace.isPinned ? 'Workspace unpinned.' : 'Workspace pinned.');
    } catch (metadataError) {
      setError(
        metadataError instanceof Error
          ? metadataError.message
          : 'Failed to update workspace pin state.',
      );
    } finally {
      setIsSavingWorkspaceMeta(false);
    }
  };

  const handleDeleteWorkspace = async () => {
    if (!selectedWorkspace || selectedWorkspace.id === ACTIVE_QUEUE_WORKSPACE_ID) {
      return;
    }

    const confirmed = window.confirm('Delete this workspace from local memory? This cannot be undone.');
    if (!confirmed) {
      return;
    }

    setIsSavingWorkspaceMeta(true);
    setError(null);

    try {
      await deleteWorkspace(selectedWorkspace.id);
      setFocusedWorkspaceId(null);
      setWorkspaceView('video');
      setStatus('Workspace deleted from local memory.');
    } catch (workspaceError) {
      setError(
        workspaceError instanceof Error
          ? workspaceError.message
          : 'Failed to delete workspace.',
      );
    } finally {
      setIsSavingWorkspaceMeta(false);
    }
  };

  const handleAudioSummary = async () => {
    if (!latestAssistantMessage) {
      setError('Generate a summary first, then audio playback can read it aloud.');
      return;
    }

    if (!canUsePremiumAudio) {
      showUpgradePrompt('Audio Summary');
      return;
    }

    if (!('speechSynthesis' in window)) {
      setError('This browser does not support speech synthesis in the side panel.');
      return;
    }

    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      setIsAudioPlaying(false);
      setStatus('Audio playback stopped.');
      return;
    }

    const utterance = new SpeechSynthesisUtterance(latestAssistantMessage.content.slice(0, 8000));
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = () => setIsAudioPlaying(false);
    utterance.onerror = () => {
      setIsAudioPlaying(false);
      setError('Audio playback failed.');
    };

    setIsAudioPlaying(true);
    setStatus('Reading the latest summary aloud...');
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    await trackEvent('audio_summary_played', {
      workspaceId: selectedWorkspace?.id,
      videoCount: selectedVideoIds.length,
    });
  };

  const openVideo = (videoId: string, startTime?: number) => {
    const url = new URL(normalizeYouTubeUrl(videoId));
    if (typeof startTime === 'number' && Number.isFinite(startTime) && startTime > 0) {
      url.searchParams.set('t', `${Math.max(0, Math.floor(startTime))}s`);
    }

    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  };

  if (!activeTab.isYouTubeVideo && !hasUnlockedQueueWorkspace && !hasFocusedWorkspace) {
    return (
      <section className="panel-stack">
        <div className="panel-card panel-card--centered">
          <span className="status-chip status-chip--quiet">Copilot idle</span>
          <h2 className="section-title">Open YouTube or queue videos</h2>
          <p className="section-copy">
            Briefly watches the active tab for video transcripts and also lets you queue videos
            directly from YouTube thumbnails on Home, Search, and Playlist pages.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel-stack">
      {(activeTab.isYouTubeVideo || hasQueueWorkspace || hasFocusedWorkspace) ? (
        <div className="panel-card">
          <div className="section-header">
            <div>
              <span className="status-chip status-chip--quiet">Workspace Focus</span>
              <h2 className="section-title">Choose your research scope</h2>
              <p className="section-copy">
                Switch between the active video and the persistent batch queue without losing
                summaries or chat history.
              </p>
            </div>
          </div>

          <div className="segmented-control segmented-control--wrap">
            <button
              className={`segment-button ${workspaceView === 'video' ? 'segment-button--active' : ''}`}
              disabled={!activeTab.isYouTubeVideo && !hasFocusedWorkspace}
              onClick={() => {
                setUpgradePrompt(null);
                setFocusedWorkspaceId(null);
                setWorkspaceView('video');
              }}
              type="button"
            >
              {hasFocusedWorkspace ? 'Live Context' : 'Current Video'}
            </button>
            <button
              className={`segment-button ${workspaceView === 'queue' ? 'segment-button--active' : ''} ${!canUseBatchWorkflows ? 'segment-button--locked' : ''}`}
              disabled={!hasQueueWorkspace && canUseBatchWorkflows}
              onClick={() => {
                if (!canUseBatchWorkflows) {
                  showUpgradePrompt('the Batch Queue');
                  return;
                }

                setUpgradePrompt(null);
                setFocusedWorkspaceId(null);
                setWorkspaceView('queue');
              }}
              type="button"
            >
              {canUseBatchWorkflows ? 'Batch Queue' : 'Batch Queue Lock'} {hasQueueWorkspace ? `(${effectiveQueueVideoIds.length})` : ''}
            </button>
          </div>

          {hasFocusedWorkspace ? (
            <div className="workspace-focus-banner">
              <span className="section-copy">
                Viewing a saved workspace from Global Search. Live tab syncing is still available when you return to live context.
              </span>
              <button
                className="queue-action-button"
                onClick={() => setFocusedWorkspaceId(null)}
                type="button"
              >
                Return to Live Context
              </button>
            </div>
          ) : null}

          {hasUnlockedQueueWorkspace ? (
            <div className="queue-list">
              <div className="queue-list__header">
                <span className="section-copy">Curate the current research batch before you run synthesis.</span>
                <button
                  className="queue-action-button"
                  disabled={!effectiveQueueVideoIds.length}
                  onClick={handleClearQueue}
                  type="button"
                >
                  Clear Queue
                </button>
              </div>
              {effectiveQueueVideos.map((video) => (
                <div className="queue-item" key={video.id}>
                  <div className="queue-item__body">
                    <span className="queue-item__title">{video.title}</span>
                    <span className="queue-item__meta">{video.channel}</span>
                  </div>
                  <button
                    className="queue-action-button"
                    onClick={() => handleRemoveFromQueue(video.id)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="panel-card hero-card">
        <div className="section-header">
          <div>
            <span className="status-chip">{selectedScopeLabel}</span>
            <h2 className="section-title">
              {workspaceDisplayTitle}
            </h2>
            <p className="section-copy">
              {hasFocusedWorkspace
                ? `${selectedVideos.length} saved videos · ${selectedTranscripts.length} transcripts indexed locally`
                : workspaceView === 'queue' && hasUnlockedQueueWorkspace
                ? `${selectedVideos.length} queued videos · ${selectedTranscripts.length} transcripts synced locally`
                : `${currentVideo?.channel ?? 'Detecting channel'} · ${currentTranscript?.segments.length ?? 0} segments · synced ${formatFetchTime(currentTranscript?.metadata.fetchedAt)}`}
            </p>
          </div>
          <div className="hero-actions">
            <button
              className={`primary-button primary-button--ghost ${!canUsePremiumAudio ? 'primary-button--locked' : ''}`}
              disabled={canUsePremiumAudio && (!latestAssistantMessage || pendingAction !== null)}
              onClick={() => {
                if (!canUsePremiumAudio) {
                  showUpgradePrompt('Audio Summary');
                  return;
                }

                void handleAudioSummary();
              }}
              type="button"
            >
              {canUsePremiumAudio
                ? isAudioPlaying
                  ? 'Stop Audio'
                  : 'Play Audio Summary'
                : 'Audio Summary Lock'}
            </button>
            <button
              className={`primary-button primary-button--ghost ${!canUseBatchWorkflows ? 'primary-button--locked' : ''}`}
              disabled={canUseBatchWorkflows && (!selectedWorkspace || !selectedVideos.length || !selectedTranscripts.length || pendingAction !== null)}
              onClick={() => {
                if (!canUseBatchWorkflows) {
                  showUpgradePrompt('Markdown export');
                  return;
                }

                void handleExport();
              }}
              type="button"
            >
              {canUseBatchWorkflows
                ? pendingAction === 'export'
                  ? 'Exporting...'
                  : 'Export Markdown'
                : 'Export Markdown Lock'}
            </button>
            {activeTab.isYouTubeVideo ? (
              <button
                className="primary-button primary-button--ghost"
                disabled={pendingAction === 'sync'}
                onClick={handleRefresh}
                type="button"
              >
                {pendingAction === 'sync' ? 'Refreshing...' : 'Refresh'}
              </button>
            ) : null}
          </div>
        </div>

        <div className="video-metadata-grid">
          <div className="meta-card">
            <span className="meta-label">Workspace ID</span>
            <span className="meta-value">{selectedWorkspace?.id ?? 'Creating...'}</span>
          </div>
          <div className="meta-card">
            <span className="meta-label">Videos in scope</span>
            <span className="meta-value">{selectedVideoIds.length}</span>
          </div>
          <div className="meta-card">
            <span className="meta-label">Current provider</span>
            <span className="meta-value">{selectedProvider}</span>
          </div>
          <div className="meta-card">
            <span className="meta-label">{selectedProvider === 'ollama' ? 'Model status' : 'Key status'}</span>
            <span className="meta-value">
              {selectedProvider === 'ollama'
                ? isProviderConfigured
                  ? 'Local endpoint ready'
                  : 'Missing local endpoint or model'
                : activeProviderKey
                  ? 'Configured'
                  : 'Missing API key'}
            </span>
          </div>
        </div>
      </div>

      {selectedVideos.length ? (
        <div className="panel-card">
          <div className="section-header">
            <div>
              <h2 className="section-title">Workspace Sources</h2>
              <p className="section-copy">
                This is the actual set of videos and locally saved transcript memory attached to the current workspace.
              </p>
            </div>
            <span className="status-chip status-chip--quiet">{selectedVideos.length} videos</span>
          </div>

          <div className="source-list">
            {selectedVideos.map((video) => {
              const transcript = transcriptByVideoId.get(video.id);
              const previewSegments = transcript?.segments.filter((segment) => segment.text.trim()).slice(0, 3) ?? [];

              return (
                <article className="source-card" key={video.id}>
                  <div className="source-card__header">
                    <div>
                      <span className="source-card__title">{video.title}</span>
                      <span className="source-card__meta">
                        {video.channel} · {transcript ? `${transcript.segments.length} transcript segments` : 'Transcript not synced yet'}
                      </span>
                    </div>
                    <div className="source-card__actions">
                      <button
                        className="queue-action-button"
                        onClick={() => openVideo(video.id)}
                        type="button"
                      >
                        Open Video
                      </button>
                    </div>
                  </div>

                  {previewSegments.length ? (
                    <div className="transcript-chip-row">
                      {previewSegments.map((segment, index) => (
                        <button
                          className="transcript-chip"
                          key={`${video.id}-${segment.start_time}-${index}`}
                          onClick={() => openVideo(video.id, segment.start_time)}
                          type="button"
                        >
                          <span className="transcript-chip__time">{formatTimestamp(segment.start_time)}</span>
                          <span className="transcript-chip__text">{segment.text}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="section-copy">
                      No transcript preview saved yet for this source.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      ) : null}

      {selectedWorkspace ? (
        <div className="panel-card">
          <div className="section-header">
            <div>
              <h2 className="section-title">Workspace Details</h2>
              <p className="section-copy">
                Name, tag, pin, and annotate this workspace so it becomes reusable research memory instead of an anonymous thread.
              </p>
            </div>
            <button
              className="queue-action-button"
              disabled={isSavingWorkspaceMeta}
              onClick={handleTogglePinWorkspace}
              type="button"
            >
              {selectedWorkspace.isPinned ? 'Unpin' : 'Pin'}
            </button>
          </div>

          <div className="form-stack">
            <label className="field">
              <span className="field-label">Workspace Name</span>
              <input
                className="text-input"
                onChange={(event) =>
                  setWorkspaceMetaDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="Open-source AI market map"
                type="text"
                value={workspaceMetaDraft.name}
              />
            </label>

            <label className="field">
              <span className="field-label">Tags</span>
              <input
                className="text-input"
                onChange={(event) =>
                  setWorkspaceMetaDraft((current) => ({
                    ...current,
                    tags: event.target.value,
                  }))
                }
                placeholder="open-source, ai, market, analysis"
                type="text"
                value={workspaceMetaDraft.tags}
              />
            </label>

            <label className="field">
              <span className="field-label">Research Notes</span>
              <textarea
                className="composer-input"
                onChange={(event) =>
                  setWorkspaceMetaDraft((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
                placeholder="Capture your own thesis, follow-up questions, or why this workspace matters."
                rows={5}
                value={workspaceMetaDraft.notes}
              />
            </label>

            <div className="hero-actions">
              <button
                className="primary-button"
                disabled={isSavingWorkspaceMeta}
                onClick={handleSaveWorkspaceMetadata}
                type="button"
              >
                {isSavingWorkspaceMeta ? 'Saving...' : 'Save Workspace Details'}
              </button>
              {selectedWorkspace.id !== ACTIVE_QUEUE_WORKSPACE_ID ? (
                <button
                  className="queue-action-button queue-action-button--danger"
                  disabled={isSavingWorkspaceMeta}
                  onClick={handleDeleteWorkspace}
                  type="button"
                >
                  Delete Workspace
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {upgradePrompt ? (
        <div className="panel-card premium-card">
          <div className="section-header">
            <div>
              <span className="status-chip status-chip--quiet">Premium</span>
              <h2 className="section-title">{premiumPromptHeading}</h2>
              <p className="section-copy">{upgradePrompt}</p>
            </div>
          </div>

          <div className="hero-actions">
            <button
              className="primary-button"
              onClick={openPremiumPortal}
              type="button"
            >
              {hasAccount ? 'View Premium' : 'Sign in & Upgrade'}
            </button>
            <button
              className="primary-button primary-button--ghost"
              onClick={() => setUpgradePrompt(null)}
              type="button"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <div className="panel-card">
        <div className="section-header">
          <div>
            <h2 className="section-title">Quick Summary Modes</h2>
            <p className="section-copy">
              For batch workspaces, Briefly creates a per-video pass first and then appends a
              cross-video synthesis to the same memory thread.
            </p>
          </div>
        </div>

        <div className="segmented-control segmented-control--wrap">
          {summaryModes.map((mode) => (
            <button
              key={mode.id}
              className={`segment-button ${selectedWorkspace?.summaryMode === mode.id ? 'segment-button--active' : ''}`}
              disabled={!isProviderConfigured || pendingAction !== null || !selectedWorkspace || !selectedVideoIds.length}
              onClick={() => handleSummary(mode.id)}
              type="button"
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      <div className="panel-card chat-card">
        <div className="section-header">
          <div>
            <h2 className="section-title">Workspace Memory</h2>
            <p className="section-copy">
              {workspaceView === 'queue' && hasUnlockedQueueWorkspace
                ? 'This thread persists for your queued multi-video research set.'
                : hasFocusedWorkspace
                  ? 'This thread was restored from local memory via Global Search.'
                : 'This thread reloads from Dexie when you revisit the same video.'}
            </p>
          </div>
        </div>

        <div className="message-list" ref={messageListRef}>
          {selectedWorkspace?.messages.length ? (
            selectedWorkspace.messages.map((message) => (
              <article
                key={message.id}
                className={`message-bubble ${message.role === 'user' ? 'message-bubble--user' : 'message-bubble--assistant'}`}
              >
                <div className="message-meta">
                  <span>{message.role === 'user' ? 'You' : 'Briefly'}</span>
                  <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
                </div>
                <p className="message-content">{message.content}</p>
              </article>
            ))
          ) : (
            <div className="empty-thread">
              <p className="section-copy">
                {workspaceView === 'queue' && hasQueueWorkspace
                  ? 'No saved batch chat yet. Run a summary to generate per-video analysis and a cross-video synthesis.'
                  : 'No saved chat yet. Run a summary or ask a question to start building memory for this video.'}
              </p>
            </div>
          )}
        </div>

        <div className="composer">
          <textarea
            className="composer-input"
            onChange={(event) => setDraftMessage(event.target.value)}
            placeholder={
              workspaceView === 'queue' && hasQueueWorkspace
                ? 'Ask for overlaps, contradictions, recurring claims, or a unified conclusion across the queued videos...'
                : 'Ask about claims, timestamps, action items, or contradictions in the video...'
            }
            rows={4}
            value={draftMessage}
          />
          <div className="composer-footer">
            <span className="section-copy">
              {selectedTranscripts[0]?.segments[0]
                ? `First timestamp ${formatTimestamp(selectedTranscripts[0].segments[0].start_time)}`
                : 'Transcript not loaded yet'}
            </span>
            <button
              className="primary-button"
              disabled={!isProviderConfigured || pendingAction !== null || !draftMessage.trim() || !selectedWorkspace || !selectedVideoIds.length}
              onClick={handleSend}
              type="button"
            >
              {pendingAction === 'chat' ? 'Thinking...' : 'Send'}
            </button>
          </div>
        </div>
      </div>

      {status ? <p className="inline-status">{status}</p> : null}
      {error ? <p className="inline-status inline-status--error">{error}</p> : null}
    </section>
  );
}
