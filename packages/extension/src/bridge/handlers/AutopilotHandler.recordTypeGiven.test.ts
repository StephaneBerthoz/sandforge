import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutopilotHandler } from './AutopilotHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage, ForgeTargetAutomation, RecordTypeGiven } from '@sandforge/shared';
import type { AutopilotRunOptions } from '../../modules/autopilot/AutopilotExecutor.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/*
 * The panel's run says on each node the record type the target gave the
 * records it created without one, and hands the executor the mute's lease:
 * the bypass given back once the last write is through, before the read back.
 */

const SET = '0PSxx0000000001AAA';

const PLAN = {
  waves: [{ order: 0, objects: ['Lead'], dependsOn: [] }],
  totalRecords: 30,
  estimatedDurationSec: 1,
  estimatedApiCalls: 2,
  complianceFramework: 'none',
  anonymizationSummary: { totalRules: 0, rulesByType: {} },
  cycleResolutions: [],
};

/** What the target runs on the leads: a flow its bypass, held by `Data_Load`, keeps quiet. */
const LEAD_FLOW: ForgeTargetAutomation = {
  objectsRead: ['Lead'],
  objects: [
    {
      objectApiName: 'Lead',
      flows: [
        {
          apiName: 'Lead_Welcome',
          label: 'Lead welcome',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [{ name: 'Load_Data', bypass: true }],
          creates: [],
        },
      ],
      triggers: [],
    },
  ],
  bypassGrants: [
    {
      permission: 'Load_Data',
      permissionSets: [{ name: 'Data_Load', label: 'Data load', grants: 1 }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
};

const GIVEN: RecordTypeGiven = {
  objectApiName: 'Lead',
  rows: 20,
  why: { masterInSource: 20 },
  predicted: { developerName: 'SFX_Retail', label: 'SFX Retail', basis: 'onlyOneOpen' },
  readBack: {
    read: 20,
    types: [{ developerName: 'SFX_Retail', label: 'SFX Retail', rows: 20 }],
  },
};

describe('autopilot:execute, the record type the target gave', () => {
  let handler: AutopilotHandler;
  let deps: HandlerDeps;
  let calls: string[];
  let dir: string;

  beforeEach(() => {
    mockGetConn.mockReset();
    calls = [];
    dir = mkdtempSync(path.join(tmpdir(), 'autopilot-record-type-'));
    const store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType: 'Sandbox', alias: 'TGT' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard({ requestRunConfirmation: async () => true }),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new AutopilotHandler(deps);
    handler.setMuteLeases({ dir, renewEveryMs: 0 });
    handler.setTargetAutomation({ read: vi.fn(async () => LEAD_FLOW) });
    const org = memoryPermissionOrg({
      sets: [{ id: SET, name: 'Data_Load' }],
      beforeWrite: (write) => {
        calls.push(`assignment ${write.kind}`);
      },
    });
    mockGetConn.mockResolvedValue({
      ...org.connection,
      request: vi.fn(async () => ({
        DataStorageMB: { Max: 200, Remaining: 150 },
        DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
      })),
    } as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Scan, plan and execute the plan of leads. The orchestrator stands in for
   * the executor: it writes, gives back the lease it was handed, reads back
   * and answers the type given on the outcome.
   */
  async function run(payload: Record<string, unknown>) {
    const executePlan = vi.fn(
      async (
        _plan: unknown,
        _graph: unknown,
        _rules: unknown,
        _counts: unknown,
        _onNodeSettled: unknown,
        _signal: unknown,
        _parentIds: unknown,
        options: AutopilotRunOptions,
      ) => {
        calls.push('written');
        await options.lease?.giveBack();
        calls.push('read back');
        return {
          totalSuccess: 30,
          totalFailure: 0,
          totalSkipped: 0,
          elapsedMs: 10,
          completedObjects: ['Lead'],
          failedObjects: [],
          skippedObjects: [],
          objectOutcomes: {
            Lead: { written: 30, linked: 0, failed: 0, refusals: [], recordTypeGiven: GIVEN },
          },
        };
      },
    );
    handler.setOrchestrator({
      scanSchemas: vi.fn().mockResolvedValue({
        objectDescribes: new Map(),
        recordCounts: new Map([['Lead', 30]]),
        parentIds: new Map(),
        personAccounts: new Map(),
        totalObjectsScanned: 1,
      }),
      buildGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
      buildCompliance: vi.fn().mockReturnValue({ profile: {}, rules: [] }),
      generatePlan: vi.fn().mockReturnValue(PLAN),
      executePlan,
      pause: vi.fn(),
      resume: vi.fn(),
      skip: vi.fn(),
    } as unknown as Parameters<AutopilotHandler['setOrchestrator']>[0]);
    const send = (id: string, type: string, body: Record<string, unknown>) =>
      handler.handle(
        inboundRequest({ id, type, timestamp: Date.now(), payload: body } as BaseMessage),
      );
    await send('scan-1', 'autopilot:scan-schema', {
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      selectedObjects: [],
      includeStandardObjects: false,
    });
    await send('plan-1', 'autopilot:generate-plan', { complianceFramework: 'none' });
    await send('exec-1', 'autopilot:execute', { grappeThreshold: 0, ...payload });
    return { executePlan };
  }

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  it('hands the executor the lease, which it gives back after the last write and before the read back', async () => {
    const { executePlan } = await run({ muteAutomation: true });

    expect(executePlan.mock.calls[0]?.[7].lease?.assigned).toBe(1);
    // Given back by the executor; given back again as the run ends, it answers the same.
    expect(calls).toEqual(['assignment insert', 'written', 'assignment delete', 'read back']);
    const steps: Record<string, WritePathStep> = {
      'assignment insert': 'leaseAcquire',
      written: 'write',
      'assignment delete': 'leaseRelease',
      'read back': 'recordTypeReadBack',
    };
    expect(
      writePathOrderDefects([
        'reads',
        'leasePlan',
        'stillRunning',
        'question',
        ...calls.flatMap((call) => (steps[call] ? [steps[call]] : [])),
        'result',
      ]),
    ).toEqual([]);
  });

  it('hands a run with no mute no lease, its emails and phone numbers as asked', async () => {
    const { executePlan } = await run({ keepContactPoints: true });

    expect(executePlan.mock.calls[0]?.[7]).toEqual({ keepContactPoints: true });
  });

  it('says on the node the type the target gave the records created without one', async () => {
    await run({});

    const settled = posted('autopilot:node-progress').filter(
      (message) => message.payload['status'] === 'completed',
    );
    expect(settled.at(-1)?.payload).toMatchObject({ objectName: 'Lead', recordTypeGiven: GIVEN });
  });
});
