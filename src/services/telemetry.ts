import { getSettings } from '../db/settings';

export type TelemetryProperties = Record<string, unknown>;

const TELEMETRY_ENDPOINT = '';
const isDevelopment = Boolean(
  (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV,
);

async function isTelemetryEnabled(): Promise<boolean> {
  try {
    const settings = await getSettings();
    return settings.featureFlags.enableTelemetry;
  } catch {
    return true;
  }
}

function buildPayload(eventName: string, properties: TelemetryProperties = {}) {
  return {
    event: eventName,
    properties,
    timestamp: new Date().toISOString(),
  };
}

export async function trackEvent(
  eventName: string,
  properties: TelemetryProperties = {},
): Promise<void> {
  if (!(await isTelemetryEnabled())) {
    return;
  }

  const payload = buildPayload(eventName, properties);

  if (isDevelopment) {
    console.log('[briefly telemetry]', payload);
  }

  if (!TELEMETRY_ENDPOINT) {
    return;
  }

  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (isDevelopment) {
      console.warn('[briefly telemetry] failed to send', error);
    }
  }
}
