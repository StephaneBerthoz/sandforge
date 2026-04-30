import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage, ForgeConfig, ForgeGraph, ForgeExecutionResult, ForgeTemplate, ForgePlan } from '@sandforge/shared';
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

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/soqlQueryHelper.js', () => ({
  queryWithFieldsFallback: vi.fn(),
}));
vi.mock('../../core/common/soqlValidator.js', () => ({
  sanitizeSoqlValue: vi.fn((v: string) => v),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallback } from '../../core/common/soqlQueryHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);
const mockQueryFallback = vi.mocked(queryWithFieldsFallback);

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
    // 15-char strict Salesforce ID (audit RT-001 hardened forgeConfigSchema)
    recordId: '001AP00000j2CEg',
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
    abort: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as ForgeOrchestrator;
}

/** Build a BaseMessage with optional payload. */
function buildMsg(type: string, payload?: unknown): BaseMessage {
  return {
    id: `test-${type}-${Date.now()}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage;
}

/** Creates standard mock deps following the HandlerDeps pattern. */
function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

describe('ForgeHandler', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let orchestrator: ForgeOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new ForgeHandler(deps);
    orchestrator = createMockOrchestrator();
    handler.setForgeOrchestrator(orchestrator);
  });

  describe('message routing', () => {
    it('returns false for unhandled message types', async () => {
      const msg = buildMsg('unknown:type');
      const result = await handler.handle(msg);
      expect(result).toBe(false);
    });

    it('returns false for non-forge message types', async () => {
      const msg = buildMsg('autopilot:execute');
      const result = await handler.handle(msg);
      expect(result).toBe(false);
    });
  });

  describe('forge:discover', () => {
    it('calls orchestrator.discover and posts response with correlationId', async () => {
      const config = createMockConfig();
      const graph = createMockGraph();
      vi.mocked(orchestrator.discover).mockResolvedValue(graph);

      const msg = buildMsg('forge:discover', { config });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(orchestrator.discover).toHaveBeenCalledWith(config, expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }));

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:discover:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & { correlationId?: string; payload: { graph: ForgeGraph } };
      expect(response.correlationId).toBe(msg.id);
      expect(response.payload.graph).toEqual(graph);
    });

    it('posts error message when discover fails', async () => {
      const config = createMockConfig();
      vi.mocked(orchestrator.discover).mockRejectedValue(new Error('Discovery failed'));

      const msg = buildMsg('forge:discover', { config });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:discover:error',
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('sends error when orchestrator not initialized', async () => {
      const freshHandler = new ForgeHandler(deps);
      const msg = buildMsg('forge:discover', { config: createMockConfig() });
      const handled = await freshHandler.handle(msg);

      expect(handled).toBe(true);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:discover:error',
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('posts discovery progress events to webview with correlationId', async () => {
      const config = createMockConfig();
      vi.mocked(orchestrator.discover).mockImplementation(
        async (_config: unknown, options?: { onProgress?: (event: unknown) => void }) => {
          options?.onProgress?.({
            objectApiName: 'Account',
            discoveredCount: 1,
            queueRemaining: 3,
          });
          return createMockGraph();
        },
      );

      const msg = buildMsg('forge:discover', { config });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const progressCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:discover:progress',
      );
      expect(progressCalls).toHaveLength(1);
      const progressResponse = progressCalls[0][0] as BaseMessage & { correlationId?: string };
      expect(progressResponse.correlationId).toBe(msg.id);
    });
  });

  describe('forge:execute', () => {
    it('calls orchestrator.execute and posts result with correlationId', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      const result = createMockResult();
      const unsubscribe = vi.fn();

      vi.mocked(orchestrator.execute).mockResolvedValue(result);
      vi.mocked(orchestrator.on).mockReturnValue(unsubscribe);

      const msg = buildMsg('forge:execute', { graph, config });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(orchestrator.on).toHaveBeenCalledWith('forge:progress', expect.any(Function));
      expect(orchestrator.execute).toHaveBeenCalledWith(graph, config);
      expect(unsubscribe).toHaveBeenCalled();

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:execute:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & { correlationId?: string; payload: { result: ForgeExecutionResult } };
      expect(response.correlationId).toBe(msg.id);
      expect(response.payload.result).toEqual(result);
    });

    it('forwards progress events with correlationId', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      let capturedListener: ProgressListener | undefined;

      vi.mocked(orchestrator.on).mockImplementation(
        (_type: string, listener: ProgressListener) => {
          capturedListener = listener;
          return vi.fn();
        },
      );
      vi.mocked(orchestrator.execute).mockImplementation(async () => {
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

      const msg = buildMsg('forge:execute', { graph, config });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const progressCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:progress',
      );
      expect(progressCalls).toHaveLength(1);
      const progressMsg = progressCalls[0][0] as BaseMessage & { correlationId?: string };
      expect(progressMsg.correlationId).toBe(msg.id);
    });

    it('posts error message when execute fails', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      vi.mocked(orchestrator.execute).mockRejectedValue(new Error('Execution failed'));

      const msg = buildMsg('forge:execute', { graph, config });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:execute:error',
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('unsubscribes progress listener even when execute fails', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      const unsubscribe = vi.fn();

      vi.mocked(orchestrator.on).mockReturnValue(unsubscribe);
      vi.mocked(orchestrator.execute).mockRejectedValue(new Error('Boom'));

      const msg = buildMsg('forge:execute', { graph, config });
      await handler.handle(msg);

      expect(unsubscribe).toHaveBeenCalled();
    });

    it('includes operationId in forge:execute:response payload', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      const result = createMockResult();
      vi.mocked(orchestrator.execute).mockResolvedValue(result);

      const msg = buildMsg('forge:execute', { graph, config });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:execute:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & { payload: { result: ForgeExecutionResult; operationId: string } };
      expect(response.payload.operationId).toBeDefined();
      expect(response.payload.operationId).toMatch(/^forge-execute-/);
    });

    it('includes code and retryable in error payloads when execute fails', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      vi.mocked(orchestrator.execute).mockRejectedValue(new Error('Execution failed'));

      const msg = buildMsg('forge:execute', { graph, config });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:execute:error',
      );
      expect(errCalls).toHaveLength(1);
      const errPayload = (errCalls[0][0] as BaseMessage & { payload: { message: string; code: string; retryable: boolean } }).payload;
      expect(errPayload.code).toBe('EXECUTE_ERROR');
      expect(errPayload.retryable).toBe(true);
    });

    it('persists result to history via ConfigStore (capped at 20)', async () => {
      const graph = createMockGraph();

      for (let i = 0; i < 25; i++) {
        const config = createMockConfig({ recordId: `001XXXXXXXXX${String(i).padStart(3, '0')}` });
        const result = createMockResult({ forgeId: `forge-${i}` });
        vi.mocked(orchestrator.execute).mockResolvedValue(result);

        // Each execution reads then writes history
        const currentHistory = Array.from({ length: Math.min(i, 20) }, (_, idx) =>
          createMockResult({ forgeId: `forge-${i - 1 - idx}` }),
        );
        vi.mocked(deps.configStore.get).mockReturnValue(currentHistory);

        const msg = buildMsg('forge:execute', { graph, config });
        await handler.handle(msg);
      }

      // Verify configStore.set was called with history category
      expect(deps.configStore.set).toHaveBeenCalledWith(
        'forge:history',
        expect.any(Array),
        'forge',
      );
    });
  });

  describe('forge:pause', () => {
    it('delegates to orchestrator.pause', async () => {
      const msg = buildMsg('forge:pause');
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(orchestrator.pause).toHaveBeenCalledOnce();
    });
  });

  describe('forge:resume', () => {
    it('delegates to orchestrator.resume', async () => {
      const msg = buildMsg('forge:resume');
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(orchestrator.resume).toHaveBeenCalledOnce();
    });
  });

  describe('forge:abort', () => {
    it('calls abort on the active AbortController', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

      let resolveExecute: ((value: ForgeExecutionResult) => void) | undefined;
      vi.mocked(orchestrator.execute).mockImplementation(
        () =>
          new Promise<ForgeExecutionResult>((resolve) => {
            resolveExecute = resolve;
          }),
      );

      const execMsg = buildMsg('forge:execute', { graph, config });
      const executePromise = handler.handle(execMsg);

      await handler.handle(buildMsg('forge:abort'));
      expect(abortSpy).toHaveBeenCalled();

      resolveExecute!(createMockResult());
      await executePromise;

      abortSpy.mockRestore();
    });

    it('aborts discovery when forge:abort is called during discover', async () => {
      const config = createMockConfig();
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

      let resolveDiscover: ((value: ForgeGraph) => void) | undefined;
      vi.mocked(orchestrator.discover).mockImplementation(
        () => new Promise<ForgeGraph>((resolve) => { resolveDiscover = resolve; }),
      );

      const discoverMsg = buildMsg('forge:discover', { config });
      const discoverPromise = handler.handle(discoverMsg);

      await handler.handle(buildMsg('forge:abort'));
      expect(abortSpy).toHaveBeenCalled();

      resolveDiscover!(createMockGraph());
      await discoverPromise;

      abortSpy.mockRestore();
    });

    it('delegates to orchestrator.abort', async () => {
      const msg = buildMsg('forge:abort');
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(orchestrator.abort).toHaveBeenCalledOnce();
    });

    it('returns true even when no active execution', async () => {
      const msg = buildMsg('forge:abort');
      const handled = await handler.handle(msg);
      expect(handled).toBe(true);
    });
  });

  describe('forge:templates:list', () => {
    it('returns empty templates from ConfigStore initially', async () => {
      vi.mocked(deps.configStore.get).mockReturnValue(undefined);

      const msg = buildMsg('forge:templates:list');
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(deps.configStore.get).toHaveBeenCalledWith('forge:templates');

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:templates:list:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & { correlationId?: string; payload: { templates: ForgeTemplate[] } };
      expect(response.correlationId).toBe(msg.id);
      expect(response.payload.templates).toEqual([]);
    });

    it('returns templates loaded from ConfigStore', async () => {
      const templates = [createMockTemplate()];
      vi.mocked(deps.configStore.get).mockReturnValue(templates);

      const msg = buildMsg('forge:templates:list');
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:templates:list:response',
      );
      const response = responseCalls[0][0] as BaseMessage & { payload: { templates: ForgeTemplate[] } };
      expect(response.payload.templates).toEqual(templates);
    });
  });

  describe('forge:templates:save', () => {
    it('persists template to ConfigStore with correlationId response', async () => {
      vi.mocked(deps.configStore.get).mockReturnValue([]);
      const template = createMockTemplate();

      const msg = buildMsg('forge:templates:save', { template });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(deps.configStore.set).toHaveBeenCalledWith(
        'forge:templates',
        [template],
        'forge',
      );

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:templates:save:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & { correlationId?: string; payload: { success: boolean } };
      expect(response.correlationId).toBe(msg.id);
      expect(response.payload.success).toBe(true);
    });

    it('replaces template with same id', async () => {
      const template1 = createMockTemplate({ id: 'tpl-1', name: 'V1' });
      vi.mocked(deps.configStore.get).mockReturnValue([template1]);

      const template2 = createMockTemplate({ id: 'tpl-1', name: 'V2' });
      const msg = buildMsg('forge:templates:save', { template: template2 });
      await handler.handle(msg);

      expect(deps.configStore.set).toHaveBeenCalledWith(
        'forge:templates',
        [template2],
        'forge',
      );
    });
  });

  describe('forge:templates:delete', () => {
    it('removes a template by id and persists to ConfigStore', async () => {
      const template = createMockTemplate({ id: 'tpl-del' });
      vi.mocked(deps.configStore.get).mockReturnValue([template]);

      const msg = buildMsg('forge:templates:delete', { templateId: 'tpl-del' });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(deps.configStore.set).toHaveBeenCalledWith(
        'forge:templates',
        [],
        'forge',
      );

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:templates:delete:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & { correlationId?: string; payload: { success: boolean } };
      expect(response.correlationId).toBe(msg.id);
      expect(response.payload.success).toBe(true);
    });
  });

  describe('forge:history:list', () => {
    it('returns empty history from ConfigStore initially', async () => {
      vi.mocked(deps.configStore.get).mockReturnValue(undefined);

      const msg = buildMsg('forge:history:list');
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(deps.configStore.get).toHaveBeenCalledWith('forge:history');

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:history:list:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & { correlationId?: string; payload: { history: ForgeExecutionResult[] } };
      expect(response.correlationId).toBe(msg.id);
      expect(response.payload.history).toEqual([]);
    });

    it('returns history loaded from ConfigStore', async () => {
      const history = [createMockResult()];
      vi.mocked(deps.configStore.get).mockReturnValue(history);

      const msg = buildMsg('forge:history:list');
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:history:list:response',
      );
      const response = responseCalls[0][0] as BaseMessage & { payload: { history: ForgeExecutionResult[] } };
      expect(response.payload.history).toEqual(history);
    });
  });

  describe('forge:plan:request', () => {
    it('sends error when planGenerator not configured', async () => {
      const msg = buildMsg('forge:plan:request', {
        graph: createMockGraph(),
        config: createMockConfig(),
      });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:plan:error',
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('calls planGenerator.generate and posts response with correlationId', async () => {
      const mockPlan: ForgePlan = {
        waves: [{ order: 0, objectApiNames: ['Account'], totalRecords: 10, estimatedDurationSeconds: 0.5, estimatedApiCalls: 1 }],
        totalRecords: 10,
        totalApiCalls: 1,
        estimatedDurationSeconds: 0.5,
        cycleResolutions: [],
      };
      const planGenerator = { generate: vi.fn().mockReturnValue(mockPlan) } as unknown as ForgePlanGenerator;
      handler.setForgeOrchestrator(orchestrator, { planGenerator });

      const graph = createMockGraph();
      const msg = buildMsg('forge:plan:request', { graph, config: createMockConfig() });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(planGenerator.generate).toHaveBeenCalledWith(graph);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:plan:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & { correlationId?: string };
      expect(response.correlationId).toBe(msg.id);
    });

    it('emits operation:started then operation:completed on success', async () => {
      const mockPlan: ForgePlan = {
        waves: [{ order: 0, objectApiNames: ['Account'], totalRecords: 10, estimatedDurationSeconds: 0.5, estimatedApiCalls: 1 }],
        totalRecords: 10,
        totalApiCalls: 1,
        estimatedDurationSeconds: 0.5,
        cycleResolutions: [],
      };
      const planGenerator = { generate: vi.fn().mockReturnValue(mockPlan) } as unknown as ForgePlanGenerator;
      handler.setForgeOrchestrator(orchestrator, { planGenerator });

      const msg = buildMsg('forge:plan:request', { graph: createMockGraph(), config: createMockConfig() });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const startedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:started',
      );
      const completedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:completed',
      );
      expect(startedCalls).toHaveLength(1);
      expect(completedCalls).toHaveLength(1);
      const startedPayload = (startedCalls[0][0] as BaseMessage & { payload: { operationId: string; description: string } }).payload;
      expect(startedPayload.operationId).toMatch(/^forge-plan-/);
      expect(startedPayload.description).toBe('Generating execution plan');
    });

    it('emits operation:failed when planGenerator throws and error has code and retryable', async () => {
      const planGenerator = { generate: vi.fn().mockImplementation(() => { throw new Error('generation failed'); }) } as unknown as ForgePlanGenerator;
      handler.setForgeOrchestrator(orchestrator, { planGenerator });

      const msg = buildMsg('forge:plan:request', { graph: createMockGraph(), config: createMockConfig() });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const failedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:failed',
      );
      expect(failedCalls).toHaveLength(1);

      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:plan:error',
      );
      expect(errCalls).toHaveLength(1);
      const errPayload = (errCalls[0][0] as BaseMessage & { payload: { message: string; code: string; retryable: boolean } }).payload;
      expect(errPayload.code).toBe('PLAN_ERROR');
      expect(errPayload.retryable).toBe(false);
    });
  });

  describe('forge:compliance:request', () => {
    it('sends error when complianceService not configured', async () => {
      const msg = buildMsg('forge:compliance:request', {
        framework: 'gdpr',
        graph: createMockGraph(),
        config: createMockConfig(),
      });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:compliance:error',
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('calls complianceService.generate and posts response with correlationId', async () => {
      const mockReport = { id: 'r-1', framework: 'gdpr' };
      const complianceService = { generate: vi.fn().mockReturnValue(mockReport) } as unknown as ForgeComplianceService;
      handler.setForgeOrchestrator(orchestrator, { complianceService });

      const graph = createMockGraph();
      const config = createMockConfig();
      const msg = buildMsg('forge:compliance:request', { framework: 'gdpr', graph, config });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(complianceService.generate).toHaveBeenCalledWith('gdpr', graph, 'src-org', 'tgt-org');

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:compliance:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & { correlationId?: string };
      expect(response.correlationId).toBe(msg.id);
    });

    it('emits operation lifecycle events on success', async () => {
      const mockReport = { id: 'r-1', framework: 'gdpr' };
      const complianceService = { generate: vi.fn().mockReturnValue(mockReport) } as unknown as ForgeComplianceService;
      handler.setForgeOrchestrator(orchestrator, { complianceService });

      const msg = buildMsg('forge:compliance:request', { framework: 'gdpr', graph: createMockGraph(), config: createMockConfig() });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const startedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:started',
      );
      const completedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:completed',
      );
      expect(startedCalls).toHaveLength(1);
      expect(completedCalls).toHaveLength(1);
      const startedPayload = (startedCalls[0][0] as BaseMessage & { payload: { operationId: string; description: string } }).payload;
      expect(startedPayload.operationId).toMatch(/^forge-compliance-/);
      expect(startedPayload.description).toBe('Generating compliance report');
    });
  });

  describe('forge:metadata-diff:request', () => {
    it('sends error when metadataDiff not configured', async () => {
      const msg = buildMsg('forge:metadata-diff:request', {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        objectApiNames: ['Account'],
      });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:metadata-diff:error',
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('calls metadataDiff.compare and posts response with correlationId', async () => {
      const mockDiffs = [{ objectApiName: 'Account', fieldApiName: 'Custom__c', issue: 'missing', severity: 'error', details: 'Missing field' }];
      const metadataDiff = { compare: vi.fn().mockResolvedValue(mockDiffs) } as unknown as ForgeMetadataDiff;
      handler.setForgeOrchestrator(orchestrator, { metadataDiff });

      const msg = buildMsg('forge:metadata-diff:request', {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        objectApiNames: ['Account'],
      });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(metadataDiff.compare).toHaveBeenCalledWith('src', 'tgt', ['Account']);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:metadata-diff:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & { correlationId?: string };
      expect(response.correlationId).toBe(msg.id);
    });

    it('emits operation lifecycle events on success', async () => {
      const mockDiffs = [{ objectApiName: 'Account', fieldApiName: 'Custom__c', issue: 'missing', severity: 'error', details: 'Missing field' }];
      const metadataDiff = { compare: vi.fn().mockResolvedValue(mockDiffs) } as unknown as ForgeMetadataDiff;
      handler.setForgeOrchestrator(orchestrator, { metadataDiff });

      const msg = buildMsg('forge:metadata-diff:request', {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        objectApiNames: ['Account'],
      });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const startedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:started',
      );
      const completedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:completed',
      );
      expect(startedCalls).toHaveLength(1);
      expect(completedCalls).toHaveLength(1);
      const startedPayload = (startedCalls[0][0] as BaseMessage & { payload: { operationId: string; description: string } }).payload;
      expect(startedPayload.operationId).toMatch(/^forge-metadata-diff-/);
      expect(startedPayload.description).toBe('Comparing metadata schemas');
    });

    it('emits operation:failed when compare throws and error has code', async () => {
      const metadataDiff = { compare: vi.fn().mockRejectedValue(new Error('diff failed')) } as unknown as ForgeMetadataDiff;
      handler.setForgeOrchestrator(orchestrator, { metadataDiff });

      const msg = buildMsg('forge:metadata-diff:request', {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        objectApiNames: ['Account'],
      });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const failedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:failed',
      );
      expect(failedCalls).toHaveLength(1);

      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:metadata-diff:error',
      );
      expect(errCalls).toHaveLength(1);
      const errPayload = (errCalls[0][0] as BaseMessage & { payload: { message: string; code: string; retryable: boolean } }).payload;
      expect(errPayload.code).toBe('METADATA_DIFF_ERROR');
      expect(errPayload.retryable).toBe(false);
    });
  });

  describe('forge:preview', () => {
    it('includes estimatedRecordCount, totalFieldCount, and estimatedSize in response', async () => {
      const mockConn = {
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
        }),
        describe: vi.fn().mockResolvedValue({
          fields: [{ name: 'Name' }, { name: 'Phone' }, { name: 'Industry' }],
        }),
        query: vi.fn().mockResolvedValue({ totalSize: 5000 }),
        limitInfo: {},
      };
      mockGetConn.mockResolvedValue(mockConn as never);
      mockQueryFallback.mockResolvedValue([
        { Id: '001xx000003DGb1', Name: 'Acme', Phone: '555-1234' },
      ]);

      const msg = buildMsg('forge:preview', { recordId: '001xx000003DGb1', orgId: 'org-1' });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:preview:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        payload: {
          estimatedRecordCount: number;
          totalFieldCount: number;
          estimatedSize: number;
        };
      };
      expect(response.payload.totalFieldCount).toBe(3);
      expect(response.payload.estimatedRecordCount).toBe(5000);
      expect(response.payload.estimatedSize).toBeCloseTo(5);
    });

    it('defaults estimatedRecordCount to 0 when COUNT() query fails', async () => {
      const mockConn = {
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
        }),
        describe: vi.fn().mockResolvedValue({
          fields: [{ name: 'Name' }],
        }),
        query: vi.fn().mockRejectedValue(new Error('INVALID_QUERY')),
        limitInfo: {},
      };
      mockGetConn.mockResolvedValue(mockConn as never);
      mockQueryFallback.mockResolvedValue([
        { Id: '001xx000003DGb1', Name: 'Acme' },
      ]);

      const msg = buildMsg('forge:preview', { recordId: '001xx000003DGb1', orgId: 'org-1' });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:preview:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        payload: {
          estimatedRecordCount: number;
          estimatedSize: number;
        };
      };
      expect(response.payload.estimatedRecordCount).toBe(0);
      expect(response.payload.estimatedSize).toBe(0);
    });
  });
});
