export type AIProvider = 'openai' | 'anthropic' | 'gemini' | 'ollama';
export type DefaultSummaryMode =
  | 'tldr'
  | 'action-items'
  | 'timestamped-highlights'
  | 'study-notes'
  | 'due-diligence'
  | 'thread-draft'
  | 'creator-research';
export type SummaryMode = DefaultSummaryMode | `custom:${string}`;
export type ThemeMode = 'dark' | 'light' | 'system';
export type MessageRole = 'system' | 'user' | 'assistant';
export type CustomPromptProfile = {
  id: string;
  label: string;
  systemInstruction: string;
};

export type AuthenticatedUser = {
  id: string;
  email: string;
};

export type FeatureFlags = {
  enableThumbnailInjection: boolean;
  enablePlaylistIngestion: boolean;
  autoSyncActiveVideo: boolean;
  enableTelemetry: boolean;
};

export type TranscriptSegment = {
  text: string;
  start_time: number;
  duration: number;
};

export type TranscriptMetadata = {
  source:
    | 'youtube-watch-page'
    | 'youtube-player-endpoint'
    | 'youtube-embed-page'
    | 'youtube-dom-scrape'
    | 'youtubei.js';
  language?: string;
  fetchedAt: number;
  title?: string;
  channel?: string;
};

export type VideoRecord = {
  id: string;
  url: string;
  title: string;
  channel: string;
  createdAt: number;
  updatedAt: number;
};

export type TranscriptRecord = {
  videoId: string;
  segments: TranscriptSegment[];
  metadata: TranscriptMetadata;
};

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  provider?: AIProvider;
};

export type WorkspaceRecord = {
  id: string;
  primaryVideoId?: string;
  videoIds: string[];
  messages: ChatMessage[];
  summaryMode: SummaryMode;
  name?: string;
  notes: string;
  tags: string[];
  isPinned: boolean;
  createdAt: number;
  updatedAt: number;
};

export type SettingsRecord = {
  id: string;
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
  updatedAt: number;
};
