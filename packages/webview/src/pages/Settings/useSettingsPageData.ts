import { useState, useEffect } from 'react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import type { SettingsValues } from './SettingsPage';
import { defaultSettings } from './SettingsPage';

/** AI status response shape. */
interface AIStatusResponse {
  enabled: boolean;
  provider: string;
  model: string;
}

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
  const [settings, setSettings] = useState<SettingsValues>(initialSettings ?? defaultSettings);

  /** Bridge query: load current settings from extension. */
  const settingsQuery = useBridgeQuery<{ settings: SettingsValues }>(
    'settings:get',
    undefined,
    {
      responseType: 'settings:response',
      skip: !!initialSettings,
    },
  );

  /** Bridge mutation: save settings to extension. */
  const settingsUpdateMutation = useBridgeMutation<{ success: boolean }>(
    'settings:update',
    { responseType: 'settings:updated' },
  );

  /** AI status query. */
  const aiStatusQuery = useBridgeQuery<AIStatusResponse>(
    'ai:status',
    undefined,
    { responseType: 'ai:status:response' },
  );

  /** AI save key mutation. */
  const aiSaveKeyMutation = useBridgeMutation<{ success: boolean; error?: string }>(
    'ai:save-key',
    { responseType: 'ai:save-key:response' },
  );

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
    if (settingsQuery.data?.settings) {
      setSettings(settingsQuery.data.settings);
    }
  }, [settingsQuery.data]);

  const updateSetting = <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]): void => {
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
  };
}
