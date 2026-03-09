import type { TranscriptRecord, VideoRecord, WorkspaceRecord } from '../types/domain';
import { formatTimestamp } from './time';

type ExportMarkdownInput = {
  workspace: WorkspaceRecord;
  videos: VideoRecord[];
  transcripts: TranscriptRecord[];
};

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
}

function renderTranscript(record: TranscriptRecord): string {
  return record.segments
    .map((segment) => `- [${formatTimestamp(segment.start_time)}] ${segment.text}`)
    .join('\n');
}

export function formatWorkspaceAsMarkdown(input: ExportMarkdownInput): string {
  const videosById = new Map(input.videos.map((video) => [video.id, video]));
  const transcriptsById = new Map(input.transcripts.map((transcript) => [transcript.videoId, transcript]));
  const orderedVideos = input.workspace.videoIds
    .map((videoId) => videosById.get(videoId))
    .filter((video): video is VideoRecord => Boolean(video));
  const assistantMessages = input.workspace.messages.filter((message) => message.role === 'assistant');

  return [
    '# Briefly Workspace Export',
    '',
    input.workspace.name ? `- Workspace Name: ${escapeMarkdown(input.workspace.name)}` : '',
    `- Workspace ID: \`${input.workspace.id}\``,
    `- Exported At: ${new Date().toLocaleString()}`,
    `- Summary Mode: ${input.workspace.summaryMode}`,
    `- Videos: ${orderedVideos.length}`,
    input.workspace.tags.length ? `- Tags: ${input.workspace.tags.map((tag) => `\`${escapeMarkdown(tag)}\``).join(', ')}` : '',
    input.workspace.isPinned ? '- Pinned: yes' : '',
    '',
    input.workspace.notes
      ? [
          '## Workspace Notes',
          input.workspace.notes,
          '',
        ].join('\n')
      : '',
    '## Highlights & Summaries',
    assistantMessages.length
      ? assistantMessages
          .map((message, index) =>
            [
              `### Output ${index + 1}`,
              `- Timestamp: ${new Date(message.createdAt).toLocaleString()}`,
              message.provider ? `- Provider: ${message.provider}` : '',
              '',
              message.content,
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .join('\n\n')
      : '_No assistant summaries saved yet._',
    '',
    '## Videos',
    orderedVideos
      .map((video, index) => {
        const transcript = transcriptsById.get(video.id);
        return [
          `### ${index + 1}. ${escapeMarkdown(video.title)}`,
          `- Channel: ${escapeMarkdown(video.channel)}`,
          `- URL: ${video.url}`,
          transcript?.metadata.source ? `- Transcript Source: ${transcript.metadata.source}` : '',
          transcript?.metadata.fetchedAt
            ? `- Transcript Synced: ${new Date(transcript.metadata.fetchedAt).toLocaleString()}`
            : '',
          '',
          '#### Transcript',
          transcript ? renderTranscript(transcript) : '_Transcript unavailable_',
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n'),
    '',
    '## Chat History',
    input.workspace.messages.length
      ? input.workspace.messages
          .map((message, index) =>
            [
              `### ${index + 1}. ${message.role === 'assistant' ? 'Briefly' : 'You'}`,
              `- Timestamp: ${new Date(message.createdAt).toLocaleString()}`,
              message.provider ? `- Provider: ${message.provider}` : '',
              '',
              message.content,
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .join('\n\n')
      : '_No chat history saved yet._',
  ].join('\n');
}

export function createWorkspaceMarkdownFilename(workspace: WorkspaceRecord): string {
  const source = workspace.name?.trim() || workspace.id;
  const slug = source.replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'briefly-workspace'}.md`;
}
