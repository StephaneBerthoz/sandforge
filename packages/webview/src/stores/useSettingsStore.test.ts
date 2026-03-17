import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore, DEFAULT_SETTINGS } from './useSettingsStore';

function getState(): ReturnType<typeof useSettingsStore.getState> {
  return useSettingsStore.getState();
}

describe('useSettingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      isDirty: false,
      lastSaved: null,
    });
  });

  it('should have correct default settings', () => {
    const { settings } = getState();
    expect(settings.language).toBe('en');
    expect(settings.theme).toBe('auto');
    expect(settings.defaultBatchSize).toBe(200);
    expect(settings.maxConcurrentOps).toBe(3);
    expect(settings.enableNotifications).toBe(true);
    expect(settings.requireProdConfirmation).toBe(true);
  });

  it('should not be dirty initially', () => {
    expect(getState().isDirty).toBe(false);
  });

  it('should update a single setting', () => {
    getState().updateSetting('language', 'fr');
    expect(getState().settings.language).toBe('fr');
    expect(getState().isDirty).toBe(true);
  });

  it('should update multiple settings', () => {
    getState().updateSettings({ language: 'de', theme: 'dark' });
    expect(getState().settings.language).toBe('de');
    expect(getState().settings.theme).toBe('dark');
    expect(getState().isDirty).toBe(true);
  });

  it('should not affect other settings when updating', () => {
    getState().updateSetting('language', 'fr');
    expect(getState().settings.defaultBatchSize).toBe(200);
    expect(getState().settings.enableNotifications).toBe(true);
  });

  it('should reset to defaults', () => {
    getState().updateSettings({ language: 'ja', theme: 'dark', defaultBatchSize: 500 });
    getState().resetToDefaults();
    expect(getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(getState().isDirty).toBe(true);
  });

  it('should mark as saved', () => {
    getState().updateSetting('language', 'fr');
    getState().markSaved();
    expect(getState().isDirty).toBe(false);
    expect(getState().lastSaved).toBeDefined();
  });

  it('should load settings from external source', () => {
    getState().loadSettings({ language: 'es', defaultBatchSize: 100 });
    expect(getState().settings.language).toBe('es');
    expect(getState().settings.defaultBatchSize).toBe(100);
    expect(getState().isDirty).toBe(false);
  });

  it('should export settings as JSON', () => {
    const json = getState().exportSettings();
    const parsed = JSON.parse(json);
    expect(parsed.language).toBe('en');
    expect(parsed.theme).toBe('auto');
  });

  it('should import valid settings JSON', () => {
    const json = JSON.stringify({ language: 'pt-BR', defaultBatchSize: 300 });
    const result = getState().importSettings(json);
    expect(result).toBe(true);
    expect(getState().settings.language).toBe('pt-BR');
    expect(getState().settings.defaultBatchSize).toBe(300);
    expect(getState().isDirty).toBe(true);
  });

  it('should return false for invalid JSON on import', () => {
    const result = getState().importSettings('not json');
    expect(result).toBe(false);
  });

  it('should return false for non-object JSON on import', () => {
    const result = getState().importSettings('"just a string"');
    expect(result).toBe(false);
  });

  it('should ignore unknown keys on import', () => {
    const json = JSON.stringify({ language: 'fr', unknownKey: 'value' });
    getState().importSettings(json);
    expect(getState().settings.language).toBe('fr');
    expect((getState().settings as Record<string, unknown>)['unknownKey']).toBeUndefined();
  });

  it('should preserve existing settings for missing keys on import', () => {
    getState().updateSetting('theme', 'dark');
    getState().importSettings(JSON.stringify({ language: 'fr' }));
    expect(getState().settings.language).toBe('fr');
    expect(getState().settings.theme).toBe('dark');
  });

  it('should export and reimport consistently', () => {
    getState().updateSettings({ language: 'ja', theme: 'light', defaultBatchSize: 500 });
    const exported = getState().exportSettings();
    getState().resetToDefaults();
    getState().importSettings(exported);
    expect(getState().settings.language).toBe('ja');
    expect(getState().settings.theme).toBe('light');
    expect(getState().settings.defaultBatchSize).toBe(500);
  });
});
