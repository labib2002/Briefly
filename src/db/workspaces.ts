import { db } from './index';
import type { ChatMessage, SummaryMode, WorkspaceRecord } from '../types/domain';

const DEFAULT_SUMMARY_MODE: SummaryMode = 'tldr';
export const ACTIVE_QUEUE_WORKSPACE_ID = 'queue:active';

export function createVideoWorkspaceId(videoId: string): string {
  return `video:${videoId}`;
}

export async function getOrCreateActiveQueueWorkspace(): Promise<WorkspaceRecord> {
  const existing = await db.workspaces.get(ACTIVE_QUEUE_WORKSPACE_ID);

  if (existing) {
    return existing;
  }

  const timestamp = Date.now();
  const workspace: WorkspaceRecord = {
    id: ACTIVE_QUEUE_WORKSPACE_ID,
    videoIds: [],
    messages: [],
    summaryMode: DEFAULT_SUMMARY_MODE,
    notes: '',
    tags: [],
    isPinned: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await db.workspaces.put(workspace);
  return workspace;
}

export async function getOrCreateVideoWorkspace(videoId: string): Promise<WorkspaceRecord> {
  const workspaceId = createVideoWorkspaceId(videoId);
  const existing = await db.workspaces.get(workspaceId);

  if (existing) {
    return existing;
  }

  const timestamp = Date.now();
  const workspace: WorkspaceRecord = {
    id: workspaceId,
    primaryVideoId: videoId,
    videoIds: [videoId],
    messages: [],
    summaryMode: DEFAULT_SUMMARY_MODE,
    notes: '',
    tags: [],
    isPinned: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await db.workspaces.put(workspace);
  return workspace;
}

export async function addVideosToWorkspace(
  workspaceId: string,
  videoIds: string[],
): Promise<WorkspaceRecord> {
  const workspace = await db.workspaces.get(workspaceId);

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const mergedVideoIds = [...new Set([...workspace.videoIds, ...videoIds])];
  const updated: WorkspaceRecord = {
    ...workspace,
    primaryVideoId: workspace.primaryVideoId ?? mergedVideoIds[0],
    videoIds: mergedVideoIds,
    updatedAt: Date.now(),
  };

  await db.workspaces.put(updated);
  return updated;
}

export async function removeVideoFromWorkspace(
  workspaceId: string,
  videoId: string,
): Promise<WorkspaceRecord> {
  const workspace = await db.workspaces.get(workspaceId);

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const nextVideoIds = workspace.videoIds.filter((candidate) => candidate !== videoId);
  const updated: WorkspaceRecord = {
    ...workspace,
    primaryVideoId: workspace.primaryVideoId === videoId ? nextVideoIds[0] : workspace.primaryVideoId,
    videoIds: nextVideoIds,
    updatedAt: Date.now(),
  };

  await db.workspaces.put(updated);
  return updated;
}

export async function clearActiveQueueWorkspace(): Promise<WorkspaceRecord> {
  const workspace = await getOrCreateActiveQueueWorkspace();
  const cleared: WorkspaceRecord = {
    ...workspace,
    primaryVideoId: undefined,
    videoIds: [],
    messages: [],
    updatedAt: Date.now(),
  };

  await db.workspaces.put(cleared);
  return cleared;
}

export async function appendWorkspaceMessages(
  workspaceId: string,
  messages: ChatMessage[],
): Promise<WorkspaceRecord> {
  const workspace = await db.workspaces.get(workspaceId);

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const updated: WorkspaceRecord = {
    ...workspace,
    messages: [...workspace.messages, ...messages],
    updatedAt: Date.now(),
  };

  await db.workspaces.put(updated);
  return updated;
}

export async function updateWorkspaceSummaryMode(
  workspaceId: string,
  summaryMode: SummaryMode,
): Promise<WorkspaceRecord> {
  const workspace = await db.workspaces.get(workspaceId);

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const updated: WorkspaceRecord = {
    ...workspace,
    summaryMode,
    updatedAt: Date.now(),
  };

  await db.workspaces.put(updated);
  return updated;
}

type WorkspaceMetadataUpdate = Partial<Pick<WorkspaceRecord, 'name' | 'notes' | 'tags' | 'isPinned'>>;

export async function updateWorkspaceMetadata(
  workspaceId: string,
  update: WorkspaceMetadataUpdate,
): Promise<WorkspaceRecord> {
  const workspace = await db.workspaces.get(workspaceId);

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const updated: WorkspaceRecord = {
    ...workspace,
    ...update,
    tags: update.tags ?? workspace.tags,
    updatedAt: Date.now(),
  };

  await db.workspaces.put(updated);
  return updated;
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await db.workspaces.delete(workspaceId);
}
