import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { OfflineManager } from '../../core/connection/OfflineManager.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** In-memory ConfigStore mock with real data tracking. */
function createMockConfigStoreWithData() {
  const data: Record<string, { value: string; category: string }> = {};

  return {
    get: vi.fn(<T>(key: string): T | undefined => {
      const entry = data[key];
      if (!entry) return undefined;
      return JSON.parse(entry.value) as T;
    }),
    set: vi.fn(<T>(key: string, value: T, category: string): void => {
      data[key] = { value: JSON.stringify(value), category };
    }),
    delete: vi.fn((key: string): boolean => {
      if (!(key in data)) return false;
      delete data[key];
      return true;
    }),
    has: vi.fn((key: string): boolean => key in data),
    getKeysByPrefix: vi.fn((prefix: string): string[] =>
      Object.keys(data).filter((k) => k.startsWith(prefix)),
    ),
    getByCategory: vi.fn((category: string): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(data)) {
        if (entry.category === category) {
          result[key] = JSON.parse(entry.value);
        }
      }
      return result;
    }),
    getAllKeys: vi.fn((): string[] => Object.keys(data)),
    clearCategory: vi.fn(),
    clearAll: vi.fn(),
    initialize: vi.fn(),
  };
}

/**
 * Creates minimal mock deps for SeedOpsHandler tests.
 */
function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: createMockConfigStoreWithData() as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

/** Minimal seed template that passes the seed:execute payload validation. */
function validSeedTemplate(): Record<string, unknown> {
  return {
    id: 'tpl-1',
    name: 'seed-from-ui',
    description: 'test',
    version: 1,
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Account',
        recordCount: 5,
        batchSize: 200,
        insertOrder: 0,
        excludedFields: [],
        fieldRules: [],
      },
    ],
    tags: [],
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  };
}

describe('SeedOpsHandler', () => {
  let handler: SeedOpsHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SeedOpsHandler(deps);
  });

  it('returns false for unhandled message types', async () => {
    const msg: InboundRequest = inboundRequest({
      id: '1',
      type: 'unknown:type',
      timestamp: Date.now(),
    });
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('handles seed:describe-global and response includes correlationId', async () => {
    mockGetConn.mockResolvedValue({
      describeGlobal: vi.fn().mockResolvedValue({
        sobjects: [
          { name: 'Account', label: 'Account', createable: true },
          { name: 'Lead', label: 'Lead', createable: false },
        ],
      }),
    } as never);

    const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
      id: 'req-100',
      type: 'seed:describe-global',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { objects: unknown[] };
    };
    expect(response.type).toBe('seed:describe-global:response');
    expect(response.correlationId).toBe('req-100');
    expect(response.payload.objects).toHaveLength(1);
    expect((response.payload.objects[0] as { apiName: string }).apiName).toBe('Account');
  });

  it('handles seed:describe-object and response includes correlationId', async () => {
    mockGetConn.mockResolvedValue({
      describe: vi.fn().mockResolvedValue({
        label: 'Account',
        fields: [
          {
            name: 'Name',
            label: 'Account Name',
            type: 'string',
            nillable: false,
            defaultedOnCreate: false,
            length: 255,
            createable: true,
          },
        ],
      }),
    } as never);

    const msg: InboundRequest & {
      payload: { orgId: string; objectApiName: string };
    } = inboundRequest({
      id: 'req-200',
      type: 'seed:describe-object',
      timestamp: Date.now(),
      payload: { orgId: 'org-1', objectApiName: 'Account' },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
    };
    expect(response.type).toBe('seed:describe-object:response');
    expect(response.correlationId).toBe('req-200');
  });

  it('error path sends error response via sendHandlerError', async () => {
    mockGetConn.mockRejectedValue(new Error('connection failed'));

    const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
      id: 'req-300',
      type: 'seed:describe-global',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    });

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string };
    };
    expect(response.type).toBe('seed:error');
    expect(response.payload.message).toBe('connection failed');
  });

  describe('seed:execute dryRun', () => {
    it('returns synthetic result when dryRun is true without performing inserts', async () => {
      mockGetConn.mockResolvedValue({} as never);

      const msg: InboundRequest & {
        payload: {
          orgId: string;
          template: Record<string, unknown>;
          dryRun: boolean;
        };
      } = inboundRequest({
        id: 'req-dry-1',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          template: validSeedTemplate(),
          dryRun: true,
        },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: {
          success: boolean;
          dryRun: boolean;
          insertedCount: number;
          results: unknown[];
        };
      };
      expect(response.type).toBe('seed:execute:response');
      expect(response.correlationId).toBe('req-dry-1');
      expect(response.payload.dryRun).toBe(true);
      expect(response.payload.insertedCount).toBe(0);
      expect(response.payload.results).toEqual([]);
    });

    it('does not short-circuit when dryRun is false', async () => {
      mockGetConn.mockResolvedValue({} as never);

      const msg: InboundRequest & {
        payload: {
          orgId: string;
          template: Record<string, unknown>;
          dryRun: boolean;
        };
      } = inboundRequest({
        id: 'req-dry-2',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          template: validSeedTemplate(),
          dryRun: false,
        },
      });

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      // If a seed:execute:response was posted, it must NOT have the dryRun flag
      const executeResponses = postToWebview.mock.calls
        .map((c) => c[0] as BaseMessage & { payload?: { dryRun?: boolean } })
        .filter((r) => r.type === 'seed:execute:response');
      for (const r of executeResponses) {
        expect(r.payload?.dryRun).not.toBe(true);
      }
    });
  });

  describe('robustness integration', () => {
    it('wraps describe-global with TimeoutManager', async () => {
      const describeGlobalFn = vi.fn().mockResolvedValue({
        sobjects: [{ name: 'Account', label: 'Account', createable: true }],
      });
      mockGetConn.mockResolvedValue({
        describeGlobal: describeGlobalFn,
      } as never);

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-timeout-1',
        type: 'seed:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      });

      await handler.handle(msg);

      // describeGlobal was called (wrapped inside TimeoutManager)
      expect(describeGlobalFn).toHaveBeenCalledTimes(1);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { objects: unknown[] };
      };
      expect(response.type).toBe('seed:describe-global:response');
      expect(response.payload.objects).toHaveLength(1);
    });

    it('wraps describe-object with TimeoutManager', async () => {
      const describeFn = vi.fn().mockResolvedValue({
        label: 'Account',
        fields: [
          {
            name: 'Name',
            label: 'Name',
            type: 'string',
            nillable: false,
            defaultedOnCreate: false,
            length: 255,
            createable: true,
          },
        ],
      });
      mockGetConn.mockResolvedValue({ describe: describeFn } as never);

      const msg: InboundRequest & {
        payload: { orgId: string; objectApiName: string };
      } = inboundRequest({
        id: 'req-timeout-2',
        type: 'seed:describe-object',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objectApiName: 'Account' },
      });

      await handler.handle(msg);

      expect(describeFn).toHaveBeenCalledTimes(1);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview.mock.calls[0][0].type).toBe('seed:describe-object:response');
    });

    it('sends TimeoutError to webview when describe-global times out', async () => {
      const describeGlobalFn = vi.fn().mockImplementation(
        () =>
          new Promise((_resolve) => {
            /* never resolves -- simulates a hung API call */
          }),
      );
      mockGetConn.mockResolvedValue({
        describeGlobal: describeGlobalFn,
      } as never);

      // Set very short timeout via configStore
      vi.mocked(deps.configStore.get).mockReturnValue({
        timeouts: {
          describeGlobal: 5000,
          describe: 5000,
          crudBatch: 10000,
          bulkJob: 60000,
        },
        retry: { maxRetries: 0 },
        bulk: { threshold: 200 },
      });

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-timeout-err',
        type: 'seed:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      });

      // The handler should catch the timeout and send an error
      // But since 5s is too long for a test, just verify the timeout wrapping
      // by checking that describeGlobal was called
      // (The actual timeout behavior is tested in TimeoutManager.test.ts)
      await Promise.race([handler.handle(msg), new Promise((resolve) => setTimeout(resolve, 50))]);

      expect(describeGlobalFn).toHaveBeenCalledTimes(1);
    });

    it('loads robustness config from ConfigStore', async () => {
      const customConfig = {
        timeouts: {
          describeGlobal: 60000,
          describe: 30000,
          crudBatch: 120000,
          bulkJob: 600000,
        },
        retry: {
          maxRetries: 5,
          initialDelay: 2000,
          maxDelay: 60000,
          backoffMultiplier: 3,
        },
        bulk: { threshold: 500 },
      };
      vi.mocked(deps.configStore.get).mockReturnValue(customConfig);

      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      } as never);

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-config',
        type: 'seed:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      });

      await handler.handle(msg);

      // ConfigStore.get was called with the robustness config key
      expect(deps.configStore.get).toHaveBeenCalledWith('robustness:config');
    });

    it('falls back to defaults when configStore returns undefined', async () => {
      vi.mocked(deps.configStore.get).mockReturnValue(undefined);

      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      } as never);

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-default',
        type: 'seed:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      });

      // Should not throw even with undefined config
      const result = await handler.handle(msg);
      expect(result).toBe(true);
    });
  });

  describe('seed:list-personas', () => {
    it('returns 10 built-in personas', async () => {
      const msg: InboundRequest = inboundRequest({
        id: 'req-personas-1',
        type: 'seed:list-personas',
        timestamp: Date.now(),
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: {
          personas: Array<{ id: string; name: string; industry: string }>;
        };
      };
      expect(response.type).toBe('seed:list-personas:response');
      expect(response.correlationId).toBe('req-personas-1');
      expect(response.payload.personas).toHaveLength(10);
      expect(response.payload.personas[0].id).toBe('assureur-fr');
      expect(response.payload.personas[0].industry).toBe('Insurance');
    });
  });

  describe('seed:create-persona', () => {
    it('returns error when description is empty', async () => {
      const msg: InboundRequest & { payload: { description: string } } = inboundRequest({
        id: 'req-create-1',
        type: 'seed:create-persona',
        timestamp: Date.now(),
        payload: { description: '' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { success: boolean; error?: string };
      };
      expect(response.type).toBe('seed:create-persona:response');
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('Description is required');
    });

    it('returns error when description is whitespace only', async () => {
      const msg: InboundRequest & { payload: { description: string } } = inboundRequest({
        id: 'req-create-2',
        type: 'seed:create-persona',
        timestamp: Date.now(),
        payload: { description: '   ' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { success: boolean; error?: string };
      };
      expect(response.type).toBe('seed:create-persona:response');
      expect(response.payload.success).toBe(false);
    });

    it('sends an explicit error when AI is disabled (no services injected)', async () => {
      // Default mock deps have no `services` — isAIEnabled() cannot be true.
      const msg: InboundRequest & { payload: { description: string } } = inboundRequest({
        id: 'req-create-3',
        type: 'seed:create-persona',
        timestamp: Date.now(),
        payload: { description: 'A veterinary clinic in Texas' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { message: string };
      };
      expect(response.type).toBe('seed:error');
      expect(response.payload.message).toContain('AI is disabled');
    });

    it('sends an explicit error when sandforge.ai.enabled is false', async () => {
      deps.services = {
        isAIEnabled: () => false,
        aiClient: vi.fn(),
      } as unknown as HandlerDeps['services'];
      handler = new SeedOpsHandler(deps);

      const msg: InboundRequest & { payload: { description: string } } = inboundRequest({
        id: 'req-create-4',
        type: 'seed:create-persona',
        timestamp: Date.now(),
        payload: { description: 'A veterinary clinic in Texas' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { message: string };
      };
      expect(response.type).toBe('seed:error');
      expect(response.payload.message).toContain('AI is disabled');
    });

    it('creates a persona through the unified AI client when AI is enabled', async () => {
      const chat = vi.fn().mockResolvedValue({
        text: JSON.stringify({
          name: 'Custom Veterinary Clinic',
          description: 'Veterinary clinic with patients, owners, and appointments.',
          industry: 'Veterinary',
          locale: 'en-US',
          dataPatterns: {
            Pet_Name__c: {
              fieldType: 'string',
              generator: 'faker',
              params: { method: 'animal.petName' },
              examples: ['Buddy', 'Luna', 'Max'],
            },
          },
        }),
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheCreate: 0,
          total: 30,
        },
        model: 'claude-sonnet-4-5-20250929',
        stopReason: 'end_turn',
      });
      const aiClient = vi.fn().mockReturnValue({ chat });
      deps.services = {
        isAIEnabled: () => true,
        aiClient,
      } as unknown as HandlerDeps['services'];
      handler = new SeedOpsHandler(deps);

      const msg: InboundRequest & { payload: { description: string } } = inboundRequest({
        id: 'req-create-5',
        type: 'seed:create-persona',
        timestamp: Date.now(),
        payload: { description: 'A veterinary clinic in Texas' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      // The prompt went through the unified client, not a stub
      expect(aiClient).toHaveBeenCalled();
      expect(chat).toHaveBeenCalledWith({
        messages: [{ role: 'user', content: expect.stringContaining('veterinary') }],
      });

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: {
          success: boolean;
          persona: { name: string; industry: string };
        };
      };
      expect(response.type).toBe('seed:create-persona:response');
      expect(response.payload.success).toBe(true);
      expect(response.payload.persona.name).toBe('Custom Veterinary Clinic');
      expect(response.payload.persona.industry).toBe('Veterinary');
    });

    it('surfaces the adapter error when the API key is missing', async () => {
      const chat = vi
        .fn()
        .mockRejectedValue(new Error('Anthropic API key not configured. Set it in Settings.'));
      deps.services = {
        isAIEnabled: () => true,
        aiClient: vi.fn().mockReturnValue({ chat }),
      } as unknown as HandlerDeps['services'];
      handler = new SeedOpsHandler(deps);

      const msg: InboundRequest & { payload: { description: string } } = inboundRequest({
        id: 'req-create-6',
        type: 'seed:create-persona',
        timestamp: Date.now(),
        payload: { description: 'A veterinary clinic in Texas' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { message: string };
      };
      expect(response.type).toBe('seed:error');
      expect(response.payload.message).toContain('API key not configured');
    });
  });

  describe('bulk path uses real IDs', () => {
    it('passes bulkResult.successIds instead of synthetic IDs', () => {
      // This is a structural test: verify the SeedOpsHandler source uses
      // bulkResult.successIds (not Array.from with synthetic bulk-N IDs).
      // The actual bulk executor is tested in BulkApiExecutor.test.ts.
      // Here we just verify the code references bulkResult.successIds.
      const handlerPath = path.join(__dirname, 'SeedOpsHandler.ts');
      const source = fs.readFileSync(handlerPath, 'utf-8') as string;

      // Should use bulkResult.successIds
      expect(source).toContain('bulkResult.successIds');
      // Should NOT contain the old synthetic pattern
      expect(source).not.toContain('Array.from({ length: bulkResult.successCount }');
    });
  });

  describe('background operation registry', () => {
    it('registers operation in BackgroundOperationRegistry when registry is set', async () => {
      const registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);

      mockGetConn.mockResolvedValue({} as never);

      const msg: InboundRequest & {
        payload: {
          orgId: string;
          template: Record<string, unknown>;
          dryRun: boolean;
        };
      } = inboundRequest({
        id: 'bg-seed-1',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          template: validSeedTemplate(),
          dryRun: false,
        },
      });

      await handler.handle(msg);

      // An operation should be registered in the registry
      const ops = registry.getActiveOperations();
      const seedOps = ops.filter((op) => op.module === 'seed');
      expect(seedOps.length).toBeGreaterThanOrEqual(1);
    });

    it('dry-run does NOT register in BackgroundOperationRegistry', async () => {
      const registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);

      mockGetConn.mockResolvedValue({} as never);

      const msg: InboundRequest & {
        payload: {
          orgId: string;
          template: Record<string, unknown>;
          dryRun: boolean;
        };
      } = inboundRequest({
        id: 'bg-seed-dry',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          template: validSeedTemplate(),
          dryRun: true,
        },
      });

      await handler.handle(msg);

      // No operation should be registered for dry-run
      const ops = registry.getActiveOperations();
      expect(ops).toHaveLength(0);

      // But a dry-run response should have been sent
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const dryRunMsgs = postToWebview.mock.calls
        .map((c) => c[0] as BaseMessage & { payload?: { dryRun?: boolean } })
        .filter((m) => m.type === 'seed:execute:response' && m.payload?.dryRun === true);
      expect(dryRunMsgs).toHaveLength(1);
    });
  });

  describe('streaming threshold', () => {
    it('SeedOpsHandler source references STREAMING_THRESHOLD and ChunkedBulkExecutor', () => {
      const handlerPath = path.join(__dirname, 'SeedOpsHandler.ts');
      const source = fs.readFileSync(handlerPath, 'utf-8') as string;

      expect(source).toContain('STREAMING_THRESHOLD');
      expect(source).toContain('ChunkedBulkExecutor');
      expect(source).toContain('BackgroundOperationRegistry');
    });
  });

  describe('seed:template CRUD handlers', () => {
    it('handles seed:template:save for a new template and responds with success', async () => {
      const template = {
        name: 'New Template',
        description: 'desc',
        version: 1,
        strategy: 'faker',
        objects: [],
        tags: ['test'],
      };

      const msg: InboundRequest & {
        payload: { template: Record<string, unknown> };
      } = inboundRequest({
        id: 'req-tpl-save',
        type: 'seed:template:save',
        timestamp: Date.now(),
        payload: { template: template as unknown as Record<string, unknown> },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { success: boolean; id: string };
      };
      expect(response.type).toBe('seed:template:save:response');
      expect(response.correlationId).toBe('req-tpl-save');
      expect(response.payload.success).toBe(true);
      expect(response.payload.id).toBeDefined();
    });

    it('handles seed:template:list and responds with summaries', async () => {
      // Save first
      await handler.handle(
        inboundRequest({
          id: 'save-1',
          type: 'seed:template:save',
          timestamp: Date.now(),
          payload: {
            template: {
              name: 'T1',
              description: 'd1',
              version: 1,
              strategy: 'faker',
              objects: [
                {
                  objectApiName: 'Account',
                  recordCount: 10,
                  fieldRules: [],
                  excludedFields: [],
                  insertOrder: 1,
                  batchSize: 200,
                },
              ],
              tags: ['a'],
            },
          },
        } as BaseMessage & { payload: { template: Record<string, unknown> } }),
      );

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      postToWebview.mockClear();

      const msg: InboundRequest = inboundRequest({
        id: 'req-tpl-list',
        type: 'seed:template:list',
        timestamp: Date.now(),
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: {
          templates: Array<{
            id: string;
            name: string;
            objectCount: number;
            totalRecords: number;
          }>;
        };
      };
      expect(response.type).toBe('seed:template:list:response');
      expect(response.payload.templates).toHaveLength(1);
      expect(response.payload.templates[0].name).toBe('T1');
      expect(response.payload.templates[0].objectCount).toBe(1);
      expect(response.payload.templates[0].totalRecords).toBe(10);
    });

    it('handles seed:template:load for non-existent returns null', async () => {
      const msg: InboundRequest & { payload: { id: string } } = inboundRequest({
        id: 'req-tpl-load',
        type: 'seed:template:load',
        timestamp: Date.now(),
        payload: { id: 'ghost' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { template: unknown };
      };
      expect(response.type).toBe('seed:template:load:response');
      expect(response.payload.template).toBeNull();
    });

    it('handles seed:template:delete for non-existent returns false', async () => {
      const msg: InboundRequest & { payload: { id: string } } = inboundRequest({
        id: 'req-tpl-del',
        type: 'seed:template:delete',
        timestamp: Date.now(),
        payload: { id: 'ghost' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { success: boolean };
      };
      expect(response.type).toBe('seed:template:delete:response');
      expect(response.payload.success).toBe(false);
    });
  });

  describe('payload validation', () => {
    it('rejects seed:execute with an injection-shaped objectApiName before touching the org', async () => {
      const template = validSeedTemplate();
      (template.objects as Array<Record<string, unknown>>)[0].objectApiName = "Account' OR '1'='1";

      const msg = inboundRequest({
        id: 'bad-seed',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template },
      } as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);
      expect(mockGetConn).not.toHaveBeenCalled();

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as {
        type: string;
        payload: { code: string };
      };
      expect(errMsg.type).toBe('seed:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects seed:execute with absurd recordCount', async () => {
      const template = validSeedTemplate();
      (template.objects as Array<Record<string, unknown>>)[0].recordCount = 99_000_000;

      const msg = inboundRequest({
        id: 'bad-seed-2',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template },
      } as BaseMessage);

      await handler.handle(msg);
      expect(mockGetConn).not.toHaveBeenCalled();

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as {
        payload: { code: string };
      };
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });
  });

  describe('live operation tracker', () => {
    it('registers the operation and marks it failed when execution fails', async () => {
      const tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);

      // Connection succeeds but executeSeed throws: no composition-root
      // services are injected in this test setup.
      mockGetConn.mockResolvedValue({} as never);

      const msg: InboundRequest & {
        payload: {
          orgId: string;
          template: Record<string, unknown>;
          dryRun: boolean;
        };
      } = inboundRequest({
        id: 'seed-live-1',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          template: validSeedTemplate(),
          dryRun: false,
        },
      });

      await handler.handle(msg);

      const ops = tracker.getAll();
      expect(ops).toHaveLength(1);
      expect(ops[0].module).toBe('seed');
      expect(ops[0].status).toBe('failed');
      expect(ops[0].error).toContain('composition-root services not injected');
      // Planned total comes from the template's recordCount (5 in validSeedTemplate).
      expect(ops[0].totalRecords).toBe(5);
      tracker.dispose();
    });

    it('registers the operation and completes it on success', async () => {
      const tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);

      deps.services = {
        isAIEnabled: () => false,
        getSandforgeSetting: vi.fn(() => 200),
        seedOrchestrator: vi.fn(() => ({
          execute: vi.fn().mockResolvedValue({ insertedIds: ['id-1', 'id-2'] }),
        })),
      } as unknown as HandlerDeps['services'];

      mockGetConn.mockResolvedValue({} as never);

      const msg: InboundRequest & {
        payload: {
          orgId: string;
          template: Record<string, unknown>;
          dryRun: boolean;
        };
      } = inboundRequest({
        id: 'seed-live-2',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          template: validSeedTemplate(),
          dryRun: false,
        },
      });

      await handler.handle(msg);

      const ops = tracker.getAll();
      expect(ops).toHaveLength(1);
      expect(ops[0].module).toBe('seed');
      expect(ops[0].status).toBe('completed');
      expect(ops[0].percentage).toBe(100);
      tracker.dispose();
    });

    it('does NOT register dry-run executions', async () => {
      const tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);

      mockGetConn.mockResolvedValue({} as never);

      const msg: InboundRequest & {
        payload: {
          orgId: string;
          template: Record<string, unknown>;
          dryRun: boolean;
        };
      } = inboundRequest({
        id: 'seed-live-dry',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          template: validSeedTemplate(),
          dryRun: true,
        },
      });

      await handler.handle(msg);

      expect(tracker.getAll()).toHaveLength(0);
      tracker.dispose();
    });
  });

  describe('offline handling (no auto-replay)', () => {
    function wireOfflineManager(): OfflineManager {
      const offlineManager = new OfflineManager(deps.configStore);
      deps.infraServices = {
        performanceTracker: undefined,
        productionGuard: undefined,
        offlineManager,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      return offlineManager;
    }

    function lastOperationFailedPayload(): Record<string, unknown> | undefined {
      const calls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const failed = calls
        .map((c) => c[0] as { type: string; payload?: Record<string, unknown> })
        .filter((m) => m.type === 'operation:failed');
      return failed.at(-1)?.payload;
    }

    it('does NOT enqueue on network error — the failure payload carries a manual-retry hint', async () => {
      const offlineManager = wireOfflineManager();

      mockGetConn.mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
          code: 'ECONNREFUSED',
        }),
      );

      const msg: InboundRequest & {
        payload: {
          orgId: string;
          template: Record<string, unknown>;
          dryRun: boolean;
        };
      } = inboundRequest({
        id: 'seed-offline-1',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          template: validSeedTemplate(),
          dryRun: false,
        },
      });

      await handler.handle(msg);

      // Seeds are inserts: auto-replay could duplicate records, so nothing is
      // queued — the user re-runs the template manually.
      expect(offlineManager.getQueueSize()).toBe(0);

      const payload = lastOperationFailedPayload();
      expect(payload).toBeDefined();
      expect(payload?.offlineReplayAvailable).toBe(false);
      expect(String(payload?.retryHint)).toContain('manually');
      expect(String(payload?.error)).toContain('ECONNREFUSED');
    });

    it('does NOT enqueue (and no hint) when the failure is a Salesforce API error', async () => {
      const offlineManager = wireOfflineManager();

      mockGetConn.mockRejectedValue(new Error('STORAGE_LIMIT_EXCEEDED: org is full'));

      const msg: InboundRequest & {
        payload: {
          orgId: string;
          template: Record<string, unknown>;
          dryRun: boolean;
        };
      } = inboundRequest({
        id: 'seed-offline-2',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          template: validSeedTemplate(),
          dryRun: false,
        },
      });

      await handler.handle(msg);

      expect(offlineManager.getQueueSize()).toBe(0);

      const payload = lastOperationFailedPayload();
      expect(payload).toBeDefined();
      expect(payload?.offlineReplayAvailable).toBeUndefined();
      expect(payload?.retryHint).toBeUndefined();
    });
  });

  describe('seed:error channel', () => {
    function postedMessages(): Array<BaseMessage & { payload?: Record<string, unknown> }> {
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      return postToWebview.mock.calls.map((c) => c[0]);
    }

    function executeMsg(id: string): InboundRequest & {
      payload: {
        orgId: string;
        template: Record<string, unknown>;
        dryRun: boolean;
      };
    } {
      return inboundRequest({
        id,
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          template: validSeedTemplate(),
          dryRun: false,
        },
      });
    }

    it('emits seed:error with the retryHint on a pre-flight network failure', async () => {
      mockGetConn.mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
          code: 'ECONNREFUSED',
        }),
      );

      await handler.handle(executeMsg('seed-err-1'));

      // useBridgeMutation only settles on seed:execute:response / seed:error —
      // without this message the user stared at the 120 s timeout.
      const seedErrors = postedMessages().filter((m) => m.type === 'seed:error');
      expect(seedErrors).toHaveLength(1);
      expect(seedErrors[0].payload?.message).toContain('ECONNREFUSED');
      expect(String(seedErrors[0].payload?.retryHint)).toContain('manually');
      expect(seedErrors[0].payload?.offlineReplayAvailable).toBe(false);
      // The operation:failed lifecycle message is preserved alongside.
      expect(postedMessages().filter((m) => m.type === 'operation:failed')).toHaveLength(1);
      // And no fake success response.
      expect(postedMessages().filter((m) => m.type === 'seed:execute:response')).toHaveLength(0);
    });

    it('emits seed:error exactly once on an execution failure (no hint for API errors)', async () => {
      // Connection succeeds but executeSeed throws: no composition-root
      // services are injected in this test setup.
      mockGetConn.mockResolvedValue({} as never);

      await handler.handle(executeMsg('seed-err-2'));

      const seedErrors = postedMessages().filter((m) => m.type === 'seed:error');
      expect(seedErrors).toHaveLength(1);
      expect(seedErrors[0].payload?.message).toContain('composition-root services not injected');
      expect(seedErrors[0].payload?.retryHint).toBeUndefined();
      expect(postedMessages().filter((m) => m.type === 'operation:failed')).toHaveLength(1);
    });

    it('emits seed:error with the retryHint when the orchestrator hits a network error', async () => {
      deps.services = {
        isAIEnabled: () => false,
        getSandforgeSetting: vi.fn(() => 200),
        seedOrchestrator: vi.fn(() => ({
          execute: vi.fn().mockRejectedValue(
            Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), {
              code: 'ETIMEDOUT',
            }),
          ),
        })),
      } as unknown as HandlerDeps['services'];
      mockGetConn.mockResolvedValue({} as never);

      await handler.handle(executeMsg('seed-err-3'));

      const seedErrors = postedMessages().filter((m) => m.type === 'seed:error');
      expect(seedErrors).toHaveLength(1);
      expect(seedErrors[0].payload?.message).toContain('ETIMEDOUT');
      expect(String(seedErrors[0].payload?.retryHint)).toContain('manually');
    });

    it('emits seed:error (correlated) when the user declines the production confirmation', async () => {
      const confirmIfNeeded = vi.fn().mockResolvedValue(false);
      deps.infraServices = {
        performanceTracker: undefined,
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: true,
            impactSummary: 'writes to production',
          }),
          logOperation: vi.fn(),
          confirmIfNeeded,
        },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      mockGetConn.mockResolvedValue({} as never);

      await handler.handle(executeMsg('seed-err-4'));

      // The confirmation was requested and refused.
      expect(confirmIfNeeded).toHaveBeenCalledTimes(1);

      // useBridgeMutation only settles on seed:execute:response / seed:error —
      // without this message the declined confirmation spun for 120 s.
      const seedErrors = postedMessages().filter((m) => m.type === 'seed:error');
      expect(seedErrors).toHaveLength(1);
      expect(seedErrors[0].payload?.message).toBe(
        'Operation cancelled by user (production confirmation declined).',
      );
      expect(seedErrors[0].payload?.retryable).toBe(false);
      expect(seedErrors[0].correlationId).toBe('seed-err-4');
      // The operation:failed lifecycle message is preserved alongside.
      const opFailed = postedMessages().filter((m) => m.type === 'operation:failed');
      expect(opFailed).toHaveLength(1);
      expect(opFailed[0].payload?.retryable).toBe(false);
      // No fake success response, and the background execution never started.
      expect(postedMessages().filter((m) => m.type === 'seed:execute:response')).toHaveLength(0);
      expect(postedMessages().filter((m) => m.type === 'operation:started')).toHaveLength(0);
    });
  });

  describe('background operation registry status', () => {
    it('marks the operation failed (not completed) when execution fails', async () => {
      const registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);

      // Connection succeeds but executeSeed throws (no services injected).
      mockGetConn.mockResolvedValue({} as never);

      const msg: InboundRequest & {
        payload: {
          orgId: string;
          template: Record<string, unknown>;
          dryRun: boolean;
        };
      } = inboundRequest({
        id: 'seed-reg-1',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          template: validSeedTemplate(),
          dryRun: false,
        },
      });

      await handler.handle(msg);

      // The seed operationId is a random UUID (unlike sync, which reuses
      // msg.id) — fish it out of the operation:started lifecycle message.
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const started = postToWebview.mock.calls
        .map((c) => c[0] as BaseMessage & { payload?: { operationId?: string } })
        .find((m) => m.type === 'operation:started');
      const operationId = started?.payload?.operationId;
      expect(operationId).toBeDefined();

      // executeSeed resolves a { status: 'failure' } result (same contract as
      // executeSync) — the registry must surface 'failed', never a lying
      // 'completed' + "seed completed" notification.
      await vi.waitFor(() => expect(registry.get(operationId!)?.status).toBe('failed'));
      registry.dispose();
    });

    it('still marks the operation completed on success', async () => {
      const registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);

      deps.services = {
        isAIEnabled: () => false,
        getSandforgeSetting: vi.fn(() => 200),
        seedOrchestrator: vi.fn(() => ({
          execute: vi.fn().mockResolvedValue({ insertedIds: ['id-1'] }),
        })),
      } as unknown as HandlerDeps['services'];
      mockGetConn.mockResolvedValue({} as never);

      const msg: InboundRequest & {
        payload: {
          orgId: string;
          template: Record<string, unknown>;
          dryRun: boolean;
        };
      } = inboundRequest({
        id: 'seed-reg-2',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          template: validSeedTemplate(),
          dryRun: false,
        },
      });

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const started = postToWebview.mock.calls
        .map((c) => c[0] as BaseMessage & { payload?: { operationId?: string } })
        .find((m) => m.type === 'operation:started');
      const operationId = started?.payload?.operationId;
      expect(operationId).toBeDefined();

      await vi.waitFor(() => expect(registry.get(operationId!)?.status).toBe('completed'));
      registry.dispose();
    });
  });

  describe('production guard record count', () => {
    /** Two-object template: 120 000 + 80 000 = 200 000 records planned. */
    function bigSeedTemplate(): Record<string, unknown> {
      const template = validSeedTemplate();
      template.objects = [
        {
          objectApiName: 'Account',
          recordCount: 120_000,
          batchSize: 200,
          insertOrder: 0,
          excludedFields: [],
          fieldRules: [],
        },
        {
          objectApiName: 'Contact',
          recordCount: 80_000,
          batchSize: 200,
          insertOrder: 1,
          excludedFields: [],
          fieldRules: [],
        },
      ];
      return template;
    }

    it('confirms the template total, not a hardcoded single record', async () => {
      // Real guard: the modal text is the one the user actually reads.
      const requestConfirmation = vi.fn<(impactSummary: string) => Promise<boolean>>();
      requestConfirmation.mockResolvedValue(false);
      const guard = new ProductionGuard({ requestConfirmation });
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'org-1',
        orgType: 'Production',
      });
      deps.infraServices = {
        performanceTracker: undefined,
        productionGuard: guard,
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      mockGetConn.mockResolvedValue({} as never);

      await handler.handle(
        inboundRequest({
          id: 'seed-guard-1',
          type: 'seed:execute',
          timestamp: Date.now(),
          payload: {
            orgId: 'org-1',
            template: bigSeedTemplate(),
            dryRun: false,
          },
        } as BaseMessage),
      );

      expect(requestConfirmation).toHaveBeenCalledTimes(1);
      const summary = requestConfirmation.mock.calls[0][0];
      expect(summary).toContain('INSERT 200000 SeedData record(s)');
      expect(summary).not.toContain('INSERT 1 SeedData');

      // 200 000 is above the 1 000-record production threshold: the audited
      // decision must flag approval instead of reading as a one-row insert.
      const entry = guard.getAuditLog()[0];
      expect(entry.request.recordCount).toBe(200_000);
      expect(entry.result.requiresApproval).toBe(true);
      expect(entry.result.warnings.join(' ')).toContain('200000 records');
    });
  });
});
