import type { GrappePartitionStrategy, BackPressureStrategy } from './grappe.types.js';

/** Supported display languages */
export type DisplayLanguage = 'auto' | 'en' | 'fr' | 'de' | 'es' | 'ja' | 'pt-BR';

/** Theme mode */
export type ThemeMode = 'auto' | 'light' | 'dark';

/** Log verbosity level */
export type LogVerbosity = 'quiet' | 'normal' | 'verbose' | 'debug';

/** CLI output format */
export type CliOutputFormat = 'json' | 'table' | 'csv' | 'html';

/** Complete application settings */
export interface AppSettings {
  general: GeneralSettings;
  connection: ConnectionSettings;
  seed: SeedSettings;
  sync: SyncSettings;
  monitor: MonitorSettings;
  grappe: GrappeSettings;
  cli: CliSettings;
  resilience: ResilienceSettings;
  security: SecuritySettings;
  onboarding: OnboardingSettings;
}

/** General settings */
export interface GeneralSettings {
  language: DisplayLanguage;
  theme: ThemeMode;
  telemetry: boolean;
  notifications: boolean;
  soundEnabled: boolean;
  autoSave: boolean;
  maxRecentOperations: number;
}

/** Connection settings */
export interface ConnectionSettings {
  defaultApiVersion: string;
  connectionTimeout: number;
  maxRetries: number;
  keepAliveInterval: number;
  poolSize: number;
  proxyUrl?: string;
}

/** Seed module settings */
export interface SeedSettings {
  defaultBatchSize: number;
  defaultStrategy: string;
  aiProvider: string;
  aiModel: string;
  maxRecordsPerRun: number;
  previewSampleSize: number;
}

/** Sync module settings */
export interface SyncSettings {
  defaultBatchSize: number;
  defaultConflictStrategy: string;
  enableIncrementalTracking: boolean;
  maxConcurrentJobs: number;
  defaultExternalIdField: string;
}

/** Monitor module settings */
export interface MonitorSettings {
  refreshInterval: number;
  alertCooldownMinutes: number;
  maxHistoryDays: number;
  defaultDashboardId?: string;
}

/** Grappe (cluster) settings */
export interface GrappeSettings {
  autoActivate: boolean;
  autoActivateThreshold: number;
  maxWorkers: number;
  defaultGrappeSize: number;
  defaultStrategy: GrappePartitionStrategy;
  backPressureEnabled: boolean;
  backPressureHighWater: number;
  backPressureLowWater: number;
  backPressureStrategy: BackPressureStrategy;
  checkpointing: boolean;
}

/** CLI mode settings */
export interface CliSettings {
  enabled: boolean;
  defaultOutputFormat: CliOutputFormat;
  colorOutput: boolean;
  verbosity: LogVerbosity;
}

/** Resilience settings */
export interface ResilienceSettings {
  offlineMode: boolean;
  checkpointInterval: number;
  checkpointRetention: number;
  autoRecoveryPrompt: boolean;
  connectionRetry: boolean;
}

/** Security settings */
export interface SecuritySettings {
  requireConfirmationForProduction: boolean;
  auditLogging: boolean;
  sensitiveDataDetection: boolean;
  allowedOperationsOnProd: string[];
}

/** Onboarding settings */
export interface OnboardingSettings {
  showWelcome: boolean;
  showTips: boolean;
  completedSteps: string[];
}
