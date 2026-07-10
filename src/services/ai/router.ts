import { DEFAULT_PROVIDER_MODELS } from '../../constants/providers';
import { getProviderApiKey, getSettings } from '../../db/settings';
import type { AIProvider } from '../../types/domain';

export type LLMMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type GenerateTextInput = {
  provider?: AIProvider;
  model?: string;
  messages: LLMMessage[];
  temperature?: number;
  maxOutputTokens?: number;
};

export type GenerateTextResult = {
  provider: AIProvider;
  model: string;
  text: string;
};

function compact<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
}

function getMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (typeof item === 'object' && item !== null && 'text' in item) {
          return String((item as { text?: string }).text ?? '');
        }

        return '';
      })
      .join('\n')
      .trim();
  }

  return '';
}

async function parseProviderError(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    return JSON.stringify(payload);
  } catch {
    return response.statusText || 'Unknown provider error';
  }
}

async function generateWithOpenAI(
  apiKey: string,
  input: GenerateTextInput,
): Promise<GenerateTextResult> {
  const model = input.model ?? DEFAULT_PROVIDER_MODELS.openai;
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      compact({
        model,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        max_completion_tokens: input.maxOutputTokens,
      }),
    ),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${await parseProviderError(response)}`);
  }

  const payload = await response.json();
  const text = getMessageText(payload.choices?.[0]?.message?.content);

  if (!text) {
    throw new Error('OpenAI returned an empty response.');
  }

  return {
    provider: 'openai',
    model,
    text,
  };
}

async function generateWithAnthropic(
  apiKey: string,
  input: GenerateTextInput,
): Promise<GenerateTextResult> {
  const model = input.model ?? DEFAULT_PROVIDER_MODELS.anthropic;
  const systemPrompt = input.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const messages = input.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    }));

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(
      compact({
        model,
        max_tokens: input.maxOutputTokens ?? 2048,
        messages,
        system: systemPrompt || undefined,
        // Claude Sonnet 5 rejects non-default sampling parameters (temperature/top_p/top_k),
        // so the Anthropic request intentionally omits them.
      }),
    ),
  });

  if (!response.ok) {
    throw new Error(`Anthropic request failed: ${await parseProviderError(response)}`);
  }

  const payload = await response.json();
  const text = getMessageText(payload.content);

  if (!text) {
    throw new Error('Anthropic returned an empty response.');
  }

  return {
    provider: 'anthropic',
    model,
    text,
  };
}

async function generateWithGemini(
  apiKey: string,
  input: GenerateTextInput,
): Promise<GenerateTextResult> {
  const model = input.model ?? DEFAULT_PROVIDER_MODELS.gemini;
  const systemPrompt = input.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const contents = input.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(
        compact({
          system_instruction: systemPrompt
            ? {
                parts: [{ text: systemPrompt }],
              }
            : undefined,
          contents,
          generationConfig: compact({
            temperature: input.temperature ?? 0.2,
            maxOutputTokens: input.maxOutputTokens,
            thinkingConfig: {
              thinkingBudget: 0,
            },
          }),
        }),
      ),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${await parseProviderError(response)}`);
  }

  const payload = await response.json();
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const text = getMessageText(parts);

  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }

  return {
    provider: 'gemini',
    model,
    text,
  };
}

async function generateWithOllama(
  endpoint: string,
  modelName: string,
  input: GenerateTextInput,
): Promise<GenerateTextResult> {
  const normalizedEndpoint = endpoint.replace(/\/+$/, '');
  const model = input.model ?? modelName ?? DEFAULT_PROVIDER_MODELS.ollama;
  const response = await fetch(`${normalizedEndpoint}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      compact({
        model,
        messages: input.messages,
        stream: false,
        options: compact({
          temperature: input.temperature ?? 0.2,
          num_predict: input.maxOutputTokens,
        }),
      }),
    ),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${await parseProviderError(response)}`);
  }

  const payload = await response.json();
  const text = getMessageText(payload.message?.content);

  if (!text) {
    throw new Error('Ollama returned an empty response.');
  }

  return {
    provider: 'ollama',
    model,
    text,
  };
}

export async function generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
  const settings = await getSettings();
  const provider = input.provider ?? settings.selectedProvider;
  const apiKey = provider === 'ollama' ? '' : getProviderApiKey(settings, provider);

  if (provider !== 'ollama' && !apiKey) {
    throw new Error(`Missing API key for ${provider}. Add it in Settings before running the copilot.`);
  }

  switch (provider) {
    case 'openai':
      return generateWithOpenAI(apiKey, input);
    case 'anthropic':
      return generateWithAnthropic(apiKey, input);
    case 'gemini':
      return generateWithGemini(apiKey, input);
    case 'ollama':
      return generateWithOllama(settings.ollamaEndpoint, settings.ollamaModel, input);
    default:
      throw new Error(`Unsupported provider: ${provider satisfies never}`);
  }
}
