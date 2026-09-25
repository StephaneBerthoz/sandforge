import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { SeedCloneHandler } from './SeedCloneHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { ErrorResolver } from '../../modules/ai/ErrorResolver.js';
import type { AIProvider } from '../../modules/ai/ErrorResolver.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

/**
 * The pipeline collaborators are constructed inside the handler, so they are
 * replaced at module level. `writer` doubles as the "did anything reach the
 * target org?" probe used by the production-guard cases.
 */
const writer = vi.hoisted(() => ({
  insert: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
}));
const fetcher = vi.hoisted(() => ({
  fetchRecords: vi.fn(),
  countRecords: vi.fn(),
  fetchSample: vi.fn(),
  /** The describe the fetcher reads the source by: the org's own. */
  describe: vi.fn((conn: { describe: (name: string) => Promise<unknown> }, name: string) =>
    conn.describe(name),
  ),
}));
const linker = vi.hoisted(() => ({
  buildEdgesFromDescribe: vi.fn(),
  resolveInsertOrder: vi.fn(),
  lookupsFilledAfter: vi.fn(),
  lookupsOf: vi.fn(),
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
vi.mock('../../modules/seed/CloneReferenceLinker.js', () => ({
  CloneReferenceLinker: vi.fn().mockImplementation(function () {
    return linker;
  }),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';
import { WriteCancelledError } from '../../modules/sync/WriteCancelledError.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { LineageStore } from '../../modules/audit/lineage.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { LiveOperation } from '../../modules/monitor/LiveOperationTracker.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** Message envelope shaped like what MessageBroker hands a handler. */
function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `msg-${type}`,
    type,
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

/** The id of the preview each test's handler answered first, for the orgs of `clonePayload`. */
const PREVIEW_ID = 'msg-seed:clone:preview';

/**
 * A valid `seed:clone:execute` payload (one object, insert mode), naming the
 * preview the handler answered for its orgs: a run that names none is refused.
 */
function clonePayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    objects: [{ objectApiName: 'Account' }],
    previewId: PREVIEW_ID,
    ...overrides,
  };
}

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
    // A clone refuses to write without a Production Guard, and the extension
    // always injects one.
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

describe('SeedCloneHandler', () => {
  let deps: HandlerDeps;
  let handler: SeedCloneHandler;

  beforeEach(async () => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SeedCloneHandler(deps);

    mockGetConn.mockResolvedValue({
      describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      describe: vi.fn().mockResolvedValue({ fields: [] }),
      limitInfo: undefined,
    } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
    linker.buildEdgesFromDescribe.mockReturnValue([]);
    linker.resolveInsertOrder.mockReturnValue(['Account']);
    linker.lookupsFilledAfter.mockReturnValue([]);
    linker.lookupsOf.mockReturnValue([]);
    fetcher.fetchRecords.mockResolvedValue([{ Id: '001SRC', Name: 'Acme' }]);
    writer.insert.mockResolvedValue([{ id: '001TGT', success: true, errors: [] }]);
    writer.upsert.mockResolvedValue([{ id: '001TGT', success: true, errors: [] }]);

    // A run follows the preview it names, which the handler answered for the
    // run's orgs: `clonePayload` names this one, as the page names its own.
    // What the preview asked and posted is forgotten: a test reads its own.
    fetcher.countRecords.mockResolvedValue(0);
    fetcher.fetchSample.mockResolvedValue([]);
    await handler.handle(buildMsg('seed:clone:preview', clonePayload()));
    expect(posted(deps, 'seed:clone:preview:response')).toHaveLength(1);
    vi.clearAllMocks();
  });

  describe('routing', () => {
    it('ignores message types it does not own', async () => {
      expect(await handler.handle(buildMsg('sync:execute'))).toBe(false);
      expect(deps.broker.postToWebview).not.toHaveBeenCalled();
    });
  });

  describe('seed:clone:describe-source', () => {
    it('returns only createable and queryable objects', async () => {
      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [
            {
              name: 'Account',
              label: 'Account',
              createable: true,
              queryable: true,
            },
            {
              name: 'AccountShare',
              label: 'Share',
              createable: true,
              queryable: false,
            },
          ],
        }),
        limitInfo: undefined,
      } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);

      await handler.handle(buildMsg('seed:clone:describe-source', { sourceOrgId: 'src-org' }));

      const responses = posted(deps, 'seed:clone:describe-source:response');
      expect(responses).toHaveLength(1);
      expect(responses[0].payload).toEqual({
        objects: [{ apiName: 'Account', label: 'Account', recordCount: -1 }],
      });
    });

    it('reports connection failures on seed:clone:error', async () => {
      mockGetConn.mockRejectedValue(new Error('org unreachable'));

      await handler.handle(buildMsg('seed:clone:describe-source', { sourceOrgId: 'src-org' }));

      const errors = posted(deps, 'seed:clone:error');
      expect(errors).toHaveLength(1);
      expect((errors[0].payload as { message: string }).message).toContain('org unreachable');
    });
  });

  describe('seed:clone:preview', () => {
    /** A feed's describes as the org gives them: a comment may not leave its feed item empty. */
    function sourceWithFeeds(): void {
      mockGetConn.mockResolvedValue({
        describe: vi.fn(async (name: string) => ({
          fields:
            name === 'FeedComment'
              ? [
                  {
                    name: 'FeedItemId',
                    type: 'reference',
                    referenceTo: ['FeedItem', 'OpportunityFeed'],
                    nillable: false,
                  },
                ]
              : [{ name: 'Type', type: 'picklist', nillable: true }],
        })),
        limitInfo: undefined,
      } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
    }

    it('counts and samples what the clone will send, and says how many rows it leaves to the platform', async () => {
      // Forty of the forty-four feed items a sandbox held were tracked
      // changes, which the clone never sends; neither does it send the comment
      // on one. The preview counted and sampled them all.
      sourceWithFeeds();
      linker.resolveInsertOrder.mockReturnValue(['FeedItem', 'FeedComment']);
      fetcher.countRecords.mockImplementation(
        async (_conn: unknown, name: string, _where?: string, sends: string[] = []) =>
          name === 'FeedItem' ? (sends.length > 0 ? 4 : 44) : sends.length > 0 ? 1 : 2,
      );
      fetcher.fetchSample.mockResolvedValue([{ Id: '0D5Fk00000PoStAIAV', Type: 'TextPost' }]);

      await handler.handle(
        buildMsg(
          'seed:clone:preview',
          clonePayload({
            objects: [
              { objectApiName: 'FeedItem', whereClause: "ParentId = '006Fk00000FaKeAIAV'" },
              { objectApiName: 'FeedComment' },
            ],
          }),
        ),
      );

      const NOT_TRACKED = ["Type != 'TrackedChange'"];
      const NOT_ON_A_TRACKED_CHANGE = [
        'FeedItemId NOT IN (SELECT Id FROM FeedItem WHERE ' +
          "(ParentId = '006Fk00000FaKeAIAV') AND (Type = 'TrackedChange'))",
      ];
      expect(fetcher.fetchSample).toHaveBeenCalledWith(
        expect.anything(),
        'FeedItem',
        5,
        "ParentId = '006Fk00000FaKeAIAV'",
        NOT_TRACKED,
      );
      expect(fetcher.fetchSample).toHaveBeenCalledWith(
        expect.anything(),
        'FeedComment',
        5,
        undefined,
        NOT_ON_A_TRACKED_CHANGE,
      );
      const [response] = posted(deps, 'seed:clone:preview:response');
      expect(response.payload as unknown).toMatchObject({
        objects: [
          { objectApiName: 'FeedItem', recordCount: 4, leftToThePlatform: 40 },
          { objectApiName: 'FeedComment', recordCount: 1, leftToThePlatform: 1 },
        ],
        insertOrder: ['FeedItem', 'FeedComment'],
      });
    });

    it('asks the source for rows by the lookups its describe has, and by no other', async () => {
      // A lookup the target requires and the source does not have — a field
      // deployed to the target alone — pointing at feed items, whose tracked
      // changes the clone leaves to the platform: read from the target's
      // describe, it went into the query the source counts and samples by,
      // and a field the source lacks is refused there, "No such column".
      const feedItem = { fields: [{ name: 'Type', type: 'picklist', nillable: true }] };
      const onItsFeedItem = {
        name: 'FeedItemId',
        type: 'reference',
        referenceTo: ['FeedItem'],
        nillable: false,
      };
      const source = {
        describe: vi.fn(async (name: string) =>
          name === 'FeedComment' ? { fields: [onItsFeedItem] } : feedItem,
        ),
        limitInfo: undefined,
      };
      const target = {
        describe: vi.fn(async (name: string) =>
          name === 'FeedComment'
            ? {
                fields: [
                  onItsFeedItem,
                  {
                    name: 'Thread_Item__c',
                    type: 'reference',
                    referenceTo: ['FeedItem'],
                    nillable: false,
                    createable: true,
                  },
                ],
              }
            : feedItem,
        ),
        limitInfo: undefined,
      };
      mockGetConn.mockImplementation(
        async (orgId: string) =>
          (orgId === 'src-org' ? source : target) as unknown as Awaited<
            ReturnType<typeof getJsforceConnection>
          >,
      );
      linker.resolveInsertOrder.mockReturnValue(['FeedItem', 'FeedComment']);
      fetcher.countRecords.mockResolvedValue(1);
      fetcher.fetchSample.mockResolvedValue([]);

      await handler.handle(
        buildMsg(
          'seed:clone:preview',
          clonePayload({
            objects: [{ objectApiName: 'FeedItem' }, { objectApiName: 'FeedComment' }],
          }),
        ),
      );

      const NOT_ON_A_TRACKED_CHANGE = [
        "FeedItemId NOT IN (SELECT Id FROM FeedItem WHERE (Type = 'TrackedChange'))",
      ];
      expect(fetcher.countRecords).toHaveBeenCalledWith(
        source,
        'FeedComment',
        undefined,
        NOT_ON_A_TRACKED_CHANGE,
      );
      expect(fetcher.fetchSample).toHaveBeenCalledWith(
        source,
        'FeedComment',
        5,
        undefined,
        NOT_ON_A_TRACKED_CHANGE,
      );
      // What the target requires is still named, above Execute.
      const [response] = posted(deps, 'seed:clone:preview:response');
      expect(response.payload as unknown).toMatchObject({
        targetOnlyRequiredLookups: [
          { objectApiName: 'FeedComment', field: 'Thread_Item__c', referenceTo: 'FeedItem' },
        ],
      });
    });

    it("lists each object's dependencies from the edges its insert order is resolved from", async () => {
      // Read from the describe apart from the order, the list named lookups
      // the order leaves out. See the second-pass tests for the real edges.
      const edges = [
        {
          from: 'FeedItem',
          to: 'FeedComment',
          fieldApiName: 'FeedItemId',
          relationshipType: 'lookup',
          required: true,
        },
      ];
      linker.buildEdgesFromDescribe.mockReturnValue(edges);
      linker.resolveInsertOrder.mockReturnValue(['FeedItem', 'FeedComment']);
      linker.lookupsOf.mockImplementation((name: string) =>
        name === 'FeedComment' ? [{ field: 'FeedItemId', referenceTo: 'FeedItem' }] : [],
      );
      fetcher.countRecords.mockResolvedValue(3);
      fetcher.fetchSample.mockResolvedValue([]);

      await handler.handle(
        buildMsg(
          'seed:clone:preview',
          clonePayload({
            objects: [{ objectApiName: 'FeedItem' }, { objectApiName: 'FeedComment' }],
          }),
        ),
      );

      expect(linker.resolveInsertOrder).toHaveBeenCalledWith(['FeedItem', 'FeedComment'], edges);
      expect(linker.lookupsOf.mock.calls).toEqual([
        ['FeedItem', edges],
        ['FeedComment', edges],
      ]);
      const [response] = posted(deps, 'seed:clone:preview:response');
      expect(response.payload as unknown).toMatchObject({
        objects: [
          { objectApiName: 'FeedItem', relationships: [] },
          {
            objectApiName: 'FeedComment',
            relationships: [{ field: 'FeedItemId', referenceTo: 'FeedItem' }],
          },
        ],
      });
    });

    it('counts once an object the clone leaves nothing of, and says nothing left out', async () => {
      fetcher.countRecords.mockResolvedValue(12);
      fetcher.fetchSample.mockResolvedValue([]);

      await handler.handle(buildMsg('seed:clone:preview', clonePayload()));

      expect(fetcher.countRecords).toHaveBeenCalledTimes(1);
      const [response] = posted(deps, 'seed:clone:preview:response');
      const [account] = (response.payload as { objects: Array<Record<string, unknown>> }).objects;
      expect(account).toMatchObject({ objectApiName: 'Account', recordCount: 12 });
      expect(account).not.toHaveProperty('leftToThePlatform');
      // Nor any lookup left to a second pass: there is none.
      expect(response.payload).not.toHaveProperty('filledAfterInsert');
    });

    it('lists the lookups a second pass fills, in the order their objects are written', async () => {
      linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);
      linker.lookupsFilledAfter.mockReturnValue([
        {
          from: 'Contact',
          to: 'Contact',
          fieldApiName: 'ReportsToId',
          relationshipType: 'lookup',
          required: false,
        },
        {
          from: 'Contact',
          to: 'Account',
          fieldApiName: 'Key_Contact__c',
          relationshipType: 'lookup',
          required: false,
        },
      ]);
      fetcher.countRecords.mockResolvedValue(3);
      fetcher.fetchSample.mockResolvedValue([]);

      await handler.handle(
        buildMsg(
          'seed:clone:preview',
          clonePayload({ objects: [{ objectApiName: 'Contact' }, { objectApiName: 'Account' }] }),
        ),
      );

      const [response] = posted(deps, 'seed:clone:preview:response');
      expect(response.payload as unknown).toMatchObject({
        insertOrder: ['Account', 'Contact'],
        filledAfterInsert: [
          { objectApiName: 'Account', field: 'Key_Contact__c', referenceTo: 'Contact' },
          { objectApiName: 'Contact', field: 'ReportsToId', referenceTo: 'Contact' },
        ],
      });
    });
  });

  describe('seed:clone:execute', () => {
    it('writes through BulkDataWriter and reports a successful clone', async () => {
      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      // A describe that lists no field could not say which the target has:
      // every field read is sent, and none named as missing.
      expect(writer.insert).toHaveBeenCalledWith('Account', [{ Name: 'Acme' }], 200);
      expect(posted(deps, 'operation:started')).toHaveLength(1);
      const responses = posted(deps, 'seed:clone:execute:response');
      expect(responses).toHaveLength(1);
      expect(responses[0].payload as unknown).toMatchObject({
        status: 'success',
        totalInserted: 1,
        totalFailed: 0,
      });
      const result = responses[0].payload as { objectResults: Array<Record<string, unknown>> };
      expect(result).not.toHaveProperty('secondPass');
      expect(result.objectResults[0]).not.toHaveProperty('fieldsNotInTarget');
    });

    describe('the preview a run follows', () => {
      /** A request as the page sends it, under its own id. */
      function request(type: string, id: string, payload: Record<string, unknown>): InboundRequest {
        return inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage);
      }

      beforeEach(async () => {
        fetcher.countRecords.mockResolvedValue(1);
        fetcher.fetchSample.mockResolvedValue([]);
        await handler.handle(request('seed:clone:preview', 'wv-preview', clonePayload()));
        expect(posted(deps, 'seed:clone:preview:response')).toHaveLength(1);
        vi.mocked(deps.broker.postToWebview).mockClear();
        mockGetConn.mockClear();
      });

      it('runs a clone for the orgs its preview was made for', async () => {
        await handler.handle(
          request('seed:clone:execute', 'wv-run', clonePayload({ previewId: 'wv-preview' })),
        );

        expect(posted(deps, 'seed:clone:error')).toEqual([]);
        expect(writer.insert).toHaveBeenCalledWith('Account', [{ Name: 'Acme' }], 200);
        expect(posted(deps, 'seed:clone:execute:response')).toHaveLength(1);
      });

      it.each([
        ['target', { targetOrgId: 'another-org' }],
        ['source', { sourceOrgId: 'another-org' }],
      ])(
        'refuses a run whose %s org is not the one its preview was made for, before reading either org',
        async (_org, orgs) => {
          // Another org selected after the preview became the target the page
          // sent, and the run wrote there: its preview had been made for the
          // org selected before.
          await handler.handle(
            request(
              'seed:clone:execute',
              'wv-run',
              clonePayload({ ...orgs, previewId: 'wv-preview' }),
            ),
          );

          expect(mockGetConn).not.toHaveBeenCalled();
          expect(writer.insert).not.toHaveBeenCalled();
          expect(posted(deps, 'operation:started')).toEqual([]);
          expect(posted(deps, 'seed:clone:execute:response')).toEqual([]);
          const refused = posted(deps, 'seed:clone:error');
          expect(refused).toHaveLength(1);
          expect(refused[0]).toMatchObject({
            correlationId: 'wv-run',
            payload: { code: 'PREVIEWED_FOR_OTHER_ORGS' },
          });
        },
      );

      it('refuses a run naming a preview it does not hold, under a code of its own', async () => {
        // Refused as a run for other orgs, it sent the user looking for an org
        // change that never happened: the preview had only been forgotten.
        await handler.handle(
          request(
            'seed:clone:execute',
            'wv-run',
            clonePayload({ previewId: 'wv-another-preview' }),
          ),
        );

        expect(writer.insert).not.toHaveBeenCalled();
        expect(posted(deps, 'seed:clone:error')[0]).toMatchObject({
          correlationId: 'wv-run',
          payload: { code: 'PREVIEW_NOT_HELD' },
        });
      });

      it('refuses a run that names no preview, before reading either org, under its own code', async () => {
        // Naming the preview was left to the caller: a run that named none
        // went to whichever orgs it said, previewed for them or not.
        await handler.handle(
          request('seed:clone:execute', 'wv-run', {
            sourceOrgId: 'src-org',
            targetOrgId: 'tgt-org',
            objects: [{ objectApiName: 'Account' }],
          }),
        );

        expect(mockGetConn).not.toHaveBeenCalled();
        expect(writer.insert).not.toHaveBeenCalled();
        expect(posted(deps, 'operation:started')).toEqual([]);
        expect(posted(deps, 'seed:clone:execute:response')).toEqual([]);
        const refused = posted(deps, 'seed:clone:error');
        expect(refused).toHaveLength(1);
        expect(refused[0]).toMatchObject({
          correlationId: 'wv-run',
          payload: { code: 'NOT_PREVIEWED' },
        });
      });
    });

    describe('before and after the write', () => {
      /** Fake ids: the source Account, the one the target holds, a closed record type. */
      const SOURCE_ACCOUNT = '001Fk00000ZzYxWIAV';
      const EXISTING_ACCOUNT = '001Fk00000AbCdEIAV';
      const PARTNER_RT = '012Fk00000RtDeFIAV';

      /** Target describes: Account with a Partner type the running user cannot use; Contact under it. */
      function targetWithRecordTypes(): void {
        mockGetConn.mockResolvedValue({
          describe: vi.fn(async (name: string) =>
            name === 'Account'
              ? {
                  keyPrefix: '001',
                  fields: [
                    { name: 'Name', type: 'string' },
                    { name: 'RecordTypeId', type: 'reference', referenceTo: ['RecordType'] },
                  ],
                  recordTypeInfos: [
                    {
                      active: true,
                      available: false,
                      defaultRecordTypeMapping: false,
                      developerName: 'Partner',
                      master: false,
                      name: 'Partner',
                      recordTypeId: PARTNER_RT,
                      urls: {},
                    },
                  ],
                }
              : {
                  keyPrefix: '003',
                  fields: [
                    { name: 'LastName', type: 'string' },
                    { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
                  ],
                  recordTypeInfos: [],
                },
          ),
          limitInfo: undefined,
        } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
      }

      it('holds back an object whose record type the running user cannot use, writing none of it', async () => {
        targetWithRecordTypes();
        fetcher.fetchRecords.mockResolvedValue([
          { Id: SOURCE_ACCOUNT, Name: 'Acme', RecordTypeId: PARTNER_RT },
        ]);

        await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

        expect(writer.insert).not.toHaveBeenCalled();
        const [response] = posted(deps, 'seed:clone:execute:response');
        expect(response.payload as unknown).toMatchObject({
          status: 'failure',
          totalInserted: 0,
          totalFailed: 1,
          objectResults: [
            {
              objectApiName: 'Account',
              failedCount: 1,
              errors: [
                {
                  sourceId: SOURCE_ACCOUNT,
                  message:
                    'RECORD_TYPE_UNAVAILABLE: 1 Account record uses record type Partner, which the ' +
                    'running user cannot use in the target org. Give the running user access to ' +
                    'record type Partner on Account, or map it to one they have.',
                },
              ],
            },
          ],
        });
      });

      it('links the children of a record the target already holds, and counts it apart', async () => {
        targetWithRecordTypes();
        linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);
        fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
          name === 'Account'
            ? [{ Id: SOURCE_ACCOUNT, Name: 'Acme' }]
            : [{ Id: '003Fk00000MnOpQIAV', LastName: 'Doe', AccountId: SOURCE_ACCOUNT }],
        );
        writer.insert.mockImplementation(async (name: string) =>
          name === 'Account'
            ? [
                {
                  success: false,
                  errors: [
                    'DUPLICATE_VALUE: duplicate value found: Name duplicates value on record with id: 001Fk00000AbCdE',
                  ],
                  existingId: EXISTING_ACCOUNT,
                },
              ]
            : [{ id: '003Fk00000NeWcTIAV', success: true, errors: [] }],
        );

        await handler.handle(
          buildMsg(
            'seed:clone:execute',
            clonePayload({
              objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }],
            }),
          ),
        );

        expect(writer.insert).toHaveBeenLastCalledWith(
          'Contact',
          [{ LastName: 'Doe', AccountId: EXISTING_ACCOUNT }],
          200,
        );
        const [response] = posted(deps, 'seed:clone:execute:response');
        expect(response.payload as unknown).toMatchObject({
          status: 'success',
          totalInserted: 1,
          totalLinked: 1,
          totalFailed: 0,
          objectResults: [
            {
              objectApiName: 'Account',
              insertedCount: 0,
              linkedCount: 1,
              failedCount: 0,
              idMappings: [{ sourceId: SOURCE_ACCOUNT, targetId: EXISTING_ACCOUNT }],
            },
            { objectApiName: 'Contact', insertedCount: 1, linkedCount: 0 },
          ],
        });
      });

      it('tells the writer the key prefix a duplicate of each object must carry', async () => {
        targetWithRecordTypes();

        await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

        const writerDeps = vi.mocked(BulkDataWriter).mock.calls[0][0];
        expect(writerDeps.keyPrefixOf?.('Account')).toBe('001');
      });
    });

    describe('a feed item the platform writes itself', () => {
      /** Fake ids: a post and a tracked change, and the comment on each. */
      const POST = '0D5Fk00000PoStAIAV';
      const CHANGE = '0D5Fk00000ChNgEIAV';
      const NEW_POST = '0D5Fk00000NeWpOIAV';

      /** Target describes as the org gives them: a comment may not leave its feed item empty. */
      function targetWithFeeds(): void {
        mockGetConn.mockResolvedValue({
          describe: vi.fn(async (name: string) => ({
            keyPrefix: name === 'FeedItem' ? '0D5' : '0D7',
            fields:
              name === 'FeedComment'
                ? [
                    {
                      name: 'FeedItemId',
                      type: 'reference',
                      referenceTo: ['FeedItem', 'OpportunityFeed'],
                      nillable: false,
                    },
                    { name: 'CommentBody', type: 'textarea' },
                  ]
                : [
                    { name: 'Type', type: 'picklist', nillable: true },
                    { name: 'Body', type: 'textarea' },
                  ],
            recordTypeInfos: [],
          })),
          limitInfo: undefined,
        } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
      }

      it('leaves out a tracked change and the comment on it, counts them apart, and says so', async () => {
        // Sent, the target refuses a tracked change — "Cannot directly insert
        // FeedItem with type TrackedChange" — and the comment on it, which
        // cannot go in without the feed item it answers.
        targetWithFeeds();
        linker.resolveInsertOrder.mockReturnValue(['FeedItem', 'FeedComment']);
        fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
          name === 'FeedItem'
            ? [
                { Id: POST, Type: 'TextPost', Body: 'Kick-off' },
                { Id: CHANGE, Type: 'TrackedChange', Body: null },
              ]
            : [
                { Id: '0D7Fk00000CmNtAIAV', CommentBody: 'On the post', FeedItemId: POST },
                { Id: '0D7Fk00000CmNtBIAV', CommentBody: 'On the change', FeedItemId: CHANGE },
              ],
        );
        writer.insert.mockImplementation(async (name: string, records: unknown[]) =>
          records.map(() => ({
            id: name === 'FeedItem' ? NEW_POST : '0D7Fk00000NeWcMIAV',
            success: true,
            errors: [],
          })),
        );

        await handler.handle(
          buildMsg(
            'seed:clone:execute',
            clonePayload({
              objects: [{ objectApiName: 'FeedItem' }, { objectApiName: 'FeedComment' }],
            }),
          ),
        );

        expect(writer.insert).toHaveBeenCalledWith(
          'FeedItem',
          [{ Type: 'TextPost', Body: 'Kick-off' }],
          200,
        );
        expect(writer.insert).toHaveBeenLastCalledWith(
          'FeedComment',
          [{ CommentBody: 'On the post', FeedItemId: NEW_POST }],
          200,
        );
        const [response] = posted(deps, 'seed:clone:execute:response');
        expect(response.payload as unknown).toMatchObject({
          status: 'success',
          totalSourceRecords: 4,
          totalInserted: 2,
          totalFailed: 0,
          totalLeftToThePlatform: 2,
          objectResults: [
            {
              objectApiName: 'FeedItem',
              sourceCount: 2,
              insertedCount: 1,
              failedCount: 0,
              leftToThePlatform: 1,
            },
            {
              objectApiName: 'FeedComment',
              sourceCount: 2,
              insertedCount: 1,
              failedCount: 0,
              leftToThePlatform: 1,
            },
          ],
        });
      });
    });

    it('sends no field the target says no record is created with', async () => {
      // The fetcher reads every lookup. A real target sets a feed item's
      // inserting user and best comment itself, and a comment's parent, and
      // refuses a record that carries any of them.
      const POST = '0D5Fk00000PoStAIAV';
      const NEW_POST = '0D5Fk00000NeWpOIAV';
      const USER = '005Fk00000UsErAIAV';
      mockGetConn.mockResolvedValue({
        describe: vi.fn(async (name: string) => ({
          keyPrefix: name === 'FeedItem' ? '0D5' : '0D7',
          fields:
            name === 'FeedItem'
              ? [
                  { name: 'Body', type: 'textarea', createable: true },
                  {
                    name: 'CreatedById',
                    type: 'reference',
                    referenceTo: ['User'],
                    createable: true,
                  },
                  {
                    name: 'InsertedById',
                    type: 'reference',
                    referenceTo: ['User'],
                    nillable: false,
                    createable: false,
                  },
                  {
                    name: 'BestCommentId',
                    type: 'reference',
                    referenceTo: ['FeedComment'],
                    createable: false,
                  },
                ]
              : [
                  {
                    name: 'FeedItemId',
                    type: 'reference',
                    referenceTo: ['FeedItem'],
                    nillable: false,
                    createable: true,
                  },
                  { name: 'CommentBody', type: 'textarea', createable: true },
                  {
                    name: 'ParentId',
                    type: 'reference',
                    referenceTo: ['Account'],
                    createable: false,
                  },
                ],
          recordTypeInfos: [],
        })),
        limitInfo: undefined,
      } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
      linker.resolveInsertOrder.mockReturnValue(['FeedItem', 'FeedComment']);
      fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
        name === 'FeedItem'
          ? [
              {
                Id: POST,
                Body: 'Kick-off',
                CreatedById: USER,
                InsertedById: USER,
                BestCommentId: null,
              },
            ]
          : [
              {
                Id: '0D7Fk00000CmNtAIAV',
                FeedItemId: POST,
                CommentBody: 'On the post',
                ParentId: '001Fk00000AcCtAIAV',
              },
            ],
      );
      writer.insert.mockImplementation(async (name: string, records: unknown[]) =>
        records.map(() => ({
          id: name === 'FeedItem' ? NEW_POST : '0D7Fk00000NeWcMIAV',
          success: true,
          errors: [],
        })),
      );

      await handler.handle(
        buildMsg(
          'seed:clone:execute',
          clonePayload({
            objects: [{ objectApiName: 'FeedItem' }, { objectApiName: 'FeedComment' }],
          }),
        ),
      );

      expect(writer.insert).toHaveBeenCalledWith(
        'FeedItem',
        [{ Body: 'Kick-off', CreatedById: USER }],
        200,
      );
      expect(writer.insert).toHaveBeenLastCalledWith(
        'FeedComment',
        [{ FeedItemId: NEW_POST, CommentBody: 'On the post' }],
        200,
      );
    });

    describe("an email's task, which the platform fills in itself", () => {
      /** Fake ids: an account outside the clone, a case, three emails and their tasks. */
      const ACCOUNT = '001Fk00000AcCtAIAV';
      const CASE = '500Fk00000CaSeAIAV';
      const NEW_CASE = '500Fk00000NeWcAIAV';
      const OFFER = '02sFk00000OfFeAIAV';
      const OFFER_TASK = '00TFk00000OfFeAIAV';
      const ON_THE_CASE = '02sFk00000OnCaAIAV';
      const ON_THE_CASE_TASK = '00TFk00000OnCaAIAV';
      const RELATED_TO_THE_CASE = '02sFk00000ReCaAIAV';
      const RELATED_TO_THE_CASE_TASK = '00TFk00000ReCaAIAV';
      const PLATFORM_TASK = '00TFk00000PlAtFIAV';
      const lookup = (name: string, ...referenceTo: string[]) => ({
        name,
        type: 'reference',
        referenceTo,
      });

      /**
       * Target describes and a target that answers as the platform does: the
       * task it wrote with the offer's email, the one email related to a
       * record it took without its task.
       */
      function targetWithEmails(): { query: ReturnType<typeof vi.fn> } {
        const OFFER_WRITTEN = '02sFk00000NeW1AIAV';
        const query = vi.fn(async (soql: string) => ({
          records:
            soql.startsWith('SELECT Id, ActivityId FROM EmailMessage') &&
            soql.includes(OFFER_WRITTEN)
              ? [{ Id: OFFER_WRITTEN, ActivityId: PLATFORM_TASK }]
              : [],
        }));
        mockGetConn.mockResolvedValue({
          describe: vi.fn(async (name: string) => ({
            keyPrefix: { Case: '500', Task: '00T', EmailMessage: '02s' }[name] ?? null,
            fields:
              name === 'EmailMessage'
                ? [
                    { name: 'Subject', type: 'string' },
                    lookup('ParentId', 'Case'),
                    lookup('RelatedToId', 'Account', 'Case'),
                    lookup('ActivityId', 'Task'),
                  ]
                : name === 'Task'
                  ? [{ name: 'Subject', type: 'string' }, lookup('WhatId', 'Account', 'Case')]
                  : [],
            recordTypeInfos: [],
          })),
          query,
          limitInfo: undefined,
        } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
        let emails = 0;
        let tasks = 0;
        writer.insert.mockImplementation(async (name: string, records: unknown[]) =>
          records.map(() => ({
            id:
              name === 'Case'
                ? NEW_CASE
                : name === 'EmailMessage'
                  ? `02sFk00000NeW${++emails}AIAV`
                  : `00TFk00000NeW${++tasks}AIAV`,
            success: true,
            errors: [],
          })),
        );
        return { query };
      }

      /** What each insert of an object sent, in order. */
      const sentOf = (name: string): Array<Record<string, unknown>> =>
        writer.insert.mock.calls
          .filter((c) => c[0] === name)
          .flatMap((c) => c[1] as Array<Record<string, unknown>>);

      it('sends an email that is not on a case without the task it names', async () => {
        // Sent with the id read from the source, the email is refused:
        // INSUFFICIENT_ACCESS_OR_READONLY, "you cannot modify this field".
        targetWithEmails();
        linker.resolveInsertOrder.mockReturnValue(['EmailMessage']);
        fetcher.fetchRecords.mockResolvedValue([
          { Id: OFFER, Subject: 'The offer', RelatedToId: ACCOUNT, ActivityId: OFFER_TASK },
        ]);

        await handler.handle(
          buildMsg(
            'seed:clone:execute',
            clonePayload({ objects: [{ objectApiName: 'EmailMessage' }] }),
          ),
        );

        expect(sentOf('EmailMessage')).toEqual([{ Subject: 'The offer', RelatedToId: ACCOUNT }]);
      });

      it('writes an email on a case after the tasks, with its task, and links the task the platform wrote with any other', async () => {
        // A clone that wrote the tasks first left the offer's task beside the
        // one the platform wrote with its email: two for one email.
        targetWithEmails();
        linker.resolveInsertOrder.mockReturnValue(['Case', 'EmailMessage', 'Task']);
        fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
          name === 'Case'
            ? [{ Id: CASE, Subject: 'Broken' }]
            : name === 'EmailMessage'
              ? [
                  { Id: OFFER, Subject: 'Offer', RelatedToId: ACCOUNT, ActivityId: OFFER_TASK },
                  {
                    Id: ON_THE_CASE,
                    Subject: 'It is broken',
                    ParentId: CASE,
                    ActivityId: ON_THE_CASE_TASK,
                  },
                  {
                    Id: RELATED_TO_THE_CASE,
                    Subject: 'Still broken',
                    RelatedToId: CASE,
                    ActivityId: RELATED_TO_THE_CASE_TASK,
                  },
                ]
              : [
                  { Id: OFFER_TASK, Subject: 'Email: Offer', WhatId: ACCOUNT },
                  { Id: ON_THE_CASE_TASK, Subject: 'Unread email', WhatId: CASE },
                  { Id: RELATED_TO_THE_CASE_TASK, Subject: 'Second email', WhatId: CASE },
                ],
        );

        await handler.handle(
          buildMsg(
            'seed:clone:execute',
            clonePayload({
              objects: [
                { objectApiName: 'Case' },
                { objectApiName: 'EmailMessage' },
                { objectApiName: 'Task' },
              ],
            }),
          ),
        );

        expect(writer.insert.mock.calls.map((c) => c[0])).toEqual([
          'Case',
          'EmailMessage',
          'Task',
          'EmailMessage',
        ]);
        expect(sentOf('Task')).toEqual([
          { Subject: 'Unread email', WhatId: NEW_CASE },
          { Subject: 'Second email', WhatId: NEW_CASE },
        ]);
        expect(sentOf('EmailMessage')).toEqual([
          { Subject: 'Offer', RelatedToId: ACCOUNT },
          { Subject: 'It is broken', ParentId: NEW_CASE, ActivityId: '00TFk00000NeW1AIAV' },
          { Subject: 'Still broken', RelatedToId: NEW_CASE, ActivityId: '00TFk00000NeW2AIAV' },
        ]);
        const [response] = posted(deps, 'seed:clone:execute:response');
        expect(response.payload as unknown).toMatchObject({
          status: 'success',
          totalSourceRecords: 7,
          totalInserted: 6,
          totalLinked: 1,
          totalFailed: 0,
          objectResults: [
            { objectApiName: 'Case', insertedCount: 1 },
            { objectApiName: 'EmailMessage', sourceCount: 3, insertedCount: 3, failedCount: 0 },
            {
              objectApiName: 'Task',
              sourceCount: 3,
              insertedCount: 2,
              linkedCount: 1,
              failedCount: 0,
            },
          ],
        });
        const taskResult = (
          response.payload as unknown as {
            objectResults: Array<{ objectApiName: string; idMappings: unknown[] }>;
          }
        ).objectResults.find((r) => r.objectApiName === 'Task');
        expect(taskResult?.idMappings).toContainEqual({
          sourceId: OFFER_TASK,
          targetId: PLATFORM_TASK,
        });
      });
    });

    describe("the relation the platform writes for an activity's who", () => {
      /** Fake ids: two contacts, an activity, its relations to both, and what the target gives. */
      const WHO = '003Fk00000WhOoAIAV';
      const OTHER = '003Fk00000OtHrAIAV';
      const NEW_WHO = '003Fk00000NeWwAIAV';
      const NEW_OTHER = '003Fk00000NeWoAIAV';
      const TO_THE_WHO = '0RXFk00000WhOoAIAV';
      const TO_THE_OTHER = '0RXFk00000OtHrAIAV';
      const PLATFORM_RELATION = '0RXFk00000PlAtFIAV';

      it.each([
        ['a task', 'Task', 'TaskRelation', 'TaskId', '00TFk00000AcTvAIAV', '00TFk00000NeWaAIAV'],
        [
          'an event',
          'Event',
          'EventRelation',
          'EventId',
          '00UFk00000AcTvAIAV',
          '00UFk00000NeWaAIAV',
        ],
      ])(
        "links the relation the platform wrote for %s's who, and writes the one to another contact",
        async (_, activity, relation, activityField, source, written) => {
          // The platform writes an activity's relation to its who as it takes
          // the activity: the one read from the source is that one.
          const reference = (name: string, ...referenceTo: string[]) => ({
            name,
            type: 'reference',
            referenceTo,
          });
          const query = vi.fn(async (soql: string) => ({
            records: soql.startsWith(`SELECT Id, ${activityField}, RelationId FROM ${relation}`)
              ? [{ Id: PLATFORM_RELATION, [activityField]: written, RelationId: NEW_WHO }]
              : [],
          }));
          mockGetConn.mockResolvedValue({
            describe: vi.fn(async (name: string) => ({
              keyPrefix: null,
              fields:
                name === relation
                  ? [
                      reference(activityField, activity),
                      reference('RelationId', 'Contact', 'Lead'),
                      { name: 'IsWhat', type: 'boolean' },
                    ]
                  : name === activity
                    ? [{ name: 'Subject', type: 'string' }, reference('WhoId', 'Contact', 'Lead')]
                    : [{ name: 'LastName', type: 'string' }],
              recordTypeInfos: [],
            })),
            query,
            limitInfo: undefined,
          } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
          linker.resolveInsertOrder.mockReturnValue(['Contact', activity, relation]);
          fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
            name === 'Contact'
              ? [
                  { Id: WHO, LastName: 'Who' },
                  { Id: OTHER, LastName: 'Other' },
                ]
              : name === activity
                ? [{ Id: source, Subject: 'Visit', WhoId: WHO }]
                : [
                    { Id: TO_THE_WHO, [activityField]: source, RelationId: WHO, IsWhat: false },
                    { Id: TO_THE_OTHER, [activityField]: source, RelationId: OTHER, IsWhat: false },
                  ],
          );
          writer.insert.mockImplementation(async (name: string, records: unknown[]) =>
            name === 'Contact'
              ? [
                  { id: NEW_WHO, success: true, errors: [] },
                  { id: NEW_OTHER, success: true, errors: [] },
                ]
              : records.map(() => ({
                  id: name === activity ? written : '0RXFk00000NeWrAIAV',
                  success: true,
                  errors: [],
                })),
          );

          await handler.handle(
            buildMsg(
              'seed:clone:execute',
              clonePayload({
                objects: [
                  { objectApiName: 'Contact' },
                  { objectApiName: activity },
                  { objectApiName: relation },
                ],
              }),
            ),
          );

          expect(query).toHaveBeenCalledWith(
            `SELECT Id, ${activityField}, RelationId FROM ${relation} WHERE ${activityField} IN ('${written}')`,
          );
          expect(
            writer.insert.mock.calls.filter((c) => c[0] === relation).flatMap((c) => c[1]),
          ).toEqual([{ [activityField]: written, RelationId: NEW_OTHER, IsWhat: false }]);
          const [response] = posted(deps, 'seed:clone:execute:response');
          const result = (
            response.payload as unknown as {
              objectResults: Array<{
                objectApiName: string;
                insertedCount: number;
                linkedCount?: number;
                idMappings: unknown[];
              }>;
            }
          ).objectResults.find((r) => r.objectApiName === relation);
          expect(result).toMatchObject({ insertedCount: 1, linkedCount: 1 });
          expect(result?.idMappings).toContainEqual({
            sourceId: TO_THE_WHO,
            targetId: PLATFORM_RELATION,
          });
        },
      );

      describe('of an event', () => {
        const EVENT = '00UFk00000AcTvAIAV';
        const NEW_EVENT = '00UFk00000NeWaAIAV';
        const PLATFORM_TO_OTHER = '0RXFk00000PlAtOIAV';

        /**
         * Clone two contacts, an event whose who is the first, and `relations`
         * of it; the target answers the relations it holds with `pages`, one
         * after the other, describes `IsInvitee` as `updateable`, and answers
         * an update of the relations with `update`, or takes each.
         */
        async function cloneAnEvent(options: {
          relations: Array<Record<string, unknown>>;
          pages: Array<Array<Record<string, unknown>>>;
          updateable?: boolean;
          update?: (
            records: Array<Record<string, unknown>>,
          ) => Promise<Array<{ success: boolean; errors: string[] }>>;
        }) {
          const { relations, pages, updateable = true, update } = options;
          const reference = (name: string, ...referenceTo: string[]) => ({
            name,
            type: 'reference',
            referenceTo,
          });
          const page = (index: number) => ({
            records: pages[index] ?? [],
            done: index >= pages.length - 1,
            ...(index < pages.length - 1 ? { nextRecordsUrl: `/next/${index + 1}` } : {}),
          });
          const query = vi.fn(async (soql: string) =>
            soql.startsWith('SELECT Id, EventId, RelationId FROM EventRelation')
              ? page(0)
              : { records: [], done: true },
          );
          const queryMore = vi.fn(async (url: string) => page(Number(url.split('/').pop())));
          mockGetConn.mockResolvedValue({
            describe: vi.fn(async (name: string) => ({
              keyPrefix: null,
              fields:
                name === 'EventRelation'
                  ? [
                      reference('EventId', 'Event'),
                      reference('RelationId', 'Contact', 'Lead'),
                      { name: 'IsParent', type: 'boolean' },
                      { name: 'IsInvitee', type: 'boolean', updateable },
                      { name: 'IsWhat', type: 'boolean' },
                    ]
                  : name === 'Event'
                    ? [{ name: 'Subject', type: 'string' }, reference('WhoId', 'Contact', 'Lead')]
                    : [{ name: 'LastName', type: 'string' }],
              recordTypeInfos: [],
            })),
            query,
            queryMore,
            limitInfo: undefined,
          } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
          linker.resolveInsertOrder.mockReturnValue(['Contact', 'Event', 'EventRelation']);
          fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
            name === 'Contact'
              ? [
                  { Id: WHO, LastName: 'Who' },
                  { Id: OTHER, LastName: 'Other' },
                ]
              : name === 'Event'
                ? [{ Id: EVENT, Subject: 'Visit', WhoId: WHO }]
                : relations,
          );
          writer.insert.mockImplementation(async (name: string, records: unknown[]) =>
            name === 'Contact'
              ? [
                  { id: NEW_WHO, success: true, errors: [] },
                  { id: NEW_OTHER, success: true, errors: [] },
                ]
              : records.map(() => ({
                  id: name === 'Event' ? NEW_EVENT : '0RXFk00000NeWrAIAV',
                  success: true,
                  errors: [],
                })),
          );
          writer.update.mockImplementation(
            async (_name: string, records: Array<Record<string, unknown>>) =>
              update ? update(records) : records.map(() => ({ success: true, errors: [] })),
          );

          await handler.handle(
            buildMsg(
              'seed:clone:execute',
              clonePayload({
                objects: [
                  { objectApiName: 'Contact' },
                  { objectApiName: 'Event' },
                  { objectApiName: 'EventRelation' },
                ],
              }),
            ),
          );

          const [response] = posted(deps, 'seed:clone:execute:response');
          return {
            queryMore,
            inserted: writer.insert.mock.calls
              .filter((c) => c[0] === 'EventRelation')
              .flatMap((c) => c[1] as unknown[]),
            updated: writer.update.mock.calls.filter((c) => c[0] === 'EventRelation'),
            result: (
              response.payload as unknown as {
                objectResults: Array<{ objectApiName: string; linkedCount?: number }>;
              }
            ).objectResults.find((r) => r.objectApiName === 'EventRelation'),
          };
        }

        it('reads every page of the relations the target holds', async () => {
          // Asked of two hundred events at a time, the target answers with
          // every relation they hold, two thousand to a page: the relation on
          // the page after was sent again beside the one the target held.
          const { queryMore, inserted, result } = await cloneAnEvent({
            relations: [
              { Id: TO_THE_WHO, EventId: EVENT, RelationId: WHO, IsWhat: false },
              { Id: TO_THE_OTHER, EventId: EVENT, RelationId: OTHER, IsWhat: false },
            ],
            pages: [
              [{ Id: PLATFORM_TO_OTHER, EventId: NEW_EVENT, RelationId: NEW_OTHER }],
              [{ Id: PLATFORM_RELATION, EventId: NEW_EVENT, RelationId: NEW_WHO }],
            ],
          });

          expect(queryMore).toHaveBeenCalledWith('/next/1');
          expect(inserted).toEqual([]);
          expect(result).toMatchObject({ linkedCount: 2 });
        });

        it("gives the relation it links for the event's who the invitee flag its row carried", async () => {
          // The platform writes the relation to the who as it takes the event,
          // not an invitee: linked to in place of the row, the who was no
          // longer invited.
          const { inserted, updated, result } = await cloneAnEvent({
            relations: [
              {
                Id: TO_THE_WHO,
                EventId: EVENT,
                RelationId: WHO,
                IsParent: true,
                IsInvitee: true,
                IsWhat: false,
              },
            ],
            pages: [[{ Id: PLATFORM_RELATION, EventId: NEW_EVENT, RelationId: NEW_WHO }]],
          });

          expect(inserted).toEqual([]);
          expect(updated).toEqual([
            ['EventRelation', [{ Id: PLATFORM_RELATION, IsInvitee: true }], 200],
          ]);
          expect(result).toMatchObject({ linkedCount: 1 });
        });

        it('writes nothing to it and says so when the target does not let the flag be updated', async () => {
          const { updated } = await cloneAnEvent({
            relations: [
              {
                Id: TO_THE_WHO,
                EventId: EVENT,
                RelationId: WHO,
                IsParent: true,
                IsInvitee: true,
                IsWhat: false,
              },
            ],
            pages: [[{ Id: PLATFORM_RELATION, EventId: NEW_EVENT, RelationId: NEW_WHO }]],
            updateable: false,
          });

          expect(updated).toEqual([]);
          expect(deps.log).toHaveBeenCalledWith(
            '[seed:clone] EventRelation: 1 linked without IsInvitee: the target does not let it be updated',
          );
        });

        describe('when the clone is cancelled while the relation is updated', () => {
          /** The id the clone runs under: its request's. */
          const OPERATION_ID = 'msg-seed:clone:execute';
          /** The event's relation to its who, which the event also invites, tentatively. */
          const INVITED_WHO = {
            Id: TO_THE_WHO,
            EventId: EVENT,
            RelationId: WHO,
            IsParent: true,
            IsInvitee: true,
            IsWhat: false,
          };
          /** The target's refusal of a status it does not hold. */
          const TENTATIVE =
            'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Tentative';

          let registry: BackgroundOperationRegistry;
          beforeEach(() => {
            registry = new BackgroundOperationRegistry();
            handler.setRegistry(registry);
          });

          it('sends no update after the cancel, and logs the refusal the target gave', async () => {
            // The update answered for its one relation: the cancel went unseen,
            // and the flag and the status the target refused went again, one
            // at a time, after it.
            const { updated } = await cloneAnEvent({
              relations: [{ ...INVITED_WHO, Status: 'Tentative' }],
              pages: [[{ Id: PLATFORM_RELATION, EventId: NEW_EVENT, RelationId: NEW_WHO }]],
              update: async (records) => {
                registry.abort(OPERATION_ID);
                return records.map(() => ({ success: false, errors: [TENTATIVE] }));
              },
            });

            expect(updated).toEqual([
              [
                'EventRelation',
                [{ Id: PLATFORM_RELATION, IsInvitee: true, Status: 'Tentative' }],
                200,
              ],
            ]);
            expect(deps.log).toHaveBeenCalledWith(
              `[seed:clone] EventRelation: 1 linked without IsInvitee: the target refused the update, ${TENTATIVE}, ` +
                `1 linked without Status: the target refused the update, ${TENTATIVE}`,
            );
          });

          it('logs the relation an aborted update never reached as cancelled, where it dropped the note', async () => {
            await cloneAnEvent({
              relations: [INVITED_WHO],
              pages: [[{ Id: PLATFORM_RELATION, EventId: NEW_EVENT, RelationId: NEW_WHO }]],
              update: async () => {
                registry.abort(OPERATION_ID);
                throw new WriteCancelledError('EventRelation');
              },
            });

            expect(deps.log).toHaveBeenCalledWith(
              '[seed:clone] EventRelation: 1 linked without IsInvitee: the run was cancelled before it was updated',
            );
          });
        });
      });
    });

    it('leaves out the fields the target does not have, and names them in the result', async () => {
      // The fetcher reads the fields the source describes. A custom field the
      // target lacks cost the whole record: the org refuses a record carrying one.
      mockGetConn.mockResolvedValue({
        describe: vi.fn(async () => ({
          keyPrefix: '001',
          fields: [
            { name: 'Name', type: 'string', createable: true },
            { name: 'Industry', type: 'picklist', createable: true },
          ],
          recordTypeInfos: [],
        })),
        limitInfo: undefined,
      } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
      fetcher.fetchRecords.mockResolvedValue([
        { Id: '001SRC1', Name: 'Acme', Industry: 'Energy', Region__c: 'North', Legacy__c: 'A-1' },
        { Id: '001SRC2', Name: 'Globex', Industry: null, Region__c: null, Legacy__c: 'G-7' },
      ]);
      writer.insert.mockResolvedValue([
        { id: '001TGT1', success: true, errors: [] },
        { id: '001TGT2', success: true, errors: [] },
      ]);

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(writer.insert).toHaveBeenCalledWith(
        'Account',
        [
          { Name: 'Acme', Industry: 'Energy' },
          { Name: 'Globex', Industry: null },
        ],
        200,
      );
      const [response] = posted(deps, 'seed:clone:execute:response');
      expect(response.payload as unknown).toMatchObject({
        status: 'success',
        totalInserted: 2,
        objectResults: [
          {
            objectApiName: 'Account',
            insertedCount: 2,
            fieldsNotInTarget: ['Legacy__c', 'Region__c'],
          },
        ],
      });
      expect(deps.log).toHaveBeenCalledWith(
        '[INFO] seed:clone Account: 2 field(s) the target does not have left out — ' +
          'Legacy__c, Region__c',
      );
    });

    it('reports execute failures on operation:failed as retryable', async () => {
      writer.insert.mockRejectedValue(new Error('bulk write exploded'));

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      // The English text is what the output channel and the fix-suggestion
      // table read; the code is what the wizard translates.
      expect(failures[0].payload as unknown).toMatchObject({
        error: 'bulk write exploded',
        retryable: true,
        code: 'CLONE_FAILED',
      });
    });

    describe('a clone a cancel stopped', () => {
      /** The id the clone runs under: its request's. */
      const OPERATION_ID = 'msg-seed:clone:execute';

      /** Account, then Contact. */
      const accountsAndContacts = (): Record<string, unknown> =>
        clonePayload({ objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }] });

      let registry: BackgroundOperationRegistry;
      beforeEach(() => {
        registry = new BackgroundOperationRegistry();
        handler.setRegistry(registry);
        linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);
      });

      it('writes no object after the cancel, and ends as aborted with what it wrote', async () => {
        // Only an upload of more than ten thousand records looked at the
        // cancel: every other object went on being read and written.
        writer.insert.mockImplementation(async () => {
          registry.abort(OPERATION_ID);
          return [{ id: '001TGT', success: true, errors: [] }];
        });

        await handler.handle(buildMsg('seed:clone:execute', accountsAndContacts()));

        expect(writer.insert.mock.calls.map((call) => call[0])).toEqual(['Account']);
        expect(posted(deps, 'operation:failed')).toEqual([]);
        expect(posted(deps, 'operation:completed')[0].payload as unknown).toEqual({
          operationId: OPERATION_ID,
          result: { aborted: true, totalInserted: 1, totalFailed: 0 },
        });
        expect(registry.get(OPERATION_ID)?.status).toBe('aborted');
        // The wizard hears what was written, and that the clone did not finish.
        expect(posted(deps, 'seed:clone:execute:response')[0].payload as unknown).toMatchObject({
          cancelled: true,
          status: 'partial',
          totalInserted: 1,
        });
      });

      it('ends cancelled when the cancel aborted the upload of its last object', async () => {
        writer.insert.mockImplementation(async (name: string) => {
          if (name === 'Contact') {
            registry.abort(OPERATION_ID);
            throw new WriteCancelledError('Contact');
          }
          return [{ id: '001TGT', success: true, errors: [] }];
        });

        await handler.handle(buildMsg('seed:clone:execute', accountsAndContacts()));

        expect(posted(deps, 'operation:completed')[0].payload as unknown).toMatchObject({
          result: { aborted: true, totalInserted: 1 },
        });
        expect(posted(deps, 'seed:clone:execute:response')[0].payload as unknown).toMatchObject({
          cancelled: true,
          objectResults: [{ objectApiName: 'Account' }],
        });
      });

      it('counts what an object wrote before the cancel stopped its write between two batches', async () => {
        // Those records stay in the target: a clone that left them out said
        // less was written than was, and lost their ids.
        fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
          name === 'Account'
            ? [{ Id: '001SRC', Name: 'Acme' }]
            : [
                { Id: '003SRC1', LastName: 'Doe' },
                { Id: '003SRC2', LastName: 'Roe' },
                { Id: '003SRC3', LastName: 'Poe' },
              ],
        );
        writer.insert.mockImplementation(async (name: string) => {
          if (name === 'Contact') {
            registry.abort(OPERATION_ID);
            throw new WriteCancelledError('Contact', [
              { id: '003TGT1', success: true, errors: [] },
              { success: false, errors: ['REQUIRED_FIELD_MISSING: LastName'] },
            ]);
          }
          return [{ id: '001TGT', success: true, errors: [] }];
        });

        await handler.handle(buildMsg('seed:clone:execute', accountsAndContacts()));

        expect(posted(deps, 'operation:completed')[0].payload as unknown).toEqual({
          operationId: OPERATION_ID,
          result: { aborted: true, totalInserted: 2, totalFailed: 1 },
        });
        const response = posted(deps, 'seed:clone:execute:response')[0].payload as unknown;
        expect(response).toMatchObject({
          cancelled: true,
          status: 'partial',
          totalInserted: 2,
          totalFailed: 1,
        });
        expect((response as { objectResults: unknown[] }).objectResults[1]).toMatchObject({
          objectApiName: 'Contact',
          sourceCount: 3,
          insertedCount: 1,
          failedCount: 1,
          idMappings: [{ sourceId: '003SRC1', targetId: '003TGT1' }],
          errors: [{ sourceId: '003SRC2', message: 'REQUIRED_FIELD_MISSING: LastName' }],
        });
      });

      it('still fails when a write fails while the cancel is pending', async () => {
        writer.insert.mockImplementation(async () => {
          registry.abort(OPERATION_ID);
          throw new Error('bulk write exploded');
        });

        await handler.handle(buildMsg('seed:clone:execute', accountsAndContacts()));

        expect(posted(deps, 'operation:completed')).toEqual([]);
        expect(posted(deps, 'operation:failed')[0].payload as unknown).toMatchObject({
          operationId: OPERATION_ID,
          error: 'bulk write exploded',
        });
      });
    });
  });

  describe('in Live Operations', () => {
    /** The id the clone runs under: its request's. */
    const OPERATION_ID = 'msg-seed:clone:execute';

    let tracker: LiveOperationTracker;
    let registry: BackgroundOperationRegistry;
    beforeEach(() => {
      tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);
      registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);
    });
    afterEach(() => {
      tracker.dispose();
    });

    it('lists a clone while it runs, under the id its Cancel reaches it by', async () => {
      let listed: LiveOperation[] = [];
      writer.insert.mockImplementation(async () => {
        listed = tracker.getAll().map((op) => ({ ...op }));
        return [{ id: '001TGT', success: true, errors: [] }];
      });

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(listed).toEqual([
        expect.objectContaining({
          operationId: OPERATION_ID,
          module: 'clone',
          status: 'running',
          currentStep: 'Cloning Account',
        }),
      ]);
      expect(registry.get(OPERATION_ID)).toBeDefined();
      expect(tracker.get(OPERATION_ID)?.status).toBe('completed');
    });

    it('counts the objects already written in as the upload of the next one goes', async () => {
      linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);
      fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
        name === 'Account'
          ? [{ Id: '001SRC', Name: 'Acme' }]
          : [
              { Id: '003SRC1', LastName: 'One' },
              { Id: '003SRC2', LastName: 'Two' },
            ],
      );
      let midway: LiveOperation | undefined;
      writer.insert.mockImplementation(async (name: string, records: unknown[]) => {
        if (name === 'Contact') {
          // The writer reports the upload of the second object half done.
          const { onProgress } = vi.mocked(BulkDataWriter).mock.calls[0][0] as unknown as {
            onProgress: (processed: number, total: number, label: string) => void;
          };
          onProgress(1, 2, 'Contact: 1/2');
          midway = { ...tracker.getAll()[0] };
        }
        return records.map(() => ({ id: '001TGT', success: true, errors: [] }));
      });

      await handler.handle(
        buildMsg(
          'seed:clone:execute',
          clonePayload({ objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }] }),
        ),
      );

      // One object of two written, and half of the second: three quarters.
      expect(midway).toMatchObject({
        percentage: 75,
        processedRecords: 2,
        currentStep: 'Contact: 1/2',
      });
    });

    it('ends a clone whose write failed as failed, with its error', async () => {
      writer.insert.mockRejectedValue(new Error('bulk write exploded'));

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(tracker.get(OPERATION_ID)).toMatchObject({
        status: 'failed',
        error: 'bulk write exploded',
      });
    });

    it('ends a clone that wrote no record as failed', async () => {
      writer.insert.mockResolvedValue([
        { id: '', success: false, errors: ['REQUIRED_FIELD_MISSING: Name'] },
      ]);

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(tracker.get(OPERATION_ID)).toMatchObject({
        status: 'failed',
        error: 'No record could be cloned.',
      });
    });

    it('ends a clone a cancel stopped as cancelled', async () => {
      writer.insert.mockImplementation(async () => {
        registry.abort(OPERATION_ID);
        throw new WriteCancelledError('Account');
      });

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(tracker.get(OPERATION_ID)?.status).toBe('cancelled');
    });
  });

  describe('how a clone ends in the registry', () => {
    /** The id the clone runs under: its request's. */
    const OPERATION_ID = 'msg-seed:clone:execute';

    let registry: BackgroundOperationRegistry;
    beforeEach(() => {
      registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);
    });

    it('ends a clone that wrote nothing as failed, as it ends everywhere else', async () => {
      writer.insert.mockResolvedValue([
        { id: '', success: false, errors: ['REQUIRED_FIELD_MISSING: Name'] },
      ]);

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      await vi.waitFor(() => expect(registry.get(OPERATION_ID)?.status).toBe('failed'));
      expect(registry.get(OPERATION_ID)?.resultSummary).toBe('No record could be cloned.');
      expect(posted(deps, 'operation:completed')[0].payload as unknown).toMatchObject({
        result: { status: 'failure' },
      });
    });

    it('ends a clone that wrote its records as completed', async () => {
      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      await vi.waitFor(() => expect(registry.get(OPERATION_ID)?.status).toBe('completed'));
    });
  });

  describe('audit trail', () => {
    const SOURCE_ACCOUNT_ID = '001Fk00000SoUrCIAV';
    const EXISTING_ACCOUNT_ID = '001Fk00000ExIsTIAV';

    /** A real store, read back the way the Reports page reads it. */
    function recordingStore(): ConfigStore {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      store.initialize();
      deps.configStore = store;
      return store;
    }

    it('records a clone once, and counts its lineage from its own id mappings', async () => {
      const store = recordingStore();
      linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);
      fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
        name === 'Account'
          ? [{ Id: SOURCE_ACCOUNT_ID, Name: 'Acme' }]
          : [
              { Id: '003Fk00000AaAaAIAV', LastName: 'Doe' },
              { Id: '003Fk00000BbBbBIAV', LastName: 'Roe' },
            ],
      );
      writer.insert.mockImplementation(async (name: string) =>
        name === 'Account'
          ? [{ success: false, errors: ['DUPLICATE_VALUE'], existingId: EXISTING_ACCOUNT_ID }]
          : [
              { id: '003Fk00000NeWcTIAV', success: true, errors: [] },
              { success: false, errors: ['REQUIRED_FIELD_MISSING'] },
            ],
      );

      await handler.handle(
        buildMsg(
          'seed:clone:execute',
          clonePayload({ objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }] }),
        ),
      );

      const { entries } = new AuditTrailStore(store).list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'seed_clone',
        module: 'seed',
        operationId: 'msg-seed:clone:execute',
        orgId: 'tgt-org',
        sourceOrgId: 'src-org',
        outcome: 'partial',
        objects: [
          // Linked to a record the target held: neither created nor failed.
          { objectApiName: 'Account', created: 0, failed: 0 },
          { objectApiName: 'Contact', created: 1, failed: 1 },
        ],
      });
      // The linked Account has a counterpart in the target, the refused Contact has none.
      const lineage = new LineageStore(store).get('msg-seed:clone:execute');
      expect(
        lineage?.nodes.filter((n) => n.type === 'object').map((n) => [n.label, n.recordCount]),
      ).toEqual([
        ['Account', 1],
        ['Contact', 1],
      ]);
      const stored = JSON.stringify([store.get('audit:trail'), store.get('lineage:runs')]);
      expect(stored).not.toContain(SOURCE_ACCOUNT_ID);
      expect(stored).not.toContain(EXISTING_ACCOUNT_ID);
    });

    it('records a clone that failed partway with the objects it had written', async () => {
      const store = recordingStore();
      linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);
      fetcher.fetchRecords.mockResolvedValue([{ Id: SOURCE_ACCOUNT_ID, Name: 'Acme' }]);
      writer.insert.mockImplementation(async (name: string) => {
        if (name === 'Contact') throw new Error('bulk write exploded');
        return [{ id: '001Fk00000NeWaCIAV', success: true, errors: [] }];
      });

      await handler.handle(
        buildMsg(
          'seed:clone:execute',
          clonePayload({ objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }] }),
        ),
      );

      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({
          outcome: 'failure',
          objects: [expect.objectContaining({ objectApiName: 'Account', created: 1 })],
        }),
      ]);
    });
  });

  describe('production guard', () => {
    /** Wire a mock ProductionGuard into deps.infraServices and return its spies. */
    function wireGuard(behavior: {
      allowed: boolean;
      requiresConfirmation?: boolean;
      blockedReason?: string;
      confirmed?: boolean;
    }): {
      check: ReturnType<typeof vi.fn>;
      confirmIfNeeded: ReturnType<typeof vi.fn>;
    } {
      const check = vi.fn().mockReturnValue({
        allowed: behavior.allowed,
        requiresConfirmation: behavior.requiresConfirmation ?? false,
        requiresApproval: false,
        blockedReason: behavior.blockedReason,
        warnings: [],
        impactSummary:
          'INSERT an unknown number of Account record(s) on production org tgt-org [module: clone]',
      });
      const confirmIfNeeded = vi.fn().mockResolvedValue(behavior.confirmed ?? true);
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: { check, confirmIfNeeded },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      return { check, confirmIfNeeded };
    }

    function mockTargetOrgType(orgType: string): void {
      vi.mocked(deps.orgManager.getOrg).mockReturnValue({
        orgType,
      } as unknown as ReturnType<HandlerDeps['orgManager']['getOrg']>);
    }

    it('refuses with NOT_INITIALIZED, writing nothing, when no Production Guard was injected', async () => {
      // A host that never wired the guard used to skip it and clone on.
      deps.infraServices = undefined;
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(writer.insert).not.toHaveBeenCalled();
      expect(getJsforceConnection).not.toHaveBeenCalled();
      const failed = posted(deps, 'operation:failed') as Array<
        BaseMessage & { payload: { code?: string; retryable?: boolean } }
      >;
      expect(failed).toHaveLength(1);
      expect(failed[0].payload).toMatchObject({ code: 'NOT_INITIALIZED', retryable: false });
      expect(posted(deps, 'seed:clone:execute:response')).toHaveLength(0);
      // Recorded as the guard's own refusals are, with the code that says why.
      const trail = vi
        .mocked(deps.configStore.set)
        .mock.calls.filter(([key]) => key === 'audit:trail');
      expect(trail.at(-1)?.[1]).toEqual([
        expect.objectContaining({
          action: 'seed_clone',
          outcome: 'stopped',
          details: { code: 'NOT_INITIALIZED' },
        }),
      ]);
    });

    it('resolves the guard tier from the target org and clones once confirmed', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: true,
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgId: 'tgt-org',
        orgTier: 'production',
        operation: 'insert',
        objectName: 'Account',
        module: 'clone',
      });
      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(writer.insert).toHaveBeenCalledTimes(1);
      expect(posted(deps, 'seed:clone:execute:response')).toHaveLength(1);
    });

    it('names every object of the clone to the guard, count unknown until the source is read', async () => {
      const guard = wireGuard({ allowed: true, requiresConfirmation: true, confirmed: true });
      mockTargetOrgType('Production');
      linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);

      await handler.handle(
        buildMsg(
          'seed:clone:execute',
          clonePayload({
            objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }],
          }),
        ),
      );

      expect(guard.check.mock.calls[0][0]).toMatchObject({
        objectName: 'Account, Contact',
        recordCount: 'unknown',
      });
    });

    it('declares an upsert clone as an upsert to the guard', async () => {
      const guard = wireGuard({ allowed: true });
      mockTargetOrgType('Sandbox');

      await handler.handle(
        buildMsg(
          'seed:clone:execute',
          clonePayload({ upsert: true, externalIdField: 'External_Id__c' }),
        ),
      );

      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgTier: 'development',
        operation: 'upsert',
      });
      expect(writer.upsert).toHaveBeenCalledWith(
        'Account',
        'External_Id__c',
        [{ Name: 'Acme' }],
        200,
      );
    });

    it('blocks the clone when the guard refuses — no write, retryable operation:failed', async () => {
      const guard = wireGuard({
        allowed: false,
        blockedReason: 'insert is not allowed on production org tgt-org',
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(guard.confirmIfNeeded).not.toHaveBeenCalled();
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'seed:clone:execute:response')).toHaveLength(0);

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toEqual({
        operationId: 'msg-seed:clone:execute',
        error:
          'Operation blocked by Production Guard: insert is not allowed on production org tgt-org',
        retryable: true,
        code: 'PRODUCTION_GUARD_BLOCKED',
      });
    });

    it('falls back to the impact summary when the guard blocks without a reason', async () => {
      wireGuard({ allowed: false });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      const failures = posted(deps, 'operation:failed');
      expect((failures[0].payload as { error: string }).error).toBe(
        'Operation blocked by Production Guard: INSERT an unknown number of Account record(s) on production org tgt-org [module: clone]',
      );
    });

    it('cancels the clone when the user declines confirmation — no write, not retryable', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: false,
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(guard.confirmIfNeeded).toHaveBeenCalledTimes(1);
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'operation:started')).toHaveLength(0);
      expect(posted(deps, 'seed:clone:execute:response')).toHaveLength(0);

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toEqual({
        operationId: 'msg-seed:clone:execute',
        error: 'Operation cancelled by user (production confirmation declined).',
        retryable: false,
        code: 'PRODUCTION_CONFIRMATION_DECLINED',
      });
    });

    it('asks before cloning into an org the registry does not know, and writes nothing when declined', async () => {
      // A real guard, and getOrg left unstubbed: nothing shows 'tgt-org' is a
      // sandbox. It was classed as development, so the clone wrote without a
      // word to the user.
      const requestConfirmation = vi.fn().mockResolvedValue(false);
      const guard = new ProductionGuard({ requestConfirmation });
      const check = vi.spyOn(guard, 'check');
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: guard,
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(requestConfirmation).toHaveBeenCalledWith(
        'INSERT an unknown number of Account record(s) on production org tgt-org [module: clone]',
        'production',
      );
      expect(check.mock.calls.map(([request]) => request.orgTier)).toEqual(['production']);
      expect(mockGetConn).not.toHaveBeenCalled();
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'operation:failed')[0].payload as unknown).toMatchObject({
        retryable: false,
        code: 'PRODUCTION_CONFIRMATION_DECLINED',
      });
    });

    it('does not leave a declined clone listed as running', async () => {
      // Registered before the question was asked; left unsettled, it stayed
      // "running" in Live Operations for the rest of the session.
      const registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: new ProductionGuard({
          requestConfirmation: vi.fn().mockResolvedValue(false),
        }),
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(registry.getRunning()).toEqual([]);
    });

    it('tells the model which objects a failed clone was writing', async () => {
      // The prompt is all the model sees: without the run behind it, an org
      // error arrives as a bare sentence and the answer fits any clone.
      const provider = vi.fn<AIProvider>(function () {
        return Promise.resolve(
          JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 }),
        );
      });
      deps.errorResolver = new ErrorResolver(provider);
      deps.broker = {
        postToWebview: vi.fn(),
        panelCount: 1,
        showFixSuggestion: vi.fn(),
      } as unknown as HandlerDeps['broker'];
      writer.insert.mockRejectedValue(new Error('SOMETHING_WE_HAVE_NEVER_SEEN: odd'));

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

      const [prompt] = provider.mock.calls[0];
      expect(prompt).toContain('Module: seed');
      expect(prompt).toContain('Operation: seed:clone:execute');
      expect(prompt).toContain('Target object: Account');
      expect(prompt).toContain('Batch size: 200');
    });
  });
});
