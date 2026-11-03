/**
 * A Sync run held, before its first write, to what the target has left — as
 * the Sync page, a re-run and a schedule start one — through the real
 * orchestrator, writer and gate, against two mocked connections: a source of
 * contacts and a Developer Edition whose contact flow sends two emails a
 * record, with fifteen single emails a day.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  SyncConfig,
  SyncObjectConfig,
  SyncWriteOrder,
} from '@sandforge/shared';
import { SyncOpsHandler } from './SyncOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import {
  ProductionGuard,
  withGivenAnswer,
  type RunConfirmation,
} from '../../core/precheck/ProductionGuard.js';
import { SyncOrchestrator } from '../../modules/sync/SyncOrchestrator.js';
import type { SyncOrchestratorDeps } from '../../modules/sync/SyncOrchestrator.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { clearDescribeCache } from '../../core/connection/describeCache.js';
import { answeringDeliverability, type DeliverabilityLevel } from '../../test/deliverabilityOrg.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** An in-memory config store, enough for the configurations, the audit trail and the history. */
function memoryConfigStore(): HandlerDeps['configStore'] {
  const data = new Map<string, { value: unknown; category: string }>();
  return {
    get: (key: string) => data.get(key)?.value,
    set: (key: string, value: unknown, category = 'default') => {
      data.set(key, { value: JSON.parse(JSON.stringify(value)), category });
    },
    delete: (key: string) => data.delete(key),
    has: (key: string) => data.has(key),
    getByCategory: (category: string) =>
      Object.fromEntries(
        [...data].filter(([, e]) => e.category === category).map(([k, e]) => [k, e.value]),
      ),
    getAllKeys: () => [...data.keys()],
    clearCategory: vi.fn(),
    clearAll: vi.fn(),
    initialize: vi.fn(),
  } as unknown as HandlerDeps['configStore'];
}

/** The questions the user was asked, and what they answered. */
interface Asked {
  questions: RunConfirmation[];
  answer: boolean;
}

function createDeps(asked: Asked): HandlerDeps {
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {
      getOrg: vi.fn((orgId: string) =>
        orgId === 'tgt-org'
          ? { orgType: 'Production', alias: 'TRAP', metadata: { edition: 'Developer Edition' } }
          : { orgType: 'Sandbox', alias: 'SOURCE' },
      ),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: memoryConfigStore(),
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    infraServices: {
      productionGuard: new ProductionGuard({
        requestRunConfirmation: async (question) => {
          asked.questions.push(question);
          return asked.answer;
        },
      }),
    } as unknown as HandlerDeps['infraServices'],
    services: {
      getSandforgeSetting: (_key: string, fallback: unknown) => fallback,
      syncOrchestrator: (d: SyncOrchestratorDeps) => new SyncOrchestrator(d),
    } as unknown as HandlerDeps['services'],
    nextId: () => `out-${++id}`,
  };
}

/** A Developer Edition's contact flow, which sends two emails for each contact created. */
const WELCOME_FLOW: ForgeTargetAutomation = {
  objectsRead: ['Contact'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Welcome',
          label: 'Contact welcome',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [],
          messages: [
            { kind: 'email', name: 'Send welcome', limit: 'SingleEmail' },
            { kind: 'email', name: 'Send follow up', limit: 'SingleEmail' },
          ],
        },
      ],
      triggers: [],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
};

const FIELDS: Record<string, unknown[]> = {
  Account: [
    { name: 'Id', type: 'id', createable: false, updateable: false },
    { name: 'Name', type: 'string', createable: true, updateable: true },
  ],
  Contact: [
    { name: 'Id', type: 'id', createable: false, updateable: false },
    { name: 'LastName', type: 'string', createable: true, updateable: true },
    {
      name: 'AccountId',
      type: 'reference',
      referenceTo: ['Account'],
      createable: true,
      updateable: true,
    },
  ],
};

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/**
 * The source's contacts, and a target with `remainingMB` of data storage and
 * `emails` single emails left, which delivers the emails of its automation
 * when `level` says all, and none of them otherwise. `deliverabilityAsked`
 * counts the requests of the reads of its deliverability.
 */
function mockOrgs(
  contacts: number,
  remainingMB = 4,
  emails = 15,
  level: DeliverabilityLevel = 'withheld',
) {
  const deliverabilityAsked: string[] = [];
  const rows = Array.from({ length: contacts }, (_, n) => ({
    attributes: { type: 'Contact' },
    Id: fakeId('003', n + 1),
    LastName: `Doe ${n}`,
  }));
  const create = vi.fn(async (batch: unknown[]) =>
    batch.map((_, n) => ({ id: fakeId('003', 900 + n), success: true, errors: [] })),
  );
  vi.mocked(getJsforceConnection).mockImplementation(
    async (orgId: string) =>
      ({
        query: vi.fn(async (soql: string) => {
          if (soql.startsWith('SELECT COUNT()')) {
            return { done: true, totalSize: soql.includes('IsPersonAccount') ? 0 : rows.length };
          }
          if (/^SELECT Id, LastName\b.* FROM Contact/.test(soql))
            return { done: true, records: rows };
          return { done: true, records: [] };
        }),
        queryMore: vi.fn(),
        describe: vi.fn(async (name: string) => ({ name, fields: FIELDS[name] ?? [] })),
        sobject: vi.fn(() => ({ create, upsert: vi.fn(), update: vi.fn(), destroy: vi.fn() })),
        // Unless told, an org that delivers none of the emails of its
        // automation, as a sandbox refreshed on System email only.
        request: vi.fn(
          answeringDeliverability(
            level,
            async () =>
              orgId === 'tgt-org'
                ? {
                    DataStorageMB: { Max: 5, Remaining: remainingMB },
                    SingleEmail: { Max: 15, Remaining: emails },
                    DailyWorkflowEmails: { Max: 8_040, Remaining: 8_040 },
                  }
                : {},
            deliverabilityAsked,
          ).request,
        ),
        limitInfo: undefined,
      }) as never,
  );
  return { create, deliverabilityAsked };
}

function insertOf(objectApiName: string, insertOrder: number): SyncObjectConfig {
  return {
    objectApiName,
    operation: 'insert',
    batchSize: 200,
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    insertOrder,
  };
}

function config(objects: SyncObjectConfig[] = [insertOf('Contact', 0)]): SyncConfig {
  return {
    id: 'cfg-gate',
    name: 'contacts',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects,
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

/** Every message the handler posted, of one type. */
function posted(
  deps: HandlerDeps,
  type: string,
): Array<BaseMessage & { payload: Record<string, unknown>; correlationId?: string }> {
  return vi
    .mocked(deps.broker.postToWebview)
    .mock.calls.map(
      ([m]) => m as BaseMessage & { payload: Record<string, unknown>; correlationId?: string },
    )
    .filter((m) => m.type === type);
}

function send(handler: SyncOpsHandler, type: string, id: string, payload: unknown) {
  return handler.handle(
    inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage),
  );
}

describe('a Sync run held to what the target has left, before its first write', () => {
  let asked: Asked;
  let deps: HandlerDeps;
  let handler: SyncOpsHandler;
  let logged: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearDescribeCache();
    asked = { questions: [], answer: false };
    deps = createDeps(asked);
    handler = new SyncOpsHandler(deps);
    handler.setTargetAutomation({ read: async () => WELCOME_FLOW });
    logged = vi.fn();
    handler.setHistoryLogger({ logExecution: logged } as never);
  });

  it('asks the user who started a run past the daily emails, and writes nothing once declined', async () => {
    const { create } = mockOrgs(30);

    await send(handler, 'sync:execute', 'run-1', { config: config() });

    expect(asked.questions).toEqual([
      expect.objectContaining({
        stage: 'write',
        module: 'sync',
        org: 'TRAP',
        total: 30,
        counted: true,
        emails: [expect.objectContaining({ limit: 'SingleEmail', emails: 60, remaining: 15 })],
      }),
    ]);
    const [error] = posted(deps, 'sync:error');
    expect(error.correlationId).toBe('run-1');
    expect(error.payload).toMatchObject({ code: 'SYNC_WRITE_DECLINED' });
    expect(create).not.toHaveBeenCalled();
    // Recorded as stopped under its code, and kept out of the history.
    const audit = new AuditTrailStore(deps.configStore).list().entries;
    expect(audit.find((e) => e.operationId === 'run-1')).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({ code: 'SYNC_WRITE_DECLINED', triggeredBy: 'manual' }),
    });
    expect(logged).not.toHaveBeenCalled();
  });

  it('writes once the user confirms', async () => {
    asked.answer = true;
    const { create } = mockOrgs(30);

    await send(handler, 'sync:execute', 'run-2', { config: config() });

    expect(create).toHaveBeenCalled();
    expect(posted(deps, 'sync:execute:response').at(-1)?.payload).toMatchObject({
      status: 'success',
      totalSuccess: 30,
    });
  });

  it('refuses a run past the data storage left, asking nothing', async () => {
    const { create } = mockOrgs(3_000, 4);

    await send(handler, 'sync:execute', 'run-3', { config: config() });

    expect(asked.questions).toEqual([]);
    const [error] = posted(deps, 'sync:error');
    expect(error.payload).toMatchObject({ code: 'SYNC_STORAGE_EXCEEDED' });
    expect(String(error.payload.message)).toContain('TRAP has 4 MB left of 5 MB');
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a scheduled run past the daily emails, which nobody watches', async () => {
    const { create } = mockOrgs(30);

    const result = await handler.executeScheduled(config(), 'schedule');

    expect(result).toMatchObject({ status: 'failure', objectResults: [] });
    expect(result.error).toContain('about 60 single emails, 15 of 15 left today');
    expect(asked.questions).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('lets a run that fits through without asking', async () => {
    const { create } = mockOrgs(5);

    await send(handler, 'sync:execute', 'run-4', { config: config() });

    expect(asked.questions).toEqual([]);
    expect(create).toHaveBeenCalled();
  });

  it('measures a simulation as the run would be held, asking nobody', async () => {
    mockOrgs(30);

    await send(handler, 'sync:simulate', 'sim-1', { config: config() });

    const [answer] = posted(deps, 'sync:simulate:response');
    expect(answer.payload.writeCheck).toMatchObject({
      total: 30,
      verdict: 'asks',
      emails: [
        expect.objectContaining({ limit: 'SingleEmail', emails: 60, verdict: 'exceeds' }),
        // A Developer Edition counts a flow's single emails against its workflow emails too.
        expect.objectContaining({ limit: 'DailyWorkflowEmails', emails: 60, verdict: 'fits' }),
      ],
    });
    expect(asked.questions).toEqual([]);
  });

  it('answers the order a run writes its objects in, parents first', async () => {
    mockOrgs(1);

    await send(handler, 'sync:write-order', 'order-1', {
      config: config([insertOf('Contact', 0), insertOf('Account', 1)]),
    });

    const [answer] = posted(deps, 'sync:write-order:response');
    expect(answer.correlationId).toBe('order-1');
    expect(answer.payload.order as SyncWriteOrder).toEqual({
      objects: ['Account', 'Contact'],
      moved: [{ objectApiName: 'Contact', after: 'Account', field: 'AccountId' }],
      cycles: [],
    });
    expect(answer.payload).not.toHaveProperty('encrypted');
  });

  describe('of contacts holding an encrypted field the source user reads masked', () => {
    /** The orgs of {@link mockOrgs}, the contacts holding a tax id the source answers masked. */
    function maskedOrgs(contacts: number) {
      const orgs = mockOrgs(contacts);
      const plain = vi.mocked(getJsforceConnection).getMockImplementation();
      vi.mocked(getJsforceConnection).mockImplementation(async (orgId, ...rest) => {
        const conn = (await plain?.(orgId, ...rest)) as unknown as {
          query: (soql: string) => Promise<{ records?: Array<Record<string, unknown>> }>;
          describe: (name: string) => Promise<{ name: string; fields: unknown[] }>;
        };
        const query = conn.query;
        const describe = conn.describe;
        return {
          ...conn,
          query: vi.fn(async (soql: string) => {
            const answer = await query(soql);
            return /^SELECT Id, LastName\b.* FROM Contact/.test(soql)
              ? {
                  ...answer,
                  records: (answer.records ?? []).map((row) => ({
                    ...row,
                    Tax_Id__c: '***-**-1234',
                  })),
                }
              : answer;
          }),
          describe: vi.fn(async (name: string) => {
            const described = await describe(name);
            return name === 'Contact'
              ? {
                  ...described,
                  fields: [
                    ...described.fields,
                    {
                      name: 'Tax_Id__c',
                      type: 'encryptedstring',
                      createable: true,
                      updateable: true,
                    },
                  ],
                }
              : described;
          }),
        } as never;
      });
      return orgs;
    }

    it('copies none of the masks, and names the field in the run result', async () => {
      // The run wrote "***-**-1234" into every contact of the target.
      const { create } = maskedOrgs(3);

      await send(handler, 'sync:execute', 'run-enc', { config: config() });

      const sent = create.mock.calls.flatMap(([batch]) => batch as Array<Record<string, unknown>>);
      expect(sent).toHaveLength(3);
      expect(sent.every((row) => !('Tax_Id__c' in row))).toBe(true);
    });

    it('warns of it on Review, with the order', async () => {
      maskedOrgs(1);

      await send(handler, 'sync:write-order', 'order-enc', { config: config() });

      const [answer] = posted(deps, 'sync:write-order:response');
      expect(answer.payload.encrypted).toEqual([
        { objectApiName: 'Contact', fields: ['Tax_Id__c'] },
      ]);
    });
  });
});

describe('a Sync run whose target delivers the emails of what still runs', () => {
  let asked: Asked;
  let deps: HandlerDeps;
  let handler: SyncOpsHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    clearDescribeCache();
    asked = { questions: [], answer: true };
    deps = createDeps(asked);
    handler = new SyncOpsHandler(deps);
    handler.setTargetAutomation({ read: async () => WELCOME_FLOW });
    handler.setHistoryLogger({ logExecution: vi.fn() } as never);
  });

  /** The audit entry of a run, by its operation id. */
  const entryOf = (operationId: string) =>
    new AuditTrailStore(deps.configStore).list().entries.find((e) => e.operationId === operationId);

  /** The audit entry of the one run the trail holds. */
  const onlyEntry = () => {
    const { entries } = new AuditTrailStore(deps.configStore).list();
    expect(entries).toHaveLength(1);
    return entries[0];
  };

  it('asks the user who started it, first, naming the flow that sends them; the answer sends them, and the audit says so', async () => {
    const { create } = mockOrgs(5, 4, 15, 'all');

    await send(handler, 'sync:execute', 'run-all', { config: config() });

    expect(asked.questions).toHaveLength(1);
    expect(asked.questions[0]).toMatchObject({
      stage: 'write',
      module: 'sync',
      deliverability: {
        reading: { level: 'all' },
        senders: [
          { objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome', why: 'email' },
        ],
      },
    });
    expect(create).toHaveBeenCalled();
    expect(entryOf('run-all')?.details).toMatchObject({
      triggeredBy: 'manual',
      deliverability: 'all',
      confirmed: 'emails',
    });
  });

  it('writes nothing once the question is declined, and the audit keeps what the org delivers', async () => {
    asked.answer = false;
    const { create } = mockOrgs(5, 4, 15, 'all');

    await send(handler, 'sync:execute', 'run-no', { config: config() });

    expect(create).not.toHaveBeenCalled();
    expect(posted(deps, 'sync:error')[0].payload).toMatchObject({ code: 'SYNC_WRITE_DECLINED' });
    const details = entryOf('run-no')?.details;
    expect(details).toMatchObject({ code: 'SYNC_WRITE_DECLINED', deliverability: 'all' });
    expect(details).not.toHaveProperty('confirmed');
  });

  it('asks nothing of an org that withholds them, and says it read them so', async () => {
    const { create, deliverabilityAsked } = mockOrgs(5);

    await send(handler, 'sync:execute', 'run-withheld', { config: config() });

    expect(asked.questions).toEqual([]);
    expect(create).toHaveBeenCalled();
    // The Apex, refused, then the user's Send Email.
    expect(deliverabilityAsked).toEqual(['apex', 'sendEmail']);
    expect(entryOf('run-withheld')?.details).toMatchObject({ deliverability: 'withheld' });
    expect(entryOf('run-withheld')?.details).not.toHaveProperty('confirmed');
  });

  it('reads nothing of it when nothing that runs sends an email', async () => {
    handler.setTargetAutomation({ read: async () => ({ ...WELCOME_FLOW, objects: [] }) });
    const { create, deliverabilityAsked } = mockOrgs(5, 4, 15, 'all');

    await send(handler, 'sync:execute', 'run-quiet', { config: config() });

    expect(deliverabilityAsked).toEqual([]);
    expect(asked.questions).toEqual([]);
    expect(create).toHaveBeenCalled();
    expect(entryOf('run-quiet')?.details).not.toHaveProperty('deliverability');
  });

  it("refuses a pipeline's step no Approval answered, saying what lifts it there, nothing written", async () => {
    const { create } = mockOrgs(5, 4, 15, 'all');

    const result = await withGivenAnswer({ approved: false }, () =>
      handler.executeScheduled(config(), 'pipeline'),
    );

    expect(result.status).toBe('failure');
    expect(result.error).toContain('TRAP delivers every email its automation sends');
    expect(result.error).toContain(
      'Approve an Approval step put before this Sync step to sync all the same',
    );
    expect(result.error).not.toContain('--accept-emails');
    expect(create).not.toHaveBeenCalled();
    expect(asked.questions).toEqual([]);
    expect(onlyEntry()).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({ code: 'EMAILS_NOT_ACCEPTED', deliverability: 'all' }),
    });
  });

  it("lets a pipeline's step through once the Approval before it was approved: that answer is the accord", async () => {
    const { create } = mockOrgs(5, 4, 15, 'all');

    const result = await withGivenAnswer({ approved: true }, () =>
      handler.executeScheduled(config(), 'pipeline'),
    );

    expect(result.status).toBe('success');
    expect(create).toHaveBeenCalled();
    expect(onlyEntry().details).toMatchObject({
      triggeredBy: 'pipeline',
      deliverability: 'all',
      confirmed: 'emails',
    });
  });

  it('refuses a scheduled run, which nobody watches, sending it to the Sync page', async () => {
    const { create } = mockOrgs(5, 4, 15, 'all');

    const result = await handler.executeScheduled(config(), 'schedule');

    expect(result.error).toContain(
      'Run it from the Sync page, which asks before it writes, to sync all the same',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('tells the question the records keep their addresses, when the configuration keeps them', async () => {
    mockOrgs(5, 4, 15, 'all');

    await send(handler, 'sync:execute', 'run-kept', {
      config: { ...config(), keepContactPoints: true },
    });

    expect(asked.questions[0]).toMatchObject({ deliverability: { keepsAddresses: true } });
  });

  it('runs no Apex in a production org, and takes it for one that would not say', async () => {
    vi.mocked(deps.orgManager.getOrg).mockImplementation(((orgId: string) =>
      orgId === 'tgt-org'
        ? { orgType: 'Production', alias: 'PROD' }
        : { orgType: 'Sandbox', alias: 'SOURCE' }) as never);
    const { deliverabilityAsked } = mockOrgs(5, 4, 15, 'all');

    await send(handler, 'sync:simulate', 'sim-prod', { config: config() });

    expect(deliverabilityAsked).toEqual([]);
    expect(posted(deps, 'sync:simulate:response')[0].payload.writeCheck).toMatchObject({
      verdict: 'asks',
      deliverability: { reading: { unread: 'SandForge runs no Apex in a production org' } },
    });
  });

  it('says it in a simulation, asking nobody', async () => {
    mockOrgs(5, 4, 15, 'all');

    await send(handler, 'sync:simulate', 'sim-all', { config: config() });

    const [answer] = posted(deps, 'sync:simulate:response');
    expect(answer.payload.writeCheck).toMatchObject({
      verdict: 'asks',
      deliverability: { reading: { level: 'all' } },
    });
    expect(asked.questions).toEqual([]);
  });
});
