import { useState, useEffect } from 'react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import i18n from '../../i18n';
import { SUPPORTED_LANGUAGES } from '../../i18n';
import type { SupportedLanguage } from '../../i18n';
import type { SettingsValues } from './SettingsPage';
import { defaultSettings } from './SettingsPage';

/**
 * Single source of truth for the UI language is the `language` key of the
 * VS Code webview state, read by the i18n module at boot and rewritten on
 * every `languageChanged` event. The settings blob persisted through
 * `settings:update` also carries a `language` field, but it is only a
 * trailing copy written on save — it is NEVER applied back to i18n.
 * At mount the local state mirrors the live i18n language (one-way sync:
 * settings ← webview-state), which eliminates the silent divergence where
 * a stale blob showed one language while the UI rendered another.
 */
function resolveBootLanguage(fallback: SupportedLanguage): SupportedLanguage {
  const current = i18n.language;
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(current)
    ? (current as SupportedLanguage)
    : fallback;
}

/** AI status response shape. */
interface AIStatusResponse {
  enabled: boolean;
  provider: string;
  model: string;
}

/** Telemetry status response shape (SettingsHandler.handleTelemetryStatus). */
interface TelemetryStatusResponse {
  enabled: boolean;
  eventCount: number;
  bufferSize: number;
}

/** Telemetry toggle response shape (SettingsHandler.handleTelemetryToggle). */
interface TelemetryToggleResponse {
  success: boolean;
  enabled: boolean;
  error?: string;
}

/**
 * Short timeout for the telemetry status probe: the Settings tab must fall
 * back to the honest "unavailable" state quickly when the extension does
 * not answer (older backend), instead of spinning for the 30 s default.
 */
const TELEMETRY_STATUS_TIMEOUT_MS = 5_000;

/** Return type for the settings page data hook. */
export interface SettingsPageData {
  /** Current settings state. */
  settings: SettingsValues;
  /** Update a single setting key. */
  updateSetting: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void;
  /** Save current settings to the extension. */
  handleSave: () => void;
  /** Reset settings to defaults. */
  handleReset: () => void;
  /** Whether settings mutation is in flight. */
  saving: boolean;
  /** AI status data (enabled, provider, model). */
  aiStatus: AIStatusResponse | undefined;
  /** AI status loading state. */
  aiStatusLoading: boolean;
  /** AI API key input value. */
  aiApiKey: string;
  /** Set the AI API key input. */
  setAiApiKey: (key: string) => void;
  /** Whether the AI key was recently saved successfully. */
  aiKeySaved: boolean;
  /** Set the AI key saved state. */
  setAiKeySaved: (saved: boolean) => void;
  /** Save an AI API key. */
  saveAiKey: (apiKey: string) => void;
  /** Whether the AI key save is in flight. */
  aiKeySaving: boolean;
  /** AI key save error, if any. */
  aiKeyError: string | null;
  /** Real telemetry status from the extension, null while unknown. */
  telemetryStatus: TelemetryStatusResponse | null;
  /** Whether the telemetry status query is in flight. */
  telemetryStatusLoading: boolean;
  /** True when the extension did not answer the telemetry status probe. */
  telemetryUnavailable: boolean;
  /** Toggle telemetry on/off (persists `sandforge.telemetry`). */
  toggleTelemetry: () => void;
  /** Whether the telemetry toggle mutation is in flight. */
  telemetryToggling: boolean;
  /** Telemetry toggle error (bridge error or backend refusal), if any. */
  telemetryToggleError: string | null;
}

/**
 * Encapsulates all data-fetching and mutation logic for the Settings page.
 * Separates data concerns from rendering.
 */
export function useSettingsPageData(
  initialSettings?: SettingsValues,
  onSave?: (settings: SettingsValues) => void,
  onReset?: () => void,
): SettingsPageData {
  const [settings, setSettings] = useState<SettingsValues>(() => {
    if (initialSettings) return initialSettings;
    return { ...defaultSettings, language: resolveBootLanguage(defaultSettings.language) };
  });

  /** Bridge query: load current settings from extension. */
  const settingsQuery = useBridgeQuery<{ settings: SettingsValues }>('settings:get', undefined, {
    responseType: 'settings:response',
    skip: !!initialSettings,
  });

  /** Bridge mutation: save settings to extension. */
  const settingsUpdateMutation = useBridgeMutation<{ success: boolean }>('settings:update', {
    responseType: 'settings:response',
  });

  /** AI status query. */
  const aiStatusQuery = useBridgeQuery<AIStatusResponse>('ai:status', undefined, {
    responseType: 'ai:status:response',
  });

  /** AI save key mutation. */
  const aiSaveKeyMutation = useBridgeMutation<{ success: boolean; error?: string }>('ai:save-key', {
    responseType: 'ai:save-key:response',
  });

  /** Telemetry status query: real opt-in state + emitted event count. */
  const telemetryStatusQuery = useBridgeQuery<TelemetryStatusResponse>(
    'telemetry:status',
    undefined,
    { timeoutMs: TELEMETRY_STATUS_TIMEOUT_MS },
  );

  /** Telemetry toggle mutation: persists `sandforge.telemetry` globally. */
  const telemetryToggleMutation = useBridgeMutation<TelemetryToggleResponse>('telemetry:toggle');

  const [aiApiKey, setAiApiKey] = useState('');
  const [aiKeySaved, setAiKeySaved] = useState(false);

  /** When AI key is saved, refresh status. */
  useEffect(() => {
    if (aiSaveKeyMutation.data?.success) {
      setAiKeySaved(true);
      setAiApiKey('');
      aiStatusQuery.refetch();
    }
  }, [aiSaveKeyMutation.data]); // eslint-disable-line react-hooks/exhaustive-deps

  /** When settings are loaded from extension, update local state. */
  useEffect(() => {
    const loaded = settingsQuery.data?.settings;
    if (!loaded) return;
    // Whitelist known keys only: blobs persisted by older versions may still
    // carry fields that nothing reads anymore (theme, batch sizes, thresholds).
    // Picking known keys avoids re-persisting those zombie fields on next save.
    const known: Partial<SettingsValues> = {};
    for (const key of Object.keys(defaultSettings) as (keyof SettingsValues)[]) {
      // `language` is deliberately NOT read back from the blob: the webview
      // state is the single source of truth (see resolveBootLanguage), so a
      // stale blob value must not overwrite the live i18n language here.
      if (key === 'language') continue;
      if (key in loaded && typeof loaded[key] === typeof defaultSettings[key]) {
        (known as Record<string, unknown>)[key] = loaded[key];
      }
    }
    setSettings((prev) => ({ ...prev, ...known }));
  }, [settingsQuery.data]);

  /**
   * After a successful toggle, refresh the status so the UI shows the value
   * actually persisted by the extension (and the latest event count).
   */
  useEffect(() => {
    if (telemetryToggleMutation.data?.success) {
      telemetryStatusQuery.refetch();
    }
  }, [telemetryToggleMutation.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateSetting = <K extends keyof SettingsValues>(
    key: K,
    value: SettingsValues[K],
  ): void => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = (): void => {
    settingsUpdateMutation.mutate({
      key: 'settings',
      value: settings as unknown as Record<string, unknown>,
    });
    onSave?.(settings);
  };

  const handleReset = (): void => {
    setSettings(defaultSettings);
    onReset?.();
  };

  const saveAiKey = (apiKey: string): void => {
    aiSaveKeyMutation.mutate({ apiKey });
  };

  const toggleTelemetry = (): void => {
    telemetryToggleMutation.mutate({ enabled: !(telemetryStatusQuery.data?.enabled ?? false) });
  };

  return {
    settings,
    updateSetting,
    handleSave,
    handleReset,
    saving: settingsUpdateMutation.loading,
    aiStatus: aiStatusQuery.data ?? undefined,
    aiStatusLoading: aiStatusQuery.loading,
    aiApiKey,
    setAiApiKey,
    aiKeySaved,
    setAiKeySaved,
    saveAiKey,
    aiKeySaving: aiSaveKeyMutation.loading,
    aiKeyError: aiSaveKeyMutation.error,
    telemetryStatus: telemetryStatusQuery.data,
    telemetryStatusLoading: telemetryStatusQuery.loading,
    telemetryUnavailable: telemetryStatusQuery.error != null,
    toggleTelemetry,
    telemetryToggling: telemetryToggleMutation.loading,
    telemetryToggleError:
      telemetryToggleMutation.error ??
      (telemetryToggleMutation.data && !telemetryToggleMutation.data.success
        ? (telemetryToggleMutation.data.error ?? null)
        : null),
  };
}
