import { z } from 'zod';

import { SF_LIMITS } from '../constants/sf-limits.js';
import { grappeConfigSchema } from './grappe.schema.js';

/** General settings schema */
export const generalSettingsSchema = z.object({
  language: z.enum(['auto', 'en', 'fr', 'de', 'es', 'ja', 'pt-BR']).default('auto'),
  theme: z.enum(['auto', 'light', 'dark']).default('auto'),
  telemetry: z.boolean().default(false),
  notifications: z.boolean().default(true),
  soundEnabled: z.boolean().default(false),
  autoSave: z.boolean().default(true),
  maxRecentOperations: z.number().int().nonnegative().default(20),
});

/** Connection settings schema */
export const connectionSettingsSchema = z.object({
  defaultApiVersion: z.string().default(SF_LIMITS.DEFAULT_API_VERSION),
  connectionTimeout: z.number().int().positive().default(30_000),
  maxRetries: z.number().int().nonnegative().default(3),
  keepAliveInterval: z.number().int().positive().default(60_000),
  poolSize: z.number().int().positive().default(5),
});

/** Seed module settings schema */
export const seedSettingsSchema = z.object({
  defaultBatchSize: z.number().int().positive().default(200),
  defaultStrategy: z.enum(['faker', 'template', 'ai']).default('faker'),
  aiProvider: z.enum(['anthropic', 'openai', 'custom', 'none']).default('none'),
  aiModel: z.string().default(''),
  maxRecordsPerRun: z.number().int().positive().default(10_000),
  previewSampleSize: z.number().int().positive().default(5),
});

/** Sync module settings schema */
export const syncSettingsSchema = z.object({
  defaultBatchSize: z.number().int().positive().default(200),
  defaultConflictStrategy: z
    .enum(['source_wins', 'target_wins', 'newest_wins', 'manual', 'merge'])
    .default('source_wins'),
  enableIncrementalTracking: z.boolean().default(true),
  maxConcurrentJobs: z.number().int().positive().default(3),
  defaultExternalIdField: z.string().default('Id'),
});

/** Security settings schema */
export const securitySettingsSchema = z.object({
  requireConfirmationForProduction: z.boolean().default(true),
  auditLogging: z.boolean().default(true),
  sensitiveDataDetection: z.boolean().default(true),
  allowedOperationsOnProd: z
    .array(z.enum(['read', 'backup', 'compare']))
    .default(['read', 'backup', 'compare']),
});

/** Monitor settings schema */
export const monitorSettingsSchema = z.object({
  refreshInterval: z.number().int().positive().default(60_000),
  alertCooldownMinutes: z.number().int().positive().default(15),
  maxHistoryDays: z.number().int().positive().default(90),
});

/** CLI settings schema */
export const cliSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  defaultOutputFormat: z.enum(['json', 'table', 'csv', 'html']).default('table'),
  colorOutput: z.boolean().default(true),
  verbosity: z.enum(['quiet', 'normal', 'verbose', 'debug']).default('normal'),
});

/** Resilience settings schema */
export const resilienceSettingsSchema = z.object({
  offlineMode: z.boolean().default(false),
  checkpointInterval: z.number().int().positive().default(30_000),
  checkpointRetention: z.number().int().positive().default(7),
  autoRecoveryPrompt: z.boolean().default(true),
});

/** Onboarding settings schema */
export const onboardingSettingsSchema = z.object({
  showWelcome: z.boolean().default(true),
  showTips: z.boolean().default(true),
  completedSteps: z.array(z.string()).default([]),
});

/** Top-level application settings schema (partial -- all fields optional with defaults) */
export const settingsSchema = z.object({
  general: generalSettingsSchema.default({}),
  connection: connectionSettingsSchema.default({}),
  seed: seedSettingsSchema.default({}),
  sync: syncSettingsSchema.default({}),
  monitor: monitorSettingsSchema.default({}),
  security: securitySettingsSchema.default({}),
  grappe: grappeConfigSchema.optional(),
  cli: cliSettingsSchema.default({}),
  resilience: resilienceSettingsSchema.default({}),
  onboarding: onboardingSettingsSchema.default({}),
});

/** Inferred type for general settings input */
export type GeneralSettingsInput = z.infer<typeof generalSettingsSchema>;

/** Inferred type for connection settings input */
export type ConnectionSettingsInput = z.infer<typeof connectionSettingsSchema>;

/** Inferred type for seed settings input */
export type SeedSettingsInput = z.infer<typeof seedSettingsSchema>;

/** Inferred type for sync settings input */
export type SyncSettingsInput = z.infer<typeof syncSettingsSchema>;

/** Inferred type for security settings input */
export type SecuritySettingsInput = z.infer<typeof securitySettingsSchema>;

/** Inferred type for monitor settings input */
export type MonitorSettingsConfig = z.infer<typeof monitorSettingsSchema>;

/** Inferred type for CLI settings input */
export type CliSettingsConfig = z.infer<typeof cliSettingsSchema>;

/** Inferred type for resilience settings input */
export type ResilienceSettingsConfig = z.infer<typeof resilienceSettingsSchema>;

/** Inferred type for onboarding settings input */
export type OnboardingSettingsConfig = z.infer<typeof onboardingSettingsSchema>;

/** Inferred type for application settings input */
export type SettingsInput = z.infer<typeof settingsSchema>;
