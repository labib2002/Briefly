import type { AIProvider } from '../types/domain';

export const AI_PROVIDERS: AIProvider[] = ['gemini', 'openai', 'anthropic', 'ollama'];

export const PROVIDER_LABELS: Record<AIProvider, string> = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
};

export const DEFAULT_PROVIDER_MODELS: Record<AIProvider, string> = {
  gemini: 'gemini-3.5-flash',
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-5',
  ollama: 'llama3',
};
