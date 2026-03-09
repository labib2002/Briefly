import { PROVIDER_LABELS } from '../constants/providers';
import type { AIProvider } from '../types/domain';
import { generateText } from './ai/router';

export type ProviderHealthResult = {
  provider: AIProvider;
  ok: boolean;
  latencyMs: number;
  model?: string;
  detail: string;
};

export async function runProviderHealthCheck(
  provider: AIProvider,
): Promise<ProviderHealthResult> {
  const startedAt = performance.now();

  try {
    const result = await generateText({
      provider,
      messages: [
        {
          role: 'system',
          content: 'Respond with only the word OK.',
        },
        {
          role: 'user',
          content: `Run a provider health check for ${PROVIDER_LABELS[provider]}.`,
        },
      ],
      maxOutputTokens: 8,
      temperature: 0,
    });

    return {
      provider,
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
      model: result.model,
      detail: result.text.trim(),
    };
  } catch (error) {
    return {
      provider,
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      detail: error instanceof Error ? error.message : 'Provider health check failed.',
    };
  }
}
