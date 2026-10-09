import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BaseMessage,
  FrozenProjectConfig,
  FrozenRemovalResult,
  FrozenStatusInfo,
} from '@sandforge/shared';

import { FrozenDatasetHandler } from './FrozenDatasetHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { writeCountingContract } from '../../modules/frozendataset/CountingContract.js';
import { SasPathGuard } from '../../modules/frozendataset/SasPathGuard.js';
import { SasReferenceIdMappingStore } from '../../modules/frozendataset/SasReferenceIdMappingStore.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** The registered org the load wrote to, and the id it answers with. */
const TARGET_ORG = 'org-dev';
const ORGANIZATION = '00DXX00000AbCdE2A1';
/** The same sandbox after a refresh: another org behind the same registration. */
const REFRESHED = '00Dxx00000FgHiJ3B2';

/** The load, by this machine's clock: it began at 10:00 and wrote its last record at 10:05. */
const LOAD_STARTED = '2026-09-20T10:00:00.000Z';
const LOAD_ENDED = '2026-09-20T10:05:00.000Z';
const DURING_LOAD = '2026-09-20T10:02:00.000+0000';
const AFTER_LOAD = '2026-09-20T11:00:00.000+0000';

/** The user the session to the target writes as. */
const USER = id('005', 1);

const ACCOUNT = id('001', 1);
const CONTACTS = [id('003', 1), id('003', 2)];
const STANDARD_BOOK = id('01s', 1);

type Row = Record<string, unknown> & { Id: string };

/**
 * The target org as jsforce shows it: the account and two contacts the load
 * created, the standard price book it matched, a delete that takes what
 * cascades along — or that the org refuses, record by record — and the
 * Organization row that says which org it is.
 */
function targetOrg() {
  const children = new Map([
    ['Account', [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }]],
  ]);
  const rows = new Map<string, Row[]>([
    ['Account', [{ Id: ACCOUNT, CreatedDate: DURING_LOAD, LastModifiedDate: DURING_LOAD }]],
    [
      'Contact',
      CONTACTS.map((contact) => ({
        Id: contact,
        AccountId: ACCOUNT,
        CreatedDate: DURING_LOAD,
        LastModifiedDate: DURING_LOAD,
      })),
    ],
    ['Pricebook2', [{ Id: STANDARD_BOOK, CreatedDate: '2020-01-01T00:00:00.000+0000' }]],
  ]);
  const organization = { id: ORGANIZATION };
  const deletes: Array<{ object: string; ids: string[] }> = [];
  let beforeDelete: (object: string) => void | Promise<void> = () => {};
  let refuseDelete: (object: string, row: Row) => string | undefined = () => undefined;
  const conn = {
    limitInfo: undefined,
    query: vi.fn(async (soql: string) => {
      if (soql === 'SELECT Id FROM Organization') {
        return { totalSize: 1, done: true, records: [{ Id: organization.id }] };
      }
      const match = /^SELECT (.+) FROM (\w+) WHERE (\w+) IN \((.*)\)(?: LIMIT \d+)?$/.exec(soql);
      if (!match) throw new Error(`unexpected query: ${soql}`);
      const [, columns, object, field, list] = match;
      const wanted = new Set(list.split(', ').map((q) => q.slice(1, -1)));
      const records = (rows.get(object) ?? [])
        .filter((row) => wanted.has(String(row[field])))
        .map((row) => Object.fromEntries(columns.split(', ').map((c) => [c, row[c]])));
      return { totalSize: records.length, done: true, records };
    }),
    describe: vi.fn(async (object: string) => ({
      name: object,
      label: object,
      fields: [],
      childRelationships: children.get(object) ?? [],
    })),
    describeGlobal: vi.fn(async () => ({
      sobjects: [...rows.keys()].map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        layoutable: true,
      })),
    })),
    soap: {
      getServerTimestamp: vi.fn(async () => ({ timestamp: new Date().toISOString() })),
      getUserInfo: vi.fn(async () => ({ userId: USER })),
    },
    sobject: (object: string) => ({
      destroy: vi.fn(async (ids: string[]) => {
        await beforeDelete(object);
        deletes.push({ object, ids: [...ids] });
        return ids.map((recordId) => {
          const remove = (from: string, what: string): void => {
            rows.set(
              from,
              (rows.get(from) ?? []).filter((r) => r.Id !== what),
            );
            for (const child of children.get(from) ?? []) {
              for (const row of rows.get(child.childSObject) ?? []) {
                if (row[child.field] === what) remove(child.childSObject, row.Id);
              }
            }
          };
          const row = (rows.get(object) ?? []).find((r) => r.Id === recordId);
          const refused = row && refuseDelete(object, row);
          if (refused) {
            return {
              id: recordId,
              success: false,
              errors: [{ statusCode: 'FIELD_INTEGRITY_EXCEPTION', message: refused, fields: [] }],
            };
          }
          remove(object, recordId);
          return { id: recordId, success: true, errors: [] };
        });
      }),
      update: vi.fn(async (records: Array<Record<string, unknown>>) =>
        records.map((record) => ({ id: record.Id, success: true, errors: [] })),
      ),
    }),
  };
  return {
    conn,
    rows,
    deletes,
    children,
    organization,
    onDelete: (hook: (object: string) => void | Promise<void>) => {
      beforeDelete = hook;
    },
    /** Refuse the delete of a record, with the message the org gives. */
    refuseDelete: (rule: (object: string, row: Row) => string | undefined) => {
      refuseDelete = rule;
    },
  };
}

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `req-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

describe('frozen:remove', () => {
  let sasDir: string;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: FrozenDatasetHandler;
  let registry: BackgroundOperationRegistry;
  let tracker: LiveOperationTracker;
  let org: ReturnType<typeof targetOrg>;

  /** Messages posted to the webview, of one type. */
  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const errors = () =>
    posted<BaseMessage & { payload: { code: string; message: string } }>('frozen:remove:error');
  const answer = (): FrozenRemovalResult | undefined =>
    posted<BaseMessage & { payload: { result: FrozenRemovalResult } }>('frozen:remove:response')[0]
      ?.payload.result;
  const trail = () => new AuditTrailStore(store).list().entries;
  /** What the sas mapping says of the load now. */
  const recorded = () => new SasReferenceIdMappingStore(sasDir, { orgId: TARGET_ORG }).recorded();
  const remove = (payload: Record<string, unknown> = {}) =>
    handler.handle(
      buildMsg('frozen:remove', { targetOrgId: TARGET_ORG, loadedAt: LOAD_ENDED, ...payload }),
    );

  /** The mapping the load wrote: what it created, and the standard book it matched. */
  async function loaded(created = true): Promise<void> {
    await new SasReferenceIdMappingStore(sasDir, {
      orgId: TARGET_ORG,
      organizationId: ORGANIZATION,
      now: () => new Date(LOAD_ENDED),
    }).persist(
      new Map([
        ['Pricebook2-000001', STANDARD_BOOK],
        ['Account-000001', ACCOUNT],
        ['Contact-000001', CONTACTS[0]],
        ['Contact-000002', CONTACTS[1]],
      ]),
      created
        ? {
            created: [
              { objectApiName: 'Account', referenceIds: ['Account-000001'] },
              {
                objectApiName: 'Contact',
                referenceIds: ['Contact-000001', 'Contact-000002'],
              },
            ],
            startedAt: new Date(LOAD_STARTED),
          }
        : undefined,
    );
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-frozen-remove-'));
    const config: FrozenProjectConfig = {
      rootObject: 'Account',
      axes: [],
      edgeCases: [],
      sasDir,
    };
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    store.set('frozen:config', config, 'frozen');
    registry = new BackgroundOperationRegistry();
    tracker = new LiveOperationTracker();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn().mockReturnValue({ orgType: 'Sandbox', alias: 'DEV' }),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard(),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new FrozenDatasetHandler(deps);
    handler.setRegistry(registry);
    handler.setLiveOperationTracker(tracker);
    org = targetOrg();
    mockGetConn.mockResolvedValue(org.conn as never);
    await loaded();
  });

  afterEach(() => {
    fs.rmSync(sasDir, { recursive: true, force: true });
  });

  it('removes what the load created, children first, and keeps the book it matched', async () => {
    await remove();

    expect(mockGetConn).toHaveBeenCalledWith(TARGET_ORG, deps.orgRegistry, deps.orgManager);
    expect(org.deletes).toEqual([
      { object: 'Contact', ids: [CONTACTS[1], CONTACTS[0]] },
      { object: 'Account', ids: [ACCOUNT] },
    ]);
    expect(org.rows.get('Pricebook2')).toHaveLength(1);
    expect(answer()).toMatchObject({
      status: 'success',
      includeChanged: false,
      objects: [
        { objectApiName: 'Contact', planned: 2, deleted: 2 },
        { objectApiName: 'Account', planned: 1, deleted: 1 },
      ],
    });
    expect(errors()).toEqual([]);
  });

  describe('after a load into another org', () => {
    // One mapping per sas, a load into a second org replaced the first org's:
    // the first load's records could no longer be removed, nor purged by a
    // reload into its org.
    const OTHER_ORG = 'org-qa';
    const OTHER_ACCOUNT = id('001', 9);

    async function loadedIntoTheOther(): Promise<void> {
      await new SasReferenceIdMappingStore(sasDir, {
        orgId: OTHER_ORG,
        organizationId: '00DXX00000QaOrg2A1',
        now: () => new Date('2026-09-20T12:05:00.000Z'),
      }).persist(new Map([['Account-000001', OTHER_ACCOUNT]]), {
        created: [{ objectApiName: 'Account', referenceIds: ['Account-000001'] }],
        startedAt: new Date('2026-09-20T12:00:00.000Z'),
        earlier: { settled: [] },
      });
    }

    it('still removes what the load into the first org created', async () => {
      await loadedIntoTheOther();

      await remove();

      expect(errors()).toEqual([]);
      expect(org.deletes).toEqual([
        { object: 'Contact', ids: [CONTACTS[1], CONTACTS[0]] },
        { object: 'Account', ids: [ACCOUNT] },
      ]);
      // The other org's load is left as it was, for its own removal.
      const other = await new SasReferenceIdMappingStore(sasDir, { orgId: OTHER_ORG }).recorded();
      expect(other?.mapping).toEqual(new Map([['Account-000001', OTHER_ACCOUNT]]));
      expect(other?.removal).toBeUndefined();
    });

    it('tells the page of the loads into each org', async () => {
      await loadedIntoTheOther();

      await handler.handle(buildMsg('frozen:status'));

      const [{ payload }] = posted<BaseMessage & { payload: { status: FrozenStatusInfo } }>(
        'frozen:status:response',
      );
      expect(
        payload.status.loadRecords?.map((load) => [load.orgId, load.loadedAt, load.created]),
      ).toEqual([
        [
          TARGET_ORG,
          LOAD_ENDED,
          [
            { objectApiName: 'Contact', count: 2 },
            { objectApiName: 'Account', count: 1 },
          ],
        ],
        [OTHER_ORG, '2026-09-20T12:05:00.000Z', [{ objectApiName: 'Account', count: 1 }]],
      ]);
    });
  });

  it('records the removal in the audit trail with what it deleted per object, and no id', async () => {
    await remove();

    expect(trail()).toEqual([
      expect.objectContaining({
        action: 'cleanup_delete',
        module: 'frozen',
        orgId: TARGET_ORG,
        outcome: 'success',
        guard: 'allowed',
        objects: [
          { objectApiName: 'Contact', created: 0, updated: 0, deleted: 2, failed: 0 },
          { objectApiName: 'Account', created: 0, updated: 0, deleted: 1, failed: 0 },
        ],
      }),
    ]);
    expect(JSON.stringify(store.get('audit:trail'))).not.toContain(CONTACTS[0]);
  });

  it('marks the load and forgets what went, so the removal is neither offered nor run twice', async () => {
    await remove();

    const load = await recorded();
    expect(load?.removal).toEqual({
      removedAt: answer()?.finishedAt,
      deleted: 3,
      alreadyGone: 0,
      kept: 0,
      refused: 0,
    });
    // The book it matched stays mapped; what went is forgotten.
    expect(load?.mapping).toEqual(new Map([['Pricebook2-000001', STANDARD_BOOK]]));

    vi.mocked(deps.broker.postToWebview).mockClear();
    org.deletes.length = 0;
    await remove();

    expect(org.deletes).toEqual([]);
    expect(errors().map((e) => e.payload.code)).toEqual(['ALREADY_REMOVED']);
  });

  it('keeps a contact modified since the load, and the account it hangs from, unless asked', async () => {
    (org.rows.get('Contact') ?? [])[0].LastModifiedDate = AFTER_LOAD;

    await remove();

    expect(answer()).toMatchObject({
      status: 'partial',
      objects: [
        { objectApiName: 'Contact', deleted: 1, keptChanged: 1 },
        { objectApiName: 'Account', deleted: 0, keptDependents: 1, heldBy: ['Contact'] },
      ],
    });
    // What stays is still the load's, for a reload to take.
    expect((await recorded())?.created).toEqual([
      { objectApiName: 'Account', referenceIds: ['Account-000001'] },
      { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
    ]);
  });

  describe('what a removal left in the org', () => {
    /** The first removal: the contact changed since the load is kept, and the account under it. */
    async function partlyRemoved(): Promise<FrozenRemovalResult | undefined> {
      (org.rows.get('Contact') ?? [])[0].LastModifiedDate = AFTER_LOAD;
      await remove();
      const first = answer();
      vi.mocked(deps.broker.postToWebview).mockClear();
      org.deletes.length = 0;
      return first;
    }

    const status = async (): Promise<FrozenStatusInfo> => {
      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('frozen:status'));
      return posted<BaseMessage & { payload: { status: FrozenStatusInfo } }>(
        'frozen:status:response',
      )[0].payload.status;
    };

    it('is removed by the next removal, which takes those records alone and says so', async () => {
      const first = await partlyRemoved();
      expect(first?.status).toBe('partial');

      await remove({ includeChanged: true });

      expect(errors()).toEqual([]);
      expect(org.deletes).toEqual([
        { object: 'Contact', ids: [CONTACTS[0]] },
        { object: 'Account', ids: [ACCOUNT] },
      ]);
      expect(answer()).toMatchObject({
        status: 'success',
        leftBy: first?.finishedAt,
        objects: [
          { objectApiName: 'Contact', planned: 1, deleted: 1 },
          { objectApiName: 'Account', planned: 1, deleted: 1 },
        ],
      });
      expect(trail()[0]).toMatchObject({ outcome: 'success', leftBy: first?.finishedAt });
      expect(trail()[1]).not.toHaveProperty('leftBy');
      // The load's mark counts what both removals took.
      const load = await recorded();
      expect(load?.removal).toEqual({
        removedAt: answer()?.finishedAt,
        deleted: 3,
        alreadyGone: 0,
        kept: 0,
        refused: 0,
      });
      expect(load?.mapping).toEqual(new Map([['Pricebook2-000001', STANDARD_BOOK]]));

      vi.mocked(deps.broker.postToWebview).mockClear();
      await remove({ includeChanged: true });
      expect(errors().map((e) => e.payload.code)).toEqual(['ALREADY_REMOVED']);
    });

    it('is what the page is told a removal takes, with the mark of the one that left it', async () => {
      const first = await partlyRemoved();

      expect((await status()).loadRecords?.find((load) => load.orgId === TARGET_ORG)).toEqual({
        orgId: TARGET_ORG,
        loadedAt: LOAD_ENDED,
        created: [
          { objectApiName: 'Contact', count: 1 },
          { objectApiName: 'Account', count: 1 },
        ],
        linked: 1,
        recorded: true,
        removed: {
          removedAt: first?.finishedAt,
          deleted: 1,
          alreadyGone: 0,
          kept: 2,
          refused: 0,
        },
      });
    });

    it('refuses to verify a load a removal took part of, saying how many records it left and how to take them', async () => {
      const first = await partlyRemoved();
      store.set(
        'frozen:lastRun',
        {
          contractPath: writeCountingContract(new SasPathGuard(), sasDir, {
            version: 1,
            orgId: TARGET_ORG,
            datasetVersion: '1.0.0',
            writtenAt: LOAD_ENDED,
            loadStartedAt: LOAD_STARTED,
            objects: {},
          }),
          datasetDir: path.join(sasDir, 'dataset'),
          manifestPath: path.join(sasDir, 'dataset', 'manifest.json'),
          targetOrgId: TARGET_ORG,
          status: 'completed',
          at: LOAD_ENDED,
        },
        'frozen',
      );

      await handler.handle(buildMsg('frozen:verify', { targetOrgId: TARGET_ORG }));

      const refusals = posted<BaseMessage & { payload: { code: string; message: string } }>(
        'frozen:verify:error',
      );
      expect(refusals.map((e) => e.payload.code)).toEqual(['LOAD_REMOVED']);
      expect(refusals[0].payload.message).toBe(
        `The removal of ${first?.finishedAt} took part of the records the last load created and left 2 in the org: a verification would read the ones it took as missing. Remove what is left, or reload the dataset, which purges or finds it again; then verify.`,
      );
    });

    it('counts in the mark a removal cancelled between two others, and offers what it did not reach', async () => {
      const first = await partlyRemoved();

      // Cancelled from Live Operations while the contact left goes: the
      // account is not reached.
      org.onDelete(() => {
        const [running] = registry.getRunning();
        if (running) registry.abort(running.operationId);
      });
      await remove({ includeChanged: true });
      const cancelled = answer();
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        leftBy: first?.finishedAt,
        objects: [{ objectApiName: 'Contact', planned: 1, deleted: 1 }],
      });
      expect((await status()).loadRecords?.find((load) => load.orgId === TARGET_ORG)).toMatchObject(
        {
          created: [{ objectApiName: 'Account', count: 1 }],
          removed: {
            removedAt: cancelled?.finishedAt,
            deleted: 2,
            alreadyGone: 0,
            kept: 0,
            refused: 0,
            notReached: 1,
          },
        },
      );

      org.onDelete(() => {});
      vi.mocked(deps.broker.postToWebview).mockClear();
      org.deletes.length = 0;
      await remove();

      expect(org.deletes).toEqual([{ object: 'Account', ids: [ACCOUNT] }]);
      expect(answer()).toMatchObject({ status: 'success', leftBy: cancelled?.finishedAt });
      // Every record the load created, whichever removal took it.
      expect((await recorded())?.removal).toEqual({
        removedAt: answer()?.finishedAt,
        deleted: 3,
        alreadyGone: 0,
        kept: 0,
        refused: 0,
      });
    });

    it('stays offered while a removal of it keeps them again', async () => {
      const first = await partlyRemoved();

      await remove();
      expect(answer()).toMatchObject({ status: 'failure', leftBy: first?.finishedAt });
      expect((await recorded())?.removal).toMatchObject({ removedAt: first?.finishedAt, kept: 2 });

      vi.mocked(deps.broker.postToWebview).mockClear();
      await remove({ includeChanged: true });
      expect(answer()).toMatchObject({ status: 'success' });
      expect(org.rows.get('Account')).toEqual([]);
    });

    it('reads what the first removal left on the records as its own doing, not as changes since the load', async () => {
      // The org refuses a contact, once. Deleting the other restamps their
      // account, a roll-up counting them, as the session's user, and feed
      // tracking records the change on it; the account is kept for the
      // refused contact, and the removal ends partial.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        org.children.get('Account')?.push({
          childSObject: 'FeedItem',
          field: 'ParentId',
          cascadeDelete: true,
        });
        let refusing = true;
        org.refuseDelete((object, row) =>
          refusing && object === 'Contact' && row.Id === CONTACTS[0]
            ? 'A validation rule refused it.'
            : undefined,
        );
        org.onDelete((object) => {
          const account = (org.rows.get('Account') ?? [])[0];
          if (object !== 'Contact' || !account || org.rows.has('FeedItem')) return;
          const now = new Date().toISOString();
          Object.assign(account, { LastModifiedDate: now, LastModifiedById: USER });
          org.rows.set('FeedItem', [
            {
              Id: id('0D5', 1),
              ParentId: ACCOUNT,
              CreatedDate: now,
              LastModifiedDate: now,
              CreatedById: USER,
            },
          ]);
        });

        await remove();
        const first = answer();
        expect(first).toMatchObject({ status: 'partial' });
        const load = await recorded();
        expect(load?.removal).toMatchObject({ deleted: 1, kept: 1, refused: 1 });
        expect(load?.removalStamps).toEqual({
          [ACCOUNT]: org.rows.get('Account')?.[0].LastModifiedDate,
        });

        // A minute later, the org takes the contact, and the records changed
        // since the load are not asked for: the account's stamp and its feed
        // item were the first removal's doing.
        refusing = false;
        org.onDelete(() => {});
        vi.setSystemTime(Date.now() + 60_000);
        vi.mocked(deps.broker.postToWebview).mockClear();
        await remove();

        expect(answer()).toMatchObject({
          status: 'success',
          includeChanged: false,
          leftBy: first?.finishedAt,
          objects: [
            { objectApiName: 'Contact', planned: 1, deleted: 1 },
            { objectApiName: 'Account', planned: 1, deleted: 1, keptChanged: 0, keptDependents: 0 },
          ],
        });
        expect(org.rows.get('Account')).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('removes a contact modified since the load when the request includes it', async () => {
    (org.rows.get('Contact') ?? [])[0].LastModifiedDate = AFTER_LOAD;

    await remove({ includeChanged: true });

    expect(answer()).toMatchObject({ status: 'success', includeChanged: true });
    expect(org.rows.get('Contact')).toEqual([]);
    expect(org.rows.get('Account')).toEqual([]);
  });

  it('runs on the registry and in Live Operations, where Cancel stops it, and is offered again', async () => {
    const events: string[] = [];
    registry.onEvent((_, type) => events.push(type));
    // Cancel from Live Operations while the contacts are being deleted.
    org.onDelete(() => {
      const [running] = registry.getRunning();
      if (running) registry.abort(running.operationId);
    });

    await remove();

    expect(events.filter((e) => e !== 'progress')).toEqual(['started', 'aborted']);
    expect(org.deletes.map((d) => d.object)).toEqual(['Contact']);
    expect(answer()).toMatchObject({
      status: 'cancelled',
      objects: [{ objectApiName: 'Contact', deleted: 2 }],
    });
    expect(tracker.getAll()).toEqual([
      expect.objectContaining({ module: 'frozen', status: 'cancelled', totalRecords: 3 }),
    ]);
    expect(trail()[0]).toMatchObject({ outcome: 'partial' });
    // Marked with what it deleted and what it did not reach: the account is
    // still there, and still the load's to remove.
    const cancelled = answer();
    const load = await recorded();
    expect(load?.removal).toEqual({
      removedAt: cancelled?.finishedAt,
      deleted: 2,
      alreadyGone: 0,
      kept: 0,
      refused: 0,
      notReached: 1,
    });
    expect(load?.created).toEqual([{ objectApiName: 'Account', referenceIds: ['Account-000001'] }]);

    org.onDelete(() => {});
    vi.mocked(deps.broker.postToWebview).mockClear();
    await remove();

    expect(answer()).toMatchObject({
      status: 'success',
      leftBy: cancelled?.finishedAt,
      objects: [{ objectApiName: 'Account', deleted: 1 }],
    });
    // The mark counts what the cancelled removal took too.
    expect((await recorded())?.removal).toEqual({
      removedAt: answer()?.finishedAt,
      deleted: 3,
      alreadyGone: 0,
      kept: 0,
      refused: 0,
    });
  });

  it("dates the load by the target's own dates of its writes, not by this machine's clock", async () => {
    // During the load the org's clock ran minutes ahead of this machine's;
    // since, the two agree. Read on this machine's clock, the load ended at
    // 10:05 and the contacts the org stamped at 10:07 read as changed since.
    const stamped = '2026-09-20T10:07:30.000+0000';
    for (const row of [...(org.rows.get('Account') ?? []), ...(org.rows.get('Contact') ?? [])]) {
      row.CreatedDate = '2026-09-20T10:04:00.000+0000';
      row.LastModifiedDate = stamped;
    }
    const mapping = await new SasReferenceIdMappingStore(sasDir, { orgId: TARGET_ORG }).recorded();
    await new SasReferenceIdMappingStore(sasDir, {
      orgId: TARGET_ORG,
      organizationId: ORGANIZATION,
      now: () => new Date(LOAD_ENDED),
    }).persist(mapping?.mapping ?? new Map(), {
      created: mapping?.created ?? [],
      startedAt: new Date(LOAD_STARTED),
      writtenBetween: { first: '2026-09-20T10:04:00.000Z', last: '2026-09-20T10:07:30.000Z' },
    });

    await remove();

    expect(answer()).toMatchObject({
      status: 'success',
      objects: [
        { objectApiName: 'Contact', deleted: 2, keptChanged: 0 },
        { objectApiName: 'Account', deleted: 1, keptDependents: 0 },
      ],
    });
  });

  describe('a load before the last one', () => {
    const SECOND_ENDED = '2026-09-21T09:05:00.000Z';
    const SECOND_ACCOUNT = id('001', 2);

    /** A second load, without Reload: it created an account, and kept the load before it. */
    async function loadedAgain(): Promise<void> {
      org.rows.get('Account')?.push({
        Id: SECOND_ACCOUNT,
        CreatedDate: '2026-09-21T09:02:00.000+0000',
        LastModifiedDate: '2026-09-21T09:02:00.000+0000',
      });
      await new SasReferenceIdMappingStore(sasDir, {
        orgId: TARGET_ORG,
        organizationId: ORGANIZATION,
        now: () => new Date(SECOND_ENDED),
      }).persist(new Map([['Account-000001', SECOND_ACCOUNT]]), {
        created: [{ objectApiName: 'Account', referenceIds: ['Account-000001'] }],
        startedAt: new Date('2026-09-21T09:00:00.000Z'),
        earlier: { settled: [] },
      });
    }

    const status = async (): Promise<FrozenStatusInfo> => {
      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('frozen:status'));
      return posted<BaseMessage & { payload: { status: FrozenStatusInfo } }>(
        'frozen:status:response',
      )[0].payload.status;
    };

    it('is offered, and removed, once the last load was', async () => {
      await loadedAgain();
      expect((await status()).loadRecords?.find((load) => load.orgId === TARGET_ORG)).toMatchObject(
        {
          loadedAt: SECOND_ENDED,
          created: [{ objectApiName: 'Account', count: 1 }],
        },
      );

      await remove({ loadedAt: SECOND_ENDED });
      expect(org.deletes).toEqual([{ object: 'Account', ids: [SECOND_ACCOUNT] }]);

      expect((await status()).loadRecords?.find((load) => load.orgId === TARGET_ORG)).toEqual({
        orgId: TARGET_ORG,
        loadedAt: LOAD_ENDED,
        created: [
          { objectApiName: 'Contact', count: 2 },
          { objectApiName: 'Account', count: 1 },
        ],
        linked: 1,
        recorded: true,
        earlier: true,
      });
      org.deletes.length = 0;
      await remove();

      expect(org.deletes).toEqual([
        { object: 'Contact', ids: [CONTACTS[1], CONTACTS[0]] },
        { object: 'Account', ids: [ACCOUNT] },
      ]);
      const loads = await new SasReferenceIdMappingStore(sasDir, {
        orgId: TARGET_ORG,
      }).recordedLoads();
      expect(loads.map((load) => load.removal?.deleted)).toEqual([1, 3]);
    });

    it('is not offered while the last load still has its records', async () => {
      await loadedAgain();

      await remove();

      expect(errors().map((e) => e.payload.code)).toEqual(['LOAD_CHANGED']);
      expect(org.deletes).toEqual([]);
    });
  });

  it('lists a finished removal as completed in the registry and in Live Operations', async () => {
    const events: string[] = [];
    registry.onEvent((_, type) => events.push(type));

    await remove();

    expect(events.filter((e) => e !== 'progress')).toEqual(['started', 'completed']);
    expect(tracker.getAll()).toEqual([
      expect.objectContaining({ module: 'frozen', status: 'completed', processedRecords: 3 }),
    ]);
  });

  describe('refusals, before anything is read from the org', () => {
    it('refuses a load another one replaced since it was shown', async () => {
      await remove({ loadedAt: '2026-09-21T08:00:00.000Z' });

      expect(errors().map((e) => e.payload.code)).toEqual(['LOAD_CHANGED']);
      expect(mockGetConn).not.toHaveBeenCalled();
      expect(trail()).toEqual([]);
    });

    it('refuses an org no load went into, whatever the loads into another', async () => {
      await remove({ targetOrgId: 'org-other' });

      expect(errors().map((e) => [e.payload.code, e.payload.message])).toEqual([
        ['NO_LOAD', 'No load into this org was recorded in this sas: there is nothing to remove.'],
      ]);
      expect(mockGetConn).not.toHaveBeenCalled();
      expect(trail()).toEqual([]);
    });

    it('refuses when no load wrote a mapping', async () => {
      fs.rmSync(sasDir, { recursive: true, force: true });
      fs.mkdirSync(sasDir);

      await remove();

      expect(errors().map((e) => e.payload.code)).toEqual(['NO_LOAD']);
      expect(mockGetConn).not.toHaveBeenCalled();
    });

    it('refuses a load recorded before loads kept what they created', async () => {
      await loaded(false);

      await remove();

      expect(errors().map((e) => e.payload.code)).toEqual(['NOT_RECORDED']);
      expect(mockGetConn).not.toHaveBeenCalled();
      expect(trail()).toEqual([]);
    });

    it('refuses a load that created nothing', async () => {
      await new SasReferenceIdMappingStore(sasDir, {
        orgId: TARGET_ORG,
        now: () => new Date(LOAD_ENDED),
      }).persist(new Map([['Pricebook2-000001', STANDARD_BOOK]]), {
        created: [],
        startedAt: new Date(LOAD_STARTED),
      });

      await remove();

      expect(errors().map((e) => e.payload.code)).toEqual(['NOTHING_TO_REMOVE']);
      expect(mockGetConn).not.toHaveBeenCalled();
    });

    it('refuses a request that does not name the load', async () => {
      await handler.handle(buildMsg('frozen:remove', { targetOrgId: TARGET_ORG }));

      expect(errors().map((e) => e.payload.code)).toEqual(['INVALID_PAYLOAD']);
      expect(mockGetConn).not.toHaveBeenCalled();
    });

    it('refuses a second removal while the first one runs', async () => {
      let release: () => void = () => {};
      let paused = false;
      org.onDelete(() => {
        org.onDelete(() => {});
        paused = true;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const first = remove();
      await vi.waitFor(() => expect(paused).toBe(true));

      await remove();
      release();
      await first;

      expect(errors().map((e) => e.payload.code)).toEqual(['DUPLICATE']);
      expect(org.deletes.map((d) => d.object)).toEqual(['Contact', 'Account']);
    });
  });

  describe('Production Guard, and the org the target is', () => {
    it('refuses with NOT_INITIALIZED, and reads nothing, when no guard was injected', async () => {
      deps.infraServices = undefined;

      await remove();

      expect(mockGetConn).not.toHaveBeenCalled();
      expect(errors().map((e) => e.payload.code)).toEqual(['NOT_INITIALIZED']);
      expect(trail()).toEqual([
        expect.objectContaining({
          action: 'cleanup_delete',
          module: 'frozen',
          outcome: 'stopped',
          details: { code: 'NOT_INITIALIZED' },
        }),
      ]);
    });

    it('refuses a production org before reading it, recorded as the guard refused it', async () => {
      vi.mocked(deps.orgManager.getOrg).mockReturnValue({
        orgType: 'Production',
      } as unknown as ReturnType<HandlerDeps['orgManager']['getOrg']>);

      await remove();

      expect(mockGetConn).not.toHaveBeenCalled();
      expect(errors()).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            code: 'GUARD_BLOCKED',
            message: expect.stringContaining('delete is not allowed on production org'),
          }),
        }),
      ]);
      expect(trail()).toEqual([
        expect.objectContaining({ outcome: 'stopped', guard: 'refused', objects: [] }),
      ]);
    });

    it('takes back what a load wrote to a Developer Edition org, which the load took for a development org', async () => {
      // It says IsSandbox false and is registered as a production org: the
      // load may now write to it, and its removal was refused as production.
      vi.mocked(deps.orgManager.getOrg).mockReturnValue({
        orgType: 'Production',
        metadata: { edition: 'Developer Edition' },
      } as unknown as ReturnType<HandlerDeps['orgManager']['getOrg']>);
      const check = vi.spyOn(ProductionGuard.prototype, 'check');

      await remove();

      expect(check).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: TARGET_ORG, orgTier: 'development', operation: 'delete' }),
      );
      expect(errors()).toEqual([]);
      expect(org.deletes.length).toBeGreaterThan(0);
      check.mockRestore();
    });

    it('still refuses a production org of any other edition', async () => {
      vi.mocked(deps.orgManager.getOrg).mockReturnValue({
        orgType: 'Production',
        metadata: { edition: 'Enterprise Edition' },
      } as unknown as ReturnType<HandlerDeps['orgManager']['getOrg']>);

      await remove();

      expect(mockGetConn).not.toHaveBeenCalled();
      expect(errors().map((e) => e.payload.code)).toEqual(['GUARD_BLOCKED']);
    });

    it('deletes nothing when the confirmation is declined', async () => {
      deps.infraServices = {
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: true,
            requiresConfirmation: true,
            warnings: [],
            impactSummary: 'DELETE 3 records',
          }),
          confirmIfNeeded: vi.fn().mockResolvedValue(false),
          canAskForConfirmation: true,
        },
      } as unknown as HandlerDeps['infraServices'];

      await remove();

      expect(mockGetConn).not.toHaveBeenCalled();
      expect(errors().map((e) => e.payload.code)).toEqual(['GUARD_DECLINED']);
      expect(trail()).toEqual([expect.objectContaining({ outcome: 'stopped', guard: 'declined' })]);
    });

    it('asks about a delete of the records the load created, on the org it wrote to', async () => {
      const check = vi.spyOn(ProductionGuard.prototype, 'check');

      await remove();

      expect(check).toHaveBeenCalledWith({
        orgId: TARGET_ORG,
        orgTier: 'development',
        operation: 'delete',
        objectName: 'Contact, Account',
        recordCount: 3,
        module: 'frozen',
      });
      check.mockRestore();
    });

    it('deletes nothing from a sandbox refreshed since the load, and says why', async () => {
      org.organization.id = REFRESHED;

      await remove();

      expect(org.deletes).toEqual([]);
      expect(errors().map((e) => e.payload.code)).toEqual(['TARGET_REFRESHED']);
      expect(trail()).toEqual([
        expect.objectContaining({
          outcome: 'stopped',
          guard: 'allowed',
          details: { code: 'TARGET_REFRESHED' },
        }),
      ]);
    });
  });

  describe('what the page is told', () => {
    const status = async (): Promise<FrozenStatusInfo> => {
      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('frozen:status'));
      return posted<BaseMessage & { payload: { status: FrozenStatusInfo } }>(
        'frozen:status:response',
      )[0].payload.status;
    };

    it('counts what a removal would take and the records it leaves, without reaching the org', async () => {
      expect((await status()).loadRecords?.find((load) => load.orgId === TARGET_ORG)).toEqual({
        orgId: TARGET_ORG,
        loadedAt: LOAD_ENDED,
        created: [
          { objectApiName: 'Contact', count: 2 },
          { objectApiName: 'Account', count: 1 },
        ],
        linked: 1,
        recorded: true,
      });
      expect(mockGetConn).not.toHaveBeenCalled();
    });

    it('carries the mark once the records went', async () => {
      await remove();

      expect((await status()).loadRecords?.find((load) => load.orgId === TARGET_ORG)).toMatchObject(
        {
          created: [],
          removed: { deleted: 3, kept: 0 },
        },
      );
    });

    it('refuses to verify a load whose records went, rather than call each one missing', async () => {
      await remove();
      store.set(
        'frozen:lastRun',
        {
          // The contract the load wrote beside its mapping: a removal leaves it.
          contractPath: writeCountingContract(new SasPathGuard(), sasDir, {
            version: 1,
            orgId: TARGET_ORG,
            datasetVersion: '1.0.0',
            writtenAt: LOAD_ENDED,
            loadStartedAt: LOAD_STARTED,
            objects: {},
          }),
          datasetDir: path.join(sasDir, 'dataset'),
          manifestPath: path.join(sasDir, 'dataset', 'manifest.json'),
          targetOrgId: TARGET_ORG,
          status: 'completed',
          at: LOAD_ENDED,
        },
        'frozen',
      );

      await handler.handle(buildMsg('frozen:verify', { targetOrgId: TARGET_ORG }));

      expect(
        posted<BaseMessage & { payload: { code: string } }>('frozen:verify:error').map(
          (e) => e.payload.code,
        ),
      ).toEqual(['LOAD_REMOVED']);
    });
  });
});
