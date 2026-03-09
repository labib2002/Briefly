import { db } from '../db';
import { appendWorkspaceMessages } from '../db/workspaces';
import type { AIProvider, ChatMessage, WorkspaceRecord } from '../types/domain';
import { createId } from '../utils/id';
import { buildChatSystemPrompt } from './ai/prompts';
import { generateText } from './ai/router';
import { buildTranscriptContext } from './summarization';
import { ingestTranscriptByVideoId } from './transcript-ingestion';

function createUserMessage(content: string): ChatMessage {
  return {
    id: createId(),
    role: 'user',
    content,
    createdAt: Date.now(),
  };
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

export async function answerWorkspaceChat(input: {
  workspaceId: string;
  videoIds: string[];
  message: string;
  provider?: AIProvider;
}): Promise<{ workspace: WorkspaceRecord; message: ChatMessage }> {
  const workspace = await db.workspaces.get(input.workspaceId);

  if (!workspace) {
    throw new Error(`Workspace not found: ${input.workspaceId}`);
  }

  const transcripts = (
    await Promise.all(input.videoIds.map((videoId) => ingestTranscriptByVideoId(videoId)))
  ).map((payload) => payload.transcript);

  if (!transcripts.length) {
    throw new Error('No transcript is available for chat.');
  }

  const userMessage = createUserMessage(input.message);
  const recentHistory = workspace.messages.slice(-6).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const transcriptContext = buildTranscriptContext(transcripts);
  const response = await generateText({
    provider: input.provider,
    messages: [
      {
        role: 'system',
        content: buildChatSystemPrompt(transcripts.length),
      },
      ...recentHistory,
      {
        role: 'user',
        content: [
          'Transcript context:',
          transcriptContext,
          '',
          `User question: ${input.message}`,
        ].join('\n'),
      },
    ],
    maxOutputTokens: 1200,
  });

  const assistantMessage = createAssistantMessage(response.text, response.provider);
  const updatedWorkspace = await appendWorkspaceMessages(input.workspaceId, [
    userMessage,
    assistantMessage,
  ]);

  return {
    workspace: updatedWorkspace,
    message: assistantMessage,
  };
}
