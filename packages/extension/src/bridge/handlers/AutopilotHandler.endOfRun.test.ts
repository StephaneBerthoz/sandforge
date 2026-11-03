import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ApiName, AutopilotEdge, BaseMessage, ForgeTargetAutomation } from '@sandforge/shared';
import { AutopilotHandler } from './AutopilotHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import {
  AutopilotExecutor,
  type AutopilotExecutorDeps,
  type ExecutionResult,
  type QueryFn,
} from '../../modules/autopilot/AutopilotExecutor.js';
import {
  AutopilotOrchestrator,
  type AutopilotOrchestratorDeps,
} from '../../modules/autopilot/AutopilotOrchestrator.js';
import { RecordIdRemapper } from '../../modules/autopilot/RecordIdRemapper.js';
import type { SmartAnonymizer } from '../../modules/autopilot/SmartAnonymizer.js';
import type { SaveOutcome } from '../../core/common/existingRecordMatch.js';

/*
 * The status each node of a run ends on, as the page receives it once the run
 * is over. The run here is the executor's own, behind the orchestrator the
 * extension builds, reading and writing fakes of the two orgs: what the end
 * of the run settles is what the executor left, not a result written by hand
 * for the handler to agree with.
 */

const mockGetConn = vi.mocked(getJsforceConnection);

/** A target with the data storage a small run fits in. */
const ROOMY_CONN = {
  request: vi.fn(async () => ({ DataStorageMB: { Max: 200, Remaining: 150 } })),
};

/** What a target that runs nothing on `objects` answers a read of its automation. */
function quietTarget(objects: readonly string[]): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 6,
  };
}

/** A lookup of the source graph: `from` is the parent, `to` the object that names it. */
function lookup(from: string, to: string, fieldApiName: string): AutopilotEdge {
  return {
    from: from as ApiName,
    to: to as ApiName,
    fieldApiName,
    relationshipType: 'lookup',
    required: false,
  };
}

/** The outcome of a record the target refused. */
function refused(statusCode: string, message: string, fields: string[]): SaveOutcome {
  return {
    id: '',
    success: false,
    errors: [`${statusCode}: ${message}`],
    errorDetails: [{ statusCode, message, fields }],
  };
}

/** Pages of each object's table, after the id the last page ended on. */
function sourceOf(rows: Record<string, Record<string, unknown>[]>): QueryFn {
  return async (objectApiName, afterId, limit) => {
    const list = rows[objectApiName] ?? [];
    const start = afterId === undefined ? 0 : list.findIndex((row) => row['Id'] === afterId) + 1;
    return list.slice(start, start + limit).map((row) => ({ ...row }));
  };
}

/** A promise let go by hand: a read held open while the run is stopped or skipped. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  const store = new ConfigStore(new InMemoryConfigStoreBackend());
  store.initialize();
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    // A real store, read back the way the Reports page reads it.
    configStore: store,
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    infraServices: {
      productionGuard: new ProductionGuard(),
    } as unknown as HandlerDeps['infraServices'],
    nextId: () => String(++idCounter),
  };
}

/** A plan of the waves given, in order, each depending on the one before. */
function planOf(...waves: string[][]): Record<string, unknown> {
  return {
    waves: waves.map((objects, order) => ({
      order,
      objects,
      dependsOn: order === 0 ? [] : [order - 1],
    })),
    totalRecords: 0,
    estimatedDurationSec: 1,
    estimatedApiCalls: 1,
    complianceFramework: 'none',
    anonymizationSummary: { totalRules: 0, rulesByType: {} },
    cycleResolutions: [],
  };
}

type NodeProgress = {
  objectName: string;
  status: string;
  recordCount?: number;
  failureCount?: number;
  notSent?: number;
  error?: string;
  refusals?: Array<{ statusCode: string; count: number }>;
};

describe('AutopilotHandler — the status each node of a run ends on', () => {
  let deps: HandlerDeps;
  let handler: AutopilotHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new AutopilotHandler(deps);
    handler.setTargetAutomation({ read: async (_org, objects) => quietTarget(objects) });
    mockGetConn.mockResolvedValue(ROOMY_CONN as never);
  });

  /** The last node-progress each object was sent: the one the run's end settled it with. */
  function lastStatusOf(): Record<string, NodeProgress> {
    const postToWebview = deps.broker.postToWebview as Mock<(message: BaseMessage) => void>;
    const settled: Record<string, NodeProgress> = {};
    for (const [message] of postToWebview.mock.calls) {
      if (message.type !== 'autopilot:node-progress') continue;
      const payload = (message as BaseMessage & { payload: NodeProgress }).payload;
      settled[payload.objectName] = payload;
    }
    return settled;
  }

  /**
   * Scan and plan with the given source, then start the run through the
   * extension's own orchestrator and executor. Returns the run under way and
   * the result the executor handed back once it is over.
   */
  async function startRun(options: {
    id: string;
    plan: Record<string, unknown>;
    rows: Record<string, Record<string, unknown>[]>;
    edges: AutopilotEdge[];
    query: QueryFn;
    insert: (objectApiName: string, records: Record<string, unknown>[]) => SaveOutcome[];
    batchSize: number;
    /** What else the executor is given of the two orgs. */
    orgs?: Partial<AutopilotExecutorDeps>;
  }): Promise<{ running: Promise<boolean>; result: () => ExecutionResult | undefined }> {
    const anonymizer = {
      anonymize: vi.fn((records: Record<string, unknown>[]) => records),
      getPersonaRegistry: vi.fn(),
    } as unknown as SmartAnonymizer;
    const orchestrator = new AutopilotOrchestrator({
      createExecutor: () =>
        new AutopilotExecutor({
          query: options.query,
          insert: async (objectApiName, records) => options.insert(objectApiName, records),
          anonymizer,
          remapper: new RecordIdRemapper(),
          batchSize: options.batchSize,
          ...options.orgs,
        }),
    } as unknown as AutopilotOrchestratorDeps);
    let ended: ExecutionResult | undefined;
    const recordCounts = new Map(Object.entries(options.rows).map(([name, l]) => [name, l.length]));
    handler.setOrchestrator({
      scanSchemas: vi.fn().mockResolvedValue({
        objectDescribes: new Map(),
        recordCounts,
        totalObjectsScanned: recordCounts.size,
      }),
      buildGraph: vi.fn().mockReturnValue({ nodes: [], edges: options.edges }),
      buildCompliance: vi.fn().mockReturnValue({ profile: {}, rules: [] }),
      generatePlan: vi.fn().mockReturnValue(options.plan),
      executePlan: async (...args: Parameters<AutopilotOrchestrator['executePlan']>) => {
        ended = await orchestrator.executePlan(...args);
        return ended;
      },
      generateReport: vi.fn(),
      pause: () => orchestrator.pause(),
      resume: () => orchestrator.resume(),
      skip: (objectApiName: string) => orchestrator.skip(objectApiName),
    } as unknown as Parameters<AutopilotHandler['setOrchestrator']>[0]);

    await handler.handle(
      inboundRequest({
        id: `scan-${options.id}`,
        type: 'autopilot:scan-schema',
        timestamp: Date.now(),
        payload: {
          sourceOrgId: 'src',
          targetOrgId: 'tgt',
          selectedObjects: [],
          includeStandardObjects: false,
        },
      } as BaseMessage),
    );
    await handler.handle(
      inboundRequest({
        id: `plan-${options.id}`,
        type: 'autopilot:generate-plan',
        timestamp: Date.now(),
        payload: { complianceFramework: 'none' },
      } as BaseMessage),
    );
    const running = handler.handle(
      inboundRequest({
        id: options.id,
        type: 'autopilot:execute',
        timestamp: Date.now(),
        payload: { grappeThreshold: 0 },
      } as BaseMessage),
    );
    return { running, result: () => ended };
  }

  /** The Skip Node of the control panel, for one object. */
  function skipNode(objectApiName: string): InboundRequest {
    return inboundRequest({
      id: `skip-${objectApiName}`,
      type: 'autopilot:skip-node',
      timestamp: Date.now(),
      payload: { objectApiName },
    } as BaseMessage);
  }

  describe('a run with an object skipped, one written and one refused, and one under it', () => {
    // Accounts and campaigns first, then the contacts under the accounts, the
    // members under the campaigns, and the leads the user skips while the
    // first wave writes.
    const rows = {
      Account: [{ Id: 'acc1', Name: 'Acme' }],
      Campaign: [{ Id: 'cmp1', Name: 'Spring' }],
      Contact: [{ Id: 'con1', LastName: 'Doe', AccountId: 'acc1' }],
      CampaignMember: [
        { Id: 'cm1', CampaignId: 'cmp1' },
        { Id: 'cm2', CampaignId: 'cmp1' },
      ],
      Lead: [
        { Id: 'led1', LastName: 'One' },
        { Id: 'led2', LastName: 'Two' },
        { Id: 'led3', LastName: 'Three' },
      ],
    };
    const edges = [
      lookup('Account', 'Contact', 'AccountId'),
      lookup('Campaign', 'CampaignMember', 'CampaignId'),
    ];

    /** Run it, Skip Node sent for the leads while the accounts are read. */
    async function runWithLeadsSkipped(): Promise<{
      sent: string[];
      result: ExecutionResult | undefined;
    }> {
      const accountsRead = gate();
      const reading = gate();
      const source = sourceOf(rows);
      const sent: string[] = [];
      const { running, result } = await startRun({
        id: 'exec-skip',
        plan: planOf(['Account', 'Campaign'], ['Contact', 'CampaignMember', 'Lead']),
        rows,
        edges,
        batchSize: 200,
        query: async (objectApiName, afterId, limit) => {
          if (objectApiName === 'Account' && afterId === undefined) {
            reading.open();
            await accountsRead.opened;
          }
          return source(objectApiName, afterId, limit);
        },
        insert: (objectApiName, records) => {
          sent.push(...records.map(() => objectApiName));
          return records.map((_, i) =>
            objectApiName === 'Campaign'
              ? refused('REQUIRED_FIELD_MISSING', 'Required fields are missing: [Type]', ['Type'])
              : { id: `${objectApiName.slice(0, 3)}T${i}`, success: true, errors: [] },
          );
        },
      });
      await reading.opened;
      await handler.handle(skipNode('Lead'));
      accountsRead.open();
      await running;
      return { sent, result: result() };
    }

    it('ends the object the user skipped as skipped, never completed, with what it did not send', async () => {
      const { sent, result } = await runWithLeadsSkipped();

      // The executor kept it from the target.
      expect(result?.skippedObjects).toEqual(['Lead']);
      expect(sent).not.toContain('Lead');
      expect(lastStatusOf()['Lead']).toMatchObject({
        status: 'skipped',
        recordCount: 0,
        failureCount: 0,
        notSent: 3,
      });
    });

    it('ends an object it wrote as completed, and one the target refused as failed', async () => {
      await runWithLeadsSkipped();

      const settled = lastStatusOf();
      expect(settled['Account']).toMatchObject({ status: 'completed', recordCount: 1 });
      expect(settled['Contact']).toMatchObject({ status: 'completed', recordCount: 1 });
      expect(settled['Campaign']).toMatchObject({
        status: 'failed',
        recordCount: 0,
        failureCount: 1,
        error: expect.stringContaining('REQUIRED_FIELD_MISSING'),
      });
    });

    it('ends an object held back under the parent the target refused as failed, as the executor counts it, never completed', async () => {
      // The executor skips no object for its parent: it holds back each record
      // naming a refused one, counted among the refused, and an object none
      // of whose records went in failed.
      const { sent, result } = await runWithLeadsSkipped();

      expect(sent).not.toContain('CampaignMember');
      expect(result?.failedObjects).toContain('CampaignMember');
      expect(lastStatusOf()['CampaignMember']).toMatchObject({
        status: 'failed',
        recordCount: 0,
        failureCount: 2,
        refusals: [expect.objectContaining({ statusCode: 'PARENT_REFUSED', count: 2 })],
      });
    });

    it('records the skipped object in the audit trail as skipped, with what it did not send', async () => {
      await runWithLeadsSkipped();

      const [entry] = new AuditTrailStore(deps.configStore as ConfigStore).list().entries;
      expect(entry?.objects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ objectApiName: 'Account', created: 1, failed: 0 }),
          expect.objectContaining({ objectApiName: 'Campaign', created: 0, failed: 1 }),
          expect.objectContaining({ objectApiName: 'CampaignMember', created: 0, failed: 2 }),
          {
            objectApiName: 'Lead',
            created: 0,
            updated: 0,
            deleted: 0,
            failed: 0,
            skipped: 'counted',
            notSent: 3,
          },
        ]),
      );
      // An object written or refused is never said skipped.
      expect(entry?.objects?.filter((counts) => counts.skipped !== undefined)).toEqual([
        expect.objectContaining({ objectApiName: 'Lead' }),
      ]);
    });
  });

  it('ends an object of which it held back one record for its record type as completed, with what it wrote, and the audit counts that record among the failed', async () => {
    // Held back whole, the object ended failed with nothing written, its
    // every record counted failed, and the lines under it with it.
    const CLOSED = '012TGT00000HidEAAA';
    const rows: Record<string, Record<string, unknown>[]> = {
      Opportunity: [
        { Id: 'opp1', Name: 'Open', RecordTypeId: null },
        { Id: 'opp2', Name: 'Hidden', RecordTypeId: CLOSED },
      ],
      OpportunityLineItem: [
        { Id: 'oli1', OpportunityId: 'opp1' },
        { Id: 'oli2', OpportunityId: 'opp2' },
      ],
    };
    const sent: string[] = [];
    const { running } = await startRun({
      id: 'exec-record-type',
      plan: planOf(['Opportunity'], ['OpportunityLineItem']),
      rows,
      edges: [lookup('Opportunity', 'OpportunityLineItem', 'OpportunityId')],
      batchSize: 200,
      query: sourceOf(rows),
      insert: (objectApiName, records) => {
        sent.push(...records.map((record) => String(record['Id'])));
        return records.map((_, i) => ({
          id: `${objectApiName.slice(0, 3)}T${i}`,
          success: true,
          errors: [],
        }));
      },
      orgs: {
        // The target's describe, and the source's count per record type.
        describeRecordTypes: async (objectApiName) =>
          objectApiName === 'Opportunity'
            ? [
                {
                  recordTypeId: CLOSED,
                  developerName: 'Hidden_Deal',
                  name: 'Hidden deal',
                  available: false,
                  active: true,
                  master: false,
                  defaultRecordTypeMapping: false,
                },
              ]
            : [],
        countRecordTypes: async (objectApiName) =>
          objectApiName === 'Opportunity' ? new Map([[CLOSED, 1]]) : new Map(),
      },
    });
    await running;

    expect(sent).toEqual(['opp1', 'oli1']);
    const settled = lastStatusOf();
    expect(settled['Opportunity']).toMatchObject({
      status: 'completed',
      recordCount: 1,
      failureCount: 1,
      refusals: [expect.objectContaining({ statusCode: 'RECORD_TYPE_UNAVAILABLE', count: 1 })],
    });
    expect(settled['OpportunityLineItem']).toMatchObject({
      status: 'completed',
      recordCount: 1,
      failureCount: 1,
      refusals: [expect.objectContaining({ statusCode: 'PARENT_REFUSED', count: 1 })],
    });
    const [entry] = new AuditTrailStore(deps.configStore as ConfigStore).list().entries;
    expect(entry?.outcome).toBe('partial');
    expect(entry?.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectApiName: 'Opportunity', created: 1, failed: 1 }),
        expect.objectContaining({ objectApiName: 'OpportunityLineItem', created: 1, failed: 1 }),
      ]),
    );
  });

  it('ends each object a stop cut short or came before as stopped, and the one it wrote as completed', async () => {
    const rows = {
      Account: [{ Id: 'acc1', Name: 'Acme' }],
      Contact: [
        { Id: 'con1', LastName: 'Doe', AccountId: 'acc1' },
        { Id: 'con2', LastName: 'Roe', AccountId: 'acc1' },
      ],
      Lead: [
        { Id: 'led1', LastName: 'One' },
        { Id: 'led2', LastName: 'Two' },
      ],
    };
    const registry = new BackgroundOperationRegistry();
    handler.setRegistry(registry);
    const contactsRead = gate();
    const reading = gate();
    const source = sourceOf(rows);
    // One record a call: the stop comes while the first contact is read, the
    // call is let through, and the second contact is never sent.
    const { running, result } = await startRun({
      id: 'exec-stop',
      plan: planOf(['Account'], ['Contact'], ['Lead']),
      rows,
      edges: [lookup('Account', 'Contact', 'AccountId')],
      batchSize: 1,
      query: async (objectApiName, afterId, limit) => {
        if (objectApiName === 'Contact' && afterId === undefined) {
          reading.open();
          await contactsRead.opened;
        }
        return source(objectApiName, afterId, limit);
      },
      insert: (objectApiName, records) =>
        records.map((_, i) => ({
          id: `${objectApiName.slice(0, 3)}T${i}`,
          success: true,
          errors: [],
        })),
    });
    await reading.opened;
    registry.abort('exec-stop');
    contactsRead.open();
    await running;

    expect(result()?.stoppedObjects).toEqual(['Contact', 'Lead']);
    const settled = lastStatusOf();
    expect(settled['Account']).toMatchObject({ status: 'completed', recordCount: 1 });
    expect(settled['Contact']).toMatchObject({ status: 'stopped', recordCount: 1, notSent: 1 });
    expect(settled['Lead']).toMatchObject({ status: 'stopped', recordCount: 0, notSent: 2 });
  });

  describe('a lookup the second pass could not fill', () => {
    /** A child account read before the parent it names. */
    const rows = {
      Account: [
        { Id: 'child', Name: 'Child', ParentId: 'parent' },
        { Id: 'parent', Name: 'Parent', ParentId: null },
      ],
    };

    /** What the run's end told the page. */
    function completed(): Record<string, unknown> {
      const postToWebview = deps.broker.postToWebview as Mock<(message: BaseMessage) => void>;
      const sent = postToWebview.mock.calls
        .map(([message]) => message)
        .find((message) => message.type === 'autopilot:completed');
      return (sent as BaseMessage & { payload: Record<string, unknown> }).payload;
    }

    /** Run the two accounts, each written or refused as told, the update as told. */
    async function runIt(
      write: (record: Record<string, unknown>, index: number) => SaveOutcome,
      update: (records: Record<string, unknown>[]) => SaveOutcome[],
    ): Promise<ExecutionResult | undefined> {
      const { running, result } = await startRun({
        id: 'exec-lookups',
        plan: planOf(['Account']),
        rows,
        edges: [lookup('Account', 'Account', 'ParentId')],
        batchSize: 200,
        query: sourceOf(rows),
        insert: (_name, records) => records.map(write),
        orgs: { update: async (_name, records) => update(records) },
      });
      await running;
      return result();
    }

    const writeAll = (_record: Record<string, unknown>, index: number): SaveOutcome => ({
      id: `001T${index}`,
      success: true,
      errors: [],
    });

    it('is listed failed in Live Operations once the org refused every record', async () => {
      const tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);

      await runIt(
        () => refused('REQUIRED_FIELD_MISSING', 'Required fields are missing: [Name]', ['Name']),
        () => [],
      );

      expect(tracker.get('exec-lookups')).toMatchObject({
        status: 'failed',
        error: 'No record could be written.',
      });
      tracker.dispose();
    });

    it('ends partial on the page and in the audit, every record written, saying what is left and why', async () => {
      // Counted written and in no failure: the run ended a success, and neither
      // the page nor the audit named the record standing without its parent.
      const noAccess = refused(
        'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
        'insufficient access rights on cross-reference id',
        [],
      );
      const tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);
      const result = await runIt(writeAll, () => [noAccess]);

      expect(tracker.get('exec-lookups')?.status).toBe('partial');
      tracker.dispose();
      expect(result).toMatchObject({ totalSuccess: 2, totalFailure: 0, failedObjects: [] });
      const refusal = {
        statusCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
        fields: ['ParentId'],
        count: 1,
        message: 'insufficient access rights on cross-reference id',
      };
      expect(lastStatusOf()['Account']).toMatchObject({
        status: 'completed',
        recordCount: 2,
        failureCount: 0,
        lookupsFilled: 0,
        lookupRefusals: [refusal],
      });
      expect(completed()).toMatchObject({
        status: 'partial',
        lookupsNotFilled: [{ objectApiName: 'Account', records: 1, refusals: [refusal] }],
      });
      const [entry] = new AuditTrailStore(deps.configStore as ConfigStore).list().entries;
      expect(entry?.outcome).toBe('partial');
      expect(entry?.objects).toEqual([
        expect.objectContaining({
          objectApiName: 'Account',
          created: 2,
          failed: 0,
          lookupsNotFilled: 1,
        }),
      ]);
    });

    it('says the child of a parent the target refused, written before it, under its parent’s refusal', async () => {
      await runIt(
        (record, index) =>
          record['Name'] === 'Parent'
            ? refused('REQUIRED_FIELD_MISSING', 'Required fields are missing: [Industry]', [
                'Industry',
              ])
            : writeAll(record, index),
        () => [],
      );

      const left = [
        expect.objectContaining({ statusCode: 'PARENT_REFUSED', fields: ['ParentId'] }),
      ];
      expect(lastStatusOf()['Account']).toMatchObject({ lookupRefusals: left });
      expect(completed()).toMatchObject({
        status: 'partial',
        lookupsNotFilled: [{ objectApiName: 'Account', records: 1, refusals: left }],
      });
      const [entry] = new AuditTrailStore(deps.configStore as ConfigStore).list().entries;
      expect(entry?.objects).toEqual([
        expect.objectContaining({ created: 1, failed: 1, lookupsNotFilled: 1 }),
      ]);
    });

    it('ends a success, with nothing to say, when the pass filled them all', async () => {
      await runIt(writeAll, (records) =>
        records.map((record) => ({ id: String(record['Id']), success: true, errors: [] })),
      );

      expect(lastStatusOf()['Account']).toMatchObject({ lookupsFilled: 1, lookupRefusals: [] });
      expect(completed()['status']).toBe('success');
      expect(completed()).not.toHaveProperty('lookupsNotFilled');
      const [entry] = new AuditTrailStore(deps.configStore as ConfigStore).list().entries;
      expect(entry?.outcome).toBe('success');
      expect(entry?.objects).toEqual([expect.not.objectContaining({ lookupsNotFilled: 1 })]);
    });
  });
});
