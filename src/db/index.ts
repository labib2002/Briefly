import Dexie, { type Table } from 'dexie';

import type {
  SettingsRecord,
  TranscriptRecord,
  VideoRecord,
  WorkspaceRecord,
} from '../types/domain';

class BrieflyDatabase extends Dexie {
  videos!: Table<VideoRecord, string>;
  transcripts!: Table<TranscriptRecord, string>;
  workspaces!: Table<WorkspaceRecord, string>;
  settings!: Table<SettingsRecord, string>;

  constructor() {
    super('briefly-db');

    this.version(1).stores({
      videos: '&id, url, channel, updatedAt',
      transcripts: '&videoId, metadata.fetchedAt',
      workspaces: '&id, *videoIds, primaryVideoId, updatedAt',
      settings: '&id, selectedProvider, updatedAt',
    });

    this.version(2)
      .stores({
        videos: '&id, url, channel, updatedAt',
        transcripts: '&videoId, metadata.fetchedAt',
        workspaces: '&id, *videoIds, primaryVideoId, updatedAt',
        settings: '&id, selectedProvider, updatedAt',
      })
      .upgrade(async (transaction) => {
        const settingsTable = transaction.table('settings');
        const settings = await settingsTable.toArray();

        await Promise.all(
          settings.map((record) =>
            settingsTable.put({
              ...record,
              customPrompts: Array.isArray(record.customPrompts) ? record.customPrompts : [],
            }),
          ),
        );
      });

    this.version(3)
      .stores({
        videos: '&id, url, channel, updatedAt',
        transcripts: '&videoId, metadata.fetchedAt',
        workspaces: '&id, *videoIds, primaryVideoId, updatedAt',
        settings: '&id, selectedProvider, updatedAt',
      })
      .upgrade(async (transaction) => {
        const settingsTable = transaction.table('settings');
        const settings = await settingsTable.toArray();

        await Promise.all(
          settings.map((record) =>
            settingsTable.put({
              ...record,
              customPrompts: Array.isArray(record.customPrompts) ? record.customPrompts : [],
              isPremium: typeof record.isPremium === 'boolean' ? record.isPremium : false,
            }),
          ),
        );
      });

    this.version(4)
      .stores({
        videos: '&id, url, channel, updatedAt',
        transcripts: '&videoId, metadata.fetchedAt',
        workspaces: '&id, *videoIds, primaryVideoId, updatedAt',
        settings: '&id, selectedProvider, updatedAt',
      })
      .upgrade(async (transaction) => {
        const settingsTable = transaction.table('settings');
        const settings = await settingsTable.toArray();

        await Promise.all(
          settings.map((record) =>
            settingsTable.put({
              ...record,
              customPrompts: Array.isArray(record.customPrompts) ? record.customPrompts : [],
              isPremium: typeof record.isPremium === 'boolean' ? record.isPremium : false,
              ollamaEndpoint:
                typeof record.ollamaEndpoint === 'string' && record.ollamaEndpoint.trim()
                  ? record.ollamaEndpoint
                  : 'http://localhost:11434',
              ollamaModel:
                typeof record.ollamaModel === 'string' && record.ollamaModel.trim()
                  ? record.ollamaModel
                  : 'llama3',
              user:
                record.user &&
                typeof record.user.id === 'string' &&
                typeof record.user.email === 'string'
                  ? record.user
                  : undefined,
            }),
          ),
        );
      });

    this.version(5)
      .stores({
        videos: '&id, url, channel, updatedAt',
        transcripts: '&videoId, metadata.fetchedAt',
        workspaces: '&id, *videoIds, *tags, isPinned, primaryVideoId, updatedAt',
        settings: '&id, selectedProvider, updatedAt',
      })
      .upgrade(async (transaction) => {
        const workspacesTable = transaction.table('workspaces');
        const settingsTable = transaction.table('settings');
        const [workspaces, settings] = await Promise.all([
          workspacesTable.toArray(),
          settingsTable.toArray(),
        ]);

        await Promise.all(
          workspaces.map((record) =>
            workspacesTable.put({
              ...record,
              notes: typeof record.notes === 'string' ? record.notes : '',
              tags: Array.isArray(record.tags) ? record.tags : [],
              isPinned: typeof record.isPinned === 'boolean' ? record.isPinned : false,
            }),
          ),
        );

        await Promise.all(
          settings.map((record) =>
            settingsTable.put({
              ...record,
              featureFlags: {
                enableThumbnailInjection:
                  typeof record.featureFlags?.enableThumbnailInjection === 'boolean'
                    ? record.featureFlags.enableThumbnailInjection
                    : true,
                enablePlaylistIngestion:
                  typeof record.featureFlags?.enablePlaylistIngestion === 'boolean'
                    ? record.featureFlags.enablePlaylistIngestion
                    : true,
                autoSyncActiveVideo:
                  typeof record.featureFlags?.autoSyncActiveVideo === 'boolean'
                    ? record.featureFlags.autoSyncActiveVideo
                    : true,
                enableTelemetry:
                  typeof record.featureFlags?.enableTelemetry === 'boolean'
                    ? record.featureFlags.enableTelemetry
                    : true,
              },
            }),
          ),
        );
      });
  }
}

export const db = new BrieflyDatabase();
