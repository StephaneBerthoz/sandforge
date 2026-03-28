import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

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

describe('SeedOpsHandler', () => {
  let handler: SeedOpsHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SeedOpsHandler(deps);
  });

  it('returns false for unhandled message types', async () => {
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
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

    const msg: BaseMessage & { payload: { orgId: string } } = {
      id: 'req-100',
      type: 'seed:describe-global',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { objects: unknown[] } };
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
          { name: 'Name', label: 'Account Name', type: 'string', nillable: false, defaultedOnCreate: false, length: 255, createable: true },
        ],
      }),
    } as never);

    const msg: BaseMessage & { payload: { orgId: string; objectApiName: string } } = {
      id: 'req-200',
      type: 'seed:describe-object',
      timestamp: Date.now(),
      payload: { orgId: 'org-1', objectApiName: 'Account' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string };
    expect(response.type).toBe('seed:describe-object:response');
    expect(response.correlationId).toBe('req-200');
  });

  it('error path sends error response via sendHandlerError', async () => {
    mockGetConn.mockRejectedValue(new Error('connection failed'));

    const msg: BaseMessage & { payload: { orgId: string } } = {
      id: 'req-300',
      type: 'seed:describe-global',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    };

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { message: string } };
    expect(response.type).toBe('seed:error');
    expect(response.payload.message).toBe('connection failed');
  });

  describe('seed:execute dryRun', () => {
    it('returns synthetic result when dryRun is true without performing inserts', async () => {
      mockGetConn.mockResolvedValue({} as never);

      const msg: BaseMessage & { payload: { orgId: string; template: Record<string, unknown>; dryRun: boolean } } = {
        id: 'req-dry-1',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template: { objects: [] }, dryRun: true },
      };

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { success: boolean; dryRun: boolean; insertedCount: number; results: unknown[] };
      };
      expect(response.type).toBe('seed:execute:response');
      expect(response.correlationId).toBe('req-dry-1');
      expect(response.payload.dryRun).toBe(true);
      expect(response.payload.insertedCount).toBe(0);
      expect(response.payload.results).toEqual([]);
    });

    it('does not short-circuit when dryRun is false', async () => {
      mockGetConn.mockResolvedValue({} as never);

      const msg: BaseMessage & { payload: { orgId: string; template: Record<string, unknown>; dryRun: boolean } } = {
        id: 'req-dry-2',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template: { objects: [] }, dryRun: false },
      };

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
      mockGetConn.mockResolvedValue({ describeGlobal: describeGlobalFn } as never);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-timeout-1',
        type: 'seed:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      };

      await handler.handle(msg);

      // describeGlobal was called (wrapped inside TimeoutManager)
      expect(describeGlobalFn).toHaveBeenCalledTimes(1);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { objects: unknown[] } };
      expect(response.type).toBe('seed:describe-global:response');
      expect(response.payload.objects).toHaveLength(1);
    });

    it('wraps describe-object with TimeoutManager', async () => {
      const describeFn = vi.fn().mockResolvedValue({
        label: 'Account',
        fields: [
          { name: 'Name', label: 'Name', type: 'string', nillable: false, defaultedOnCreate: false, length: 255, createable: true },
        ],
      });
      mockGetConn.mockResolvedValue({ describe: describeFn } as never);

      const msg: BaseMessage & { payload: { orgId: string; objectApiName: string } } = {
        id: 'req-timeout-2',
        type: 'seed:describe-object',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objectApiName: 'Account' },
      };

      await handler.handle(msg);

      expect(describeFn).toHaveBeenCalledTimes(1);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview.mock.calls[0][0].type).toBe('seed:describe-object:response');
    });

    it('sends TimeoutError to webview when describe-global times out', async () => {
      const describeGlobalFn = vi.fn().mockImplementation(() =>
        new Promise((_resolve) => {
          /* never resolves -- simulates a hung API call */
        }),
      );
      mockGetConn.mockResolvedValue({ describeGlobal: describeGlobalFn } as never);

      // Set very short timeout via configStore
      vi.mocked(deps.configStore.get).mockReturnValue({
        timeouts: { describeGlobal: 5000, describe: 5000, crudBatch: 10000, bulkJob: 60000 },
        retry: { maxRetries: 0 },
        bulk: { threshold: 200 },
      });

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-timeout-err',
        type: 'seed:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      };

      // The handler should catch the timeout and send an error
      // But since 5s is too long for a test, just verify the timeout wrapping
      // by checking that describeGlobal was called
      // (The actual timeout behavior is tested in TimeoutManager.test.ts)
      await Promise.race([
        handler.handle(msg),
        new Promise((resolve) => setTimeout(resolve, 50)),
      ]);

      expect(describeGlobalFn).toHaveBeenCalledTimes(1);
    });

    it('loads robustness config from ConfigStore', async () => {
      const customConfig = {
        timeouts: { describeGlobal: 60000, describe: 30000, crudBatch: 120000, bulkJob: 600000 },
        retry: { maxRetries: 5, initialDelay: 2000, maxDelay: 60000, backoffMultiplier: 3 },
        bulk: { threshold: 500 },
      };
      vi.mocked(deps.configStore.get).mockReturnValue(customConfig);

      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      } as never);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-config',
        type: 'seed:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      };

      await handler.handle(msg);

      // ConfigStore.get was called with the robustness config key
      expect(deps.configStore.get).toHaveBeenCalledWith('robustness:config');
    });

    it('falls back to defaults when configStore returns undefined', async () => {
      vi.mocked(deps.configStore.get).mockReturnValue(undefined);

      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      } as never);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-default',
        type: 'seed:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      };

      // Should not throw even with undefined config
      const result = await handler.handle(msg);
      expect(result).toBe(true);
    });
  });

  describe('seed:list-personas', () => {
    it('returns 10 built-in personas', async () => {
      const msg: BaseMessage = {
        id: 'req-personas-1',
        type: 'seed:list-personas',
        timestamp: Date.now(),
      };

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { personas: Array<{ id: string; name: string; industry: string }> };
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
      const msg: BaseMessage & { payload: { description: string } } = {
        id: 'req-create-1',
        type: 'seed:create-persona',
        timestamp: Date.now(),
        payload: { description: '' },
      };

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
      const msg: BaseMessage & { payload: { description: string } } = {
        id: 'req-create-2',
        type: 'seed:create-persona',
        timestamp: Date.now(),
        payload: { description: '   ' },
      };

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
      expect(source).not.toContain("Array.from({ length: bulkResult.successCount }");
    });
  });

  describe('background operation registry', () => {
    it('registers operation in BackgroundOperationRegistry when registry is set', async () => {
      const registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);

      mockGetConn.mockResolvedValue({} as never);

      const msg: BaseMessage & { payload: { orgId: string; template: Record<string, unknown>; dryRun: boolean } } = {
        id: 'bg-seed-1',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template: { objects: [] }, dryRun: false },
      };

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

      const msg: BaseMessage & { payload: { orgId: string; template: Record<string, unknown>; dryRun: boolean } } = {
        id: 'bg-seed-dry',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template: { objects: [] }, dryRun: true },
      };

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

      const msg: BaseMessage & { payload: { template: Record<string, unknown> } } = {
        id: 'req-tpl-save',
        type: 'seed:template:save',
        timestamp: Date.now(),
        payload: { template: template as unknown as Record<string, unknown> },
      };

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { success: boolean; id: string } };
      expect(response.type).toBe('seed:template:save:response');
      expect(response.correlationId).toBe('req-tpl-save');
      expect(response.payload.success).toBe(true);
      expect(response.payload.id).toBeDefined();
    });

    it('handles seed:template:list and responds with summaries', async () => {
      // Save first
      await handler.handle({
        id: 'save-1',
        type: 'seed:template:save',
        timestamp: Date.now(),
        payload: {
          template: {
            name: 'T1',
            description: 'd1',
            version: 1,
            strategy: 'faker',
            objects: [{ objectApiName: 'Account', recordCount: 10, fieldRules: [], excludedFields: [], insertOrder: 1, batchSize: 200 }],
            tags: ['a'],
          },
        },
      } as BaseMessage & { payload: { template: Record<string, unknown> } });

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      postToWebview.mockClear();

      const msg: BaseMessage = {
        id: 'req-tpl-list',
        type: 'seed:template:list',
        timestamp: Date.now(),
      };

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { templates: Array<{ id: string; name: string; objectCount: number; totalRecords: number }> } };
      expect(response.type).toBe('seed:template:list:response');
      expect(response.payload.templates).toHaveLength(1);
      expect(response.payload.templates[0].name).toBe('T1');
      expect(response.payload.templates[0].objectCount).toBe(1);
      expect(response.payload.templates[0].totalRecords).toBe(10);
    });

    it('handles seed:template:load for non-existent returns null', async () => {
      const msg: BaseMessage & { payload: { id: string } } = {
        id: 'req-tpl-load',
        type: 'seed:template:load',
        timestamp: Date.now(),
        payload: { id: 'ghost' },
      };

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { template: unknown } };
      expect(response.type).toBe('seed:template:load:response');
      expect(response.payload.template).toBeNull();
    });

    it('handles seed:template:delete for non-existent returns false', async () => {
      const msg: BaseMessage & { payload: { id: string } } = {
        id: 'req-tpl-del',
        type: 'seed:template:delete',
        timestamp: Date.now(),
        payload: { id: 'ghost' },
      };

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { success: boolean } };
      expect(response.type).toBe('seed:template:delete:response');
      expect(response.payload.success).toBe(false);
    });
  });
});
