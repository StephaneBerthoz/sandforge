import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { ForgeHandlerDeps } from './ForgeHandler.js';
import type { ForgeConfig, ForgeGraph, ForgeExecutionResult, ForgeTemplate, ForgePlan } from '@sandforge/shared';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { ForgePlanGenerator } from '../../modules/forge/ForgePlanGenerator.js';
import type { ForgeComplianceService } from '../../modules/forge/ForgeComplianceService.js';
import type { ForgeMetadataDiff } from '../../modules/forge/ForgeMetadataDiff.js';

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createMockGraph(): ForgeGraph {
  return {
    nodes: [
      {
        objectApiName: 'Account',
        recordCount: 10,
        fieldCount: 5,
        status: 'idle',
        progress: 0,
        included: true,
        piiFields: [],
        anonymizeFields: [],
        errors: [],
        level: 0,
        successCount: 0,
        failureCount: 0,
        createableFieldCount: 0,
        estimatedSizeMB: 0,
        estimatedApiCalls: 0,
        batchStrategy: 'auto',
      },
    ],
    edges: [],
    totalRecords: 10,
    estimatedSizeMB: 0.01,
    estimatedDurationSeconds: 0.1,
  };
}

function createMockConfig(overrides?: Partial<ForgeConfig>): ForgeConfig {
  return {
    inputMode: 'record',
    recordId: '001XXXXXXXXXX',
    depth: 'direct',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
    ...overrides,
  };
}

function createMockResult(overrides?: Partial<ForgeExecutionResult>): ForgeExecutionResult {
  return {
    forgeId: 'forge-123',
    status: 'success',
    graph: createMockGraph(),
    duration: 1000,
    timestamp: '2026-03-07T00:00:00.000Z',
    idRemapCount: 5,
    ...overrides,
  };
}

function createMockTemplate(overrides?: Partial<ForgeTemplate>): ForgeTemplate {
  return {
    id: 'tpl-1',
    name: 'Test Template',
    description: 'A test template',
    config: {
      inputMode: 'record',
      depth: 'direct',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    },
    objectCount: 3,
    recordCount: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Captured progress listener from orchestrator.on('forge:progress', ...). */
type ProgressListener = (event: unknown) => void;

function createMockOrchestrator(): ForgeOrchestrator {
  return {
    discover: vi.fn().mockResolvedValue(createMockGraph()),
    execute: vi.fn().mockResolvedValue(createMockResult()),
    on: vi.fn().mockReturnValue(vi.fn()),
  } as unknown as ForgeOrchestrator;
}

function createHandler(): { handler: ForgeHandler; deps: ForgeHandlerDeps } {
  const deps: ForgeHandlerDeps = {
    orchestrator: createMockOrchestrator(),
    postMessage: vi.fn(),
  };
  return { handler: new ForgeHandler(deps), deps };
}

describe('ForgeHandler', () => {
  let handler: ForgeHandler;
  let deps: ForgeHandlerDeps;

  beforeEach(() => {
    const created = createHandler();
    handler = created.handler;
    deps = created.deps;
  });

  describe('forge:discover', () => {
    it('calls orchestrator.discover and posts response', async () => {
      const config = createMockConfig();
      const graph = createMockGraph();
      vi.mocked(deps.orchestrator.discover).mockResolvedValue(graph);

      const handled = await handler.handle('forge:discover', { config });

      expect(handled).toBe(true);
      expect(deps.orchestrator.discover).toHaveBeenCalledWith(config, expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }));
      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:discover:response',
        payload: { graph },
      });
    });

    it('posts error message when discover fails', async () => {
      const config = createMockConfig();
      vi.mocked(deps.orchestrator.discover).mockRejectedValue(new Error('Discovery failed'));

      const handled = await handler.handle('forge:discover', { config });

      expect(handled).toBe(true);
      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:discover:error',
        payload: { message: 'Discovery failed' },
      });
    });

    it('passes abort signal and progress callback to orchestrator.discover', async () => {
      const config = createMockConfig();
      await handler.handle('forge:discover', { config });

      expect(deps.orchestrator.discover).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          onProgress: expect.any(Function),
        }),
      );
    });

    it('posts discovery progress events to webview', async () => {
      const config = createMockConfig();
      vi.mocked(deps.orchestrator.discover).mockImplementation(
        async (_config: unknown, options?: { onProgress?: (event: unknown) => void }) => {
          options?.onProgress?.({
            objectApiName: 'Account',
            discoveredCount: 1,
            queueRemaining: 3,
          });
          return createMockGraph();
        },
      );

      await handler.handle('forge:discover', { config });

      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:discover:progress',
        payload: {
          objectApiName: 'Account',
          discoveredCount: 1,
          queueRemaining: 3,
        },
      });
    });
  });

  describe('forge:execute', () => {
    it('calls orchestrator.execute, subscribes to progress, and posts result', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      const result = createMockResult();
      const unsubscribe = vi.fn();

      vi.mocked(deps.orchestrator.execute).mockResolvedValue(result);
      vi.mocked(deps.orchestrator.on).mockReturnValue(unsubscribe);

      const handled = await handler.handle('forge:execute', { graph, config });

      expect(handled).toBe(true);
      expect(deps.orchestrator.on).toHaveBeenCalledWith('forge:progress', expect.any(Function));
      expect(deps.orchestrator.execute).toHaveBeenCalledWith(graph, config);
      expect(unsubscribe).toHaveBeenCalled();
      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:execute:response',
        payload: { result },
      });
    });

    it('forwards progress events to postMessage', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      let capturedListener: ProgressListener | undefined;

      vi.mocked(deps.orchestrator.on).mockImplementation(
        (_type: string, listener: ProgressListener) => {
          capturedListener = listener;
          return vi.fn();
        },
      );
      vi.mocked(deps.orchestrator.execute).mockImplementation(async () => {
        if (capturedListener) {
          capturedListener({
            objectName: 'Account',
            status: 'running',
            progress: 50,
            message: 'Inserting...',
          });
        }
        return createMockResult();
      });

      await handler.handle('forge:execute', { graph, config });

      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:progress',
        payload: {
          objectName: 'Account',
          status: 'running',
          progress: 50,
          message: 'Inserting...',
        },
      });
    });

    it('posts error message when execute fails', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      vi.mocked(deps.orchestrator.execute).mockRejectedValue(new Error('Execution failed'));

      const handled = await handler.handle('forge:execute', { graph, config });

      expect(handled).toBe(true);
      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:execute:error',
        payload: { message: 'Execution failed' },
      });
    });

    it('unsubscribes progress listener even when execute fails', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      const unsubscribe = vi.fn();

      vi.mocked(deps.orchestrator.on).mockReturnValue(unsubscribe);
      vi.mocked(deps.orchestrator.execute).mockRejectedValue(new Error('Boom'));

      await handler.handle('forge:execute', { graph, config });

      expect(unsubscribe).toHaveBeenCalled();
    });

    it('adds result to history (capped at 20)', async () => {
      const graph = createMockGraph();

      for (let i = 0; i < 25; i++) {
        const config = createMockConfig({ recordId: `001XXXXXXXXX${String(i).padStart(3, '0')}` });
        const result = createMockResult({ forgeId: `forge-${i}` });
        vi.mocked(deps.orchestrator.execute).mockResolvedValue(result);
        await handler.handle('forge:execute', { graph, config });
      }

      // List history to verify cap
      await handler.handle('forge:history:list', {});
      const historyCall = vi.mocked(deps.postMessage).mock.calls.find(
        (call) => (call[0] as { type: string }).type === 'forge:history:list:response',
      );
      expect(historyCall).toBeDefined();
      const historyPayload = (historyCall![0] as { payload: ForgeExecutionResult[] }).payload;
      expect(historyPayload).toHaveLength(20);
      // Most recent should be first
      expect(historyPayload[0].forgeId).toBe('forge-24');
    });
  });

  describe('forge:pause', () => {
    it('sets isPaused to true', async () => {
      expect(handler.paused).toBe(false);

      const handled = await handler.handle('forge:pause', {});

      expect(handled).toBe(true);
      expect(handler.paused).toBe(true);
    });
  });

  describe('forge:resume', () => {
    it('sets isPaused to false', async () => {
      await handler.handle('forge:pause', {});
      expect(handler.paused).toBe(true);

      const handled = await handler.handle('forge:resume', {});

      expect(handled).toBe(true);
      expect(handler.paused).toBe(false);
    });
  });

  describe('forge:abort', () => {
    it('calls abort on the active AbortController', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

      // Start an execute that we can intercept
      let resolveExecute: ((value: ForgeExecutionResult) => void) | undefined;
      vi.mocked(deps.orchestrator.execute).mockImplementation(
        () =>
          new Promise<ForgeExecutionResult>((resolve) => {
            resolveExecute = resolve;
          }),
      );

      const executePromise = handler.handle('forge:execute', { graph, config });

      // Abort while executing
      await handler.handle('forge:abort', {});
      expect(abortSpy).toHaveBeenCalled();

      // Resolve to complete the promise
      resolveExecute!(createMockResult());
      await executePromise;

      abortSpy.mockRestore();
    });

    it('aborts discovery when forge:abort is called during discover', async () => {
      const config = createMockConfig();
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

      let resolveDiscover: ((value: ForgeGraph) => void) | undefined;
      vi.mocked(deps.orchestrator.discover).mockImplementation(
        () => new Promise<ForgeGraph>((resolve) => { resolveDiscover = resolve; }),
      );

      const discoverPromise = handler.handle('forge:discover', { config });

      await handler.handle('forge:abort', {});
      expect(abortSpy).toHaveBeenCalled();

      resolveDiscover!(createMockGraph());
      await discoverPromise;

      abortSpy.mockRestore();
    });

    it('returns true even when no active execution', async () => {
      const handled = await handler.handle('forge:abort', {});
      expect(handled).toBe(true);
    });
  });

  describe('forge:templates:list', () => {
    it('returns empty templates initially', async () => {
      const handled = await handler.handle('forge:templates:list', {});

      expect(handled).toBe(true);
      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:templates:list:response',
        payload: [],
      });
    });

    it('returns saved templates', async () => {
      const template = createMockTemplate();
      await handler.handle('forge:templates:save', { template });

      await handler.handle('forge:templates:list', {});

      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:templates:list:response',
        payload: [template],
      });
    });
  });

  describe('forge:templates:save', () => {
    it('adds a new template', async () => {
      const template = createMockTemplate();

      const handled = await handler.handle('forge:templates:save', { template });

      expect(handled).toBe(true);
      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:templates:save:response',
        payload: { success: true },
      });
    });

    it('replaces template with same id', async () => {
      const template1 = createMockTemplate({ id: 'tpl-1', name: 'V1' });
      const template2 = createMockTemplate({ id: 'tpl-1', name: 'V2' });

      await handler.handle('forge:templates:save', { template: template1 });
      await handler.handle('forge:templates:save', { template: template2 });
      await handler.handle('forge:templates:list', {});

      const listCall = vi.mocked(deps.postMessage).mock.calls.find(
        (call) => (call[0] as { type: string }).type === 'forge:templates:list:response',
      );
      const templates = (listCall![0] as { payload: ForgeTemplate[] }).payload;
      expect(templates).toHaveLength(1);
      expect(templates[0].name).toBe('V2');
    });
  });

  describe('forge:templates:delete', () => {
    it('removes a template by id', async () => {
      const template = createMockTemplate({ id: 'tpl-del' });
      await handler.handle('forge:templates:save', { template });

      const handled = await handler.handle('forge:templates:delete', { templateId: 'tpl-del' });

      expect(handled).toBe(true);
      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:templates:delete:response',
        payload: { success: true },
      });

      // Verify it was removed
      await handler.handle('forge:templates:list', {});
      const listCall = vi.mocked(deps.postMessage).mock.calls.find(
        (call) => (call[0] as { type: string }).type === 'forge:templates:list:response',
      );
      const templates = (listCall![0] as { payload: ForgeTemplate[] }).payload;
      expect(templates).toHaveLength(0);
    });
  });

  describe('forge:history:list', () => {
    it('returns empty history initially', async () => {
      const handled = await handler.handle('forge:history:list', {});

      expect(handled).toBe(true);
      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:history:list:response',
        payload: [],
      });
    });

    it('returns history after executions', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      const result = createMockResult();
      vi.mocked(deps.orchestrator.execute).mockResolvedValue(result);

      await handler.handle('forge:execute', { graph, config });
      await handler.handle('forge:history:list', {});

      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:history:list:response',
        payload: [result],
      });
    });
  });

  describe('forge:plan:request', () => {
    it('returns error when planGenerator not configured', async () => {
      const handled = await handler.handle('forge:plan:request', {
        graph: createMockGraph(),
        config: createMockConfig(),
      });

      expect(handled).toBe(true);
      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:plan:error',
        payload: { message: 'Plan generator not configured' },
      });
    });

    it('calls planGenerator.generate and posts forge:plan:response', async () => {
      const mockPlan: ForgePlan = {
        waves: [{ order: 0, objectApiNames: ['Account'], totalRecords: 10, estimatedDurationSeconds: 0.5, estimatedApiCalls: 1 }],
        totalRecords: 10,
        totalApiCalls: 1,
        estimatedDurationSeconds: 0.5,
        cycleResolutions: [],
      };
      const planGenerator = { generate: vi.fn().mockReturnValue(mockPlan) } as unknown as ForgePlanGenerator;
      const planDeps: ForgeHandlerDeps = {
        orchestrator: createMockOrchestrator(),
        postMessage: vi.fn(),
        planGenerator,
      };
      const planHandler = new ForgeHandler(planDeps);

      const graph = createMockGraph();
      const handled = await planHandler.handle('forge:plan:request', { graph, config: createMockConfig() });

      expect(handled).toBe(true);
      expect(planGenerator.generate).toHaveBeenCalledWith(graph);
      expect(planDeps.postMessage).toHaveBeenCalledWith({
        type: 'forge:plan:response',
        payload: { plan: mockPlan },
      });
    });
  });

  describe('forge:compliance:request', () => {
    it('returns error when complianceService not configured', async () => {
      const handled = await handler.handle('forge:compliance:request', {
        framework: 'gdpr',
        graph: createMockGraph(),
        config: createMockConfig(),
      });

      expect(handled).toBe(true);
      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:compliance:error',
        payload: { message: 'Compliance service not configured' },
      });
    });

    it('calls complianceService.generate and posts forge:compliance:response', async () => {
      const mockReport = { id: 'r-1', framework: 'gdpr' };
      const complianceService = { generate: vi.fn().mockReturnValue(mockReport) } as unknown as ForgeComplianceService;
      const compDeps: ForgeHandlerDeps = {
        orchestrator: createMockOrchestrator(),
        postMessage: vi.fn(),
        complianceService,
      };
      const compHandler = new ForgeHandler(compDeps);

      const graph = createMockGraph();
      const config = createMockConfig();
      const handled = await compHandler.handle('forge:compliance:request', {
        framework: 'gdpr',
        graph,
        config,
      });

      expect(handled).toBe(true);
      expect(complianceService.generate).toHaveBeenCalledWith('gdpr', graph, 'src-org', 'tgt-org');
      expect(compDeps.postMessage).toHaveBeenCalledWith({
        type: 'forge:compliance:response',
        payload: { report: mockReport },
      });
    });
  });

  describe('forge:metadata-diff:request', () => {
    it('returns error when metadataDiff not configured', async () => {
      const handled = await handler.handle('forge:metadata-diff:request', {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        objectApiNames: ['Account'],
      });

      expect(handled).toBe(true);
      expect(deps.postMessage).toHaveBeenCalledWith({
        type: 'forge:metadata-diff:error',
        payload: { message: 'Metadata diff service not configured' },
      });
    });

    it('calls metadataDiff.compare and posts forge:metadata-diff:response', async () => {
      const mockDiffs = [{ objectApiName: 'Account', fieldApiName: 'Custom__c', issue: 'missing', severity: 'error', details: 'Missing field' }];
      const metadataDiff = { compare: vi.fn().mockResolvedValue(mockDiffs) } as unknown as ForgeMetadataDiff;
      const diffDeps: ForgeHandlerDeps = {
        orchestrator: createMockOrchestrator(),
        postMessage: vi.fn(),
        metadataDiff,
      };
      const diffHandler = new ForgeHandler(diffDeps);

      const handled = await diffHandler.handle('forge:metadata-diff:request', {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        objectApiNames: ['Account'],
      });

      expect(handled).toBe(true);
      expect(metadataDiff.compare).toHaveBeenCalledWith('src', 'tgt', ['Account']);
      expect(diffDeps.postMessage).toHaveBeenCalledWith({
        type: 'forge:metadata-diff:response',
        payload: { diffs: mockDiffs },
      });
    });
  });

  describe('unknown type', () => {
    it('returns false for unhandled message types', async () => {
      const handled = await handler.handle('unknown:type', {});
      expect(handled).toBe(false);
    });

    it('returns false for non-forge message types', async () => {
      const handled = await handler.handle('autopilot:execute', {});
      expect(handled).toBe(false);
    });
  });
});
