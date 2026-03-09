import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { AI_PROVIDERS, PROVIDER_LABELS } from '../constants/providers';
import { PREMIUM_PLACEHOLDER_URL } from '../constants/premium';
import { STARTER_PROMPT_PRESETS } from '../constants/prompt-presets';
import { SETTINGS_RECORD_ID, saveSettings } from '../db/settings';
import { db } from '../db';
import { signInWithGoogle, signOut, syncPremiumEntitlement } from '../services/auth';
import { runProviderHealthCheck, type ProviderHealthResult } from '../services/provider-health';
import type {
  AIProvider,
  CustomPromptProfile,
  FeatureFlags,
  SettingsRecord,
  ThemeMode,
} from '../types/domain';
import { createId } from '../utils/id';

const CLOUD_PROVIDERS: AIProvider[] = ['gemini', 'openai', 'anthropic'];

function hasSettingsLoaded(value: SettingsRecord | undefined): value is SettingsRecord {
  return Boolean(value);
}

export function SettingsView() {
  const settings = useLiveQuery(() => db.settings.get(SETTINGS_RECORD_ID), []);
  const [draft, setDraft] = useState<SettingsRecord | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isAuthPending, setIsAuthPending] = useState(false);
  const [isHealthCheckPending, setIsHealthCheckPending] = useState(false);
  const [healthCheckResult, setHealthCheckResult] = useState<ProviderHealthResult | null>(null);
  const [accountEmailDraft, setAccountEmailDraft] = useState('');

  useEffect(() => {
    if (hasSettingsLoaded(settings)) {
      setDraft(settings);
      setAccountEmailDraft(settings.user?.email ?? '');
    }
  }, [settings]);

  if (!draft) {
    return (
      <section className="panel-stack">
        <div className="panel-card">
          <h2 className="section-title">Settings</h2>
          <p className="section-copy">Loading local settings...</p>
        </div>
      </section>
    );
  }

  const updateProviderKey = (provider: AIProvider, value: string) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            apiKeys: {
              ...current.apiKeys,
              [provider]: value,
            },
            apiKey: provider === current.selectedProvider ? value : current.apiKey,
          }
        : current,
    );
  };

  const selectProvider = (provider: AIProvider) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            selectedProvider: provider,
            apiKey: current.apiKeys[provider] ?? '',
          }
        : current,
    );
  };

  const selectTheme = (theme: ThemeMode) => {
    setDraft((current) => (current ? { ...current, theme } : current));
  };

  const updateFeatureFlag = (flag: keyof FeatureFlags, checked: boolean) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            featureFlags: {
              ...current.featureFlags,
              [flag]: checked,
            },
          }
        : current,
    );
  };

  const addCustomPrompt = () => {
    setDraft((current) =>
      current
        ? {
            ...current,
            customPrompts: [
              ...current.customPrompts,
              {
                id: createId(),
                label: 'New Prompt',
                systemInstruction: 'Describe the exact extraction rule, format, and output style here.',
              },
            ],
          }
        : current,
    );
  };

  const updateCustomPrompt = (
    promptId: string,
    field: keyof Pick<CustomPromptProfile, 'label' | 'systemInstruction'>,
    value: string,
  ) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            customPrompts: current.customPrompts.map((prompt) =>
              prompt.id === promptId
                ? {
                    ...prompt,
                    [field]: value,
                  }
                : prompt,
            ),
          }
        : current,
    );
  };

  const deleteCustomPrompt = (promptId: string) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            customPrompts: current.customPrompts.filter((prompt) => prompt.id !== promptId),
          }
        : current,
    );
  };

  const addPromptPreset = (label: string, systemInstruction: string) => {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const duplicate = current.customPrompts.some(
        (prompt) =>
          prompt.label.trim().toLowerCase() === label.trim().toLowerCase() &&
          prompt.systemInstruction.trim() === systemInstruction.trim(),
      );

      if (duplicate) {
        return current;
      }

      return {
        ...current,
        customPrompts: [
          ...current.customPrompts,
          {
            id: createId(),
            label,
            systemInstruction,
          },
        ],
      };
    });
  };

  const handleSave = async () => {
    if (!draft) {
      return;
    }

    setIsSaving(true);
    setStatus(null);

    try {
      await saveSettings({
        selectedProvider: draft.selectedProvider,
        apiKey: draft.apiKeys[draft.selectedProvider] ?? '',
        apiKeys: draft.apiKeys,
        ollamaEndpoint: draft.ollamaEndpoint,
        ollamaModel: draft.ollamaModel,
        theme: draft.theme,
        featureFlags: draft.featureFlags,
        customPrompts: draft.customPrompts
          .map((prompt) => ({
            ...prompt,
            label: prompt.label.trim(),
            systemInstruction: prompt.systemInstruction.trim(),
          }))
          .filter((prompt) => prompt.label && prompt.systemInstruction),
      });
      setStatus('Settings saved locally to the extension database.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to save settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const openPremiumPortal = () => {
    window.open(PREMIUM_PLACEHOLDER_URL, '_blank', 'noopener,noreferrer');
  };

  const handleProviderHealthCheck = async () => {
    setIsHealthCheckPending(true);
    setHealthCheckResult(null);
    setStatus(null);

    try {
      const result = await runProviderHealthCheck(draft.selectedProvider);
      setHealthCheckResult(result);
      setStatus(
        result.ok
          ? `${PROVIDER_LABELS[result.provider]} is reachable in ${result.latencyMs} ms.`
          : result.detail,
      );
    } finally {
      setIsHealthCheckPending(false);
    }
  };

  const hasProviderConfigured =
    draft.selectedProvider === 'ollama'
      ? Boolean(draft.ollamaEndpoint.trim() && draft.ollamaModel.trim())
      : Boolean(draft.apiKeys[draft.selectedProvider]?.trim());

  const handleSignIn = async () => {
    setIsAuthPending(true);
    setStatus(null);

    try {
      const signedInSettings = await signInWithGoogle(accountEmailDraft);
      const syncedSettings = await syncPremiumEntitlement();
      setDraft(syncedSettings);
      setAccountEmailDraft(signedInSettings.user?.email ?? '');
      setStatus(`Signed in as ${signedInSettings.user?.email ?? 'local user'}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Sign-in failed.');
    } finally {
      setIsAuthPending(false);
    }
  };

  const handleSignOut = async () => {
    setIsAuthPending(true);
    setStatus(null);

    try {
      const nextSettings = await signOut();
      setDraft(nextSettings);
      setAccountEmailDraft('');
      setStatus('Signed out. Premium features are locked until a user signs back in.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Sign-out failed.');
    } finally {
      setIsAuthPending(false);
    }
  };

  const handleSyncPremium = async () => {
    setIsAuthPending(true);
    setStatus(null);

    try {
      const nextSettings = await syncPremiumEntitlement();
      setDraft(nextSettings);
      setStatus(
        nextSettings.isPremium
          ? 'Premium entitlement synced.'
          : 'No premium entitlement is linked yet. Upgrade flow is still a placeholder.',
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to sync premium entitlement.');
    } finally {
      setIsAuthPending(false);
    }
  };

  return (
    <section className="panel-stack">
      <div className="panel-card">
        <div className="section-header">
          <div>
            <h2 className="section-title">Launch Checklist</h2>
            <p className="section-copy">
              The fastest path to a stable paid product is to keep the operational state visible.
            </p>
          </div>
          <span className="status-chip status-chip--quiet">V3</span>
        </div>

        <div className="toggle-grid">
          <div className="toggle-row">
            <div className="check-copy">
              <span className="field-label">Provider configured</span>
              <span className="section-copy">
                {draft.selectedProvider === 'ollama'
                  ? 'Ollama endpoint and model are set.'
                  : `${PROVIDER_LABELS[draft.selectedProvider]} key is stored locally.`}
              </span>
            </div>
            <span className="status-chip">{hasProviderConfigured ? 'Ready' : 'Missing'}</span>
          </div>

          <div className="toggle-row">
            <div className="check-copy">
              <span className="field-label">Active-video sync</span>
              <span className="section-copy">
                Automatic transcript sync can be disabled if YouTube changes or the watch page becomes unstable.
              </span>
            </div>
            <span className="status-chip">
              {draft.featureFlags.autoSyncActiveVideo ? 'Enabled' : 'Manual only'}
            </span>
          </div>

          <div className="toggle-row">
            <div className="check-copy">
              <span className="field-label">Account state</span>
              <span className="section-copy">
                Required for future sync and Lemon Squeezy-based premium entitlements.
              </span>
            </div>
            <span className="status-chip">{draft.user ? 'Connected' : 'Local only'}</span>
          </div>
        </div>
      </div>

      <div className="panel-card">
        <div className="section-header">
          <div>
            <h2 className="section-title">Account & Sync</h2>
            <p className="section-copy">
              Identity is the bridge between your local extension, future cloud sync,
              and the managed premium tier. This is the local placeholder until real OAuth
              and Lemon Squeezy entitlement sync land.
            </p>
          </div>
          <span className="status-chip">{draft.user ? 'Signed In' : 'Signed Out'}</span>
        </div>

        {draft.user ? (
          <div className="form-stack">
            <div className="meta-card">
              <span className="meta-label">Connected account</span>
              <span className="meta-value">{draft.user.email}</span>
            </div>

            <div className="hero-actions">
              <button
                className="primary-button"
                disabled={isAuthPending}
                onClick={handleSyncPremium}
                type="button"
              >
                {isAuthPending ? 'Syncing...' : 'Sync Premium Entitlement'}
              </button>
              <button
                className="primary-button primary-button--ghost"
                onClick={openPremiumPortal}
                type="button"
              >
                {draft.isPremium ? 'Manage Premium' : 'Upgrade to Premium Managed'}
              </button>
              <button
                className="queue-action-button"
                disabled={isAuthPending}
                onClick={handleSignOut}
                type="button"
              >
                Sign Out
              </button>
            </div>
          </div>
        ) : (
          <div className="form-stack">
            <p className="section-copy">
              Sign in to attach future Lemon Squeezy subscriptions, sync saved workspaces across devices,
              and unlock premium batch workflows once billing is live.
            </p>

            <label className="field">
              <span className="field-label">Google account email</span>
              <input
                autoComplete="email"
                className="text-input"
                onChange={(event) => setAccountEmailDraft(event.target.value)}
                placeholder="you@example.com"
                type="email"
                value={accountEmailDraft}
              />
            </label>

            <div className="hero-actions">
              <button
                className="primary-button"
                disabled={isAuthPending}
                onClick={handleSignIn}
                type="button"
              >
                {isAuthPending ? 'Signing In...' : 'Sign in with Google Placeholder'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="panel-card">
        <div className="section-header">
          <div>
            <h2 className="section-title">Bring Your Own Model Key</h2>
            <p className="section-copy">
              Keys stay local to this extension. Briefly only sends them to the provider
              you explicitly choose when you run the copilot.
            </p>
          </div>
          <span className="status-chip status-chip--quiet">
            {draft.selectedProvider === 'ollama' ? 'Local-only' : 'BYO Key'}
          </span>
        </div>

        <div className="segmented-control">
          {AI_PROVIDERS.map((provider) => (
            <button
              key={provider}
              className={`segment-button ${draft.selectedProvider === provider ? 'segment-button--active' : ''}`}
              onClick={() => selectProvider(provider)}
              type="button"
            >
              {PROVIDER_LABELS[provider]}
            </button>
          ))}
        </div>

        <div className="form-stack">
          {CLOUD_PROVIDERS.map((provider) => (
            <label key={provider} className="field">
              <span className="field-label">{PROVIDER_LABELS[provider]} API key</span>
              <input
                autoComplete="off"
                className="text-input"
                onChange={(event) => updateProviderKey(provider, event.target.value)}
                placeholder={`Paste your ${PROVIDER_LABELS[provider]} key`}
                type="password"
                value={draft.apiKeys[provider] ?? ''}
              />
            </label>
          ))}

          {draft.selectedProvider === 'ollama' ? (
            <>
              <label className="field">
                <span className="field-label">Ollama Endpoint</span>
                <input
                  autoComplete="off"
                  className="text-input"
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            ollamaEndpoint: event.target.value,
                          }
                        : current,
                    )
                  }
                  placeholder="http://localhost:11434"
                  type="url"
                  value={draft.ollamaEndpoint}
                />
              </label>

              <label className="field">
                <span className="field-label">Ollama Model</span>
                <input
                  autoComplete="off"
                  className="text-input"
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            ollamaModel: event.target.value,
                          }
                        : current,
                    )
                  }
                  placeholder="llama3"
                  type="text"
                  value={draft.ollamaModel}
                />
              </label>
            </>
          ) : (
            <p className="section-copy">
              Select Ollama to run a local model over `http://localhost:11434` without a cloud API key.
            </p>
          )}

          <div className="status-callout">
            <div>
              <span className="field-label">Provider Health Check</span>
              <p className="section-copy">
                Sends one tiny live request with the selected provider so you can verify
                the key, endpoint, and model before using the copilot.
              </p>
            </div>
            <button
              className="queue-action-button"
              disabled={isHealthCheckPending}
              onClick={handleProviderHealthCheck}
              type="button"
            >
              {isHealthCheckPending ? 'Checking...' : 'Test Provider'}
            </button>
          </div>

          {healthCheckResult ? (
            <p className={`inline-status ${healthCheckResult.ok ? '' : 'inline-status--error'}`}>
              {healthCheckResult.ok
                ? `${PROVIDER_LABELS[healthCheckResult.provider]} responded via ${healthCheckResult.model ?? 'default model'} in ${healthCheckResult.latencyMs} ms.`
                : healthCheckResult.detail}
            </p>
          ) : null}
        </div>
      </div>

      <div className="panel-card">
        <h2 className="section-title">Workspace Theme</h2>
        <p className="section-copy">
          Theme is stored alongside your provider settings so the side panel stays
          consistent across sessions.
        </p>

        <div className="segmented-control">
          {(['dark', 'light', 'system'] as ThemeMode[]).map((theme) => (
            <button
              key={theme}
              className={`segment-button ${draft.theme === theme ? 'segment-button--active' : ''}`}
              onClick={() => selectTheme(theme)}
              type="button"
            >
              {theme}
            </button>
          ))}
        </div>
      </div>

      <div className="panel-card">
        <div className="section-header">
          <div>
            <h2 className="section-title">Operational Controls</h2>
            <p className="section-copy">
              These switches exist so risky YouTube-facing surfaces can be disabled immediately
              without shipping emergency code changes.
            </p>
          </div>
          <span className="status-chip status-chip--quiet">Kill Switches</span>
        </div>

        <div className="toggle-grid">
          <label className="toggle-row">
            <input
              checked={draft.featureFlags.enableThumbnailInjection}
              className="check-input"
              onChange={(event) =>
                updateFeatureFlag('enableThumbnailInjection', event.target.checked)
              }
              type="checkbox"
            />
            <div className="check-copy">
              <span className="field-label">Enable thumbnail queue buttons</span>
              <span className="section-copy">
                Turns Home/Search thumbnail injection on or off.
              </span>
            </div>
          </label>

          <label className="toggle-row">
            <input
              checked={draft.featureFlags.enablePlaylistIngestion}
              className="check-input"
              onChange={(event) =>
                updateFeatureFlag('enablePlaylistIngestion', event.target.checked)
              }
              type="checkbox"
            />
            <div className="check-copy">
              <span className="field-label">Enable playlist queue controls</span>
              <span className="section-copy">
                Controls playlist header actions separately from general thumbnail injection.
              </span>
            </div>
          </label>

          <label className="toggle-row">
            <input
              checked={draft.featureFlags.autoSyncActiveVideo}
              className="check-input"
              onChange={(event) =>
                updateFeatureFlag('autoSyncActiveVideo', event.target.checked)
              }
              type="checkbox"
            />
            <div className="check-copy">
              <span className="field-label">Auto-sync active watch page</span>
              <span className="section-copy">
                When off, active-video transcript sync becomes manual through the refresh button.
              </span>
            </div>
          </label>

          <label className="toggle-row">
            <input
              checked={draft.featureFlags.enableTelemetry}
              className="check-input"
              onChange={(event) =>
                updateFeatureFlag('enableTelemetry', event.target.checked)
              }
              type="checkbox"
            />
            <div className="check-copy">
              <span className="field-label">Enable telemetry events</span>
              <span className="section-copy">
                Keeps analytics instrumentation active for future PostHog wiring.
              </span>
            </div>
          </label>
        </div>
      </div>

      <div className="panel-card">
        <div className="section-header">
          <div>
            <h2 className="section-title">Custom Prompt Profiles</h2>
            <p className="section-copy">
              Save reusable extraction rules for niche workflows like financial metrics,
              due diligence notes, or social-post formatting.
            </p>
          </div>
          <button
            className="queue-action-button"
            onClick={addCustomPrompt}
            type="button"
          >
            Add Prompt
          </button>
        </div>

        <div className="tag-row">
          {STARTER_PROMPT_PRESETS.map((preset) => (
            <button
              key={preset.label}
              className="queue-action-button"
              onClick={() => addPromptPreset(preset.label, preset.systemInstruction)}
              type="button"
            >
              Use {preset.label}
            </button>
          ))}
        </div>

        <div className="form-stack">
          {draft.customPrompts.length ? (
            draft.customPrompts.map((prompt) => (
              <div className="prompt-card" key={prompt.id}>
                <label className="field">
                  <span className="field-label">Prompt Label</span>
                  <input
                    className="text-input"
                    onChange={(event) => updateCustomPrompt(prompt.id, 'label', event.target.value)}
                    placeholder="Financial Metrics"
                    type="text"
                    value={prompt.label}
                  />
                </label>

                <label className="field">
                  <span className="field-label">System Instruction</span>
                  <textarea
                    className="composer-input prompt-editor"
                    onChange={(event) =>
                      updateCustomPrompt(prompt.id, 'systemInstruction', event.target.value)
                    }
                    placeholder="Extract only revenue, growth, margin, and guidance figures. Return bullets grouped by metric."
                    rows={5}
                    value={prompt.systemInstruction}
                  />
                </label>

                <div className="prompt-card__footer">
                  <span className="section-copy">
                    {draft.selectedProvider === 'ollama'
                      ? 'Runs fully local through Ollama.'
                      : 'Runs with your selected provider and your locally stored key.'}
                  </span>
                  <button
                    className="queue-action-button"
                    onClick={() => deleteCustomPrompt(prompt.id)}
                    type="button"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-thread">
              <p className="section-copy">
                No custom prompts saved yet. Add one to turn Briefly into a reusable
                research workflow tool instead of a fixed summarizer.
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="panel-card premium-card">
        <div className="section-header">
          <div>
            <h2 className="section-title">Managed Premium</h2>
            <p className="section-copy">
              Placeholder for the subscription tier: hosted keys, bigger context windows,
              team workspaces, and eventually server-side batch jobs.
            </p>
          </div>
          <span className="status-chip">{draft.isPremium ? 'Premium Active' : 'Free Tier'}</span>
        </div>

        <button
          className="primary-button primary-button--ghost"
          onClick={openPremiumPortal}
          type="button"
        >
          {draft.isPremium ? 'Manage Premium' : 'Upgrade with Lemon Squeezy'}
        </button>
      </div>

      <div className="footer-row">
        <button
          className="primary-button"
          disabled={isSaving}
          onClick={handleSave}
          type="button"
        >
          {isSaving ? 'Saving...' : 'Save Settings'}
        </button>
        {status ? <p className="inline-status">{status}</p> : null}
      </div>
    </section>
  );
}
