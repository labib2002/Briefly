import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { db } from '../db';
import { useUIStore } from '../state/ui-store';
import type { TranscriptRecord, VideoRecord, WorkspaceRecord } from '../types/domain';

type SearchResult = {
  workspaceId: string;
  title: string;
  subtitle: string;
  snippet: string;
  tags: string[];
  isPinned: boolean;
  matchType: 'transcript' | 'chat' | 'video' | 'recent';
  updatedAt: number;
};

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractSnippet(source: string, query: string): string {
  const normalized = compactWhitespace(source);

  if (!query) {
    return normalized.slice(0, 180);
  }

  const sourceLower = normalized.toLowerCase();
  const index = sourceLower.indexOf(query);

  if (index === -1) {
    return normalized.slice(0, 180);
  }

  const start = Math.max(0, index - 72);
  const end = Math.min(normalized.length, index + query.length + 108);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalized.length ? '...' : '';

  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function buildSearchResults(input: {
  query: string;
  workspaces: WorkspaceRecord[];
  videos: VideoRecord[];
  transcripts: TranscriptRecord[];
}): SearchResult[] {
  const videosById = new Map(input.videos.map((video) => [video.id, video]));
  const transcriptsById = new Map(input.transcripts.map((transcript) => [transcript.videoId, transcript]));
  const query = normalizeQuery(input.query);

  if (!query) {
    return input.workspaces
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 8)
      .map((workspace) => {
        const primaryVideo = workspace.primaryVideoId
          ? videosById.get(workspace.primaryVideoId)
          : workspace.videoIds[0]
            ? videosById.get(workspace.videoIds[0])
            : undefined;

        return {
          workspaceId: workspace.id,
          title: (workspace.name?.trim() || primaryVideo?.title) ?? workspace.id,
          subtitle: primaryVideo?.channel ?? `${workspace.videoIds.length} videos`,
          snippet:
            (workspace.notes ||
              workspace.messages[workspace.messages.length - 1]?.content.slice(0, 180)) ??
            `${workspace.videoIds.length} saved videos in this workspace.`,
          tags: workspace.tags,
          isPinned: workspace.isPinned,
          matchType: 'recent',
          updatedAt: workspace.updatedAt,
        };
      });
  }

  const results: SearchResult[] = [];

  input.workspaces.forEach((workspace) => {
    const orderedVideos = workspace.videoIds
      .map((videoId) => videosById.get(videoId))
      .filter((video): video is VideoRecord => Boolean(video));
    const matchingVideo = orderedVideos.find((video) =>
      [video.title, video.channel, video.url].some((value) => value.toLowerCase().includes(query)),
    );
    const matchingWorkspaceMetadata = [
      workspace.name ?? '',
      workspace.notes,
      workspace.tags.join(' '),
    ].some((value) => value.toLowerCase().includes(query));
    const matchingTranscript = workspace.videoIds
      .map((videoId) => transcriptsById.get(videoId))
      .filter((transcript): transcript is TranscriptRecord => Boolean(transcript))
      .find((transcript) =>
        transcript.segments.some((segment) => segment.text.toLowerCase().includes(query)),
      );
    const matchingMessage = workspace.messages.find((message) =>
      message.content.toLowerCase().includes(query),
    );

    if (!matchingVideo && !matchingTranscript && !matchingMessage && !matchingWorkspaceMetadata) {
      return;
    }

    const primaryVideo = workspace.primaryVideoId
      ? videosById.get(workspace.primaryVideoId)
      : orderedVideos[0];

    if (matchingMessage) {
      results.push({
        workspaceId: workspace.id,
        title: (workspace.name?.trim() || primaryVideo?.title) ?? workspace.id,
        subtitle: primaryVideo?.channel ?? `${workspace.videoIds.length} videos`,
        snippet: extractSnippet(matchingMessage.content, query),
        tags: workspace.tags,
        isPinned: workspace.isPinned,
        matchType: 'chat',
        updatedAt: workspace.updatedAt,
      });
      return;
    }

    if (matchingTranscript) {
      results.push({
        workspaceId: workspace.id,
        title: (workspace.name?.trim() || primaryVideo?.title) ?? workspace.id,
        subtitle: primaryVideo?.channel ?? `${workspace.videoIds.length} videos`,
        snippet: extractSnippet(
          matchingTranscript.segments.map((segment) => segment.text).join(' '),
          query,
        ),
        tags: workspace.tags,
        isPinned: workspace.isPinned,
        matchType: 'transcript',
        updatedAt: workspace.updatedAt,
      });
      return;
    }

    if (matchingVideo) {
      results.push({
        workspaceId: workspace.id,
        title: (workspace.name?.trim() || primaryVideo?.title) ?? workspace.id,
        subtitle: primaryVideo?.channel ?? `${workspace.videoIds.length} videos`,
        snippet: extractSnippet(
          [matchingVideo.title, matchingVideo.channel, matchingVideo.url].join(' '),
          query,
        ),
        tags: workspace.tags,
        isPinned: workspace.isPinned,
        matchType: 'video',
        updatedAt: workspace.updatedAt,
      });
      return;
    }

    if (matchingWorkspaceMetadata) {
      results.push({
        workspaceId: workspace.id,
        title: (workspace.name?.trim() || primaryVideo?.title) ?? workspace.id,
        subtitle: primaryVideo?.channel ?? `${workspace.videoIds.length} videos`,
        snippet: extractSnippet([workspace.name ?? '', workspace.notes, workspace.tags.join(' ')].join(' '), query),
        tags: workspace.tags,
        isPinned: workspace.isPinned,
        matchType: 'video',
        updatedAt: workspace.updatedAt,
      });
    }
  });

  return results.sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return left.isPinned ? -1 : 1;
    }

    return right.updatedAt - left.updatedAt;
  });
}

function getResultLabel(type: SearchResult['matchType']): string {
  switch (type) {
    case 'chat':
      return 'Chat match';
    case 'transcript':
      return 'Transcript match';
    case 'video':
      return 'Video match';
    default:
      return 'Recent workspace';
  }
}

export function SearchView() {
  const [query, setQuery] = useState('');
  const datasets = useLiveQuery(
    async () => ({
      workspaces: await db.workspaces.toArray(),
      videos: await db.videos.toArray(),
      transcripts: await db.transcripts.toArray(),
    }),
    [],
  );
  const setActiveView = useUIStore((state) => state.setActiveView);
  const setFocusedWorkspaceId = useUIStore((state) => state.setFocusedWorkspaceId);

  if (!datasets) {
    return (
      <section className="panel-stack">
        <div className="panel-card">
          <h2 className="section-title">Global Search</h2>
          <p className="section-copy">Loading local second-brain index...</p>
        </div>
      </section>
    );
  }

  const results = buildSearchResults({
    query,
    workspaces: datasets.workspaces,
    videos: datasets.videos,
    transcripts: datasets.transcripts,
  });

  const openWorkspace = (workspaceId: string) => {
    setFocusedWorkspaceId(workspaceId);
    setActiveView('copilot');
  };

  return (
    <section className="panel-stack">
      <div className="panel-card">
        <div className="section-header">
          <div>
            <span className="status-chip status-chip--quiet">Global Search</span>
            <h2 className="section-title">Search your saved research</h2>
            <p className="section-copy">
              Query transcripts, chat history, and saved video metadata across every
              workspace in local memory.
            </p>
          </div>
        </div>

        <div className="form-stack">
          <label className="field">
            <span className="field-label">Search Query</span>
            <input
              className="text-input"
              onChange={(event) => setQuery(event.target.value)}
              placeholder='Try "OLED", "revenue", or "open source"'
              type="search"
              value={query}
            />
          </label>
        </div>
      </div>

      <div className="panel-card">
        <div className="section-header">
          <div>
            <h2 className="section-title">{query.trim() ? 'Matching Workspaces' : 'Recent Workspaces'}</h2>
            <p className="section-copy">
              Click a result to load that workspace into the Copilot view instantly.
            </p>
          </div>
          <span className="status-chip">{results.length} result{results.length === 1 ? '' : 's'}</span>
        </div>

        <div className="search-results">
          {results.length ? (
            results.map((result) => (
              <button
                className="search-result-card"
                key={`${result.workspaceId}:${result.matchType}`}
                onClick={() => openWorkspace(result.workspaceId)}
                type="button"
              >
                <div className="search-result-card__header">
                  <div>
                    <span className="search-result-card__title">{result.title}</span>
                    <span className="search-result-card__meta">{result.subtitle}</span>
                  </div>
                  <span className="status-chip status-chip--quiet">
                    {result.isPinned ? 'Pinned' : getResultLabel(result.matchType)}
                  </span>
                </div>
                <p className="search-result-card__snippet">{result.snippet}</p>
                {result.tags.length ? (
                  <div className="tag-row">
                    {result.tags.map((tag) => (
                      <span className="tag-chip" key={`${result.workspaceId}:${tag}`}>
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </button>
            ))
          ) : (
            <div className="empty-thread">
              <p className="section-copy">
                No saved workspaces match that query yet.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
