import { getProviderApiKey, getSettings } from '../db/settings';
import { trackEvent } from './telemetry';

const OPENAI_AUDIO_ENDPOINT = 'https://api.openai.com/v1/audio/speech';
const OPENAI_AUDIO_MODEL = 'gpt-4o-mini-tts';
const OPENAI_AUDIO_VOICE = 'coral';
const OPENAI_AUDIO_MAX_INPUT_CHARS = 4096;

export type PremiumAudioResult = {
  objectUrl: string;
  provider: 'openai';
  model: string;
  voice: string;
  inputChars: number;
};

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNarrationScript(text: string): string {
  const normalized = stripMarkdown(text);

  if (!normalized) {
    return '';
  }

  if (normalized.length <= OPENAI_AUDIO_MAX_INPUT_CHARS) {
    return normalized;
  }

  return normalized.slice(0, OPENAI_AUDIO_MAX_INPUT_CHARS - 1).trimEnd();
}

async function parseProviderError(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    return JSON.stringify(payload);
  } catch {
    return response.statusText || 'Unknown provider error';
  }
}

export async function generatePremiumAudioSummary(
  summaryText: string,
): Promise<PremiumAudioResult> {
  const settings = await getSettings();
  const apiKey = getProviderApiKey(settings, 'openai').trim();

  if (!apiKey) {
    throw new Error('Premium audio uses OpenAI TTS. Add an OpenAI API key in Settings first.');
  }

  const input = buildNarrationScript(summaryText);

  if (!input) {
    throw new Error('There is no usable summary text to turn into audio.');
  }

  const response = await fetch(OPENAI_AUDIO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_AUDIO_MODEL,
      voice: OPENAI_AUDIO_VOICE,
      input,
      instructions: 'Read this as a concise, polished research briefing.',
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI audio request failed: ${await parseProviderError(response)}`);
  }

  const audioBlob = await response.blob();

  if (!audioBlob.size) {
    throw new Error('OpenAI audio request returned an empty audio file.');
  }

  await trackEvent('premium_audio_generated', {
    provider: 'openai',
    model: OPENAI_AUDIO_MODEL,
    voice: OPENAI_AUDIO_VOICE,
    inputChars: input.length,
  });

  return {
    objectUrl: URL.createObjectURL(audioBlob),
    provider: 'openai',
    model: OPENAI_AUDIO_MODEL,
    voice: OPENAI_AUDIO_VOICE,
    inputChars: input.length,
  };
}
