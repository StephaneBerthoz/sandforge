import { describe, it, expect, vi } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import type { ApiName } from '@sandforge/shared';
import { initAutopilotComposition } from './autopilotComposition.js';
import { AutopilotOrchestrator } from '../modules/autopilot/AutopilotOrchestrator.js';
import type {
  AutopilotConnection,
  ObjectDescribeResult,
  GlobalSObjectDescribe,
} from '../modules/autopilot/SchemaScanner.js';
import { AutopilotHandler } from '../bridge/handlers/AutopilotHandler.js';
import type { HandlerDeps, InboundRequest } from '../bridge/handlers/HandlerTypes.js';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers.js';
import { inboundRequest } from '../test/mockFactories.js';

/** Captures the orchestrator injected through setAutopilotOrchestrator. */
function createFakeHandlers() {
  let orchestrator: AutopilotOrchestrator | undefined;
  const setAutopilotOrchestrator = vi.fn((o: AutopilotOrchestrator) => {
    orchestrator = o;
  });
  const handlers = { setAutopilotOrchestrator } as unknown as ExtensionHandlers;
  return {
    handlers,
    setAutopilotOrchestrator,
    getOrchestrator: (): AutopilotOrchestrator => {
      if (!orchestrator) throw new Error('orchestrator was not injected');
      return orchestrator;
    },
  };
}

/** Minimal mock deps for the route-response test (mirrors AutopilotHandler.test.ts). */
function createMockHandlerDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn(),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

function mockObjectDescribe(name: string): ObjectDescribeResult {
  return {
    name,
    label: name,
    custom: false,
    keyPrefix: '001',
    fields: [],
    recordTypeInfos: [],
  };
}

function globalSObject(name: string): GlobalSObjectDescribe {
  return {
    name,
    label: name,
    custom: false,
    queryable: true,
    createable: true,
    deletable: true,
    updateable: true,
  };
}

/**
 * Fake org connection covering both the scan surface (AutopilotConnection) and
 * the executor surfaces the composition uses at runtime (query + sobject().create
 * — recovered via the documented cast in autopilotComposition).
 */
function fakeOrg(
  recordCount: number,
  queriedRecords: Record<string, unknown>[],
  insertedId: string,
): {
  conn: AutopilotConnection;
  query: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue({ id: insertedId, success: true });
  const query = vi.fn().mockImplementation((soql: string) =>
    soql.includes('COUNT()')
      ? Promise.resolve({ totalSize: recordCount, done: true, records: [] })
      : Promise.resolve({
          totalSize: queriedRecords.length,
          done: true,
          records: queriedRecords,
        }),
  );
  const conn = {
    describe: vi
      .fn()
      .mockImplementation((name: string) => Promise.resolve(mockObjectDescribe(name))),
    describeGlobal: vi.fn().mockResolvedValue({ sobjects: [globalSObject('Account')] }),
    query,
    sobject: vi.fn(() => ({ create })),
  } as unknown as AutopilotConnection;
  return { conn, query, create };
}

/** Drive the real scan → graph → plan → execute flow for one Account record. */
async function runOneAccountFlow(
  orchestrator: AutopilotOrchestrator,
  source: AutopilotConnection,
  target: AutopilotConnection,
): Promise<{ totalSuccess: number; completedObjects: string[] }> {
  const scanResult = await orchestrator.scanSchemas(source, target, {
    selectedObjects: ['Account' as ApiName],
    includeStandardObjects: false,
  });
  const graph = orchestrator.buildGraph(scanResult);
  const plan = orchestrator.generatePlan(graph, 'gdpr', []);
  // Empty rules: anonymization is a no-op so insert assertions stay deterministic.
  return orchestrator.executePlan(plan, graph, [], scanResult.recordCounts);
}

describe('autopilotComposition', () => {
  it('injects a real AutopilotOrchestrator through setAutopilotOrchestrator', async () => {
    const { handlers, setAutopilotOrchestrator, getOrchestrator } = createFakeHandlers();
    const log = vi.fn();

    await initAutopilotComposition({ handlers, log });

    expect(setAutopilotOrchestrator).toHaveBeenCalledTimes(1);
    expect(getOrchestrator()).toBeInstanceOf(AutopilotOrchestrator);
    expect(log).toHaveBeenCalledWith('Autopilot module initialized.');
  });

  it('lifts the NOT_INITIALIZED guard on autopilot routes once injected', async () => {
    const deps = createMockHandlerDeps();
    const handler = new AutopilotHandler(deps);
    const pauseMsg: InboundRequest = inboundRequest({
      id: 'p1',
      type: 'autopilot:pause',
      timestamp: Date.now(),
    });

    // Before injection: the honest guard answers.
    await handler.handle(pauseMsg);

    const { handlers, getOrchestrator } = createFakeHandlers();
    await initAutopilotComposition({ handlers, log: vi.fn() });
    handler.setOrchestrator(getOrchestrator());

    // After injection: the route answers with business behavior.
    await handler.handle(pauseMsg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const messages = postToWebview.mock.calls.map(
      (c) => (c[0] as BaseMessage & { payload: { message: string } }).payload.message,
    );
    expect(messages[0]).toBe('Autopilot module is not initialized.');
    expect(messages[1]).toBe('No autopilot execution in progress.');
  });

  it('createExecutor rejects before any scan captured connections', async () => {
    const { handlers, getOrchestrator } = createFakeHandlers();
    await initAutopilotComposition({ handlers, log: vi.fn() });

    const orchestrator = getOrchestrator();
    await expect(
      orchestrator.executePlan(
        { waves: [] } as unknown as Parameters<AutopilotOrchestrator['executePlan']>[0],
        { nodes: [], edges: [] } as unknown as Parameters<AutopilotOrchestrator['executePlan']>[1],
        [],
        new Map(),
      ),
    ).rejects.toThrow('no scanned connections');
  });

  it('runs scan → graph → plan → execute end to end with the captured connections', async () => {
    const { handlers, getOrchestrator } = createFakeHandlers();
    await initAutopilotComposition({ handlers, log: vi.fn() });
    const orchestrator = getOrchestrator();

    const source = fakeOrg(
      1,
      [
        {
          Id: 'src1',
          Name: 'Acme',
          attributes: {
            type: 'Account',
            url: '/services/data/v00/sobjects/Account/src1',
          },
        },
      ],
      'tgt1',
    );
    const target = fakeOrg(0, [], 'tgt1');

    const result = await runOneAccountFlow(orchestrator, source.conn, target.conn);

    expect(result.totalSuccess).toBe(1);
    expect(result.completedObjects).toContain('Account');
    // The executor queries the source with FIELDS(ALL) + LIMIT/OFFSET pagination.
    expect(source.query).toHaveBeenCalledWith('SELECT FIELDS(ALL) FROM Account LIMIT 200 OFFSET 0');
    // The insert path strips the source Id and jsforce attributes before create.
    expect(target.create).toHaveBeenCalledTimes(1);
    expect(target.create).toHaveBeenCalledWith([{ Name: 'Acme' }], expect.anything());
  });

  describe('a record type closed to the running user in the target', () => {
    const PARTNER = '012Fk00000RtDeFIAV';

    /** One Partner Account to copy, into a target that says whether Partner is open. */
    async function partnerAccountRun(isOpen: () => boolean) {
      const { handlers, getOrchestrator } = createFakeHandlers();
      await initAutopilotComposition({ handlers, log: vi.fn() });
      const orchestrator = getOrchestrator();

      const source = fakeOrg(1, [{ Id: 'src1', Name: 'Acme', RecordTypeId: PARTNER }], 'tgt1');
      source.query.mockImplementation((soql: string) =>
        Promise.resolve(
          soql.includes('GROUP BY RecordTypeId')
            ? { totalSize: 1, done: true, records: [{ RecordTypeId: PARTNER, n: 1 }] }
            : soql.includes('COUNT()')
              ? { totalSize: 1, done: true, records: [] }
              : {
                  totalSize: 1,
                  done: true,
                  records: [{ Id: 'src1', Name: 'Acme', RecordTypeId: PARTNER }],
                },
        ),
      );
      const target = fakeOrg(0, [], 'tgt1');
      const targetDescribe = vi.fn().mockImplementation(async () => ({
        ...mockObjectDescribe('Account'),
        fields: [
          { name: 'Name', createable: true },
          { name: 'RecordTypeId', createable: true },
        ],
        recordTypeInfos: [
          {
            active: true,
            available: isOpen(),
            defaultRecordTypeMapping: false,
            developerName: 'Partner',
            master: false,
            name: 'Partner',
            recordTypeId: PARTNER,
            urls: {},
          },
        ],
      }));
      (target.conn as unknown as { describe: typeof targetDescribe }).describe = targetDescribe;
      const run = () => runOneAccountFlow(orchestrator, source.conn, target.conn);
      return { run, source, target, targetDescribe };
    }

    it('holds back the object, reading it from the describe the run makes anyway', async () => {
      const { run, source, target, targetDescribe } = await partnerAccountRun(() => false);

      const result = await run();

      expect(target.create).not.toHaveBeenCalled();
      expect(result.completedObjects).not.toContain('Account');
      expect(source.query).toHaveBeenCalledWith(
        'SELECT RecordTypeId, COUNT(Id) n FROM Account GROUP BY RecordTypeId',
      );
      // The fields and the record types came from one describe of the target.
      expect(targetDescribe).toHaveBeenCalledTimes(1);
    });

    it('reads the target again on the run after, so access granted in between is seen', async () => {
      let open = false;
      const { run, target, targetDescribe } = await partnerAccountRun(() => open);
      await run();
      expect(target.create).not.toHaveBeenCalled();

      // The user does what the run said: the target now lets them use Partner.
      open = true;
      const retry = await run();

      expect(retry.completedObjects).toContain('Account');
      expect(target.create).toHaveBeenCalledTimes(1);
      expect(targetDescribe).toHaveBeenCalledTimes(2);
    });
  });

  it('uses the connections of the latest scan per execution ("latest wins")', async () => {
    const { handlers, getOrchestrator } = createFakeHandlers();
    await initAutopilotComposition({ handlers, log: vi.fn() });
    const orchestrator = getOrchestrator();

    const firstSource = fakeOrg(1, [{ Id: 'src1', Name: 'First' }], 'tgt1');
    const firstTarget = fakeOrg(0, [], 'tgt1');
    await runOneAccountFlow(orchestrator, firstSource.conn, firstTarget.conn);
    expect(firstTarget.create).toHaveBeenCalledTimes(1);

    const secondSource = fakeOrg(1, [{ Id: 'src2', Name: 'Second' }], 'tgt2');
    const secondTarget = fakeOrg(0, [], 'tgt2');
    await runOneAccountFlow(orchestrator, secondSource.conn, secondTarget.conn);

    // The second execution ran against the second org pair, the first is untouched.
    expect(secondTarget.create).toHaveBeenCalledTimes(1);
    expect(secondTarget.create).toHaveBeenCalledWith([{ Name: 'Second' }], expect.anything());
    expect(firstTarget.create).toHaveBeenCalledTimes(1);
  });
});
