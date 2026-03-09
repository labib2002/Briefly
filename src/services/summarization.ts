import { db } from '../db';
import { getSettings } from '../db/settings';
import { appendWorkspaceMessages, updateWorkspaceSummaryMode } from '../db/workspaces';
import type {
  AIProvider,
  ChatMessage,
  SummaryMode,
  TranscriptRecord,
  TranscriptSegment,
  WorkspaceRecord,
} from '../types/domain';
import { createId } from '../utils/id';
import { formatTimestamp } from '../utils/time';
import {
  buildChunkSummaryPrompt,
  buildCrossVideoSynthesisPrompt,
  buildSummarySystemPrompt,
  buildSynthesisPrompt,
  resolveSummaryPromptProfile,
} from './ai/prompts';
import { generateText } from './ai/router';
import { trackEvent } from './telemetry';
import { ingestTranscriptByVideoId } from './transcript-ingestion';

const TARGET_CHUNK_CHARS = 12000;
const MAX_CHAT_TRANSCRIPT_CHARS = 18000;

type TranscriptChunk = {
  label: string;
  transcript: TranscriptRecord;
};

function chunkTranscript(record: TranscriptRecord): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let currentSegments: TranscriptSegment[] = [];
  let currentLength = 0;
  let chunkIndex = 0;

  for (const segment of record.segments) {
    const renderedLength = segment.text.length + 16;

    if (currentSegments.length > 0 && currentLength + renderedLength > TARGET_CHUNK_CHARS) {
      chunkIndex += 1;
      chunks.push({
        label: `${record.metadata.title ?? record.videoId} chunk ${chunkIndex}`,
        transcript: {
          ...record,
          segments: currentSegments,
        },
      });
      currentSegments = [];
      currentLength = 0;
    }

    currentSegments.push(segment);
    currentLength += renderedLength;
  }

  if (currentSegments.length > 0) {
    chunkIndex += 1;
    chunks.push({
      label: `${record.metadata.title ?? record.videoId} chunk ${chunkIndex}`,
      transcript: {
        ...record,
        segments: currentSegments,
      },
    });
  }

  return chunks;
}

function createAssistantMessage(content: string, provider: AIProvider): ChatMessage {
  return {
    id: createId(),
    role: 'assistant',
    content,
    createdAt: Date.now(),
    provider,
  };
}

async function generateTranscriptSummary(input: {
  transcript: TranscriptRecord;
  summaryMode: SummaryMode;
  provider?: AIProvider;
  customPrompts: Awaited<ReturnType<typeof getSettings>>['customPrompts'];
}): Promise<{ provider: AIProvider; text: string }> {
  const partialSummaries: string[] = [];
  const promptProfile = resolveSummaryPromptProfile(input.summaryMode, input.customPrompts);
  const systemPrompt = buildSummarySystemPrompt(promptProfile, 1);
  const chunks = chunkTranscript(input.transcript);

  for (const chunk of chunks) {
    const result = await generateText({
      provider: input.provider,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: buildChunkSummaryPrompt(promptProfile, chunk.transcript),
        },
      ],
      maxOutputTokens: promptProfile.chunkMaxOutputTokens,
    });

    partialSummaries.push(`Source: ${chunk.label}\n${result.text}`);
  }

  return generateText({
    provider: input.provider,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: buildSynthesisPrompt(promptProfile, partialSummaries, 1),
      },
    ],
    maxOutputTokens: promptProfile.synthesisMaxOutputTokens,
  });
}

export async function generateWorkspaceSummary(input: {
  workspaceId: string;
  videoIds: string[];
  summaryMode: SummaryMode;
  provider?: AIProvider;
}): Promise<{ workspace: WorkspaceRecord; message: ChatMessage }> {
  const settings = await getSettings();
  const promptProfile = resolveSummaryPromptProfile(input.summaryMode, settings.customPrompts);
  const transcripts = (
    await Promise.all(input.videoIds.map((videoId) => ingestTranscriptByVideoId(videoId)))
  ).map((payload) => payload.transcript);

  if (!transcripts.length) {
    throw new Error('No transcripts are available for summarization.');
  }

  await updateWorkspaceSummaryMode(input.workspaceId, input.summaryMode);
  const assistantMessages: ChatMessage[] = [];
  const perVideoSummaries: Array<{
    title: string;
    channel: string;
    summary: string;
  }> = [];

  for (const transcript of transcripts) {
    const summary = await generateTranscriptSummary({
      transcript,
      summaryMode: input.summaryMode,
      provider: input.provider,
      customPrompts: settings.customPrompts,
    });
    const title = transcript.metadata.title ?? transcript.videoId;
    const channel = transcript.metadata.channel ?? 'Unknown channel';

    perVideoSummaries.push({
      title,
      channel,
      summary: summary.text,
    });

    assistantMessages.push(
      createAssistantMessage(
        transcripts.length > 1
          ? [`Summary: ${title}`, `Channel: ${channel}`, '', summary.text].join('\n')
          : summary.text,
        summary.provider,
      ),
    );
  }

  if (transcripts.length > 1) {
    const synthesis = await generateText({
      provider: input.provider,
      messages: [
        {
          role: 'system',
          content: buildSummarySystemPrompt(promptProfile, transcripts.length),
        },
        {
          role: 'user',
          content: buildCrossVideoSynthesisPrompt(promptProfile, perVideoSummaries),
        },
      ],
      maxOutputTokens: promptProfile.crossVideoMaxOutputTokens,
    });

    assistantMessages.push(
      createAssistantMessage(
        ['Cross-Video Synthesis', synthesis.text].join('\n\n'),
        synthesis.provider,
      ),
    );
  }

  const workspace = await appendWorkspaceMessages(input.workspaceId, assistantMessages);
  const assistantMessage = assistantMessages[assistantMessages.length - 1];
  await trackEvent('summary_generated', {
    mode: input.summaryMode,
    provider: assistantMessage.provider,
    videoCount: transcripts.length,
  });

  return {
    workspace,
    message: assistantMessage,
  };
}

export function buildTranscriptContext(records: TranscriptRecord[]): string {
  const lines: string[] = [];
  let totalChars = 0;

  for (const record of records) {
    lines.push(`Video: ${record.metadata.title ?? record.videoId}`);
    if (record.metadata.channel) {
      lines.push(`Channel: ${record.metadata.channel}`);
    }

    for (const segment of record.segments) {
      const line = `[${formatTimestamp(segment.start_time)}] ${segment.text}`;
      totalChars += line.length;
      if (totalChars > MAX_CHAT_TRANSCRIPT_CHARS) {
        lines.push('[Transcript truncated for chat context]');
        return lines.join('\n');
      }
      lines.push(line);
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}
