import { getSettings, saveSettings } from '../db/settings';
import { createId } from '../utils/id';

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export async function signInWithGoogle(email: string) {
  const settings = await getSettings();
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail.includes('@')) {
    throw new Error('Enter a valid email address to continue.');
  }

  return saveSettings({
    user: {
      id: settings.user?.id ?? createId(),
      email: normalizedEmail,
    },
  });
}

export async function signOut() {
  return saveSettings({
    user: undefined,
    isPremium: false,
  });
}

export async function syncPremiumEntitlement() {
  const settings = await getSettings();

  if (!settings.user) {
    return saveSettings({
      isPremium: false,
    });
  }

  return settings;
}
