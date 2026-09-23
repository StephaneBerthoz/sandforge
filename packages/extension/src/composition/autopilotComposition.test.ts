import { describe, it, expect, vi } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { STANDARD_PRICEBOOK_SOQL } from '@sandforge/shared';
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

/** One object of {@link fakeDataOrg}: the lookups it has and the rows it holds. */
interface FakeObject {
  /** Lookup field → the object it points at. */
  lookups?: Record<string, string>;
  /** Other fields the target takes. */
  fields?: string[];
  rows?: Record<string, unknown>[];
  keyPrefix?: string;
}

/**
 * An org that describes, counts and reads the objects given, answers any
 * other SOQL through `soql`, and writes through `create` and `update`.
 */
function fakeDataOrg(
  objects: Record<string, FakeObject>,
  options: {
    soql?: (query: string) => Record<string, unknown>[] | undefined;
    create?: (objectName: string, records: Record<string, unknown>[]) => unknown[];
    update?: (objectName: string, records: Record<string, unknown>[]) => unknown[];
  } = {},
) {
  const created: Array<{ objectName: string; records: Record<string, unknown>[] }> = [];
  const updated: Array<{ objectName: string; records: Record<string, unknown>[] }> = [];
  const describe = vi.fn(async (name: string) => {
    const object = objects[name] ?? {};
    const lookups = Object.entries(object.lookups ?? {}).map(([field, to]) => ({
      name: field,
      label: field,
      type: 'reference',
      nillable: true,
      createable: true,
      updateable: true,
      unique: false,
      externalId: false,
      referenceTo: [to],
      relationshipName: field.replace(/Id$/, ''),
      defaultValue: null,
    }));
    const plain = [...(object.fields ?? []), 'Name'].map((field) => ({
      name: field,
      label: field,
      type: 'string',
      nillable: true,
      createable: true,
      updateable: true,
      unique: false,
      externalId: false,
      referenceTo: [],
      relationshipName: null,
      defaultValue: null,
    }));
    return {
      ...mockObjectDescribe(name),
      keyPrefix: object.keyPrefix ?? null,
      fields: [...lookups, ...plain],
    };
  });
  const query = vi.fn(async (soql: string) => {
    const count = /^SELECT COUNT\(\) FROM (\w+)$/.exec(soql);
    if (count) {
      return { totalSize: objects[count[1]]?.rows?.length ?? 0, done: true, records: [] };
    }
    const page = /^SELECT FIELDS\(ALL\) FROM (\w+) LIMIT (\d+) OFFSET (\d+)$/.exec(soql);
    if (page) {
      const [, name, limit, offset] = page;
      const records = (objects[name]?.rows ?? [])
        .slice(Number(offset), Number(offset) + Number(limit))
        .map((row) => ({ ...row }));
      return { totalSize: records.length, done: true, records };
    }
    const records = options.soql?.(soql) ?? [];
    return { totalSize: records.length, done: true, records };
  });
  const sobject = vi.fn((objectName: string) => ({
    create: vi.fn(async (records: Record<string, unknown>[]) => {
      created.push({ objectName, records });
      return (
        options.create?.(objectName, records) ??
        records.map((_, i) => ({ id: `${objectName}-new-${i}`, success: true, errors: [] }))
      );
    }),
    update: vi.fn(async (records: Record<string, unknown>[]) => {
      updated.push({ objectName, records });
      return (
        options.update?.(objectName, records) ??
        records.map((r) => ({ id: String(r['Id']), success: true, errors: [] }))
      );
    }),
  }));
  const conn = {
    describe,
    describeGlobal: vi.fn(async () => ({
      sobjects: Object.keys(objects).map((name) => globalSObject(name)),
    })),
    query,
    sobject,
  } as unknown as AutopilotConnection;
  return { conn, created, updated, sobject };
}

/** Scan, plan and run what `selected` reaches, through the composition's own wiring. */
async function compose(
  selected: string[],
  source: AutopilotConnection,
  target: AutopilotConnection,
) {
  const { handlers, getOrchestrator } = createFakeHandlers();
  await initAutopilotComposition({ handlers, log: vi.fn() });
  const orchestrator = getOrchestrator();
  const scanResult = await orchestrator.scanSchemas(source, target, {
    selectedObjects: selected as ApiName[],
    includeStandardObjects: false,
  });
  const graph = orchestrator.buildGraph(scanResult);
  const plan = orchestrator.generatePlan(graph, 'none', []);
  const result = await orchestrator.executePlan(plan, graph, [], scanResult.recordCounts);
  return { plan, result };
}

describe('autopilotComposition — the rules a copy needs', () => {
  /** A fake Account id, in both forms (the checksum is the real algorithm's). */
  const ACCOUNT_15 = '001Fk00000AbCdE';
  const ACCOUNT_18 = '001Fk00000AbCdEIAV';

  it('keeps the code and the fields of each refusal, from the target answer to the result', async () => {
    const objects = { Account: { keyPrefix: '001', rows: [{ Id: 'accSrc', Name: 'Acme' }] } };
    const source = fakeDataOrg(objects);
    const target = fakeDataOrg(objects, {
      create: () => [
        {
          success: false,
          errors: [
            {
              statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
              message: 'Le numéro fiscal est invalide',
              fields: ['TaxNumber__c'],
            },
          ],
        },
      ],
    });

    const { result } = await compose(['Account'], source.conn, target.conn);

    expect(result.objectOutcomes?.['Account']?.refusals).toEqual([
      {
        statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
        fields: ['TaxNumber__c'],
        count: 1,
        message: 'Le numéro fiscal est invalide',
      },
    ]);
    expect(result.nodeErrors?.['Account']).toBe(
      'FIELD_CUSTOM_VALIDATION_EXCEPTION: Le numéro fiscal est invalide',
    );
  });

  it('links a record the target refuses as a duplicate, and writes its children against it', async () => {
    const objects = {
      Account: { keyPrefix: '001', rows: [{ Id: 'accSrc', Name: 'Acme' }] },
      Contact: {
        keyPrefix: '003',
        lookups: { AccountId: 'Account' },
        rows: [{ Id: 'conSrc', Name: 'Doe', AccountId: 'accSrc' }],
      },
    };
    const source = fakeDataOrg(objects);
    const target = fakeDataOrg(objects, {
      create: (objectName, records) =>
        objectName === 'Account'
          ? [
              {
                success: false,
                errors: [
                  {
                    statusCode: 'DUPLICATE_VALUE',
                    message: `valeur en double trouvée : ExternalKey__c duplique une valeur dans l'enregistrement ID : ${ACCOUNT_15}`,
                    fields: [],
                  },
                ],
              },
            ]
          : records.map((_, i) => ({ id: `003NEW${i}`, success: true, errors: [] })),
    });

    const { result } = await compose(['Contact'], source.conn, target.conn);

    const contact = target.created.find((call) => call.objectName === 'Contact');
    expect(contact?.records[0]['AccountId']).toBe(ACCOUNT_18);
    expect(result.objectOutcomes?.['Account']).toMatchObject({ written: 0, linked: 1, failed: 0 });
  });

  it("matches each org's standard price book instead of inserting the source one", async () => {
    const objects = {
      Pricebook2: {
        keyPrefix: '01s',
        rows: [
          { Id: '01sSRCSTANDARD0', Name: 'Standard Price Book', IsStandard: true },
          { Id: '01sSRCCUSTOM000', Name: 'Resellers' },
        ],
      },
    };
    const standardBook =
      (id: string) =>
      (query: string): Record<string, unknown>[] | undefined =>
        query === STANDARD_PRICEBOOK_SOQL ? [{ Id: id }] : undefined;
    const source = fakeDataOrg(objects, { soql: standardBook('01sSRCSTANDARD0') });
    const target = fakeDataOrg(objects, { soql: standardBook('01sTGTSTANDARD0') });

    const { result } = await compose(['Pricebook2'], source.conn, target.conn);

    expect(target.created.flatMap((call) => call.records.map((r) => r['Name']))).toEqual([
      'Resellers',
    ]);
    expect(result.objectOutcomes?.['Pricebook2']).toMatchObject({ written: 1, linked: 1 });
  });

  it('inserts an activated order as a draft and gives it its status back through the target', async () => {
    const objects = {
      Order: { keyPrefix: '801', fields: ['Status'], rows: [{ Id: 'ordSrc', Status: 'ST004' }] },
    };
    const source = fakeDataOrg(objects);
    const target = fakeDataOrg(objects, {
      soql: (query) =>
        query === 'SELECT ApiName, StatusCode FROM OrderStatus'
          ? [
              { ApiName: 'ST001', StatusCode: 'Draft' },
              { ApiName: 'ST004', StatusCode: 'Activated' },
            ]
          : undefined,
    });

    const { result } = await compose(['Order'], source.conn, target.conn);

    expect(target.created[0].records[0]['Status']).toBe('ST001');
    expect(target.updated).toEqual([
      { objectName: 'Order', records: [{ Id: 'Order-new-0', Status: 'ST004' }] },
    ]);
    expect(result.statuses).toEqual({ Order: { applied: 1, refusals: [] } });
  });

  it('never plans nor writes an object every copy leaves out, whatever points at it', async () => {
    // The platform tags what an app manages with it; written by a copy onto a
    // quote, it was refused.
    const objects = {
      Quote: {
        keyPrefix: '0Q0',
        lookups: { UsageAssignmentId__c: 'AppUsageAssignment' },
        rows: [{ Id: 'quoteSrc', Name: 'Q-1' }],
      },
      AppUsageAssignment: { keyPrefix: '0Ua', rows: [{ Id: 'usageSrc', Name: 'Tag' }] },
    };
    const source = fakeDataOrg(objects);
    const target = fakeDataOrg(objects);

    const { plan } = await compose(['Quote'], source.conn, target.conn);

    expect(plan.waves.flatMap((wave) => wave.objects)).toEqual(['Quote']);
    expect(target.sobject).not.toHaveBeenCalledWith('AppUsageAssignment');
  });
});
