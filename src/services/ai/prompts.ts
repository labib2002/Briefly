import type {
  CustomPromptProfile,
  DefaultSummaryMode,
  SummaryMode,
  TranscriptRecord,
  TranscriptSegment,
} from '../../types/domain';
import { formatTimestamp } from '../../utils/time';

export type SummaryPromptProfile = {
  id: SummaryMode;
  label: string;
  systemInstruction: string;
  chunkInstruction: string;
  synthesisInstruction: string;
  crossVideoInstruction: string;
  chunkMaxOutputTokens: number;
  synthesisMaxOutputTokens: number;
  crossVideoMaxOutputTokens: number;
};

function isDefaultSummaryMode(mode: SummaryMode): mode is DefaultSummaryMode {
  return mode === 'tldr' || mode === 'action-items' || mode === 'timestamped-highlights';
}

function buildCustomSummaryProfile(
  mode: SummaryMode,
  customPrompt: CustomPromptProfile,
): SummaryPromptProfile {
  return {
    id: mode,
    label: customPrompt.label,
    systemInstruction: [
      'You are Briefly, a grounded YouTube research copilot.',
      customPrompt.systemInstruction,
      'Use only the transcript evidence provided.',
      'If a requested detail is absent, say that clearly instead of inventing it.',
    ].join(' '),
    chunkInstruction: `Apply the custom prompt profile "${customPrompt.label}" to this transcript chunk.`,
    synthesisInstruction: `Combine these chunk outputs into one final answer using the custom prompt profile "${customPrompt.label}".`,
    crossVideoInstruction: `Compare and synthesize these per-video outputs using the custom prompt profile "${customPrompt.label}".`,
    chunkMaxOutputTokens: 1400,
    synthesisMaxOutputTokens: 1800,
    crossVideoMaxOutputTokens: 2200,
  };
}

export function resolveSummaryPromptProfile(
  mode: SummaryMode,
  customPrompts: CustomPromptProfile[],
): SummaryPromptProfile {
  if (!isDefaultSummaryMode(mode)) {
    const promptId = mode.slice('custom:'.length);
    const customPrompt = customPrompts.find((candidate) => candidate.id === promptId);

    if (!customPrompt) {
      throw new Error('The selected custom prompt profile no longer exists.');
    }

    return buildCustomSummaryProfile(mode, customPrompt);
  }

  switch (mode) {
    case 'action-items':
      return {
        id: mode,
        label: 'Action Items',
        systemInstruction: [
          'You are Briefly, a YouTube research copilot.',
          'Return structured output for a busy professional.',
          'Prioritize tasks, decisions, owner-like statements, and concrete follow-through.',
        ].join(' '),
        chunkInstruction:
          'Extract decisions, commitments, next steps, and practical action items from this transcript chunk.',
        synthesisInstruction: 'Create a final action-oriented synthesis grouped by priority.',
        crossVideoInstruction:
          'Compare and contrast these videos, then produce a unified action plan with conflicts, dependencies, and next steps.',
        chunkMaxOutputTokens: 1200,
        synthesisMaxOutputTokens: 1600,
        crossVideoMaxOutputTokens: 1800,
      };
    case 'timestamped-highlights':
      return {
        id: mode,
        label: 'Highlights',
        systemInstruction: [
          'You are Briefly, a YouTube research copilot.',
          'Return timestamped highlights only from the evidence provided.',
          'Preserve timestamps exactly. Do not fabricate timestamps.',
          'Prefer bullet points and short explanations.',
        ].join(' '),
        chunkInstruction:
          'Extract the most useful highlights from this transcript chunk and preserve timestamps exactly as provided.',
        synthesisInstruction:
          'Create the final highlight list. Keep timestamps if present in the partial summaries.',
        crossVideoInstruction:
          'Compare and contrast these videos. Preserve any timestamps already present in the summaries and call out the most important shared and conflicting moments.',
        chunkMaxOutputTokens: 1400,
        synthesisMaxOutputTokens: 1800,
        crossVideoMaxOutputTokens: 2200,
      };
    default:
      return {
        id: mode,
        label: 'TL;DR',
        systemInstruction: [
          'You are Briefly, a YouTube research copilot.',
          'Produce a compact but information-dense summary.',
          'Preserve nuance, unique insights, and factual details.',
        ].join(' '),
        chunkInstruction: 'Create a concise but high-signal summary of this transcript chunk.',
        synthesisInstruction: 'Create a final TL;DR with the most important insights first.',
        crossVideoInstruction:
          'Compare and contrast these videos. Identify overlapping themes, conflicting claims, and a unified conclusion.',
        chunkMaxOutputTokens: 1200,
        synthesisMaxOutputTokens: 1600,
        crossVideoMaxOutputTokens: 1800,
      };
  }
}

function renderSegments(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => `[${formatTimestamp(segment.start_time)}] ${segment.text}`)
    .join('\n');
}

export function buildChunkSummaryPrompt(
  profile: SummaryPromptProfile,
  transcript: TranscriptRecord,
): string {
  return [
    profile.chunkInstruction,
    'Do not invent facts that are not in the transcript.',
    'If the chunk is repetitive, compress repetition aggressively.',
    '',
    `Video: ${transcript.metadata.title ?? transcript.videoId}`,
    transcript.metadata.channel ? `Channel: ${transcript.metadata.channel}` : '',
    '',
    renderSegments(transcript.segments),
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildSummarySystemPrompt(
  profile: SummaryPromptProfile,
  videoCount: number,
): string {
  return [
    profile.systemInstruction,
    videoCount > 1
      ? 'When multiple videos are involved, note where ideas align, diverge, or conflict.'
      : 'Stay grounded in the provided transcript only.',
  ].join(' ');
}

export function buildSynthesisPrompt(
  profile: SummaryPromptProfile,
  partialSummaries: string[],
  videoCount: number,
): string {
  return [
    profile.synthesisInstruction,
    videoCount > 1
      ? 'Also add a short cross-video synthesis that captures agreements, differences, and repeated themes.'
      : 'Keep the final answer tightly focused on the single video.',
    '',
    partialSummaries.map((summary, index) => `Chunk ${index + 1}\n${summary}`).join('\n\n'),
  ].join('\n');
}

export function buildCrossVideoSynthesisPrompt(
  profile: SummaryPromptProfile,
  perVideoSummaries: Array<{
    title: string;
    channel: string;
    summary: string;
  }>,
): string {
  return [
    profile.crossVideoInstruction,
    'Stay grounded in the provided per-video summaries only.',
    'Name the video title or channel when the source matters.',
    '',
    perVideoSummaries
      .map(
        (summary, index) =>
          `Video ${index + 1}: ${summary.title}\nChannel: ${summary.channel}\n${summary.summary}`,
      )
      .join('\n\n'),
  ].join('\n');
}

export function buildChatSystemPrompt(videoCount: number): string {
  return [
    'You are Briefly, a grounded YouTube research copilot.',
    'Answer using only the transcript evidence provided in the prompt.',
    'If the answer is uncertain or absent from the transcript, say that clearly.',
    'When relevant, cite timestamps in square brackets like [00:12:34].',
    videoCount > 1
      ? 'The user may ask you to compare across videos. State which video or channel each point comes from when useful.'
      : 'You are answering questions about one video.',
  ].join(' ');
}
