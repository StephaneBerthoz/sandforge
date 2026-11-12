import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { SeedExecutionResult } from '@sandforge/shared';
import { DEFAULT_ROBUSTNESS_CONFIG } from '@sandforge/shared';
import type { SeedOrchestratorDependencies } from '../../modules/seed/SeedOrchestrator.js';
import { contactRolesSoql } from '../../core/common/platformRecords.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/*
 * The panel's seed reads the contact roles the platform writes with the
 * opportunities it inserts with their contact, and updates the one it links
 * the role it generated to, through the target's connection: without them,
 * the role went in beside the platform's.
 */

function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      delete: vi.fn(),
      has: vi.fn(() => false),
      getKeysByPrefix: vi.fn(() => []),
      getByCategory: vi.fn(() => ({})),
      getAllKeys: vi.fn(() => []),
      clearCategory: vi.fn(),
      clearAll: vi.fn(),
      initialize: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    robustness: {
      ...DEFAULT_ROBUSTNESS_CONFIG,
      retry: { ...DEFAULT_ROBUSTNESS_CONFIG.retry, maxRetries: 0 },
    },
    infraServices: {
      productionGuard: new ProductionGuard({ requestRunConfirmation: async () => true }),
    } as unknown as HandlerDeps['infraServices'],
    nextId: () => String(++idCounter),
  };
}

function seedTemplate(): Record<string, unknown> {
  return {
    id: 'tpl-roles',
    name: 'roles',
    description: 'test',
    version: 1,
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Account',
        recordCount: 1,
        batchSize: 200,
        insertOrder: 0,
        excludedFields: [],
        fieldRules: [],
      },
    ],
    tags: [],
    createdAt: '2026-11-05T00:00:00Z',
    updatedAt: '2026-11-05T00:00:00Z',
  };
}

function emptySeedResult(): SeedExecutionResult {
  return {
    templateId: 'tpl-roles',
    operationId: 'op-1',
    status: 'success',
    objectResults: [],
    totalRecordsCreated: 0,
    totalRecordsFailed: 0,
    duration: 1,
    timestamp: '2026-11-05T00:00:00.000Z',
  };
}

/** The dependencies the handler hands the orchestrator, for `seed:execute`. */
async function captureDeps(deps: HandlerDeps): Promise<SeedOrchestratorDependencies> {
  let captured: SeedOrchestratorDependencies | undefined;
  deps.services = {
    getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback,
    isAIEnabled: () => false,
    aiClient: () => ({ chat: () => Promise.reject(new Error('no AI in this test')) }),
    seedOrchestrator: (orchestratorDeps: SeedOrchestratorDependencies) => {
      captured = orchestratorDeps;
      return { execute: () => Promise.resolve(emptySeedResult()) };
    },
  } as unknown as HandlerDeps['services'];
  const msg: InboundRequest = inboundRequest({
    id: 'req-roles-1',
    type: 'seed:execute',
    timestamp: Date.now(),
    payload: { orgId: 'org-1', template: seedTemplate(), dryRun: false },
  });
  await new SeedOpsHandler(deps).handle(msg);
  if (!captured) throw new Error('seed:execute never reached the orchestrator factory');
  return captured;
}

describe('SeedOpsHandler — the contact roles the platform writes with the opportunities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the roles through the target and updates the one linked record by record', async () => {
    const role = { Id: '00K000000000001AAA', OpportunityId: '006000000000001AAA' };
    const query = vi.fn(async () => ({ done: true, totalSize: 1, records: [role] }));
    const update = vi.fn(async () => [{ success: true, id: role.Id }]);
    const create = vi.fn();
    mockGetConn.mockResolvedValue({
      query,
      sobject: () => ({ create, update }),
    } as never);

    const orchestrator = await captureDeps(createMockDeps());
    const soql = contactRolesSoql([role.OpportunityId], ['Role']);

    expect(await orchestrator.readTarget?.(soql)).toEqual([role]);
    expect(query).toHaveBeenCalledWith(soql);
    expect(
      await orchestrator.update?.('org-1', 'OpportunityContactRole', [
        { Id: role.Id, Role: 'Decision Maker' },
      ]),
    ).toEqual([{ success: true }]);
    // With the headers of every write of a seed, as its inserts go.
    expect(update).toHaveBeenCalledWith([{ Id: role.Id, Role: 'Decision Maker' }], {
      allOrNone: false,
      headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true', 'Sforce-Auto-Assign': 'FALSE' },
    });
  });
});
