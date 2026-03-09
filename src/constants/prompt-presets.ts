import type { CustomPromptProfile } from '../types/domain';

export type PromptPreset = Omit<CustomPromptProfile, 'id'>;

export const STARTER_PROMPT_PRESETS: PromptPreset[] = [
  {
    label: 'Financial Metrics',
    systemInstruction:
      'Extract only financial metrics, forward-looking guidance, unit economics, margins, growth rates, and notable quantitative claims. Return concise bullets grouped by metric and call out any uncertainty.',
  },
  {
    label: 'Twitter Thread',
    systemInstruction:
      'Rewrite the core ideas as a clean Twitter/X thread. Keep each post concise, preserve the speaker’s strongest claims, and end with a final post that captures the main conclusion.',
  },
  {
    label: 'Competitive Research',
    systemInstruction:
      'Summarize this video for competitor research. Extract positioning, product claims, pricing cues, go-to-market signals, strategic risks, and anything that implies market direction.',
  },
  {
    label: 'Study Guide',
    systemInstruction:
      'Turn the video into a study guide with key concepts, definitions, likely quiz questions, and a short review checklist at the end.',
  },
];
