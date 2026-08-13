import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** Result shape of the insert function the handler hands to the orchestrator. */
type InsertResult = { successIds: string[]; errors: string[] };

/** The insert function signature built inside `SeedOpsHandler.executeSeed`. */
type InsertFn = (
  orgId: string,
  objectApiName: string,
  records: Record<string, unknown>[],
  batchSize: number,
) => Promise<InsertResult>;

/**
 * ConfigStore double serving one key: the robustness config. Retries are
 * disabled so a rejecting `create()` settles immediately instead of burning
 * the default 1s/2s/4s backoff.
 */
function createConfigStore(): HandlerDeps['configStore'] {
  return {
    get: vi.fn((key: string) =>
      key === 'robustness:config'
        ? { retry: { maxRetries: 0 }, bulk: { threshold: 200 } }
        : undefined,
    ),
    set: vi.fn(),
    delete: vi.fn(),
    has: vi.fn(() => false),
    getKeysByPrefix: vi.fn(() => []),
    getByCategory: vi.fn(() => ({})),
    getAllKeys: vi.fn(() => []),
    clearCategory: vi.fn(),
    clearAll: vi.fn(),
    initialize: vi.fn(),
  } as unknown as HandlerDeps['configStore'];
}

function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: createConfigStore(),
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

function seedTemplate(): Record<string, unknown> {
  return {
    id: 'tpl-fail',
    name: 'batch-failure',
    description: 'test',
    version: 1,
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Account',
        recordCount: 180,
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

/**
 * Drive `seed:execute` far enough to capture the insert function the handler
 * builds, by standing in for the orchestrator factory.
 */
async function captureInsertFn(deps: HandlerDeps): Promise<InsertFn> {
  let captured: InsertFn | undefined;
  deps.services = {
    getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback,
    // AIDataGenerator is constructed unconditionally before the orchestrator.
    isAIEnabled: () => false,
    aiClient: () => ({ chat: () => Promise.reject(new Error('no AI in this test')) }),
    seedOrchestrator: (orchestratorDeps: { insert: InsertFn }) => {
      captured = orchestratorDeps.insert;
      return { execute: () => Promise.resolve({ insertedIds: [] }) };
    },
  } as unknown as HandlerDeps['services'];

  const handler = new SeedOpsHandler(deps);
  const msg: BaseMessage & {
    payload: { orgId: string; template: Record<string, unknown>; dryRun: boolean };
  } = {
    id: 'req-insert-1',
    type: 'seed:execute',
    timestamp: Date.now(),
    payload: { orgId: 'org-1', template: seedTemplate(), dryRun: false },
  };
  await handler.handle(msg);

  if (!captured) {
    const posted = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      JSON.stringify(c[0]),
    );
    throw new Error(`seed:execute never reached the orchestrator factory: ${posted.join(' | ')}`);
  }
  return captured;
}

describe('SeedOpsHandler REST insert error accounting', () => {
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
  });

  it('reports one error per record when a whole REST batch fails', async () => {
    const create = vi.fn().mockRejectedValue(new Error('INVALID_FIELD: no such column'));
    mockGetConn.mockResolvedValue({ sobject: () => ({ create }) } as never);

    const insert = await captureInsertFn(deps);
    const records = Array.from({ length: 180 }, (_, i) => ({ Name: `Acme ${i}` }));

    const result = await insert('org-1', 'Account', records, 200);

    // recordsFailed in SeedOrchestrator is `insertResult.errors.length` — one
    // push per lost batch would report 180 dead records as a single failure.
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.successIds).toHaveLength(0);
    expect(result.errors).toHaveLength(180);
    expect(result.errors[0]).toContain('INVALID_FIELD');
    expect(result.errors[179]).toContain('INVALID_FIELD');
  });

  it('counts every record of every failed batch, not every batch', async () => {
    const create = vi.fn().mockRejectedValue(new Error('SERVER_UNAVAILABLE'));
    mockGetConn.mockResolvedValue({ sobject: () => ({ create }) } as never);

    const insert = await captureInsertFn(deps);
    const records = Array.from({ length: 150 }, (_, i) => ({ Name: `Acme ${i}` }));

    // batchSize 50 -> 3 batches, all lost.
    const result = await insert('org-1', 'Account', records, 50);

    expect(create).toHaveBeenCalledTimes(3);
    expect(result.errors).toHaveLength(150);
  });

  it('still reports per-record errors when the batch itself succeeds', async () => {
    const create = vi.fn().mockResolvedValue([
      { success: true, id: '001000000000001' },
      { success: false, errors: [{ message: 'REQUIRED_FIELD_MISSING: Name' }] },
    ]);
    mockGetConn.mockResolvedValue({ sobject: () => ({ create }) } as never);

    const insert = await captureInsertFn(deps);
    const result = await insert('org-1', 'Account', [{ Name: 'a' }, {}], 200);

    expect(result.successIds).toEqual(['001000000000001']);
    expect(result.errors).toEqual(['REQUIRED_FIELD_MISSING: Name']);
  });
});
