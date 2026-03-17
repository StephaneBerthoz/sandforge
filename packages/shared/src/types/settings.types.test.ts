import { describe, it, expect } from 'vitest';
import type {
  AppSettings,
  GeneralSettings,
  GrappeSettings,
  CliSettings,
} from './settings.types.js';

describe('settings.types', () => {
  describe('AppSettings', () => {
    it('should accept a complete AppSettings with all nested settings', () => {
      const settings: AppSettings = {
        general: {
          language: 'en',
          theme: 'dark',
          telemetry: true,
          notifications: true,
          soundEnabled: false,
          autoSave: true,
          maxRecentOperations: 50,
        },
        connection: {
          defaultApiVersion: '59.0',
          connectionTimeout: 30000,
          maxRetries: 3,
          keepAliveInterval: 60000,
          poolSize: 5,
        },
        seed: {
          defaultBatchSize: 200,
          defaultStrategy: 'smart',
          aiProvider: 'openai',
          aiModel: 'gpt-4',
          maxRecordsPerRun: 10000,
          previewSampleSize: 10,
        },
        sync: {
          defaultBatchSize: 500,
          defaultConflictStrategy: 'source_wins',
          enableIncrementalTracking: true,
          maxConcurrentJobs: 3,
          defaultExternalIdField: 'ExternalId__c',
        },
        monitor: {
          refreshInterval: 30000,
          alertCooldownMinutes: 15,
          maxHistoryDays: 90,
        },
        grappe: {
          autoActivate: true,
          autoActivateThreshold: 1000,
          maxWorkers: 4,
          defaultGrappeSize: 2000,
          defaultStrategy: 'round_robin',
          backPressureEnabled: true,
          backPressureHighWater: 80,
          backPressureLowWater: 40,
          backPressureStrategy: 'throttle',
          checkpointing: true,
        },
        cli: {
          enabled: true,
          defaultOutputFormat: 'table',
          colorOutput: true,
          verbosity: 'normal',
        },
        resilience: {
          offlineMode: false,
          checkpointInterval: 60000,
          checkpointRetention: 7,
          autoRecoveryPrompt: true,
          connectionRetry: true,
        },
        security: {
          requireConfirmationForProduction: true,
          auditLogging: true,
          sensitiveDataDetection: true,
          allowedOperationsOnProd: ['compare', 'monitor'],
        },
        onboarding: {
          showWelcome: true,
          showTips: true,
          completedSteps: [],
        },
      };

      expect(settings.general.language).toBe('en');
      expect(settings.general.theme).toBe('dark');
      expect(settings.connection.defaultApiVersion).toBe('59.0');
      expect(settings.seed.aiProvider).toBe('openai');
      expect(settings.sync.enableIncrementalTracking).toBe(true);
      expect(settings.monitor.refreshInterval).toBe(30000);
      expect(settings.grappe.autoActivate).toBe(true);
      expect(settings.cli.enabled).toBe(true);
      expect(settings.resilience.autoRecoveryPrompt).toBe(true);
      expect(settings.security.allowedOperationsOnProd).toEqual(['compare', 'monitor']);
      expect(settings.onboarding.completedSteps).toHaveLength(0);
    });

    it('should accept settings with optional fields on ConnectionSettings and MonitorSettings', () => {
      const settings: AppSettings = {
        general: {
          language: 'fr',
          theme: 'light',
          telemetry: false,
          notifications: true,
          soundEnabled: true,
          autoSave: false,
          maxRecentOperations: 20,
        },
        connection: {
          defaultApiVersion: '58.0',
          connectionTimeout: 15000,
          maxRetries: 5,
          keepAliveInterval: 30000,
          poolSize: 3,
          proxyUrl: 'https://proxy.company.com:8080',
        },
        seed: {
          defaultBatchSize: 100,
          defaultStrategy: 'random',
          aiProvider: 'anthropic',
          aiModel: 'claude-3',
          maxRecordsPerRun: 5000,
          previewSampleSize: 5,
        },
        sync: {
          defaultBatchSize: 200,
          defaultConflictStrategy: 'target_wins',
          enableIncrementalTracking: false,
          maxConcurrentJobs: 1,
          defaultExternalIdField: 'Id',
        },
        monitor: {
          refreshInterval: 60000,
          alertCooldownMinutes: 30,
          maxHistoryDays: 30,
          defaultDashboardId: 'dash-main-001',
        },
        grappe: {
          autoActivate: false,
          autoActivateThreshold: 5000,
          maxWorkers: 2,
          defaultGrappeSize: 1000,
          defaultStrategy: 'by_hash',
          backPressureEnabled: false,
          backPressureHighWater: 90,
          backPressureLowWater: 50,
          backPressureStrategy: 'pause',
          checkpointing: false,
        },
        cli: {
          enabled: false,
          defaultOutputFormat: 'json',
          colorOutput: false,
          verbosity: 'quiet',
        },
        resilience: {
          offlineMode: true,
          checkpointInterval: 30000,
          checkpointRetention: 14,
          autoRecoveryPrompt: false,
          connectionRetry: false,
        },
        security: {
          requireConfirmationForProduction: true,
          auditLogging: false,
          sensitiveDataDetection: false,
          allowedOperationsOnProd: [],
        },
        onboarding: {
          showWelcome: false,
          showTips: false,
          completedSteps: ['connect-org', 'first-seed', 'first-sync'],
        },
      };

      expect(settings.general.language).toBe('fr');
      expect(settings.connection.proxyUrl).toBe('https://proxy.company.com:8080');
      expect(settings.monitor.defaultDashboardId).toBe('dash-main-001');
      expect(settings.onboarding.completedSteps).toHaveLength(3);
    });
  });

  describe('GeneralSettings', () => {
    it('should accept all supported language and theme values', () => {
      const autoSettings: GeneralSettings = {
        language: 'auto',
        theme: 'auto',
        telemetry: false,
        notifications: true,
        soundEnabled: false,
        autoSave: true,
        maxRecentOperations: 100,
      };

      expect(autoSettings.language).toBe('auto');
      expect(autoSettings.theme).toBe('auto');
      expect(autoSettings.maxRecentOperations).toBe(100);
    });

    it('should represent all boolean preferences explicitly', () => {
      const settings: GeneralSettings = {
        language: 'ja',
        theme: 'light',
        telemetry: true,
        notifications: false,
        soundEnabled: true,
        autoSave: false,
        maxRecentOperations: 10,
      };

      expect(settings.telemetry).toBe(true);
      expect(settings.notifications).toBe(false);
      expect(settings.soundEnabled).toBe(true);
      expect(settings.autoSave).toBe(false);
    });
  });

  describe('GrappeSettings', () => {
    it('should accept all grappe configuration fields with correct types', () => {
      const grappeSettings: GrappeSettings = {
        autoActivate: true,
        autoActivateThreshold: 1000,
        maxWorkers: 8,
        defaultGrappeSize: 5000,
        defaultStrategy: 'dependency_aware',
        backPressureEnabled: true,
        backPressureHighWater: 85,
        backPressureLowWater: 35,
        backPressureStrategy: 'throttle',
        checkpointing: true,
      };

      expect(grappeSettings.autoActivate).toBe(true);
      expect(grappeSettings.autoActivateThreshold).toBe(1000);
      expect(grappeSettings.maxWorkers).toBe(8);
      expect(grappeSettings.defaultGrappeSize).toBe(5000);
      expect(grappeSettings.defaultStrategy).toBe('dependency_aware');
      expect(grappeSettings.backPressureEnabled).toBe(true);
      expect(grappeSettings.backPressureHighWater).toBe(85);
      expect(grappeSettings.backPressureLowWater).toBe(35);
      expect(grappeSettings.backPressureStrategy).toBe('throttle');
      expect(grappeSettings.checkpointing).toBe(true);
    });

    it('should accept all valid partition strategies and back-pressure strategies', () => {
      const withDropPriority: GrappeSettings = {
        autoActivate: false,
        autoActivateThreshold: 500,
        maxWorkers: 2,
        defaultGrappeSize: 1000,
        defaultStrategy: 'by_record_type',
        backPressureEnabled: true,
        backPressureHighWater: 70,
        backPressureLowWater: 30,
        backPressureStrategy: 'drop_priority',
        checkpointing: false,
      };

      expect(withDropPriority.defaultStrategy).toBe('by_record_type');
      expect(withDropPriority.backPressureStrategy).toBe('drop_priority');
    });
  });

  describe('CliSettings', () => {
    it('should accept all CLI configuration fields', () => {
      const cliSettings: CliSettings = {
        enabled: true,
        defaultOutputFormat: 'csv',
        colorOutput: true,
        verbosity: 'debug',
      };

      expect(cliSettings.enabled).toBe(true);
      expect(cliSettings.defaultOutputFormat).toBe('csv');
      expect(cliSettings.colorOutput).toBe(true);
      expect(cliSettings.verbosity).toBe('debug');
    });

    it('should accept all supported output formats and verbosity levels', () => {
      const htmlVerbose: CliSettings = {
        enabled: true,
        defaultOutputFormat: 'html',
        colorOutput: false,
        verbosity: 'verbose',
      };

      expect(htmlVerbose.defaultOutputFormat).toBe('html');
      expect(htmlVerbose.verbosity).toBe('verbose');
    });
  });
});
