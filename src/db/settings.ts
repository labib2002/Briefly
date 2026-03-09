import { db } from './index';
import type {
  AIProvider,
  AuthenticatedUser,
  CustomPromptProfile,
  FeatureFlags,
  SettingsRecord,
  ThemeMode,
} from '../types/domain';

export const SETTINGS_RECORD_ID = 'local';

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  enableThumbnailInjection: true,
  enablePlaylistIngestion: true,
  autoSyncActiveVideo: true,
  enableTelemetry: true,
};

const defaultSettings: SettingsRecord = {
  id: SETTINGS_RECORD_ID,
  apiKey: '',
  apiKeys: {},
  selectedProvider: 'gemini',
  ollamaEndpoint: 'http://localhost:11434',
  ollamaModel: 'llama3',
  theme: 'dark',
  customPrompts: [],
  isPremium: false,
  featureFlags: DEFAULT_FEATURE_FLAGS,
  updatedAt: Date.now(),
};

export async function ensureDefaultSettings(): Promise<SettingsRecord> {
  const existing = await db.settings.get(SETTINGS_RECORD_ID);

  if (existing) {
    if (
      Array.isArray(existing.customPrompts) &&
      typeof existing.isPremium === 'boolean' &&
      typeof existing.ollamaEndpoint === 'string' &&
      typeof existing.ollamaModel === 'string' &&
      typeof existing.featureFlags?.enableThumbnailInjection === 'boolean' &&
      typeof existing.featureFlags?.enablePlaylistIngestion === 'boolean' &&
      typeof existing.featureFlags?.autoSyncActiveVideo === 'boolean' &&
      typeof existing.featureFlags?.enableTelemetry === 'boolean'
    ) {
      return existing;
    }

    const next: SettingsRecord = {
      ...existing,
      customPrompts: Array.isArray(existing.customPrompts) ? existing.customPrompts : [],
      isPremium: typeof existing.isPremium === 'boolean' ? existing.isPremium : false,
      ollamaEndpoint:
        typeof existing.ollamaEndpoint === 'string' && existing.ollamaEndpoint.trim()
          ? existing.ollamaEndpoint
          : 'http://localhost:11434',
      ollamaModel:
        typeof existing.ollamaModel === 'string' && existing.ollamaModel.trim()
          ? existing.ollamaModel
          : 'llama3',
      user:
        existing.user &&
        typeof existing.user.id === 'string' &&
        typeof existing.user.email === 'string'
          ? existing.user
          : undefined,
      featureFlags: {
        ...DEFAULT_FEATURE_FLAGS,
        ...existing.featureFlags,
      },
    };

    await db.settings.put(next);
    return next;
  }

  await db.settings.put(defaultSettings);
  return defaultSettings;
}

export async function getSettings(): Promise<SettingsRecord> {
  return ensureDefaultSettings();
}

type SettingsUpdate = Partial<{
  apiKey: string;
  apiKeys: Partial<Record<AIProvider, string>>;
  selectedProvider: AIProvider;
  ollamaEndpoint: string;
  ollamaModel: string;
  theme: ThemeMode;
  customPrompts: CustomPromptProfile[];
  isPremium: boolean;
  user?: AuthenticatedUser;
  featureFlags: FeatureFlags;
}>;

export async function saveSettings(update: SettingsUpdate): Promise<SettingsRecord> {
  const current = await ensureDefaultSettings();
  const selectedProvider = update.selectedProvider ?? current.selectedProvider;
  const mergedApiKeys = {
    ...current.apiKeys,
    ...update.apiKeys,
  };

  const resolvedApiKey =
    update.apiKey ??
    mergedApiKeys[selectedProvider] ??
    current.apiKey;

  if (resolvedApiKey) {
    mergedApiKeys[selectedProvider] = resolvedApiKey;
  }

  const normalizedOllamaEndpoint =
    update.ollamaEndpoint?.trim() || current.ollamaEndpoint || 'http://localhost:11434';
  const normalizedOllamaModel =
    update.ollamaModel?.trim() || current.ollamaModel || 'llama3';

  const next: SettingsRecord = {
    ...current,
    ...update,
    selectedProvider,
    apiKey: resolvedApiKey ?? '',
    apiKeys: mergedApiKeys,
    ollamaEndpoint: normalizedOllamaEndpoint,
    ollamaModel: normalizedOllamaModel,
    featureFlags: {
      ...current.featureFlags,
      ...update.featureFlags,
    },
    updatedAt: Date.now(),
  };

  await db.settings.put(next);
  return next;
}

export function getProviderApiKey(
  settings: SettingsRecord,
  provider: AIProvider,
): string {
  return settings.apiKeys[provider] ?? (settings.selectedProvider === provider ? settings.apiKey : '');
}
