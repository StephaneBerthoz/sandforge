import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeUndoResult,
} from '@sandforge/shared';

import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { ForgeAbortedError } from '../../modules/forge/ForgeExecutor.js';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import { keepPartialSummary } from '../../modules/forge/interruptedRun.js';
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
const src = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}SRC`;

const RUN_ENDED = '2026-09-20T10:05:00.000Z';
const DURING_RUN = '2026-09-20T10:02:00.000+0000';
const AFTER_RUN = '2026-09-20T11:00:00.000+0000';
const TARGET_ORG = 'tgt-org';
/** The user the session to the target writes as. */
const USER = id('005', 1);

const GRAPH: ForgeGraph = {
  nodes: [],
  edges: [],
  totalRecords: 3,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 1,
};

/** A run that created an account and two contacts under it, and linked one account. */
function runEntry(overrides: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult {
  return {
    forgeId: 'forge-1',
    status: 'success',
    graph: GRAPH,
    duration: 300_000,
    timestamp: RUN_ENDED,
    idRemapCount: 4,
    idRemapTable: {
      [src('001', 1)]: id('001', 1),
      [src('001', 2)]: id('001', 9),
      [src('003', 1)]: id('003', 1),
      [src('003', 2)]: id('003', 2),
    },
    idRemapExisting: [src('001', 2)],
    idRemapCreated: [
      { objectApiName: 'Account', sourceIds: [src('001', 1)] },
      { objectApiName: 'Contact', sourceIds: [src('003', 1), src('003', 2)] },
    ],
    targetOrgId: TARGET_ORG,
    config: {
      inputMode: 'record',
      recordId: src('001', 1).slice(0, 15),
      depth: 'direct',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    },
    ...overrides,
  };
}

type Row = Record<string, unknown> & { Id: string };

/**
 * The target org, as jsforce shows it to the removal: rows per object, the
 * account's cascading children, a delete that takes what cascades along, and
 * a clock of its own, which may run apart from this machine's. An update is
 * stamped by that clock, as written by the session's user.
 */
function targetOrg() {
  const accountChildren = [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }];
  const children = new Map([['Account', accountChildren]]);
  const clock = { aheadMs: 0 };
  const orgNow = (): string => new Date(Date.now() + clock.aheadMs).toISOString();
  const rows = new Map<string, Row[]>([
    ['Account', [{ Id: id('001', 1), LastModifiedDate: DURING_RUN, CreatedDate: DURING_RUN }]],
    [
      'Contact',
      [
        {
          Id: id('003', 1),
          AccountId: id('001', 1),
          LastModifiedDate: DURING_RUN,
          CreatedDate: DURING_RUN,
        },
        {
          Id: id('003', 2),
          AccountId: id('001', 1),
          LastModifiedDate: DURING_RUN,
          CreatedDate: DURING_RUN,
        },
      ],
    ],
  ]);
  const deletes: Array<{ object: string; ids: string[] }> = [];
  let beforeDelete: (object: string) => void | Promise<void> = () => {};
  let refuseDelete: (object: string, row: Row) => string | undefined = () => undefined;
  const conn = {
    limitInfo: undefined,
    query: vi.fn(async (soql: string) => {
      // The statuses of a lifecycle object, each with its category.
      const statuses = /^SELECT ApiName, StatusCode FROM (\w+)$/.exec(soql);
      if (statuses) {
        const records = rows.get(statuses[1]) ?? [];
        return { totalSize: records.length, done: true, records };
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
      sobjects: [
        ...new Set([
          'Account',
          ...rows.keys(),
          ...[...children.values()].flat().map((c) => c.childSObject),
        ]),
      ].map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        layoutable: true,
      })),
    })),
    soap: {
      getServerTimestamp: vi.fn(async () => ({ timestamp: orgNow() })),
      getUserInfo: vi.fn(async () => ({ userId: USER })),
    },
    sobject: (object: string) => ({
      destroy: vi.fn(async (ids: string[]) => {
        await beforeDelete(object);
        deletes.push({ object, ids: [...ids] });
        return ids.map((recordId) => {
          const row = (rows.get(object) ?? []).find((r) => r.Id === recordId);
          const refused = row && refuseDelete(object, row);
          if (refused) {
            return {
              id: recordId,
              success: false,
              errors: [{ statusCode: 'FIELD_INTEGRITY_EXCEPTION', message: refused, fields: [] }],
            };
          }
          rows.set(
            object,
            (rows.get(object) ?? []).filter((r) => r.Id !== recordId),
          );
          return { id: recordId, success: true, errors: [] };
        });
      }),
      update: vi.fn(async (records: Array<Record<string, unknown>>) =>
        records.map((record) => {
          const row = (rows.get(object) ?? []).find((r) => r.Id === record.Id);
          if (row)
            Object.assign(row, record, { LastModifiedDate: orgNow(), LastModifiedById: USER });
          return { id: record.Id, success: row !== undefined, errors: [] };
        }),
      ),
    }),
  };
  return {
    conn,
    rows,
    deletes,
    accountChildren,
    children,
    clock,
    orgNow,
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

describe('forge:undo', () => {
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: ForgeHandler;
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
    posted<BaseMessage & { payload: { code: string; message: string } }>('forge:undo:error');
  const answer = (): ForgeUndoResult | undefined =>
    posted<BaseMessage & { payload: { result: ForgeUndoResult } }>('forge:undo:response')[0]
      ?.payload.result;
  const history = (): ForgeExecutionResult[] =>
    store.get<ForgeExecutionResult[]>('forge:history') ?? [];
  const trail = () => new AuditTrailStore(store).list().entries;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    store.set('forge:history', [runEntry()], 'forge');
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
        backgroundRegistry: registry,
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new ForgeHandler(deps);
    handler.setLiveOperationTracker(tracker);
    org = targetOrg();
    mockGetConn.mockResolvedValue(org.conn as never);
  });

  it('removes what the run created, children first, and keeps the account it linked', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(mockGetConn).toHaveBeenCalledWith(TARGET_ORG, deps.orgRegistry, deps.orgManager);
    expect(org.deletes).toEqual([
      { object: 'Contact', ids: [id('003', 2), id('003', 1)] },
      { object: 'Account', ids: [id('001', 1)] },
    ]);
    expect(org.deletes.flatMap((d) => d.ids)).not.toContain(id('001', 9));
    expect(answer()).toMatchObject({
      forgeId: 'forge-1',
      status: 'success',
      includeChanged: false,
      objects: [
        { objectApiName: 'Contact', planned: 2, deleted: 2 },
        { objectApiName: 'Account', planned: 1, deleted: 1 },
      ],
    });
    expect(errors()).toEqual([]);
  });

  it('records the removal in the audit trail with what it deleted per object', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(trail()).toEqual([
      expect.objectContaining({
        action: 'cleanup_delete',
        module: 'forge',
        orgId: TARGET_ORG,
        outcome: 'success',
        guard: 'allowed',
        objects: [
          { objectApiName: 'Contact', created: 0, updated: 0, deleted: 2, failed: 0 },
          { objectApiName: 'Account', created: 0, updated: 0, deleted: 1, failed: 0 },
        ],
      }),
    ]);
    // Counts only: no record id reaches the trail.
    expect(JSON.stringify(store.get('audit:trail'))).not.toContain(id('003', 1));
  });

  it('marks the entry, so its removal is not offered or run twice', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(history()[0].undo).toEqual({
      removedAt: answer()?.finishedAt,
      deleted: 3,
      alreadyGone: 0,
      kept: 0,
      refused: 0,
    });

    vi.mocked(deps.broker.postToWebview).mockClear();
    org.deletes.length = 0;
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(org.deletes).toEqual([]);
    expect(errors().map((e) => e.payload.code)).toEqual(['ALREADY_REMOVED']);
  });

  it('keeps a contact modified since the run, and the account it hangs from, unless asked', async () => {
    (org.rows.get('Contact') ?? [])[0].LastModifiedDate = AFTER_RUN;

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(answer()).toMatchObject({
      status: 'partial',
      objects: [
        { objectApiName: 'Contact', deleted: 1, keptChanged: 1 },
        { objectApiName: 'Account', deleted: 0, keptDependents: 1, heldBy: ['Contact'] },
      ],
    });
    expect(history()[0].undo).toMatchObject({ deleted: 1, kept: 2 });
  });

  it('removes a contact modified since the run when the request includes it', async () => {
    (org.rows.get('Contact') ?? [])[0].LastModifiedDate = AFTER_RUN;

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', includeChanged: true }));

    expect(answer()).toMatchObject({ status: 'success', includeChanged: true });
    expect(org.rows.get('Contact')).toEqual([]);
  });

  it('leaves the entry unmarked when nothing could be removed', async () => {
    for (const row of [...(org.rows.get('Contact') ?? []), ...(org.rows.get('Account') ?? [])]) {
      row.LastModifiedDate = AFTER_RUN;
    }

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(answer()?.status).toBe('failure');
    expect(history()[0].undo).toBeUndefined();
    expect(trail()[0]).toMatchObject({ outcome: 'failure', objects: [] });
  });

  it('runs on the registry and in Live Operations, where Cancel stops it', async () => {
    const events: string[] = [];
    registry.onEvent((_, type) => events.push(type));
    // Cancel from Live Operations while the contacts are being deleted.
    org.onDelete(() => {
      const [running] = registry.getRunning();
      if (running) registry.abort(running.operationId);
    });

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    // Stopped once, and nothing reported after the stop.
    expect(events.filter((e) => e !== 'progress')).toEqual(['started', 'aborted']);
    expect(events.at(-1)).toBe('aborted');
    expect(org.deletes.map((d) => d.object)).toEqual(['Contact']);
    expect(answer()).toMatchObject({
      status: 'cancelled',
      objects: [{ objectApiName: 'Contact', deleted: 2 }],
    });
    expect(tracker.getAll()).toEqual([
      expect.objectContaining({ module: 'forge', status: 'cancelled', totalRecords: 3 }),
    ]);
    // Stopped part way: recorded with what it deleted, and offered again.
    expect(trail()[0]).toMatchObject({ outcome: 'partial' });
    expect(history()[0].undo).toBeUndefined();
  });

  it('keeps on the entry what a cancelled removal left on the account and when it ran, and the next removal takes the account', async () => {
    // Deleting the contacts restamps their account, a roll-up counting them,
    // as modified by the session's user, and feed tracking records the change
    // on the account; Live Operations cancels meanwhile. The next removal
    // comes a minute later.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      org.accountChildren.push({
        childSObject: 'FeedItem',
        field: 'ParentId',
        cascadeDelete: true,
      });
      org.onDelete((object) => {
        const account = (org.rows.get('Account') ?? [])[0];
        if (object !== 'Contact' || !account) return;
        const now = org.orgNow();
        Object.assign(account, { LastModifiedDate: now, LastModifiedById: USER });
        org.rows.set('FeedItem', [
          {
            Id: id('0D5', 1),
            ParentId: account.Id,
            CreatedDate: now,
            LastModifiedDate: now,
            CreatedById: USER,
          },
        ]);
        const [running] = registry.getRunning();
        if (running) registry.abort(running.operationId);
      });

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(answer()).toMatchObject({
        status: 'cancelled',
        objects: [{ objectApiName: 'Contact', deleted: 2 }],
      });
      expect(history()[0].undo).toBeUndefined();
      expect(history()[0].removalStamps).toEqual({
        [id('001', 1)]: org.rows.get('Account')?.[0].LastModifiedDate,
      });
      expect(history()[0].removalSpans).toEqual([
        { first: expect.any(String), last: expect.any(String), userId: USER.slice(0, 15) },
      ]);

      org.onDelete(() => {});
      vi.setSystemTime(Date.now() + 60_000);
      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(answer()).toMatchObject({
        status: 'success',
        objects: [
          { objectApiName: 'Contact', alreadyGone: 2 },
          { objectApiName: 'Account', deleted: 1, keptChanged: 0, keptDependents: 0 },
        ],
      });
      expect(org.rows.get('Account')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists a finished removal as completed in the registry and in Live Operations', async () => {
    const events: string[] = [];
    registry.onEvent((_, type) => events.push(type));

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(events.filter((e) => e !== 'progress')).toEqual(['started', 'completed']);
    expect(tracker.getAll()).toEqual([
      expect.objectContaining({ module: 'forge', status: 'completed', processedRecords: 3 }),
    ]);
  });

  describe('refusals, before anything is read', () => {
    it.each([
      ['a run no longer in the history', { forgeId: 'forge-gone' }, undefined, 'NOT_FOUND'],
      [
        'a run recorded before runs kept what they created',
        { forgeId: 'forge-1' },
        runEntry({ idRemapCreated: undefined }),
        'NOT_RECORDED',
      ],
      [
        'a run recorded before its target org was kept',
        { forgeId: 'forge-1' },
        runEntry({ targetOrgId: undefined }),
        'NOT_RECORDED',
      ],
      [
        'a run that created nothing',
        { forgeId: 'forge-1' },
        runEntry({ idRemapCreated: [] }),
        'NOTHING_TO_REMOVE',
      ],
      [
        'a run whose records were removed already',
        { forgeId: 'forge-1' },
        runEntry({
          undo: {
            removedAt: '2026-09-21T08:00:00.000Z',
            deleted: 3,
            alreadyGone: 0,
            kept: 0,
            refused: 0,
          },
        }),
        'ALREADY_REMOVED',
      ],
      ['a request that names no run', { includeChanged: true }, undefined, 'INVALID_PAYLOAD'],
    ])('refuses %s', async (_, payload, entry, code) => {
      if (entry) store.set('forge:history', [entry], 'forge');

      await handler.handle(buildMsg('forge:undo', payload));

      expect(errors().map((e) => e.payload.code)).toEqual([code]);
      expect(errors()[0].correlationId).toBe('req-forge:undo');
      expect(mockGetConn).not.toHaveBeenCalled();
      expect(trail()).toEqual([]);
    });

    it('refuses a second removal of a run while the first one runs', async () => {
      let release: () => void = () => {};
      let paused = false;
      org.onDelete(() => {
        org.onDelete(() => {});
        paused = true;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const first = handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));
      await vi.waitFor(() => expect(paused).toBe(true));

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));
      release();
      await first;

      expect(errors().map((e) => e.payload.code)).toEqual(['DUPLICATE']);
    });

    it('refuses a second removal while the first waits on the production confirmation', async () => {
      /** Every question put to the person, answered only once the test says so. */
      const asked: Array<(confirmed: boolean) => void> = [];
      const confirmIfNeeded = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            asked.push(resolve);
          }),
      );
      deps.infraServices = {
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: true,
            requiresConfirmation: true,
            requiresApproval: false,
            warnings: [],
            impactSummary: 'DELETE 3 records',
          }),
          confirmIfNeeded,
          canAskForConfirmation: true,
        },
        backgroundRegistry: registry,
      } as unknown as HandlerDeps['infraServices'];
      const first = handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));
      await vi.waitFor(() => expect(confirmIfNeeded).toHaveBeenCalledTimes(1));

      const second = handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));
      await vi.waitFor(() => expect(errors().length + asked.length).toBeGreaterThan(1));
      asked.forEach((confirm) => confirm(true));
      await Promise.all([first, second]);

      // One question, one removal.
      expect(confirmIfNeeded).toHaveBeenCalledTimes(1);
      expect(errors().map((e) => e.payload.code)).toEqual(['DUPLICATE']);
      expect(org.deletes.map((d) => d.object)).toEqual(['Contact', 'Account']);
    });
  });

  describe('Production Guard', () => {
    it('refuses with NOT_INITIALIZED, and reads nothing, when no guard was injected', async () => {
      deps.infraServices = undefined;

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(mockGetConn).not.toHaveBeenCalled();
      expect(errors().map((e) => e.payload.code)).toEqual(['NOT_INITIALIZED']);
      expect(trail()).toEqual([
        expect.objectContaining({
          action: 'cleanup_delete',
          module: 'forge',
          outcome: 'stopped',
          details: { code: 'NOT_INITIALIZED' },
        }),
      ]);
    });

    it('refuses a production org, recorded as the guard refused it', async () => {
      vi.mocked(deps.orgManager.getOrg).mockReturnValue({
        orgType: 'Production',
      } as unknown as ReturnType<HandlerDeps['orgManager']['getOrg']>);

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

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

    it('deletes nothing when the confirmation is declined', async () => {
      deps.infraServices = {
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: true,
            requiresConfirmation: true,
            requiresApproval: false,
            warnings: [],
            impactSummary: 'DELETE 3 records',
          }),
          confirmIfNeeded: vi.fn().mockResolvedValue(false),
          canAskForConfirmation: true,
        },
      } as unknown as HandlerDeps['infraServices'];

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(mockGetConn).not.toHaveBeenCalled();
      expect(errors().map((e) => e.payload.code)).toEqual(['GUARD_DECLINED']);
      expect(trail()).toEqual([expect.objectContaining({ outcome: 'stopped', guard: 'declined' })]);
    });

    it('asks about a delete of the records the run created, on the org it wrote to', async () => {
      const check = vi.spyOn(ProductionGuard.prototype, 'check');

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(check).toHaveBeenCalledWith({
        orgId: TARGET_ORG,
        orgTier: 'development',
        operation: 'delete',
        objectName: 'Contact, Account',
        recordCount: 3,
        module: 'forge',
      });
      check.mockRestore();
    });
  });

  describe("the run's dates, by the org's clock", () => {
    /** The account and contacts, created by the org at 10:05:02 and last updated at 10:05:04. */
    function datedByTheOrg(): void {
      for (const row of [...(org.rows.get('Account') ?? []), ...(org.rows.get('Contact') ?? [])]) {
        row.CreatedDate = '2026-09-20T10:05:02.000+0000';
        row.LastModifiedDate = '2026-09-20T10:05:04.000+0000';
      }
    }

    it('removes a run by the span the org dated it by, whatever this machine said', async () => {
      // This machine's clock ran five seconds behind the org's: the run ended
      // at 10:05:00 by it, and the org stamped its last write at 10:05:04.
      datedByTheOrg();
      store.set(
        'forge:history',
        [
          runEntry({
            timestamp: '2026-09-20T10:05:00.000Z',
            duration: 3_000,
            writtenBetween: {
              first: '2026-09-20T10:05:02.000Z',
              last: '2026-09-20T10:05:04.000Z',
            },
          }),
        ],
        'forge',
      );

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(answer()).toMatchObject({
        status: 'success',
        objects: [
          { objectApiName: 'Contact', deleted: 2, keptChanged: 0 },
          { objectApiName: 'Account', deleted: 1, keptDependents: 0 },
        ],
      });
    });

    it("keeps what changed after the run's last write, however long the run read before it wrote", async () => {
      // A minute of reading the source, then two seconds of writing; someone
      // edited a contact half a minute after the last write.
      datedByTheOrg();
      (org.rows.get('Contact') ?? [])[0].LastModifiedDate = '2026-09-20T10:05:30.000+0000';
      store.set(
        'forge:history',
        [
          runEntry({
            timestamp: '2026-09-20T10:05:04.000Z',
            duration: 62_000,
            writtenBetween: {
              first: '2026-09-20T10:05:02.000Z',
              last: '2026-09-20T10:05:04.000Z',
            },
          }),
        ],
        'forge',
      );

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(answer()).toMatchObject({
        status: 'partial',
        objects: [
          { objectApiName: 'Contact', deleted: 1, keptChanged: 1 },
          { objectApiName: 'Account', deleted: 0, keptDependents: 1, heldBy: ['Contact'] },
        ],
      });
    });

    it('dates a run recorded before runs kept their dates by its records and by when it was recorded, give or take a few seconds', async () => {
      // Recorded at 10:05:00 by a machine a few seconds behind the org, whose
      // clock has caught up with the org's since.
      datedByTheOrg();
      store.set(
        'forge:history',
        [runEntry({ timestamp: '2026-09-20T10:05:00.000Z', duration: 3_000 })],
        'forge',
      );

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(answer()).toMatchObject({ status: 'success' });
      expect(org.rows.get('Account')).toEqual([]);
    });

    it('keeps what changed after the end of a run the target did not date, however long the run read before it wrote', async () => {
      // Recorded before runs kept their dates: a minute of reading the source,
      // then two seconds of writing, recorded as it ended on a machine whose
      // clock agrees with the org's. Someone edited a contact half a minute
      // after the last write.
      datedByTheOrg();
      (org.rows.get('Contact') ?? [])[0].LastModifiedDate = '2026-09-20T10:05:30.000+0000';
      store.set(
        'forge:history',
        [runEntry({ timestamp: '2026-09-20T10:05:04.000Z', duration: 62_000 })],
        'forge',
      );

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(answer()).toMatchObject({
        status: 'partial',
        objects: [
          { objectApiName: 'Contact', deleted: 1, keptChanged: 1 },
          { objectApiName: 'Account', deleted: 0, keptDependents: 1, heldBy: ['Contact'] },
        ],
      });
    });

    it("dates its own start by the org's clock: what the org records of the removal does not hold the account", async () => {
      // The org runs a minute behind this machine, and answers the contacts'
      // delete with a feed item on their account.
      org.clock.aheadMs = -60_000;
      org.accountChildren.push({
        childSObject: 'FeedItem',
        field: 'ParentId',
        cascadeDelete: true,
      });
      org.onDelete((object) => {
        if (object !== 'Contact' || (org.rows.get('FeedItem') ?? []).length > 0) return;
        const now = org.orgNow();
        org.rows.set('FeedItem', [
          {
            Id: id('0D5', 1),
            ParentId: id('001', 1),
            CreatedDate: now,
            LastModifiedDate: now,
            CreatedById: USER,
          },
        ]);
      });

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(answer()).toMatchObject({
        status: 'success',
        objects: [
          { objectApiName: 'Contact', deleted: 2 },
          { objectApiName: 'Account', deleted: 1, keptDependents: 0 },
        ],
      });
    });
  });

  describe('an activated order a removal sets to Draft and leaves', () => {
    const ORDER = id('801', 1);
    const ITEM = id('802', 1);

    /** A run that created an activated order and its item; the org refuses the item once. */
    function orderRun(): { itemRefused: { value: boolean } } {
      store.set(
        'forge:history',
        [
          runEntry({
            idRemapTable: { [src('801', 1)]: ORDER, [src('802', 1)]: ITEM },
            idRemapExisting: [],
            idRemapCreated: [
              { objectApiName: 'Order', sourceIds: [src('801', 1)] },
              { objectApiName: 'OrderItem', sourceIds: [src('802', 1)] },
            ],
            writtenBetween: { first: '2026-09-20T10:00:00.000Z', last: RUN_ENDED },
          }),
        ],
        'forge',
      );
      org.rows.set('OrderStatus', [
        { Id: 'status-open', ApiName: 'Open', StatusCode: 'Draft' },
        { Id: 'status-live', ApiName: 'Live', StatusCode: 'Activated' },
      ]);
      org.rows.set('Order', [
        { Id: ORDER, Status: 'Live', CreatedDate: DURING_RUN, LastModifiedDate: DURING_RUN },
      ]);
      org.rows.set('OrderItem', [
        { Id: ITEM, OrderId: ORDER, CreatedDate: DURING_RUN, LastModifiedDate: DURING_RUN },
      ]);
      org.children.set('Order', [
        { childSObject: 'OrderItem', field: 'OrderId', cascadeDelete: true },
      ]);
      const itemRefused = { value: true };
      org.refuseDelete((object, row) => {
        if (object === 'OrderItem' && itemRefused.value) return 'A validation rule refused it.';
        const orderOf =
          object === 'Order'
            ? row
            : (org.rows.get('Order') ?? []).find((o) => o.Id === row.OrderId);
        return orderOf?.Status === 'Live' ? 'unable to modify activated order' : undefined;
      });
      return { itemRefused };
    }

    it('gives the order its status back and keeps on the entry what that wrote, for the next removal', async () => {
      const { itemRefused } = orderRun();

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(answer()).toMatchObject({
        status: 'failure',
        objects: [
          { objectApiName: 'OrderItem', refused: 1 },
          { objectApiName: 'Order', keptDependents: 1 },
        ],
      });
      expect(org.rows.get('Order')?.[0]).toMatchObject({ Status: 'Live' });
      // Offered again, with the order's last stamp as the removal's own.
      expect(history()[0].undo).toBeUndefined();
      expect(history()[0].removalStamps).toEqual({ [ORDER]: expect.any(String) });

      itemRefused.value = false;
      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(answer()).toMatchObject({
        status: 'success',
        objects: [
          { objectApiName: 'OrderItem', deleted: 1 },
          { objectApiName: 'Order', deleted: 1, keptChanged: 0 },
        ],
      });
      expect(org.rows.get('Order')).toEqual([]);
    });
  });

  describe('a run that stopped part way', () => {
    /**
     * `error`, carrying what the executor held when the run stopped: the
     * account and the two contacts it created, and the account it linked.
     */
    function stoppedRun(error: Error): Error {
      const entry = runEntry();
      keepPartialSummary(error, {
        successCount: 3,
        updatedCount: 0,
        linkedCount: 1,
        wouldInsertCount: 0,
        failedCount: 0,
        skippedCount: 0,
        remapCount: 4,
        errors: [],
        truncatedObjects: [],
        remapTable: entry.idRemapTable ?? {},
        existingRecords: [{ objectApiName: 'Account', linked: 1, unidentified: 0 }],
        existingSourceIds: entry.idRemapExisting ?? [],
        updatedSourceIds: [],
        remapByObject: [
          { objectApiName: 'Account', created: 1, linked: 1 },
          { objectApiName: 'Contact', created: 2, linked: 0 },
        ],
        createdByObject: entry.idRemapCreated ?? [],
      });
      return error;
    }

    /** Run a clone that throws `error`, and read back the entry the history kept of it. */
    async function runThatThrows(error: Error): Promise<ForgeExecutionResult | undefined> {
      handler.setForgeOrchestrator({
        execute: vi.fn().mockRejectedValue(error),
        on: vi.fn().mockReturnValue(vi.fn()),
        abort: vi.fn(),
      } as unknown as ForgeOrchestrator);
      store.set('forge:history', [], 'forge');
      await handler.handle(
        buildMsg('forge:execute', {
          graph: { ...GRAPH, nodes: [] },
          config: {
            ...runEntry().config,
            sourceOrgId: 'src-org',
            targetOrgId: TARGET_ORG,
          },
        }),
      );
      return history()[0];
    }

    it('removes what a run that failed part way created, from the entry the history kept', async () => {
      const entry = await runThatThrows(
        stoppedRun(new Error('INVALID_SESSION_ID: Session expired or invalid')),
      );
      expect(entry).toMatchObject({ status: 'failure', targetOrgId: TARGET_ORG });

      await handler.handle(buildMsg('forge:undo', { forgeId: entry?.forgeId }));

      expect(org.deletes).toEqual([
        { object: 'Contact', ids: [id('003', 2), id('003', 1)] },
        { object: 'Account', ids: [id('001', 1)] },
      ]);
      expect(errors()).toEqual([]);
    });

    it('removes what a cancelled run created, from an entry that says it was cancelled', async () => {
      const entry = await runThatThrows(
        stoppedRun(new ForgeAbortedError('Forge execution was aborted by user request.')),
      );
      expect(entry).toMatchObject({ status: 'partial', cancelled: true });

      await handler.handle(buildMsg('forge:undo', { forgeId: entry?.forgeId }));

      expect(org.deletes.flatMap((d) => d.ids)).toEqual([id('003', 2), id('003', 1), id('001', 1)]);
      expect(org.deletes.flatMap((d) => d.ids)).not.toContain(id('001', 9));
    });
  });

  it('answers on the error channel when the org cannot be reached, and records the failure', async () => {
    mockGetConn.mockRejectedValue(new Error(`Org not found: ${TARGET_ORG}`));

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(errors().map((e) => e.payload.code)).toEqual(['UNDO_ERROR']);
    expect(trail()[0]).toMatchObject({ outcome: 'failure', guard: 'allowed' });
    expect(history()[0].undo).toBeUndefined();
    expect(tracker.getAll()[0]).toMatchObject({ status: 'failed' });
  });
});
