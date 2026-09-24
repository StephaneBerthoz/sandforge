/**
 * A Seed clone of objects whose lookups point both ways, and of an object that
 * points at itself, through the real insert order: the lookups that point
 * forward go in empty and are filled by the second pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { duplicateRuleHeaders } from '@sandforge/shared';
import { SeedCloneHandler } from './SeedCloneHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

/** The records written to the target org. */
const writer = vi.hoisted(() => ({
  insert: vi.fn(),
  upsert: vi.fn(),
}));
/** The updates the second pass sends the target: object, records, options. */
const targetUpdate = vi.hoisted(() => vi.fn());
const fetcher = vi.hoisted(() => ({
  fetchRecords: vi.fn(),
  countRecords: vi.fn(),
  fetchSample: vi.fn(),
  /** The describe the fetcher reads the source by: the org's own. */
  describe: vi.fn((conn: { describe: (name: string) => Promise<unknown> }, name: string) =>
    conn.describe(name),
  ),
}));

vi.mock('../../modules/sync/BulkDataWriter.js', () => ({
  BulkDataWriter: vi.fn().mockImplementation(function () {
    return writer;
  }),
}));
vi.mock('../../modules/seed/CloneRecordFetcher.js', () => ({
  CloneRecordFetcher: vi.fn().mockImplementation(function () {
    return fetcher;
  }),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** Fake ids: accounts and contacts of the source, and what the target gave them. */
const ACME = '001Fk00000AcMeAIAV';
const GLOBEX = '001Fk00000GlObXIAV';
const INITECH = '001Fk00000InItCIAV';
const DOE = '003Fk00000DoEjOIAV';
/** A contact the clone does not read. */
const ELSEWHERE_CONTACT = '003Fk00000ElSeWIAV';
/** An account the clone does not read. */
const ELSEWHERE_ACCOUNT = '001Fk00000ElSeWIAV';

/** The target's id of a record the clone wrote: its source id, marked. */
const inTarget = (sourceId: string): string => `${sourceId.slice(0, 12)}TGT`;

/** A lookup as a real describe gives it: optional, and set on create and on update. */
function lookup(name: string, referenceTo: string, nillable = true) {
  return {
    name,
    type: 'reference',
    referenceTo: [referenceTo],
    nillable,
    createable: true,
    updateable: true,
  };
}

/**
 * The describes of an account whose key contact is a custom lookup, and of a
 * contact under its account: each may be left empty unless told otherwise.
 */
function orgWithAccountsAndContacts(required: { keyContact?: boolean; account?: boolean } = {}) {
  const fields: Record<string, unknown[]> = {
    Account: [
      { name: 'Name', type: 'string', createable: true, updateable: true },
      lookup('ParentId', 'Account'),
      lookup('Key_Contact__c', 'Contact', !required.keyContact),
    ],
    Contact: [
      { name: 'LastName', type: 'string', createable: true, updateable: true },
      lookup('AccountId', 'Account', !required.account),
      lookup('ReportsToId', 'Contact'),
    ],
  };
  mockGetConn.mockResolvedValue({
    describe: vi.fn(async (name: string) => ({
      keyPrefix: name === 'Account' ? '001' : '003',
      fields: fields[name] ?? [],
      recordTypeInfos: [],
    })),
    sobject: vi.fn((name: string) => ({
      update: (records: unknown[], options: unknown) => targetUpdate(name, records, options),
    })),
    limitInfo: undefined,
  } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
}

/** How the second pass sends its updates: as Forge sends its own, duplicate rules waived. */
const SENT_AS_FORGE_SENDS = { allowRecursive: true, headers: duplicateRuleHeaders(true) };

/** The source rows, per object. */
function sourceRows(rows: Record<string, Array<Record<string, unknown>>>): void {
  fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) => rows[name] ?? []);
}

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `msg-${type}`,
    type,
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

/** Contacts and accounts, picked on the page in that order: the order is the clone's to decide. */
const ACCOUNTS_AND_CONTACTS = {
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  objects: [{ objectApiName: 'Contact' }, { objectApiName: 'Account' }],
};

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
    infraServices: {
      productionGuard: new ProductionGuard(),
    } as unknown as HandlerDeps['infraServices'],
    nextId: () => String(++idCounter),
  };
}

/** All messages of one type posted to the webview, in emission order. */
function posted(deps: HandlerDeps, type: string): Array<BaseMessage & { payload: never }> {
  return vi
    .mocked(deps.broker.postToWebview)
    .mock.calls.map((call) => call[0] as BaseMessage & { payload: never })
    .filter((msg) => msg.type === type);
}

describe('SeedCloneHandler — the second pass', () => {
  let deps: HandlerDeps;
  let handler: SeedCloneHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SeedCloneHandler(deps);
    // Every record taken; the ids it gets are given by `targetGivesIds`.
    writer.insert.mockImplementation(async (_name: string, records: unknown[]) =>
      records.map(() => ({ success: true, errors: [] })),
    );
    targetUpdate.mockImplementation(async (_name: string, records: Array<{ Id: string }>) =>
      records.map((record) => ({ id: record.Id, success: true, errors: [] })),
    );
  });

  /** Insert answers giving each source row its marked id, in the order read. */
  function targetGivesIds(rows: Record<string, Array<Record<string, unknown>>>): void {
    writer.insert.mockImplementation(async (name: string, records: unknown[]) =>
      records.map((_, index) => ({
        id: inTarget(String(rows[name]?.[index]?.['Id'])),
        success: true,
        errors: [],
      })),
    );
  }

  it('writes the accounts without their key contact and fills it in once the contacts are in', async () => {
    // An account's key contact against a contact's account: the preview and
    // the clone stopped on "Cycle detected among objects: Account, Contact".
    orgWithAccountsAndContacts();
    const rows = {
      Account: [{ Id: ACME, Name: 'Acme', Key_Contact__c: DOE }],
      Contact: [{ Id: DOE, LastName: 'Doe', AccountId: ACME }],
    };
    sourceRows(rows);
    targetGivesIds(rows);

    await handler.handle(buildMsg('seed:clone:execute', ACCOUNTS_AND_CONTACTS));

    expect(writer.insert.mock.calls.map(([name, records]) => [name, records])).toEqual([
      ['Account', [{ Name: 'Acme' }]],
      ['Contact', [{ LastName: 'Doe', AccountId: inTarget(ACME) }]],
    ]);
    expect(targetUpdate.mock.calls).toEqual([
      ['Account', [{ Id: inTarget(ACME), Key_Contact__c: inTarget(DOE) }], SENT_AS_FORGE_SENDS],
    ]);
    const [response] = posted(deps, 'seed:clone:execute:response');
    expect(response.payload as unknown).toMatchObject({
      status: 'success',
      totalInserted: 2,
      secondPass: { owed: 1, filled: 1, samples: [] },
    });
    // Said as Forge says its own second pass.
    expect(
      posted(deps, 'operation:progress').map(
        (m) => (m.payload as { currentStep: string }).currentStep,
      ),
    ).toContain('Pass 2 (cycle FK update): 1/1 resolved');
  });

  it("fills in an account's parent once it is in, and sends as read a parent the clone does not write", async () => {
    // Written in one insert, a child named its parent's source id: refused,
    // or tied to a record the target held under that id.
    orgWithAccountsAndContacts();
    const rows = {
      Account: [
        { Id: ACME, Name: 'Acme', ParentId: null },
        { Id: GLOBEX, Name: 'Globex', ParentId: ACME },
        { Id: INITECH, Name: 'Initech', ParentId: ELSEWHERE_ACCOUNT },
      ],
    };
    sourceRows(rows);
    targetGivesIds(rows);

    await handler.handle(
      buildMsg('seed:clone:execute', {
        ...ACCOUNTS_AND_CONTACTS,
        objects: [{ objectApiName: 'Account' }],
      }),
    );

    expect(writer.insert).toHaveBeenCalledWith(
      'Account',
      [
        { Name: 'Acme', ParentId: null },
        { Name: 'Globex' },
        { Name: 'Initech', ParentId: ELSEWHERE_ACCOUNT },
      ],
      200,
    );
    expect(targetUpdate.mock.calls).toEqual([
      ['Account', [{ Id: inTarget(GLOBEX), ParentId: inTarget(ACME) }], SENT_AS_FORGE_SENDS],
    ]);
    const [response] = posted(deps, 'seed:clone:execute:response');
    expect(response.payload as unknown).toMatchObject({
      secondPass: { owed: 1, filled: 1, samples: [] },
    });
  });

  it('says which lookups the second pass could not fill, and why', async () => {
    orgWithAccountsAndContacts();
    const rows = {
      Account: [
        { Id: ACME, Name: 'Acme', Key_Contact__c: DOE },
        { Id: GLOBEX, Name: 'Globex', Key_Contact__c: ELSEWHERE_CONTACT },
      ],
      Contact: [{ Id: DOE, LastName: 'Doe', AccountId: ACME }],
    };
    sourceRows(rows);
    targetGivesIds(rows);
    targetUpdate.mockResolvedValue([
      {
        success: false,
        errors: [
          {
            statusCode: 'FIELD_FILTER_VALIDATION_EXCEPTION',
            message: 'Value does not match filter criteria.',
            fields: ['Key_Contact__c'],
          },
        ],
      },
    ]);

    await handler.handle(buildMsg('seed:clone:execute', ACCOUNTS_AND_CONTACTS));

    // Only what can be filled is sent.
    expect(targetUpdate.mock.calls).toEqual([
      ['Account', [{ Id: inTarget(ACME), Key_Contact__c: inTarget(DOE) }], SENT_AS_FORGE_SENDS],
    ]);
    const [response] = posted(deps, 'seed:clone:execute:response');
    expect(response.payload as unknown).toMatchObject({
      // Every record went in: the lookups are what the clone could not finish.
      status: 'success',
      totalInserted: 3,
      secondPass: {
        owed: 2,
        filled: 0,
        samples: [
          {
            record: `Id=${inTarget(ACME)} Key_Contact__c=${inTarget(DOE)}`,
            messages: ['FIELD_FILTER_VALIDATION_EXCEPTION: Value does not match filter criteria.'],
          },
          {
            record: `Account source=${GLOBEX} target=${inTarget(GLOBEX)} Key_Contact__c=<source ${ELSEWHERE_CONTACT}>`,
            messages: [
              `Cycle FK 'Key_Contact__c' could not be resolved — referenced parent (source ${ELSEWHERE_CONTACT}) was not cloned`,
            ],
          },
        ],
      },
    });
  });

  it('owes nothing for a record the target already held', async () => {
    // Linked to, never written to: its key contact stays the target's.
    orgWithAccountsAndContacts();
    const rows = {
      Account: [{ Id: ACME, Name: 'Acme', Key_Contact__c: DOE }],
      Contact: [{ Id: DOE, LastName: 'Doe', AccountId: ACME }],
    };
    sourceRows(rows);
    writer.insert.mockImplementation(async (name: string) =>
      name === 'Account'
        ? [{ success: false, errors: ['DUPLICATE_VALUE'], existingId: '001Fk00000HeLdAIAV' }]
        : [{ id: inTarget(DOE), success: true, errors: [] }],
    );

    await handler.handle(buildMsg('seed:clone:execute', ACCOUNTS_AND_CONTACTS));

    expect(targetUpdate).not.toHaveBeenCalled();
    const [response] = posted(deps, 'seed:clone:execute:response');
    expect(response.payload as unknown).not.toHaveProperty('secondPass');
  });

  it('fills in nothing after a cancel, and says how many lookups it left empty, and why', async () => {
    // Cancelled before its second pass, a clone said it had filled none of
    // the lookups it owed and gave no reason: it read as one whose updates
    // the target had all refused.
    const registry = new BackgroundOperationRegistry();
    handler.setRegistry(registry);
    orgWithAccountsAndContacts();
    const rows = {
      Account: [{ Id: ACME, Name: 'Acme', Key_Contact__c: DOE }],
      Contact: [{ Id: DOE, LastName: 'Doe', AccountId: ACME }],
    };
    sourceRows(rows);
    writer.insert.mockImplementation(async (name: string) => {
      if (name === 'Contact') registry.abort('msg-seed:clone:execute');
      return [{ id: inTarget(name === 'Account' ? ACME : DOE), success: true, errors: [] }];
    });

    await handler.handle(buildMsg('seed:clone:execute', ACCOUNTS_AND_CONTACTS));

    expect(targetUpdate).not.toHaveBeenCalled();
    const [response] = posted(deps, 'seed:clone:execute:response');
    expect(response.payload as unknown).toMatchObject({
      cancelled: true,
      // Said as the pass says it when a cancel stops it partway.
      secondPass: {
        owed: 1,
        filled: 0,
        cancelledBefore: true,
        samples: [
          {
            record: 'Account: 1 lookup not sent',
            messages: ['The run was cancelled before they were filled in: they stay empty.'],
          },
        ],
      },
    });
  });

  it('stops the second pass between two calls when the clone is cancelled, and says what it filled and what it left', async () => {
    // Cancelled during the pass, the clone went on filling lookups in the
    // target until the last one, and ended as a clone nobody had cancelled.
    const registry = new BackgroundOperationRegistry();
    handler.setRegistry(registry);
    orgWithAccountsAndContacts();
    /** A fake account id whose first twelve characters tell it apart. */
    const account = (n: number): string => `001Fk${String(n).padStart(7, '0')}PaReIA`;
    // Each account under the one before: 249 parents to fill, in two calls.
    const rows = {
      Account: Array.from({ length: 250 }, (_, n) => ({
        Id: account(n),
        Name: `Account ${n}`,
        ParentId: n === 0 ? null : account(n - 1),
      })),
    };
    sourceRows(rows);
    targetGivesIds(rows);
    targetUpdate.mockImplementation(async (_name: string, records: Array<{ Id: string }>) => {
      registry.abort('msg-seed:clone:execute');
      return records.map((record) => ({ id: record.Id, success: true, errors: [] }));
    });

    await handler.handle(
      buildMsg('seed:clone:execute', {
        ...ACCOUNTS_AND_CONTACTS,
        objects: [{ objectApiName: 'Account' }],
      }),
    );

    expect(targetUpdate).toHaveBeenCalledTimes(1);
    const [response] = posted(deps, 'seed:clone:execute:response');
    expect(response.payload as unknown).toMatchObject({
      status: 'partial',
      cancelled: true,
      totalInserted: 250,
      secondPass: {
        owed: 249,
        filled: 200,
        samples: [
          {
            record: 'Account: 49 lookups not sent',
            messages: ['The run was cancelled before they were filled in: they stay empty.'],
          },
        ],
      },
    });
    expect(posted(deps, 'operation:completed')[0].payload as unknown).toMatchObject({
      result: { aborted: true },
    });
  });

  it('stops before writing anything at a cycle of lookups that must be set at insert', async () => {
    orgWithAccountsAndContacts({ keyContact: true, account: true });

    await handler.handle(buildMsg('seed:clone:execute', ACCOUNTS_AND_CONTACTS));

    expect(writer.insert).not.toHaveBeenCalled();
    expect(posted(deps, 'operation:failed')[0].payload as unknown).toMatchObject({
      error:
        'Cycle detected among objects: Account, Contact. Contact.AccountId and ' +
        'Account.Key_Contact__c must be set when the record is created, so no object of ' +
        'the cycle can be written first.',
    });
  });

  it('previews the order and the lookups the second pass fills, in the order their objects are written', async () => {
    orgWithAccountsAndContacts();
    fetcher.countRecords.mockResolvedValue(2);
    fetcher.fetchSample.mockResolvedValue([]);

    await handler.handle(buildMsg('seed:clone:preview', ACCOUNTS_AND_CONTACTS));

    expect(posted(deps, 'seed:clone:error')).toEqual([]);
    const [response] = posted(deps, 'seed:clone:preview:response');
    expect(response.payload as unknown).toMatchObject({
      insertOrder: ['Account', 'Contact'],
      filledAfterInsert: [
        { objectApiName: 'Account', field: 'ParentId', referenceTo: 'Account' },
        { objectApiName: 'Account', field: 'Key_Contact__c', referenceTo: 'Contact' },
        { objectApiName: 'Contact', field: 'ReportsToId', referenceTo: 'Contact' },
      ],
    });
  });

  it('lists as a dependency only a lookup the clone writes', async () => {
    // A feed item names its best comment through a lookup the platform sets
    // itself: the clone never writes it, and it is not what orders the feed.
    mockGetConn.mockResolvedValue({
      describe: vi.fn(async (name: string) => ({
        fields:
          name === 'FeedComment'
            ? [
                {
                  name: 'FeedItemId',
                  type: 'reference',
                  referenceTo: ['FeedItem'],
                  nillable: false,
                  createable: true,
                },
              ]
            : [
                {
                  name: 'BestCommentId',
                  type: 'reference',
                  referenceTo: ['FeedComment'],
                  nillable: true,
                  createable: false,
                },
              ],
      })),
      limitInfo: undefined,
    } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
    fetcher.countRecords.mockResolvedValue(3);
    fetcher.fetchSample.mockResolvedValue([]);

    await handler.handle(
      buildMsg('seed:clone:preview', {
        ...ACCOUNTS_AND_CONTACTS,
        objects: [{ objectApiName: 'FeedItem' }, { objectApiName: 'FeedComment' }],
      }),
    );

    const [response] = posted(deps, 'seed:clone:preview:response');
    expect(response.payload as unknown).toMatchObject({
      insertOrder: ['FeedItem', 'FeedComment'],
      objects: [
        { objectApiName: 'FeedItem', relationships: [] },
        {
          objectApiName: 'FeedComment',
          relationships: [{ field: 'FeedItemId', referenceTo: 'FeedItem' }],
        },
      ],
    });
  });

  describe('a source and a target that describe the objects differently', () => {
    const NAME = { name: 'Name', type: 'string', createable: true, updateable: true };
    const LAST_NAME = { name: 'LastName', type: 'string', createable: true, updateable: true };

    /** A describe per object, or what the org answers when it has no such object. */
    type Describes = Record<string, unknown[] | Error>;

    /** Each org's connection answers with its own describes. */
    function twoOrgs(source: Describes, target: Describes): void {
      const connectionTo = (describes: Describes) => ({
        describe: vi.fn(async (name: string) => {
          const fields = describes[name] ?? [];
          if (fields instanceof Error) throw fields;
          return { keyPrefix: null, fields, recordTypeInfos: [] };
        }),
        sobject: vi.fn((name: string) => ({
          update: (records: unknown[], options: unknown) => targetUpdate(name, records, options),
        })),
        limitInfo: undefined,
      });
      const byOrg = new Map([
        [ACCOUNTS_AND_CONTACTS.sourceOrgId, connectionTo(source)],
        [ACCOUNTS_AND_CONTACTS.targetOrgId, connectionTo(target)],
      ]);
      mockGetConn.mockImplementation(
        async (orgId: string) =>
          byOrg.get(orgId) as unknown as Awaited<ReturnType<typeof getJsforceConnection>>,
      );
    }

    beforeEach(() => {
      fetcher.countRecords.mockResolvedValue(2);
      fetcher.fetchSample.mockResolvedValue([]);
    });

    it('previews the order, the dependencies and the second pass from the describe the run reads, and names the lookup only the source has', async () => {
      // A key contact the target was never given: read from the source's
      // describe, the preview put the accounts in a cycle with the contacts
      // and promised a second pass for it, and the run, which reads the
      // target's, left the field out of every record.
      twoOrgs(
        {
          Account: [NAME, lookup('ParentId', 'Account'), lookup('Key_Contact__c', 'Contact')],
          Contact: [LAST_NAME, lookup('AccountId', 'Account'), lookup('ReportsToId', 'Contact')],
        },
        {
          Account: [NAME, lookup('ParentId', 'Account')],
          Contact: [LAST_NAME, lookup('AccountId', 'Account'), lookup('ReportsToId', 'Contact')],
        },
      );

      await handler.handle(buildMsg('seed:clone:preview', ACCOUNTS_AND_CONTACTS));

      expect(posted(deps, 'seed:clone:error')).toEqual([]);
      const [response] = posted(deps, 'seed:clone:preview:response');
      expect(response.payload as unknown).toMatchObject({
        insertOrder: ['Account', 'Contact'],
        objects: [
          {
            objectApiName: 'Contact',
            relationships: [
              { field: 'AccountId', referenceTo: 'Account' },
              { field: 'ReportsToId', referenceTo: 'Contact' },
            ],
          },
          {
            objectApiName: 'Account',
            relationships: [{ field: 'ParentId', referenceTo: 'Account' }],
          },
        ],
        filledAfterInsert: [
          { objectApiName: 'Account', field: 'ParentId', referenceTo: 'Account' },
          { objectApiName: 'Contact', field: 'ReportsToId', referenceTo: 'Contact' },
        ],
        sourceOnlyLookups: [
          { objectApiName: 'Account', field: 'Key_Contact__c', referenceTo: 'Contact' },
        ],
      });
    });

    it('writes the objects in the order its preview showed when a lookup only the source has would have ordered them', async () => {
      // An invoice's account, deployed to the source alone: the preview put
      // the accounts first, and the run wrote the invoices first, as picked.
      const INVOICE = 'a01Fk00000InVoIIAV';
      const PICKED = {
        ...ACCOUNTS_AND_CONTACTS,
        objects: [{ objectApiName: 'Invoice__c' }, { objectApiName: 'Account' }],
      };
      twoOrgs(
        { Invoice__c: [NAME, lookup('Account__c', 'Account')], Account: [NAME] },
        { Invoice__c: [NAME], Account: [NAME] },
      );
      sourceRows({
        Invoice__c: [{ Id: INVOICE, Name: 'First invoice', Account__c: ACME }],
        Account: [{ Id: ACME, Name: 'Acme' }],
      });

      await handler.handle(buildMsg('seed:clone:preview', PICKED));
      await handler.handle(buildMsg('seed:clone:execute', PICKED));

      const written = writer.insert.mock.calls.map(([name]) => name);
      expect(written).toEqual(['Invoice__c', 'Account']);
      const [preview] = posted(deps, 'seed:clone:preview:response');
      expect(preview.payload as unknown).toMatchObject({
        insertOrder: written,
        objects: [
          { objectApiName: 'Invoice__c', relationships: [] },
          { objectApiName: 'Account', relationships: [] },
        ],
        sourceOnlyLookups: [
          { objectApiName: 'Invoice__c', field: 'Account__c', referenceTo: 'Account' },
        ],
      });
      // The run leaves it out, as the preview said.
      const [response] = posted(deps, 'seed:clone:execute:response');
      expect(response.payload as unknown).toMatchObject({
        objectResults: [{ objectApiName: 'Invoice__c', fieldsNotInTarget: ['Account__c'] }, {}],
      });
    });

    it('says which object the target cannot describe, where the run would stop before writing anything', async () => {
      // Previewed from the source alone, an object the target lacks read as
      // ready to clone, and the run stopped on the target's answer, which
      // names no object.
      twoOrgs(
        { Invoice__c: [NAME], Account: [NAME] },
        {
          Invoice__c: new Error('NOT_FOUND: The requested resource does not exist'),
          Account: [NAME],
        },
      );

      await handler.handle(
        buildMsg('seed:clone:preview', {
          ...ACCOUNTS_AND_CONTACTS,
          objects: [{ objectApiName: 'Account' }, { objectApiName: 'Invoice__c' }],
        }),
      );

      expect(posted(deps, 'seed:clone:preview:response')).toEqual([]);
      expect(posted(deps, 'seed:clone:error')[0].payload as unknown).toMatchObject({
        message:
          'Invoice__c could not be described in the target org: NOT_FOUND: The requested resource does not exist',
      });
    });

    it('orders the preview and the run by the lookups both orgs have: one only the target has orders nothing', async () => {
      // An invoice's account and the invoice it follows, deployed to the
      // target alone: the source has no value for either, and the target's
      // describe put the accounts first all the same, and the preview promised
      // a second pass for the previous invoice that the run never made.
      const INVOICE = 'a01Fk00000InVoIIAV';
      const PICKED = {
        ...ACCOUNTS_AND_CONTACTS,
        objects: [{ objectApiName: 'Invoice__c' }, { objectApiName: 'Account' }],
      };
      twoOrgs(
        { Invoice__c: [NAME], Account: [NAME] },
        {
          Invoice__c: [
            NAME,
            lookup('Account__c', 'Account'),
            lookup('Previous_Invoice__c', 'Invoice__c'),
          ],
          Account: [NAME],
        },
      );
      sourceRows({
        Invoice__c: [{ Id: INVOICE, Name: 'First invoice' }],
        Account: [{ Id: ACME, Name: 'Acme' }],
      });

      await handler.handle(buildMsg('seed:clone:preview', PICKED));
      await handler.handle(buildMsg('seed:clone:execute', PICKED));

      const written = writer.insert.mock.calls.map(([name]) => name);
      expect(written).toEqual(['Invoice__c', 'Account']);
      const [preview] = posted(deps, 'seed:clone:preview:response');
      expect(preview.payload as unknown).toMatchObject({
        insertOrder: written,
        objects: [
          { objectApiName: 'Invoice__c', relationships: [] },
          { objectApiName: 'Account', relationships: [] },
        ],
      });
      expect(preview.payload).not.toHaveProperty('filledAfterInsert');
      expect(posted(deps, 'seed:clone:execute:response')[0].payload).not.toHaveProperty(
        'secondPass',
      );
    });

    it('orders by a lookup at an object only where both orgs let it name that object', async () => {
      // A task's what can name an invoice in the target alone: no task read
      // names one, and the tasks need not wait for the invoices.
      const PICKED = {
        ...ACCOUNTS_AND_CONTACTS,
        objects: [
          { objectApiName: 'Task' },
          { objectApiName: 'Account' },
          { objectApiName: 'Invoice__c' },
        ],
      };
      const what = (referenceTo: string[]) => ({ ...lookup('WhatId', 'Account'), referenceTo });
      twoOrgs(
        { Task: [what(['Account'])], Invoice__c: [NAME], Account: [NAME] },
        { Task: [what(['Account', 'Invoice__c'])], Invoice__c: [NAME], Account: [NAME] },
      );

      await handler.handle(buildMsg('seed:clone:preview', PICKED));

      const [preview] = posted(deps, 'seed:clone:preview:response');
      expect(preview.payload as unknown).toMatchObject({
        insertOrder: ['Account', 'Task', 'Invoice__c'],
        objects: [
          { objectApiName: 'Task', relationships: [{ field: 'WhatId', referenceTo: 'Account' }] },
          { objectApiName: 'Account', relationships: [] },
          { objectApiName: 'Invoice__c', relationships: [] },
        ],
      });
    });

    it('names the object the target cannot describe when the run stops on it, before writing anything', async () => {
      // The preview named it; the run stopped on the org's answer alone,
      // which names none.
      twoOrgs(
        { Invoice__c: [NAME], Account: [NAME] },
        {
          Invoice__c: new Error('NOT_FOUND: The requested resource does not exist'),
          Account: [NAME],
        },
      );
      sourceRows({ Account: [{ Id: ACME, Name: 'Acme' }] });

      await handler.handle(
        buildMsg('seed:clone:execute', {
          ...ACCOUNTS_AND_CONTACTS,
          objects: [{ objectApiName: 'Account' }, { objectApiName: 'Invoice__c' }],
        }),
      );

      expect(writer.insert).not.toHaveBeenCalled();
      expect(posted(deps, 'operation:failed')[0].payload as unknown).toMatchObject({
        error:
          'Invoice__c could not be described in the target org: NOT_FOUND: The requested resource does not exist',
        code: 'CLONE_FAILED',
      });
    });

    it('names the object the source cannot describe, in the preview and in the run, before writing anything', async () => {
      // The order goes by what the source's describe says is read: without
      // it, the run cannot tell which lookups order its objects.
      const PICKED = {
        ...ACCOUNTS_AND_CONTACTS,
        objects: [{ objectApiName: 'Account' }, { objectApiName: 'Invoice__c' }],
      };
      twoOrgs(
        {
          Invoice__c: new Error("INVALID_TYPE: sObject type 'Invoice__c' is not supported."),
          Account: [NAME],
        },
        { Invoice__c: [NAME], Account: [NAME] },
      );
      sourceRows({ Account: [{ Id: ACME, Name: 'Acme' }] });

      await handler.handle(buildMsg('seed:clone:preview', PICKED));
      await handler.handle(buildMsg('seed:clone:execute', PICKED));

      const said =
        "Invoice__c could not be described in the source org: INVALID_TYPE: sObject type 'Invoice__c' is not supported.";
      expect(posted(deps, 'seed:clone:preview:response')).toEqual([]);
      expect(posted(deps, 'seed:clone:error')[0].payload as unknown).toMatchObject({
        message: said,
      });
      expect(writer.insert).not.toHaveBeenCalled();
      expect(posted(deps, 'operation:failed')[0].payload as unknown).toMatchObject({
        error: said,
      });
    });

    it('names no lookup when both orgs have the same', async () => {
      orgWithAccountsAndContacts();

      await handler.handle(buildMsg('seed:clone:preview', ACCOUNTS_AND_CONTACTS));

      const [response] = posted(deps, 'seed:clone:preview:response');
      expect(response.payload).not.toHaveProperty('sourceOnlyLookups');
    });

    it('previews nothing without a target, before reading either org', async () => {
      // The order is the target's to give, as the run reads it: a preview
      // that fell back to the source's would show what no run does.
      await handler.handle(
        buildMsg('seed:clone:preview', { ...ACCOUNTS_AND_CONTACTS, targetOrgId: '' }),
      );

      expect(mockGetConn).not.toHaveBeenCalled();
      expect(posted(deps, 'seed:clone:preview:response')).toEqual([]);
      expect(posted(deps, 'seed:clone:error')[0].payload as unknown).toMatchObject({
        code: 'INVALID_PAYLOAD',
      });
    });
  });

  describe('with the emails and their tasks', () => {
    /** Fake ids: an account outside the clone, a case, three emails and their tasks. */
    const ACCOUNT = '001Fk00000AcCtAIAV';
    const CASE = '500Fk00000CaSeAIAV';
    const ON_THE_CASE = '02sFk00000OnCaAIAV';
    const ON_THE_CASE_TASK = '00TFk00000OnCaAIAV';
    const ANSWER_ON_THE_CASE = '02sFk00000AnCaAIAV';
    const ANSWER_ON_THE_CASE_TASK = '00TFk00000AnCaAIAV';
    const OFFER = '02sFk00000OfFeAIAV';
    const OFFER_TASK = '00TFk00000OfFeAIAV';
    /** The task the platform wrote with the offer's email, in the target. */
    const PLATFORM_TASK = '00TFk00000PlAtFIAV';

    /**
     * Target describes as a real org gives them — an email names the email it
     * answers through a lookup an update can set, its case and its task
     * through lookups it cannot — and a target that answers as the platform
     * does: the task it wrote with the first email written, the offer's.
     */
    function targetWithEmailsThatAnswerEachOther(): void {
      const field = (name: string) => ({ name, type: 'string', createable: true });
      const fields: Record<string, unknown[]> = {
        Case: [field('Subject')],
        EmailMessage: [
          field('Subject'),
          { ...lookup('ParentId', 'Case'), updateable: false },
          { ...lookup('RelatedToId', 'Account'), referenceTo: ['Account', 'Case'] },
          { ...lookup('ActivityId', 'Task'), updateable: false },
          lookup('ReplyToEmailMessageId', 'EmailMessage'),
        ],
        Task: [
          field('Subject'),
          { ...lookup('WhatId', 'Account'), referenceTo: ['Account', 'Case'] },
        ],
      };
      mockGetConn.mockResolvedValue({
        describe: vi.fn(async (name: string) => ({
          keyPrefix: { Case: '500', Task: '00T', EmailMessage: '02s' }[name] ?? null,
          fields: fields[name] ?? [],
          recordTypeInfos: [],
        })),
        query: vi.fn(async (soql: string) => ({
          records:
            soql.startsWith('SELECT Id, ActivityId FROM EmailMessage') &&
            soql.includes(inTarget(OFFER))
              ? [{ Id: inTarget(OFFER), ActivityId: PLATFORM_TASK }]
              : [],
        })),
        sobject: vi.fn((name: string) => ({
          update: (records: unknown[], options: unknown) => targetUpdate(name, records, options),
        })),
        limitInfo: undefined,
      } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
    }

    it('previews as dependencies the lookups the order reads: not the task the platform fills for an email, and a what at each object it can name', async () => {
      // A real preview listed the email's task among the email's dependencies,
      // though the emails go in before the tasks and the platform fills it;
      // and a task's what, which names an account or a case, at the account
      // alone.
      targetWithEmailsThatAnswerEachOther();
      fetcher.countRecords.mockResolvedValue(1);
      fetcher.fetchSample.mockResolvedValue([]);

      await handler.handle(
        buildMsg('seed:clone:preview', {
          ...ACCOUNTS_AND_CONTACTS,
          objects: [
            { objectApiName: 'Task' },
            { objectApiName: 'EmailMessage' },
            { objectApiName: 'Case' },
            { objectApiName: 'Account' },
          ],
        }),
      );

      const [response] = posted(deps, 'seed:clone:preview:response');
      expect(response.payload as unknown).toMatchObject({
        // Nothing orders the case and the account: they go as they were picked.
        insertOrder: ['Case', 'Account', 'EmailMessage', 'Task'],
        objects: [
          {
            objectApiName: 'Task',
            relationships: [
              { field: 'WhatId', referenceTo: 'Account' },
              { field: 'WhatId', referenceTo: 'Case' },
            ],
          },
          {
            objectApiName: 'EmailMessage',
            relationships: [
              { field: 'ParentId', referenceTo: 'Case' },
              { field: 'RelatedToId', referenceTo: 'Account' },
              { field: 'RelatedToId', referenceTo: 'Case' },
              { field: 'ReplyToEmailMessageId', referenceTo: 'EmailMessage' },
            ],
          },
          { objectApiName: 'Case', relationships: [] },
          { objectApiName: 'Account', relationships: [] },
        ],
      });
    });

    it('fills in after the tasks the lookups at an email that waited for its task', async () => {
      // An email on a case waits for the task it names, and goes in after the
      // tasks: a lookup at it, from an email written before or beside it, is
      // at a record the clone writes, filled in once it is in.
      targetWithEmailsThatAnswerEachOther();
      const rows = {
        Case: [{ Id: CASE, Subject: 'Broken' }],
        EmailMessage: [
          {
            Id: ON_THE_CASE,
            Subject: 'It is broken',
            ParentId: CASE,
            ActivityId: ON_THE_CASE_TASK,
          },
          {
            Id: ANSWER_ON_THE_CASE,
            Subject: 'Still broken',
            ParentId: CASE,
            ActivityId: ANSWER_ON_THE_CASE_TASK,
            ReplyToEmailMessageId: ON_THE_CASE,
          },
          {
            Id: OFFER,
            Subject: 'The offer',
            RelatedToId: ACCOUNT,
            ActivityId: OFFER_TASK,
            ReplyToEmailMessageId: ON_THE_CASE,
          },
        ],
        Task: [
          { Id: ON_THE_CASE_TASK, Subject: 'Email: It is broken', WhatId: CASE },
          { Id: ANSWER_ON_THE_CASE_TASK, Subject: 'Email: Still broken', WhatId: CASE },
          { Id: OFFER_TASK, Subject: 'Email: The offer', WhatId: ACCOUNT },
        ],
      };
      sourceRows(rows);
      // Each record written gets its source id, marked: read from the rows
      // the insert is handed, by their subject.
      const idOf = new Map(
        Object.values(rows)
          .flat()
          .map((row) => [row.Subject, inTarget(row.Id)]),
      );
      writer.insert.mockImplementation(async (_name: string, records: Array<{ Subject: string }>) =>
        records.map((record) => ({ id: idOf.get(record.Subject), success: true, errors: [] })),
      );

      await handler.handle(
        buildMsg('seed:clone:execute', {
          ...ACCOUNTS_AND_CONTACTS,
          objects: [
            { objectApiName: 'Task' },
            { objectApiName: 'EmailMessage' },
            { objectApiName: 'Case' },
          ],
        }),
      );

      expect(writer.insert.mock.calls.map(([name, records]) => [name, records])).toEqual([
        ['Case', [{ Subject: 'Broken' }]],
        // The offer goes without the task the platform writes with it, and
        // without the email it answers, which waits for its own task.
        ['EmailMessage', [{ Subject: 'The offer', RelatedToId: ACCOUNT }]],
        // The offer's task is the one the platform wrote: linked, not sent.
        [
          'Task',
          [
            { Subject: 'Email: It is broken', WhatId: inTarget(CASE) },
            { Subject: 'Email: Still broken', WhatId: inTarget(CASE) },
          ],
        ],
        [
          'EmailMessage',
          [
            {
              Subject: 'It is broken',
              ParentId: inTarget(CASE),
              ActivityId: inTarget(ON_THE_CASE_TASK),
            },
            {
              Subject: 'Still broken',
              ParentId: inTarget(CASE),
              ActivityId: inTarget(ANSWER_ON_THE_CASE_TASK),
            },
          ],
        ],
      ]);
      expect(targetUpdate.mock.calls).toEqual([
        [
          'EmailMessage',
          [
            { Id: inTarget(OFFER), ReplyToEmailMessageId: inTarget(ON_THE_CASE) },
            { Id: inTarget(ANSWER_ON_THE_CASE), ReplyToEmailMessageId: inTarget(ON_THE_CASE) },
          ],
          SENT_AS_FORGE_SENDS,
        ],
      ]);
      const [response] = posted(deps, 'seed:clone:execute:response');
      expect(response.payload as unknown).toMatchObject({
        status: 'success',
        totalInserted: 6,
        totalLinked: 1,
        secondPass: { owed: 2, filled: 2, samples: [] },
        objectResults: [
          { objectApiName: 'Case', insertedCount: 1 },
          { objectApiName: 'EmailMessage', sourceCount: 3, insertedCount: 3 },
          { objectApiName: 'Task', sourceCount: 3, insertedCount: 2, linkedCount: 1 },
        ],
      });
    });
  });
});
