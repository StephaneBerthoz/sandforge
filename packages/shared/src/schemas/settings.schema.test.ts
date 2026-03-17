import { describe, it, expect } from 'vitest';

import {
  settingsSchema,
  generalSettingsSchema,
  connectionSettingsSchema,
  seedSettingsSchema,
  syncSettingsSchema,
  securitySettingsSchema,
  monitorSettingsSchema,
  cliSettingsSchema,
  resilienceSettingsSchema,
  onboardingSettingsSchema,
} from './settings.schema.js';

describe('settingsSchema', () => {
  it('should parse an empty object with all defaults', () => {
    const result = settingsSchema.parse({});

    expect(result.general.language).toBe('auto');
    expect(result.general.theme).toBe('auto');
    expect(result.general.telemetry).toBe(false);
    expect(result.general.notifications).toBe(true);
    expect(result.general.soundEnabled).toBe(false);
    expect(result.general.autoSave).toBe(true);
    expect(result.general.maxRecentOperations).toBe(20);
    expect(result.connection.defaultApiVersion).toBe('62.0');
    expect(result.connection.connectionTimeout).toBe(30000);
    expect(result.connection.maxRetries).toBe(3);
    expect(result.connection.keepAliveInterval).toBe(60000);
    expect(result.connection.poolSize).toBe(5);
    expect(result.seed.defaultBatchSize).toBe(200);
    expect(result.seed.defaultStrategy).toBe('faker');
    expect(result.sync.defaultConflictStrategy).toBe('source_wins');
    expect(result.monitor.refreshInterval).toBe(60000);
    expect(result.security.requireConfirmationForProduction).toBe(true);
    expect(result.grappe).toBeUndefined();
    expect(result.cli.enabled).toBe(false);
    expect(result.resilience.offlineMode).toBe(false);
    expect(result.onboarding.showWelcome).toBe(true);
  });

  it('should accept partial general settings and fill defaults', () => {
    const result = settingsSchema.parse({
      general: { language: 'fr', telemetry: true },
    });

    expect(result.general.language).toBe('fr');
    expect(result.general.telemetry).toBe(true);
    expect(result.general.theme).toBe('auto');
    expect(result.general.notifications).toBe(true);
    expect(result.general.soundEnabled).toBe(false);
  });

  it('should accept partial connection settings and fill defaults', () => {
    const result = settingsSchema.parse({
      connection: { defaultApiVersion: '61.0', poolSize: 10 },
    });

    expect(result.connection.defaultApiVersion).toBe('61.0');
    expect(result.connection.poolSize).toBe(10);
    expect(result.connection.connectionTimeout).toBe(30000);
    expect(result.connection.maxRetries).toBe(3);
  });

  it('should accept grappe config when provided', () => {
    const result = settingsSchema.parse({
      grappe: {
        enabled: true,
        strategy: 'round_robin',
        backPressure: {
          enabled: true,
          strategy: 'pause',
        },
      },
    });

    expect(result.grappe).toBeDefined();
    expect(result.grappe?.enabled).toBe(true);
    expect(result.grappe?.maxWorkers).toBe(4);
    expect(result.grappe?.grappeSize).toBe(5000);
  });

  it('should allow omitting grappe entirely', () => {
    const result = settingsSchema.parse({
      general: { theme: 'dark' },
    });

    expect(result.grappe).toBeUndefined();
  });

  it('should override all general defaults when fully specified', () => {
    const result = settingsSchema.parse({
      general: {
        language: 'ja',
        theme: 'dark',
        telemetry: true,
        notifications: false,
        soundEnabled: true,
        autoSave: false,
        maxRecentOperations: 50,
      },
    });

    expect(result.general.language).toBe('ja');
    expect(result.general.theme).toBe('dark');
    expect(result.general.telemetry).toBe(true);
    expect(result.general.notifications).toBe(false);
    expect(result.general.soundEnabled).toBe(true);
    expect(result.general.autoSave).toBe(false);
    expect(result.general.maxRecentOperations).toBe(50);
  });

  it('should override all connection defaults when fully specified', () => {
    const result = settingsSchema.parse({
      connection: {
        defaultApiVersion: '60.0',
        connectionTimeout: 60000,
        maxRetries: 5,
        keepAliveInterval: 120000,
        poolSize: 10,
      },
    });

    expect(result.connection.defaultApiVersion).toBe('60.0');
    expect(result.connection.connectionTimeout).toBe(60000);
    expect(result.connection.maxRetries).toBe(5);
    expect(result.connection.keepAliveInterval).toBe(120000);
    expect(result.connection.poolSize).toBe(10);
  });
});

describe('generalSettingsSchema', () => {
  it('should parse an empty object with all defaults', () => {
    const result = generalSettingsSchema.parse({});

    expect(result.language).toBe('auto');
    expect(result.theme).toBe('auto');
    expect(result.telemetry).toBe(false);
    expect(result.notifications).toBe(true);
    expect(result.soundEnabled).toBe(false);
    expect(result.autoSave).toBe(true);
    expect(result.maxRecentOperations).toBe(20);
  });

  it('should accept all valid languages', () => {
    const languages = ['auto', 'en', 'fr', 'de', 'es', 'ja', 'pt-BR'] as const;

    for (const language of languages) {
      const result = generalSettingsSchema.parse({ language });

      expect(result.language).toBe(language);
    }
  });

  it('should accept all valid themes', () => {
    const themes = ['auto', 'light', 'dark'] as const;

    for (const theme of themes) {
      const result = generalSettingsSchema.parse({ theme });

      expect(result.theme).toBe(theme);
    }
  });

  it('should reject invalid language', () => {
    expect(() => generalSettingsSchema.parse({ language: 'zh' })).toThrow();
  });

  it('should reject invalid theme', () => {
    expect(() => generalSettingsSchema.parse({ theme: 'neon' })).toThrow();
  });

  it('should reject negative maxRecentOperations', () => {
    expect(() => generalSettingsSchema.parse({ maxRecentOperations: -1 })).toThrow();
  });
});

describe('connectionSettingsSchema', () => {
  it('should parse an empty object with all defaults', () => {
    const result = connectionSettingsSchema.parse({});

    expect(result.defaultApiVersion).toBe('62.0');
    expect(result.connectionTimeout).toBe(30000);
    expect(result.maxRetries).toBe(3);
    expect(result.keepAliveInterval).toBe(60000);
    expect(result.poolSize).toBe(5);
  });

  it('should reject non-positive connectionTimeout', () => {
    expect(() => connectionSettingsSchema.parse({ connectionTimeout: 0 })).toThrow();
  });

  it('should reject negative maxRetries', () => {
    expect(() => connectionSettingsSchema.parse({ maxRetries: -1 })).toThrow();
  });

  it('should reject non-positive poolSize', () => {
    expect(() => connectionSettingsSchema.parse({ poolSize: 0 })).toThrow();
  });

  it('should reject non-positive keepAliveInterval', () => {
    expect(() => connectionSettingsSchema.parse({ keepAliveInterval: 0 })).toThrow();
  });

  it('should accept zero for maxRetries', () => {
    const result = connectionSettingsSchema.parse({ maxRetries: 0 });

    expect(result.maxRetries).toBe(0);
  });
});

describe('seedSettingsSchema', () => {
  it('should parse an empty object with all defaults', () => {
    const result = seedSettingsSchema.parse({});

    expect(result.defaultBatchSize).toBe(200);
    expect(result.defaultStrategy).toBe('faker');
    expect(result.aiProvider).toBe('none');
    expect(result.aiModel).toBe('');
    expect(result.maxRecordsPerRun).toBe(10000);
    expect(result.previewSampleSize).toBe(5);
  });

  it('should accept all valid strategies', () => {
    for (const strategy of ['faker', 'template', 'ai'] as const) {
      const result = seedSettingsSchema.parse({ defaultStrategy: strategy });
      expect(result.defaultStrategy).toBe(strategy);
    }
  });

  it('should accept all valid AI providers', () => {
    for (const provider of ['anthropic', 'openai', 'custom', 'none'] as const) {
      const result = seedSettingsSchema.parse({ aiProvider: provider });
      expect(result.aiProvider).toBe(provider);
    }
  });

  it('should reject non-positive batchSize', () => {
    expect(() => seedSettingsSchema.parse({ defaultBatchSize: 0 })).toThrow();
  });

  it('should reject invalid strategy', () => {
    expect(() => seedSettingsSchema.parse({ defaultStrategy: 'random' })).toThrow();
  });
});

describe('syncSettingsSchema', () => {
  it('should parse an empty object with all defaults', () => {
    const result = syncSettingsSchema.parse({});

    expect(result.defaultBatchSize).toBe(200);
    expect(result.defaultConflictStrategy).toBe('source_wins');
    expect(result.enableIncrementalTracking).toBe(true);
    expect(result.maxConcurrentJobs).toBe(3);
    expect(result.defaultExternalIdField).toBe('Id');
  });

  it('should accept all valid conflict strategies', () => {
    for (const strategy of ['source_wins', 'target_wins', 'newest_wins', 'manual', 'merge'] as const) {
      const result = syncSettingsSchema.parse({ defaultConflictStrategy: strategy });
      expect(result.defaultConflictStrategy).toBe(strategy);
    }
  });

  it('should reject non-positive maxConcurrentJobs', () => {
    expect(() => syncSettingsSchema.parse({ maxConcurrentJobs: 0 })).toThrow();
  });

  it('should reject invalid conflict strategy', () => {
    expect(() => syncSettingsSchema.parse({ defaultConflictStrategy: 'ignore' })).toThrow();
  });
});

describe('securitySettingsSchema', () => {
  it('should parse an empty object with all defaults', () => {
    const result = securitySettingsSchema.parse({});

    expect(result.requireConfirmationForProduction).toBe(true);
    expect(result.auditLogging).toBe(true);
    expect(result.sensitiveDataDetection).toBe(true);
    expect(result.allowedOperationsOnProd).toEqual(['read', 'backup', 'compare']);
  });

  it('should accept custom allowed operations', () => {
    const result = securitySettingsSchema.parse({
      allowedOperationsOnProd: ['read'],
    });
    expect(result.allowedOperationsOnProd).toEqual(['read']);
  });

  it('should accept empty allowed operations', () => {
    const result = securitySettingsSchema.parse({
      allowedOperationsOnProd: [],
    });
    expect(result.allowedOperationsOnProd).toEqual([]);
  });

  it('should reject invalid operations', () => {
    expect(() => securitySettingsSchema.parse({
      allowedOperationsOnProd: ['delete'],
    })).toThrow();
  });

  it('should accept overriding all security defaults', () => {
    const result = securitySettingsSchema.parse({
      requireConfirmationForProduction: false,
      auditLogging: false,
      sensitiveDataDetection: false,
      allowedOperationsOnProd: ['read', 'compare'],
    });

    expect(result.requireConfirmationForProduction).toBe(false);
    expect(result.auditLogging).toBe(false);
    expect(result.sensitiveDataDetection).toBe(false);
    expect(result.allowedOperationsOnProd).toEqual(['read', 'compare']);
  });
});

describe('monitorSettingsSchema', () => {
  it('should parse an empty object with all defaults', () => {
    const result = monitorSettingsSchema.parse({});

    expect(result.refreshInterval).toBe(60000);
    expect(result.alertCooldownMinutes).toBe(15);
    expect(result.maxHistoryDays).toBe(90);
  });

  it('should reject non-positive refreshInterval', () => {
    expect(() => monitorSettingsSchema.parse({ refreshInterval: 0 })).toThrow();
  });
});

describe('cliSettingsSchema', () => {
  it('should parse an empty object with all defaults', () => {
    const result = cliSettingsSchema.parse({});

    expect(result.enabled).toBe(false);
    expect(result.defaultOutputFormat).toBe('table');
    expect(result.colorOutput).toBe(true);
    expect(result.verbosity).toBe('normal');
  });

  it('should accept all valid output formats', () => {
    for (const fmt of ['json', 'table', 'csv', 'html'] as const) {
      const result = cliSettingsSchema.parse({ defaultOutputFormat: fmt });
      expect(result.defaultOutputFormat).toBe(fmt);
    }
  });

  it('should accept all valid verbosity levels', () => {
    for (const v of ['quiet', 'normal', 'verbose', 'debug'] as const) {
      const result = cliSettingsSchema.parse({ verbosity: v });
      expect(result.verbosity).toBe(v);
    }
  });
});

describe('resilienceSettingsSchema', () => {
  it('should parse an empty object with all defaults', () => {
    const result = resilienceSettingsSchema.parse({});

    expect(result.offlineMode).toBe(false);
    expect(result.checkpointInterval).toBe(30000);
    expect(result.checkpointRetention).toBe(7);
    expect(result.autoRecoveryPrompt).toBe(true);
  });

  it('should reject non-positive checkpointInterval', () => {
    expect(() => resilienceSettingsSchema.parse({ checkpointInterval: 0 })).toThrow();
  });
});

describe('onboardingSettingsSchema', () => {
  it('should parse an empty object with all defaults', () => {
    const result = onboardingSettingsSchema.parse({});

    expect(result.showWelcome).toBe(true);
    expect(result.showTips).toBe(true);
    expect(result.completedSteps).toEqual([]);
  });

  it('should accept completed steps', () => {
    const result = onboardingSettingsSchema.parse({
      completedSteps: ['connect', 'seed'],
    });
    expect(result.completedSteps).toEqual(['connect', 'seed']);
  });
});

describe('syncSettingsSchema merge conflict strategy', () => {
  it('should accept merge as a conflict strategy', () => {
    const result = syncSettingsSchema.parse({ defaultConflictStrategy: 'merge' });
    expect(result.defaultConflictStrategy).toBe('merge');
  });
});
