import { create } from 'zustand';

/** Settings values for the webview. */
export interface SettingsValues {
  language: string;
  theme: string;
  defaultBatchSize: number;
  maxConcurrentOps: number;
  enableGrappe: boolean;
  grappeThreshold: number;
  apiTimeout: number;
  retryAttempts: number;
  enableNotifications: boolean;
  soundAlerts: boolean;
  autoRefreshInterval: number;
  logLevel: string;
  requireProdConfirmation: boolean;
  auditLogging: boolean;
}

/** Default settings values. */
export const DEFAULT_SETTINGS: SettingsValues = {
  language: 'en',
  theme: 'auto',
  defaultBatchSize: 200,
  maxConcurrentOps: 3,
  enableGrappe: true,
  grappeThreshold: 10_000,
  apiTimeout: 30_000,
  retryAttempts: 3,
  enableNotifications: true,
  soundAlerts: false,
  autoRefreshInterval: 60,
  logLevel: 'info',
  requireProdConfirmation: true,
  auditLogging: true,
};

/** Settings store state. */
export interface SettingsState {
  settings: SettingsValues;
  isDirty: boolean;
  lastSaved: string | null;
  updateSetting: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void;
  updateSettings: (partial: Partial<SettingsValues>) => void;
  resetToDefaults: () => void;
  markSaved: () => void;
  loadSettings: (values: Partial<SettingsValues>) => void;
  exportSettings: () => string;
  importSettings: (json: string) => boolean;
}

/** Zustand store for application settings state. */
export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  isDirty: false,
  lastSaved: null,

  updateSetting<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]): void {
    set((state) => ({
      settings: { ...state.settings, [key]: value },
      isDirty: true,
    }));
  },

  updateSettings(partial: Partial<SettingsValues>): void {
    set((state) => ({
      settings: { ...state.settings, ...partial },
      isDirty: true,
    }));
  },

  resetToDefaults(): void {
    set({
      settings: { ...DEFAULT_SETTINGS },
      isDirty: true,
    });
  },

  markSaved(): void {
    set({
      isDirty: false,
      lastSaved: new Date().toISOString(),
    });
  },

  loadSettings(values: Partial<SettingsValues>): void {
    set((state) => ({
      settings: { ...state.settings, ...values },
      isDirty: false,
    }));
  },

  exportSettings(): string {
    return JSON.stringify(get().settings, null, 2);
  },

  importSettings(json: string): boolean {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      if (typeof parsed !== 'object' || parsed === null) return false;

      const validKeys = Object.keys(DEFAULT_SETTINGS) as (keyof SettingsValues)[];
      const validEntries: Partial<SettingsValues> = {};

      for (const key of validKeys) {
        if (key in parsed && typeof parsed[key] === typeof DEFAULT_SETTINGS[key]) {
          (validEntries as Record<string, unknown>)[key] = parsed[key];
        }
      }

      set((state) => ({
        settings: { ...state.settings, ...validEntries },
        isDirty: true,
      }));
      return true;
    } catch {
      return false;
    }
  },
}));
