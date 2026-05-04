import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';

import { createServices, runSecretMigration } from './services.js';
import {
  SalesforceAdapter,
  TelemetryAdapter,
  StorageAdapter,
  FsAdapter,
} from './adapters/index.js';
import { MonitorOrchestrator } from './modules/monitor/MonitorOrchestrator.js';
import { SeedOrchestrator } from './modules/seed/SeedOrchestrator.js';
import { SyncOrchestrator } from './modules/sync/SyncOrchestrator.js';
import { CompareOrchestrator } from './modules/compare/CompareOrchestrator.js';
import { PipelineOrchestrator } from './modules/automation/PipelineOrchestrator.js';

type GlobalStateStore = Map<string, unknown>;
type SecretStore = Map<string, string>;

function createMockContext(
  seededGlobalState: Record<string, unknown> = {},
  seededSecrets: Record<string, string> = {},
): vscode.ExtensionContext {
  const globalState: GlobalStateStore = new Map(Object.entries(seededGlobalState));
  const secrets: SecretStore = new Map(Object.entries(seededSecrets));

  const globalStateApi = {
    get: vi.fn(<T>(key: string) => globalState.get(key) as T | undefined),
    update: vi.fn(async (key: string, value: unknown) => {
      if (value === undefined) {
        globalState.delete(key);
      } else {
        globalState.set(key, value);
      }
    }),
    keys: () => [...globalState.keys()],
    setKeysForSync: vi.fn(),
  };

  const workspaceStateApi = {
    get: vi.fn(<T>(_key: string) => undefined as T | undefined),
    update: vi.fn(async (_key: string, _value: unknown) => undefined),
    keys: () => [],
  };

  const secretsApi = {
    get: vi.fn(async (key: string) => secrets.get(key)),
    store: vi.fn(async (key: string, value: string) => {
      secrets.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      secrets.delete(key);
    }),
    onDidChange: vi.fn(() => ({ dispose: () => undefined })),
  };

  return {
    globalState: globalStateApi,
    workspaceState: workspaceStateApi,
    secrets: secretsApi,
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/ext', scheme: 'file' },
    extensionPath: '/tmp/ext',
    storageUri: undefined,
    globalStorageUri: { fsPath: '/tmp/global', scheme: 'file' },
    logUri: { fsPath: '/tmp/log', scheme: 'file' },
    environmentVariableCollection: {
      replace: vi.fn(),
      append: vi.fn(),
      prepend: vi.fn(),
      get: vi.fn(),
      forEach: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
    },
    asAbsolutePath: vi.fn((p: string) => `/tmp/ext/${p}`),
    extensionMode: 1,
    logPath: '/tmp/log',
    storagePath: undefined,
    globalStoragePath: '/tmp/global',
    extension: { id: 'sandforge', packageJSON: { version: '1.3.0' } },
  } as unknown as vscode.ExtensionContext;
}

// Stub vscode.env.isTelemetryEnabled (default true) via mock — the TelemetryAdapter
// reads it during construction. We don't enable Sentry (no DSN provided), so Pino-only.
vi.mock('vscode', () => ({
  env: { isTelemetryEnabled: false },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: string) => fallback,
    }),
  },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
}));

describe('services', () => {
  describe('createServices', () => {
    let context: vscode.ExtensionContext;

    beforeEach(() => {
      context = createMockContext();
    });

    it('returns a Services object with every expected field', () => {
      const services = createServices(context);

      expect(services).toHaveProperty('context', context);
      expect(services).toHaveProperty('storage');
      expect(services).toHaveProperty('telemetry');
      expect(services).toHaveProperty('salesforce');
      expect(services).toHaveProperty('fs');
      expect(services).toHaveProperty('monitorOrchestrator');
      expect(services).toHaveProperty('seedOrchestrator');
      expect(services).toHaveProperty('syncOrchestrator');
      expect(services).toHaveProperty('compareOrchestrator');
      expect(services).toHaveProperty('dataopsOrchestrator');
      expect(services).toHaveProperty('automationOrchestrator');
    });

    it('wires the four core adapters as instanceof of their classes', () => {
      const services = createServices(context);

      expect(services.storage).toBeInstanceOf(StorageAdapter);
      expect(services.telemetry).toBeInstanceOf(TelemetryAdapter);
      expect(services.salesforce).toBeInstanceOf(SalesforceAdapter);
      expect(services.fs).toBeInstanceOf(FsAdapter);
    });

    it('exposes orchestrator factories that produce the correct instance types', () => {
      const services = createServices(context);

      const monitor = services.monitorOrchestrator({
        limitsTracker: { fetch: vi.fn().mockResolvedValue({}) },
        jobMonitor: { fetch: vi.fn().mockResolvedValue([]) },
        errorLogMonitor: { fetch: vi.fn().mockResolvedValue([]) },
        deploymentTracker: { fetch: vi.fn().mockResolvedValue([]) },
        userSessionMonitor: { fetch: vi.fn().mockResolvedValue([]) },
        alertEngine: { evaluate: vi.fn() },
        healthCheck: {
          computeHealth: vi.fn().mockResolvedValue({
            orgId: 'o',
            overall: 'healthy',
            apiLimitsStatus: 'ok',
            storageStatus: 'ok',
            activeJobs: 0,
            recentErrors: 0,
            lastChecked: '',
          }),
        },
      } as unknown as Parameters<typeof services.monitorOrchestrator>[0]);
      expect(monitor).toBeInstanceOf(MonitorOrchestrator);

      const seed = services.seedOrchestrator({
        validator: { validate: vi.fn() },
        planBuilder: { build: vi.fn() },
        fieldMapper: { mapFields: vi.fn() },
        referenceLinker: { resolveInsertOrder: vi.fn() },
        insert: vi.fn(),
        generateId: () => 'id-1',
        now: () => '',
      } as unknown as Parameters<typeof services.seedOrchestrator>[0]);
      expect(seed).toBeInstanceOf(SeedOrchestrator);

      const sync = services.syncOrchestrator({
        dataSync: { sync: vi.fn() },
        metadataSync: { sync: vi.fn() },
        deltaDetector: { detect: vi.fn() },
        conflictResolver: { detectConflicts: vi.fn(), resolve: vi.fn() },
        fieldMapping: { apply: vi.fn(), applyAddOns: vi.fn() },
        transformPipeline: { transformRecord: vi.fn() },
        migrationScript: { execute: vi.fn() },
        incrementalTracker: { getLastSync: vi.fn(), recordSync: vi.fn(), reset: vi.fn() },
        querySource: vi.fn(),
        queryTarget: vi.fn(),
      } as unknown as Parameters<typeof services.syncOrchestrator>[0]);
      expect(sync).toBeInstanceOf(SyncOrchestrator);

      const compare = services.compareOrchestrator({
        metadataCompare: { compare: vi.fn() },
        configCompare: { compare: vi.fn() },
        permissionCompare: { compare: vi.fn() },
        dataCompare: { compare: vi.fn() },
        diffEngine: { computeSummary: vi.fn() },
      } as unknown as Parameters<typeof services.compareOrchestrator>[0]);
      expect(compare).toBeInstanceOf(CompareOrchestrator);

      const automation = services.automationOrchestrator({
        builder: { validate: vi.fn().mockReturnValue([]) },
        triggerEngine: {},
        scheduler: {},
        stepLibrary: {},
        stepExecutor: { execute: vi.fn() },
        conditionalRouter: { evaluate: vi.fn(), getNextStep: vi.fn() },
        history: { record: vi.fn(), getRun: vi.fn() },
      } as unknown as Parameters<typeof services.automationOrchestrator>[0]);
      expect(automation).toBeInstanceOf(PipelineOrchestrator);

      // DataOps has no orchestrator — it's a collection of independent services.
      expect(services.dataopsOrchestrator).toBeNull();
    });

    it('smoke: monitorOrchestrator built via factory exposes read-only methods without throwing', () => {
      const services = createServices(context);
      const monitor = services.monitorOrchestrator({
        limitsTracker: { fetch: vi.fn().mockResolvedValue({}) },
        jobMonitor: { fetch: vi.fn().mockResolvedValue([]) },
        errorLogMonitor: { fetch: vi.fn().mockResolvedValue([]) },
        deploymentTracker: { fetch: vi.fn().mockResolvedValue([]) },
        userSessionMonitor: { fetch: vi.fn().mockResolvedValue([]) },
        alertEngine: { evaluate: vi.fn() },
        healthCheck: {
          computeHealth: vi.fn().mockResolvedValue({
            orgId: 'org-1',
            overall: 'healthy',
            apiLimitsStatus: 'ok',
            storageStatus: 'ok',
            activeJobs: 0,
            recentErrors: 0,
            lastChecked: '',
          }),
        },
      } as unknown as Parameters<typeof services.monitorOrchestrator>[0]);

      expect(() => monitor.isActive('unknown-org')).not.toThrow();
      expect(monitor.isActive('unknown-org')).toBe(false);
      expect(() => monitor.getHealthStatus('unknown-org')).not.toThrow();
    });
  });

  describe('runSecretMigration', () => {
    it('migrates the legacy ai.apiKey to sandforge.ai.anthropic.key', async () => {
      const context = createMockContext({ 'ai.apiKey': 'sk-anthropic-legacy' });
      const services = createServices(context);

      const result = await runSecretMigration(services.storage, services.telemetry, context);

      expect(result.count).toBeGreaterThanOrEqual(1);
      expect(result.success).toBe(true);
      expect(context.globalState.get('ai.apiKey')).toBeUndefined();
      expect(await context.secrets.get('sandforge.ai.anthropic.key')).toBe('sk-anthropic-legacy');
    });

    it('migrates per-org access and refresh tokens from globalState to SecretStorage', async () => {
      const context = createMockContext({
        'sandforge.orgs': [{ orgId: 'org-1', alias: 'dev' }],
        'sandforge.org-1.accessToken': 'access-legacy',
        'sandforge.org-1.refreshToken': 'refresh-legacy',
      });
      const services = createServices(context);

      const result = await runSecretMigration(services.storage, services.telemetry, context);

      expect(result.count).toBeGreaterThanOrEqual(2);
      expect(context.globalState.get('sandforge.org-1.accessToken')).toBeUndefined();
      expect(context.globalState.get('sandforge.org-1.refreshToken')).toBeUndefined();
      expect(await context.secrets.get('sandforge.org-1.accessToken')).toBe('access-legacy');
      expect(await context.secrets.get('sandforge.org-1.refreshToken')).toBe('refresh-legacy');
    });

    it('is idempotent: running twice produces no additional migrations', async () => {
      const context = createMockContext({ 'ai.apiKey': 'sk-anthropic' });
      const services = createServices(context);

      const first = await runSecretMigration(services.storage, services.telemetry, context);
      const second = await runSecretMigration(services.storage, services.telemetry, context);

      expect(first.count).toBe(1);
      expect(second.count).toBe(0);
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
    });

    it('emits a telemetry breadcrumb summarising the run', async () => {
      const context = createMockContext({ 'ai.apiKey': 'sk-legacy' });
      const services = createServices(context);
      const spy = vi.spyOn(services.telemetry, 'addBreadcrumb');

      await runSecretMigration(services.storage, services.telemetry, context);

      expect(spy).toHaveBeenCalledWith(
        expect.stringMatching(/^secret_migration count=\d+ success=(true|false)$/),
        'storage',
        expect.stringMatching(/^(info|error)$/),
      );
    });

    it('returns count=0 and success=true when nothing to migrate', async () => {
      const context = createMockContext();
      const services = createServices(context);

      const result = await runSecretMigration(services.storage, services.telemetry, context);

      expect(result.count).toBe(0);
      expect(result.success).toBe(true);
    });
  });
});
