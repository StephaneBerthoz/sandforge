import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BaseMessage,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeSweepListing,
  ForgeTargetAutomation,
  ForgeUndoResult,
} from '@sandforge/shared';
import { forgeRemovalPlanOf } from '@sandforge/shared';

import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { writePathOrderDefects } from '../../modules/checkpoint/beforeRunCheckpoint.js';
import { muteOrgOf } from '../../modules/forge/AutomationMuteLease.js';
import { ForgeRemovalPlanStore } from '../../modules/forge/ForgeRemovalPlanStore.js';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { tiedTargetOrg, type TiedRow, type TiedTargetOrg } from '../../test/tiedTargetOrg.js';

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

const FIRST_WRITE = '2026-09-20T10:00:00.000Z';
const LAST_WRITE = '2026-09-20T10:05:00.000Z';
/** `seconds` after the run's first write, as the org writes a date. */
const at = (seconds: number): string =>
  new Date(Date.parse(FIRST_WRITE) + seconds * 1000).toISOString().replace('Z', '+0000');
const LONG_AFTER = '2026-09-20T12:00:00.000+0000';
const TARGET_ORG = 'tgt-org';
/** The user the run wrote as, and the session to the target writes as. */
const USER = id('005', 1);
const COLLEAGUE = id('005', 2);

const ACCOUNT = id('001', 1);
const LINKED_ACCOUNT = id('001', 9);
const CONTACT = id('003', 1);
const CASE = id('500', 1);
const ASSET = id('02i', 1);
const WELCOME = id('00T', 1);
const COLLEAGUES = id('00T', 2);
const TYPED_LATER = id('00T', 3);
const FOLLOW_UP = id('00T', 4);
const REVIEW = id('00T', 5);
const LOOSE = id('00T', 6);

const GRAPH: ForgeGraph = {
  nodes: [],
  edges: [],
  totalRecords: 3,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 1,
};

/** A run that created an account, a contact and a case under it, and linked one account. */
function runEntry(overrides: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult {
  return {
    forgeId: 'forge-1',
    status: 'success',
    graph: GRAPH,
    duration: 300_000,
    timestamp: LAST_WRITE,
    idRemapCount: 4,
    idRemapTable: {
      [src('001', 1)]: ACCOUNT,
      [src('001', 9)]: LINKED_ACCOUNT,
      [src('003', 1)]: CONTACT,
      [src('500', 1)]: CASE,
    },
    idRemapExisting: [src('001', 9)],
    idRemapCreated: [
      { objectApiName: 'Account', sourceIds: [src('001', 1)] },
      { objectApiName: 'Contact', sourceIds: [src('003', 1)] },
      { objectApiName: 'Case', sourceIds: [src('500', 1)] },
    ],
    writtenBetween: { first: FIRST_WRITE, last: LAST_WRITE },
    targetOrgId: TARGET_ORG,
    ...overrides,
  };
}

/** A record created by `by` at `created`, untouched since, with its lookups. */
const rec = (
  recordId: string,
  name: string,
  by: string,
  created: string,
  lookups: Record<string, string> = {},
): TiedRow => ({
  Id: recordId,
  Name: name,
  CreatedById: by,
  CreatedDate: created,
  LastModifiedDate: created,
  LastModifiedById: by,
  SystemModstamp: created,
  ...lookups,
});

/**
 * The target after the run: its account, its contact and its case, and what
 * the target's automation made as the run wrote — a welcome call under the
 * contact, which goes with it; a review task naming the account alone
 * (`Task.AccountId`, which the org clears as the account goes); the insured
 * risk the case's flow cloned into an asset and named on the case
 * (`Case.AssetId`, which refuses the asset's delete while the case stands).
 * Then what is not the run's to take unasked: a colleague's task on the
 * account the run only linked to, one the run's user typed hours later, and a
 * loose task tied to nothing of the run.
 */
function targetOrg(): TiedTargetOrg {
  const org = tiedTargetOrg(USER);
  org.shape('Account', {
    children: [
      { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'Case', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
      { childSObject: 'Task', field: 'AccountId' },
    ],
  });
  org.shape('Contact', {
    references: { AccountId: ['Account'] },
    children: [
      { childSObject: 'Task', field: 'WhoId', cascadeDelete: true },
      { childSObject: 'Case', field: 'ContactId' },
    ],
  });
  org.shape('Case', {
    references: { AccountId: ['Account'], ContactId: ['Contact'], AssetId: ['Asset'] },
    children: [{ childSObject: 'Task', field: 'WhatId', cascadeDelete: true }],
  });
  org.shape('Asset', {
    children: [{ childSObject: 'Case', field: 'AssetId', restrictedDelete: true }],
  });
  org.shape('Task', {
    references: { WhoId: ['Contact'], WhatId: ['Account', 'Case'], AccountId: ['Account'] },
  });
  org.add('Account', rec(ACCOUNT, 'Cloned account', USER, at(0)));
  org.add(
    'Account',
    rec(LINKED_ACCOUNT, 'Matched account', COLLEAGUE, '2026-09-01T09:00:00.000+0000'),
  );
  org.add('Contact', rec(CONTACT, 'Cloned contact', USER, at(290), { AccountId: ACCOUNT }));
  org.add(
    'Case',
    rec(CASE, 'Cloned case', USER, at(295), {
      AccountId: ACCOUNT,
      ContactId: CONTACT,
      AssetId: ASSET,
    }),
  );
  org.add('Asset', rec(ASSET, 'Insured risk', USER, at(296)));
  org.add(
    'Task',
    rec(WELCOME, 'Welcome call', USER, at(291), { WhoId: CONTACT }),
    rec(COLLEAGUES, 'A colleague’s call', COLLEAGUE, at(120), { WhatId: LINKED_ACCOUNT }),
    rec(TYPED_LATER, 'Typed later', USER, LONG_AFTER),
    rec(REVIEW, 'Account review', USER, at(1), { AccountId: ACCOUNT }),
    rec(LOOSE, 'Loose task', USER, at(180)),
  );
  return org;
}

/** What the target runs on the run's objects: a case flow that creates an asset and a task. */
const AUTOMATION = {
  objectsRead: ['Account', 'Contact', 'Case'],
  objects: [
    {
      objectApiName: 'Case',
      flows: [
        {
          apiName: 'Clone_Risk',
          label: 'Clone risk',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [],
          creates: ['Asset', 'Task'],
        },
      ],
      triggers: [],
    },
  ],
  unread: [],
} as unknown as ForgeTargetAutomation;

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `req-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

/** A removal plan store over a disk in memory, as the extension's storage holds it. */
function memoryPlans(): ForgeRemovalPlanStore {
  const disk = new Map<string, string>();
  return new ForgeRemovalPlanStore({
    storagePath: '/extension-storage',
    readFile: async (path) => {
      const content = disk.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path, content) => {
      disk.set(path, content);
    },
    rename: async (from, to) => {
      disk.set(to, disk.get(from) ?? '');
      disk.delete(from);
    },
    mkdir: async () => undefined,
  });
}

describe('a sweep asked with a removal', () => {
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: ForgeHandler;
  let org: TiedTargetOrg;
  let reader: { read: ReturnType<typeof vi.fn> };
  let orgType: string;
  let plans: ForgeRemovalPlanStore;

  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const answer = (): ForgeUndoResult | undefined =>
    posted<BaseMessage & { payload: { result: ForgeUndoResult } }>('forge:undo:response').at(-1)
      ?.payload.result;
  const errors = () =>
    posted<BaseMessage & { payload: { code: string; message: string } }>('forge:undo:error');
  const listed = (): ForgeSweepListing | undefined =>
    posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
      'forge:undo-sweep:response',
    ).at(-1)?.payload.listing;
  const history = (): ForgeExecutionResult[] =>
    store.get<ForgeExecutionResult[]>('forge:history') ?? [];
  const trail = () => new AuditTrailStore(store).list().entries;
  const deleted = (): string[] => org.deletes.flatMap((call) => call.ids);

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    store.set('forge:history', [runEntry()], 'forge');
    orgType = 'Sandbox';
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType, alias: 'DEV' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard({ requestRunConfirmation: async () => true }),
        backgroundRegistry: new BackgroundOperationRegistry(),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new ForgeHandler(deps);
    reader = { read: vi.fn(async () => AUTOMATION) };
    plans = memoryPlans();
    handler.setForgeOrchestrator({ on: vi.fn() } as unknown as ForgeOrchestrator, {
      targetAutomation: reader as never,
      removalPlans: plans,
    });
    org = targetOrg();
    mockGetConn.mockResolvedValue(org.conn as never);
  });

  it('takes what the automation made around the run’s records: before them, with them, and what waited for them', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(errors()).toEqual([]);
    // Before the run's records: the review task, which goes neither with
    // them nor waits for one of them. Then the run's own; then the asset,
    // which the org refuses while the case names it.
    expect(org.deletes[0]).toEqual({ object: 'Task', ids: [REVIEW] });
    const objects = org.deletes.map((call) => call.object);
    expect(objects.indexOf('Asset')).toBeGreaterThan(objects.indexOf('Case'));
    expect(org.ids('Asset')).toEqual([]);
    expect(org.ids('Case')).toEqual([]);
    expect(org.ids('Contact')).toEqual([]);
    // The welcome call went with its contact; what is not the run's to take
    // unasked stays: the colleague's, the one typed later, the loose task.
    expect(org.ids('Task').sort()).toEqual([COLLEAGUES, TYPED_LATER, LOOSE].sort());
    expect(org.ids('Account')).toEqual([LINKED_ACCOUNT]);
    expect(deleted()).not.toContain(LINKED_ACCOUNT);
    // The automation was read for the objects the run wrote.
    expect([...(reader.read.mock.calls[0]?.[1] ?? [])].sort()).toEqual([
      'Account',
      'Case',
      'Contact',
    ]);

    const result = answer();
    expect(result?.status).toBe('success');
    expect(result?.sweep).toMatchObject({
      status: 'success',
      window: { from: '2026-09-20T09:59:59Z', to: '2026-09-20T10:06:00Z' },
      handWork: [],
    });
    expect(result?.sweep?.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectApiName: 'Task', found: 2, deleted: 1, alreadyGone: 1 }),
        expect.objectContaining({ objectApiName: 'Asset', found: 1, deleted: 1, afterRemoval: 1 }),
      ]),
    );
    expect(history()[0].sweep).toEqual({
      sweptAt: expect.any(String),
      deleted: 2,
      keptChanged: 0,
      refused: 0,
    });
    const removals = trail().filter((entry) => entry.action === 'cleanup_delete');
    const sweep = removals.find((entry) => entry.operationId?.endsWith('-sweep'));
    const removal = removals.find((entry) => entry.operationId?.endsWith('-sweep') === false);
    expect(removal).toBeDefined();
    expect(sweep).toMatchObject({
      outcome: 'success',
      guard: 'allowed',
      details: { sweep: true, forgeId: 'forge-1', found: 3, deleted: 2 },
    });
    // Counts only: no record id, no name reaches the trail.
    expect(JSON.stringify(store.get('audit:trail'))).not.toContain(REVIEW);
    expect(JSON.stringify(store.get('audit:trail'))).not.toContain('Welcome call');
    // The objects were counted five to a composite, one request each.
    expect(org.composites.length).toBeGreaterThan(0);
    expect(org.composites.every((subrequests) => subrequests <= 5)).toBe(true);
  });

  it('keeps one order: its reads, then its question, then its writes, the run’s records between its two parts', async () => {
    // Each question Production Guard puts is a step of the path: the
    // removal's, before anything is read, then the sweep's.
    const guard = deps.infraServices?.productionGuard as ProductionGuard;
    const check = guard.check.bind(guard);
    vi.spyOn(guard, 'check').mockImplementation((request) => {
      org.events.push('question' as never);
      return check(request);
    });

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));
    const events: Parameters<typeof writePathOrderDefects>[0] = [
      ...(org.events as Parameters<typeof writePathOrderDefects>[0]),
      'result',
    ];

    expect(answer()?.status).toBe('success');
    expect(writePathOrderDefects(events)).toEqual([]);
    // Two questions: the removal's, then the sweep's, once its reads were through.
    expect(events.filter((step) => step === 'question')).toHaveLength(2);
    expect(events.indexOf('write')).toBeGreaterThan(events.lastIndexOf('question'));
    // The sweep counted and read before its question; once asked, it read
    // nothing more of its own before its first delete.
    const counts = org.queries.filter((soql) => soql.startsWith('SELECT COUNT()'));
    expect(counts.length).toBeGreaterThan(0);
    // It assigns nothing, takes no checkpoint, and holds no lease unasked.
    expect(events).not.toContain('leaseAcquire');
    expect(events).not.toContain('checkpointTake');
    expect(org.deletes.some((call) => call.object === 'PermissionSetAssignment')).toBe(false);
  });

  it('keeps no record of the run back for a task the automation opened under it after the run’s last write', async () => {
    // Opened by an asynchronous path twenty seconds after the run's last
    // write, half a minute after the contact: out of the run's span, so a
    // removal reads it as a record that stays, and made for the run, so the
    // sweep takes it — in cascade with the contact, which it holds back no more.
    org.add('Task', rec(FOLLOW_UP, 'Follow-up call', USER, at(320), { WhoId: CONTACT }));

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(errors()).toEqual([]);
    expect(org.ids('Contact')).toEqual([]);
    expect(org.ids('Account')).toEqual([LINKED_ACCOUNT]);
    expect(org.ids('Task')).not.toContain(FOLLOW_UP);
    const result = answer();
    expect(result?.status).toBe('success');
    expect(result?.objects.find((o) => o.objectApiName === 'Contact')).toMatchObject({
      deleted: 1,
      keptDependents: 0,
    });
  });

  it('removes the run’s account though deleting the task the automation hung under it restamped it, a roll-up counting tasks', async () => {
    // The review task under the run's account: deleted, the org recalculates
    // the account's roll-up and dates the account then, as modified by the
    // session's user. Read after the sweep, the account was a change since
    // the run, and the removal kept it.
    org.hooks.onDestroy = (object, row) => {
      if (object !== 'Task' || row.AccountId !== ACCOUNT) return;
      const account = org.row('Account', ACCOUNT);
      if (account) {
        Object.assign(account, {
          LastModifiedDate: new Date().toISOString(),
          LastModifiedById: USER,
        });
      }
    };

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(errors()).toEqual([]);
    expect(org.deletes[0]).toEqual({ object: 'Task', ids: [REVIEW] });
    expect(org.ids('Account')).toEqual([LINKED_ACCOUNT]);
    const result = answer();
    expect(result?.status).toBe('success');
    expect(result?.objects.find((o) => o.objectApiName === 'Account')).toMatchObject({
      deleted: 1,
      keptChanged: 0,
    });
  });

  it('keeps what is tied to nothing of the run unasked, takes it when asked, and not while another run of this machine wrote in its window', async () => {
    await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));
    expect(listed()?.untied).toEqual({ objects: [{ objectApiName: 'Task', count: 1 }] });

    await handler.handle(
      buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, sweepUntied: true }),
    );
    expect(errors()).toEqual([]);
    expect(deleted()).toContain(LOOSE);

    // Another run of this machine into the same target, a minute in: what is
    // tied to nothing may be its doing, and is left, its own records too.
    org = targetOrg();
    mockGetConn.mockResolvedValue(org.conn as never);
    const other = runEntry({
      forgeId: 'forge-2',
      idRemapTable: { [src('00T', 7)]: id('00T', 7) },
      idRemapExisting: [],
      idRemapCreated: [{ objectApiName: 'Task', sourceIds: [src('00T', 7)] }],
      writtenBetween: { first: '2026-09-20T10:01:00.000Z', last: '2026-09-20T10:01:30.000Z' },
    });
    org.add('Task', rec(id('00T', 7), 'The other run’s', USER, at(70)));
    store.set('forge:history', [runEntry(), other], 'forge');

    await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));
    expect(listed()?.untied?.refusal).toMatch(/^Another run of this machine wrote to the target/);
    expect(listed()?.found.find((found) => found.objectApiName === 'Task')?.classes).toMatchObject({
      untied: 1,
    });

    await handler.handle(
      buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, sweepUntied: true }),
    );
    expect(deleted()).not.toContain(LOOSE);
    expect(deleted()).not.toContain(id('00T', 7));
  });

  it('keeps what is tied to nothing while a run of another module wrote in its window', async () => {
    const told: Array<[string, unknown]> = [];
    const during = Date.parse(FIRST_WRITE) + 60_000;
    handler.setOtherModuleRuns(async (orgId, written) => {
      told.push([orgId, written]);
      return [{ ids: [id('00T', 7)], from: during, to: during }];
    });
    org.add('Task', rec(id('00T', 7), 'The other run’s', USER, at(70)));

    await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));
    expect(told).toEqual([[TARGET_ORG, { first: FIRST_WRITE, last: LAST_WRITE }]]);
    expect(listed()?.untied?.refusal).toMatch(/^Another run of this machine wrote to the target/);

    await handler.handle(
      buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, sweepUntied: true }),
    );
    expect(deleted()).not.toContain(LOOSE);
    expect(deleted()).not.toContain(id('00T', 7));
  });

  describe('beside a run of this machine past the bound, whose ids are in its journal', () => {
    const THEIRS = id('00T', 7);
    const pastTheBound = (overrides: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult =>
      runEntry({
        forgeId: 'forge-2',
        idRemapTable: undefined,
        idRemapExisting: undefined,
        idRemapCreated: undefined,
        remapInJournal: true,
        journalId: 'journal-2',
        journalPart: 1,
        writtenBetween: { first: '2026-09-20T10:01:00.000Z', last: '2026-09-20T10:01:30.000Z' },
        ...overrides,
      });
    const withJournal = (idsOf: () => Promise<unknown>): void => {
      handler.setForgeOrchestrator({ on: vi.fn() } as unknown as ForgeOrchestrator, {
        targetAutomation: reader as never,
        removalPlans: plans,
        runJournal: {
          idsOf,
          leftOf: async () => undefined,
          stampsOf: async () => ({}),
        } as never,
      });
    };

    beforeEach(() => {
      store.set('forge:history', [runEntry(), pastTheBound()], 'forge');
      org.add('Task', rec(THEIRS, 'The other run’s', USER, at(70)));
    });

    it('reads its records from its journal: they are never swept, and what is tied to nothing is left', async () => {
      const idsOf = vi.fn(async () => ({
        table: { [src('00T', 7)]: THEIRS },
        existing: [],
        createdByObject: [{ objectApiName: 'Task', sourceIds: [src('00T', 7)] }],
      }));
      withJournal(idsOf);

      await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));

      expect(idsOf).toHaveBeenCalledWith('journal-2', 1);
      expect(listed()?.untied?.refusal).toMatch(/^Another run of this machine/);
      expect(
        listed()?.found.find((found) => found.objectApiName === 'Task')?.classes,
      ).toMatchObject({ untied: 1 });
    });

    it('counts by when it wrote once its journal is gone, its records unnamed', async () => {
      withJournal(async () => undefined);

      await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));
      expect(listed()?.untied?.refusal).toMatch(/^Another run of this machine/);

      await handler.handle(
        buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, sweepUntied: true }),
      );
      expect(deleted()).not.toContain(LOOSE);
      expect(deleted()).not.toContain(THEIRS);
    });

    it('reads no journal of a run that wrote outside the window', async () => {
      const idsOf = vi.fn(async () => undefined);
      withJournal(idsOf);
      store.set(
        'forge:history',
        [
          runEntry(),
          pastTheBound({
            writtenBetween: {
              first: '2026-09-21T10:00:00.000Z',
              last: '2026-09-21T10:30:00.000Z',
            },
          }),
        ],
        'forge',
      );

      await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));

      expect(idsOf).not.toHaveBeenCalled();
      expect(listed()?.untied?.refusal).toBeUndefined();
    });

    it('counts a run the history dropped too, by its plan', async () => {
      withJournal(async () => undefined);
      store.set('forge:history', [runEntry()], 'forge');
      await plans.put({
        forgeId: 'forge-3',
        targetOrgId: TARGET_ORG,
        timestamp: LAST_WRITE,
        duration: 1_000,
        status: 'success',
        writtenBetween: { first: '2026-09-20T10:01:00.000Z', last: '2026-09-20T10:01:30.000Z' },
        objects: [],
        linked: 0,
        inJournal: { journalId: 'journal-3', part: 1, left: [] },
      });

      await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));

      expect(listed()?.untied?.refusal).toMatch(/^Another run of this machine/);
    });
  });

  it('takes the user the run kept, reading none of its records to tell it', async () => {
    store.set('forge:history', [runEntry({ runUserId: USER })], 'forge');

    await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));

    expect(listed()?.refusal).toBeUndefined();
    expect(org.queries.some((soql) => soql.startsWith('SELECT CreatedById FROM'))).toBe(false);

    store.set('forge:history', [runEntry()], 'forge');
    await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));
    expect(org.queries.some((soql) => soql.startsWith('SELECT CreatedById FROM'))).toBe(true);
  });

  it('removes none of the run’s records once a cancel stopped the sweep before them', async () => {
    // Cancel from Live Operations while the sweep reads: it stops before its
    // next call to the org, and the removal does not start.
    reader.read.mockImplementation(async () => {
      const registry = deps.infraServices?.backgroundRegistry;
      for (const op of registry?.getRunning() ?? []) registry?.abort(op.operationId);
      return AUTOMATION;
    });

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(org.deletes).toEqual([]);
    expect(org.ids('Contact')).toEqual([CONTACT]);
    const result = answer();
    expect(result?.status).toBe('cancelled');
    expect(result?.sweep?.status).toBe('cancelled');
    expect(history()[0]).not.toHaveProperty('undo');
  });

  it('sweeps nothing unasked', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(deleted()).not.toContain(REVIEW);
    expect(org.ids('Asset')).toEqual([ASSET]);
    expect(org.ids('Task')).toContain(REVIEW);
    expect(answer()).not.toHaveProperty('sweep');
    expect(history()[0]).not.toHaveProperty('sweep');
    expect(trail().filter((entry) => entry.action === 'cleanup_delete')).toHaveLength(1);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('runs alone when asked of a run whose records were all removed already, and takes none of what the removal left tied to nothing', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));
    const removed = history()[0].undo;
    org.deletes.length = 0;

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(errors()).toEqual([]);
    // Once the account went, the org cleared the review task's lookup, and
    // nothing of the run names the asset: tied to nothing, both are left.
    expect(org.deletes).toEqual([]);
    const result = answer();
    expect(result?.objects).toEqual([]);
    expect(result?.sweep?.status).toBe('success');
    expect(result?.sweep?.handWork).toEqual([{ objectApiName: 'Asset', count: 1 }]);
    // The removal's mark is the first removal's still.
    expect(history()[0].undo).toEqual(removed);
  });

  it('keeps what it found made, and takes it once the record that told the tie is gone', async () => {
    // A colleague edits the case after the run: the removal keeps it, and the
    // asset it names waits for it, refused.
    const changedCase = org.row('Case', CASE);
    if (changedCase) {
      Object.assign(changedCase, { LastModifiedDate: LONG_AFTER, LastModifiedById: COLLEAGUE });
    }
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));
    expect(org.ids('Asset')).toEqual([ASSET]);
    expect(answer()?.sweep?.objects.find((o) => o.objectApiName === 'Asset')).toMatchObject({
      deleted: 0,
      refused: 1,
    });
    // Kept: the asset it left. The tasks it deleted, said gone, are kept no more.
    expect(await plans.madeOf('forge-1')).toEqual([ASSET]);

    // Then the case goes by hand: nothing of the run names the asset now.
    const caseRow = org.row('Case', CASE);
    org.rows.set('Case', []);
    if (caseRow) org.bin.set('Case', [caseRow]);
    org.deletes.length = 0;

    await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));
    expect(listed()?.found.find((found) => found.objectApiName === 'Asset')?.classes).toMatchObject(
      { made: 1, untied: 0 },
    );
    expect(listed()?.handWork).toEqual([]);

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));
    expect(deleted()).toContain(ASSET);
    expect(org.ids('Asset')).toEqual([]);
  });

  it('keeps what it found made late and left, and takes it with what came late once the record that told the tie is gone', async () => {
    // Five minutes after the case: what a scheduled path of its flow makes.
    const late = org.row('Asset', ASSET);
    if (late) Object.assign(late, { CreatedDate: at(595), LastModifiedDate: at(595) });
    // A colleague edits the case after the run: the removal keeps it.
    const changedCase = org.row('Case', CASE);
    if (changedCase) {
      Object.assign(changedCase, { LastModifiedDate: LONG_AFTER, LastModifiedById: COLLEAGUE });
    }
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));
    expect(org.ids('Asset')).toEqual([ASSET]);
    expect(answer()?.sweep?.left).toEqual(
      expect.arrayContaining([expect.objectContaining({ class: 'late', option: '--sweep-late' })]),
    );
    expect(await plans.lateOf('forge-1')).toEqual([ASSET]);

    // Then the case goes by hand: nothing of the run names the asset now.
    const caseRow = org.row('Case', CASE);
    org.rows.set('Case', []);
    if (caseRow) org.bin.set('Case', [caseRow]);
    org.deletes.length = 0;

    await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));
    expect(listed()?.found.find((found) => found.objectApiName === 'Asset')?.classes).toMatchObject(
      { late: 1, untied: 0 },
    );

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));
    expect(org.ids('Asset')).toEqual([ASSET]);
    await handler.handle(
      buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, sweepLate: true }),
    );
    expect(deleted()).toContain(ASSET);
    expect(org.ids('Asset')).toEqual([]);
  });

  it('lets Production Guard refuse the sweep’s deletes, and records why', async () => {
    // A run marked removed whose records the org still holds: the sweep runs
    // alone, and finds what the automation made under them.
    store.set(
      'forge:history',
      [
        runEntry({
          undo: {
            removedAt: '2026-09-20T11:00:00.000Z',
            deleted: 3,
            alreadyGone: 0,
            kept: 0,
            refused: 0,
          },
          removalLeft: [],
        }),
      ],
      'forge',
    );
    // The org now reads as a production one: the guard refuses a delete there.
    orgType = 'Production';

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(org.deletes).toEqual([]);
    expect(answer()?.sweep).toMatchObject({
      status: 'refused',
      refusal: expect.stringMatching(/^Operation blocked by Production Guard/),
    });
    // Asked and refused: no success, though nothing of the run was left to take.
    expect(answer()?.status).toBe('partial');
    expect(history()[0]).not.toHaveProperty('sweep');
    expect(trail()[0]).toMatchObject({
      action: 'cleanup_delete',
      outcome: 'stopped',
      guard: 'refused',
      details: { sweep: true },
    });
  });

  it('is refused for a run the history dropped, and removes nothing', async () => {
    await plans.put(forgeRemovalPlanOf(runEntry())!);
    store.set('forge:history', [], 'forge');

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(errors().map((e) => e.payload.code)).toEqual(['SWEEP_UNAVAILABLE']);
    expect(org.deletes).toEqual([]);
  });

  it('lists, for the confirmation, what a sweep would take in its classes, and deletes nothing', async () => {
    await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));

    const [response] = posted<
      BaseMessage & { payload: { forgeId: string; listing: ForgeSweepListing } }
    >('forge:undo-sweep:response');
    expect(response?.payload.forgeId).toBe('forge-1');
    const listing = response?.payload.listing;
    expect(listing?.refusal).toBeUndefined();
    expect(listing?.found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectApiName: 'Task',
          count: 3,
          classes: expect.objectContaining({ made: 2, untied: 1 }),
        }),
        expect.objectContaining({
          objectApiName: 'Asset',
          count: 1,
          names: ['Insured risk'],
          classes: expect.objectContaining({ made: 1 }),
        }),
      ]),
    );
    expect(listing?.handWork).toEqual([]);
    expect(org.deletes).toEqual([]);
  });

  it('lists none of the lines the platform copied under the quote the run synced: its removal names them', async () => {
    const opportunity = id('006', 1);
    const quote = id('0Q0', 1);
    const lineItem = id('00k', 1);
    const runLine = id('0QL', 1);
    const copy = id('0QL', 2);
    org.shape('Opportunity', {
      references: { AccountId: ['Account'], SyncedQuoteId: ['Quote'] },
      children: [
        { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
        { childSObject: 'Quote', field: 'OpportunityId', cascadeDelete: true },
      ],
    });
    org.shape('Quote', {
      references: { OpportunityId: ['Opportunity'] },
      children: [{ childSObject: 'QuoteLineItem', field: 'QuoteId', cascadeDelete: true }],
    });
    org.shape('OpportunityLineItem', { references: { OpportunityId: ['Opportunity'] } });
    org.shape('QuoteLineItem', {
      references: { QuoteId: ['Quote'], OpportunityLineItemId: ['OpportunityLineItem'] },
    });
    org.add(
      'Opportunity',
      rec(opportunity, 'Cloned deal', USER, at(10), { AccountId: ACCOUNT, SyncedQuoteId: quote }),
    );
    org.add('Quote', rec(quote, 'Cloned quote', USER, at(11), { OpportunityId: opportunity }));
    org.add(
      'OpportunityLineItem',
      rec(lineItem, 'Line', USER, at(12), { OpportunityId: opportunity }),
    );
    // The platform's copy of the run's line item, a second before the run's own quote line.
    org.add(
      'QuoteLineItem',
      rec(copy, 'Copied line', USER, at(12), { QuoteId: quote, OpportunityLineItemId: lineItem }),
      rec(runLine, 'Run line', USER, at(13), { QuoteId: quote, OpportunityLineItemId: lineItem }),
    );
    store.set(
      'forge:history',
      [
        runEntry({
          idRemapTable: {
            [src('001', 1)]: ACCOUNT,
            [src('006', 1)]: opportunity,
            [src('0Q0', 1)]: quote,
            [src('00k', 1)]: lineItem,
            [src('0QL', 1)]: runLine,
          },
          idRemapExisting: [],
          idRemapCreated: [
            { objectApiName: 'Account', sourceIds: [src('001', 1)] },
            { objectApiName: 'Opportunity', sourceIds: [src('006', 1)] },
            { objectApiName: 'Quote', sourceIds: [src('0Q0', 1)] },
            { objectApiName: 'OpportunityLineItem', sourceIds: [src('00k', 1)] },
            { objectApiName: 'QuoteLineItem', sourceIds: [src('0QL', 1)] },
          ],
        }),
      ],
      'forge',
    );

    await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));

    const listing = listed();
    expect(listing?.refusal).toBeUndefined();
    expect(listing?.looked).toContain('QuoteLineItem');
    expect(listing?.found.map((found) => found.objectApiName)).not.toContain('QuoteLineItem');
    // What the automation made under the run's account is listed as ever.
    expect(listing?.found.map((found) => found.objectApiName)).toContain('Task');
  });

  describe('asked to mute the target’s automation', () => {
    const SET = '0PS000000000001AAA';
    let leases: string;
    let permissions: ReturnType<typeof memoryPermissionOrg>;

    /** What a deleted case fires, which `Data_Load` keeps quiet. */
    const ON_DELETE = {
      objectsRead: ['Account', 'Contact', 'Case'],
      objects: [
        {
          objectApiName: 'Case',
          flows: [
            {
              apiName: 'Case_Gone',
              label: 'Case gone',
              timing: 'afterSave',
              startsOn: 'delete',
              condition: 'read',
              permissions: [{ name: 'Load_Data', bypass: true }],
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
    } as unknown as ForgeTargetAutomation;

    beforeEach(() => {
      leases = mkdtempSync(join(tmpdir(), 'sandforge-sweep-leases-'));
      permissions = memoryPermissionOrg({
        userId: USER,
        sets: [{ id: SET, name: 'Data_Load' }],
        beforeWrite: (write) => {
          org.events.push((write.kind === 'insert' ? 'leaseAcquire' : 'leaseRelease') as never);
        },
      });
      reader.read.mockImplementation(async () => ON_DELETE);
      handler.setForgeOrchestrator({ on: vi.fn() } as unknown as ForgeOrchestrator, {
        targetAutomation: reader as never,
        removalPlans: plans,
        muteOrg: async () => muteOrgOf(permissions.connection),
        muteLeases: { dir: leases, renewEveryMs: 0 },
      });
    });

    afterEach(() => {
      rmSync(leases, { recursive: true, force: true });
    });

    const steps = (): string[] => org.events.filter((step) => step !== 'reads');

    it('holds one lease from before the sweep’s first delete to after its last, and takes none alongside', async () => {
      await handler.handle(
        buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, muteAutomation: true }),
      );

      expect(errors()).toEqual([]);
      expect(answer()?.status).toBe('success');
      expect(answer()?.mutedAutomation).toMatchObject({ state: 'muted', assigned: ['Data_Load'] });
      const events = steps();
      expect(events.filter((step) => step === 'leaseAcquire')).toHaveLength(1);
      expect(events.filter((step) => step === 'leaseRelease')).toHaveLength(1);
      expect(events[0]).toBe('leaseAcquire');
      expect(events.at(-1)).toBe('leaseRelease');
      // The asset went under the lease, the last of the sweep's parts.
      expect(org.ids('Asset')).toEqual([]);
      expect(permissions.assignments()).toEqual([]);
    });

    it('plans it on the duplicate record sets of the run’s records too when the run kept its user, as the removal takes them', async () => {
      store.set('forge:history', [runEntry({ runUserId: USER })], 'forge');

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', muteAutomation: true }));

      expect(errors()).toEqual([]);
      expect([...(reader.read.mock.calls.at(-1)?.[1] ?? [])].sort()).toEqual([
        'Account',
        'Case',
        'Contact',
        'DuplicateRecordSet',
      ]);
    });

    describe('of a user who may not delete the cases', () => {
      /** What the org was told by the time the question was put. */
      let seenAsked: string[][];
      let removeTheRest: boolean;

      beforeEach(() => {
        const conn = org.conn as unknown as {
          describe: (object: string) => Promise<Record<string, unknown>>;
        };
        // The case's describe, as a profile without Delete on it gives it.
        mockGetConn.mockResolvedValue({
          ...org.conn,
          describe: async (object: string) => ({
            ...(await conn.describe(object)),
            deletable: object !== 'Case',
          }),
        } as never);
        seenAsked = [];
        removeTheRest = false;
        (
          deps.infraServices as { confirmRemovalLeavingUndeletable?: () => Promise<boolean> }
        ).confirmRemovalLeavingUndeletable = vi.fn(async () => {
          seenAsked.push(steps());
          return removeTheRest;
        });
      });

      it('asks before it assigns anything, and assigns nothing once told to stop', async () => {
        // Taken before the question, the lease held the sets assigned while
        // it stayed open, for nothing once it was answered no.
        await handler.handle(
          buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, muteAutomation: true }),
        );

        expect(seenAsked).toHaveLength(1);
        expect(seenAsked[0]).not.toContain('leaseAcquire');
        expect(steps()).not.toContain('leaseAcquire');
        expect(permissions.assignments()).toEqual([]);
      });

      it('takes the lease once told to remove the rest, before its first delete', async () => {
        removeTheRest = true;

        await handler.handle(
          buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, muteAutomation: true }),
        );

        expect(seenAsked[0]).not.toContain('leaseAcquire');
        expect(steps()).toContain('leaseAcquire');
        expect(steps().indexOf('leaseAcquire')).toBeLessThan(steps().indexOf('write'));
        expect(permissions.assignments()).toEqual([]);
      });
    });

    describe('of what a Flow fires on the quote lines the platform copied, none of the quote’s lines in the run’s plan', () => {
      const opportunity = id('006', 1);
      const quote = id('0Q0', 1);
      const lineItem = id('00k', 1);
      const copy = id('0QL', 2);

      beforeEach(() => {
        org.shape('Opportunity', {
          references: { AccountId: ['Account'], SyncedQuoteId: ['Quote'] },
          children: [
            { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
            { childSObject: 'Quote', field: 'OpportunityId', cascadeDelete: true },
          ],
        });
        org.shape('Quote', {
          references: { OpportunityId: ['Opportunity'] },
          children: [{ childSObject: 'QuoteLineItem', field: 'QuoteId', cascadeDelete: true }],
        });
        org.shape('OpportunityLineItem', { references: { OpportunityId: ['Opportunity'] } });
        org.shape('QuoteLineItem', {
          references: { QuoteId: ['Quote'], OpportunityLineItemId: ['OpportunityLineItem'] },
        });
        org.add(
          'Opportunity',
          rec(opportunity, 'Cloned deal', USER, at(10), {
            AccountId: ACCOUNT,
            SyncedQuoteId: quote,
          }),
        );
        org.add('Quote', rec(quote, 'Cloned quote', USER, at(11), { OpportunityId: opportunity }));
        org.add(
          'OpportunityLineItem',
          rec(lineItem, 'Line', USER, at(12), { OpportunityId: opportunity }),
        );
        // The platform's copy of the run's line item: the run wrote no quote line.
        org.add(
          'QuoteLineItem',
          rec(copy, 'Copied line', USER, at(12), {
            QuoteId: quote,
            OpportunityLineItemId: lineItem,
          }),
        );
        store.set(
          'forge:history',
          [
            runEntry({
              idRemapTable: {
                [src('006', 1)]: opportunity,
                [src('0Q0', 1)]: quote,
                [src('00k', 1)]: lineItem,
              },
              idRemapExisting: [],
              idRemapCreated: [
                { objectApiName: 'Opportunity', sourceIds: [src('006', 1)] },
                { objectApiName: 'Quote', sourceIds: [src('0Q0', 1)] },
                { objectApiName: 'OpportunityLineItem', sourceIds: [src('00k', 1)] },
              ],
            }),
          ],
          'forge',
        );
        // A Flow on quote lines alone, as the real reader says only what it is asked.
        reader.read.mockImplementation(
          async (_org: string, objects: readonly string[]) =>
            ({
              ...ON_DELETE,
              objectsRead: [...objects],
              objects: objects.includes('QuoteLineItem')
                ? [{ ...ON_DELETE.objects[0], objectApiName: 'QuoteLineItem' }]
                : [],
            }) as ForgeTargetAutomation,
        );
        // The Flow refuses a quote line's delete, unless the user holds the bypass.
        mockGetConn.mockResolvedValue({
          ...org.conn,
          sobject: (object: string) => {
            const records = org.conn.sobject(object);
            if (object !== 'QuoteLineItem') return records;
            return {
              ...records,
              destroy: async (ids: string[]) =>
                permissions.assignments().length > 0
                  ? records.destroy(ids)
                  : ids.map((recordId) => ({
                      id: recordId,
                      success: false,
                      errors: [
                        {
                          statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
                          message: 'A quote line cannot be deleted without the bypass.',
                        },
                      ],
                    })),
            };
          },
        } as never);
      });

      it('plans the mute on them with the run’s own, and the lease lets their delete through', async () => {
        await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', muteAutomation: true }));

        expect(errors()).toEqual([]);
        expect(answer()?.status).toBe('success');
        expect(org.ids('QuoteLineItem')).toEqual([]);
        expect(answer()?.objects.find((o) => o.objectApiName === 'QuoteLineItem')).toMatchObject({
          deleted: 1,
          platformCopies: 1,
        });
        expect(answer()?.mutedAutomation).toMatchObject({
          state: 'muted',
          assigned: ['Data_Load'],
          silenced: [expect.objectContaining({ objectApiName: 'QuoteLineItem' })],
        });
        expect(permissions.assignments()).toEqual([]);
      });
    });

    describe('of what a Flow fires on the asset the sweep deletes', () => {
      /** What the org runs: a Flow on the asset alone, as the real reader says only what it is asked. */
      const onAsset = async (_org: string, objects: readonly string[]) =>
        ({
          ...ON_DELETE,
          objectsRead: [...objects],
          objects: objects.includes('Asset')
            ? [{ ...ON_DELETE.objects[0], objectApiName: 'Asset' }]
            : [],
        }) as ForgeTargetAutomation;

      beforeEach(() => {
        reader.read.mockImplementation(onAsset);
        // The Flow refuses the asset's delete, unless the user holds the bypass.
        mockGetConn.mockResolvedValue({
          ...org.conn,
          sobject: (object: string) => {
            const records = org.conn.sobject(object);
            if (object !== 'Asset') return records;
            return {
              ...records,
              destroy: async (ids: string[]) =>
                permissions.assignments().length > 0
                  ? records.destroy(ids)
                  : ids.map((recordId) => ({
                      id: recordId,
                      success: false,
                      errors: [
                        {
                          statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
                          message: 'An asset cannot be deleted without the bypass.',
                        },
                      ],
                    })),
            };
          },
        } as never);
      });

      it('plans the mute on it once the sweep has read, and the lease lets the delete through', async () => {
        await handler.handle(
          buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, muteAutomation: true }),
        );

        expect(errors()).toEqual([]);
        expect(org.ids('Asset')).toEqual([]);
        expect(answer()?.sweep?.status).toBe('success');
        expect(answer()?.mutedAutomation).toMatchObject({
          state: 'muted',
          assigned: ['Data_Load'],
          silenced: [expect.objectContaining({ objectApiName: 'Asset' })],
        });
        const planned = reader.read.mock.calls.at(-1)?.[1];
        expect(planned).toEqual(expect.arrayContaining(['Account', 'Contact', 'Case', 'Asset']));
        expect(permissions.assignments()).toEqual([]);
      });

      it('mutes a sweep that goes alone, nothing of the run left, and names the mute in its entry', async () => {
        // The run's records go; the org refuses the asset, found made for the run.
        await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));
        expect(org.ids('Case')).toEqual([]);
        expect(org.ids('Asset')).toEqual([ASSET]);
        org.events.length = 0;
        vi.mocked(deps.broker.postToWebview).mockClear();

        await handler.handle(
          buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, muteAutomation: true }),
        );

        expect(errors()).toEqual([]);
        expect(org.ids('Asset')).toEqual([]);
        expect(answer()?.objects).toEqual([]);
        expect(answer()?.mutedAutomation).toMatchObject({ state: 'muted' });
        expect(reader.read.mock.calls.at(-1)?.[1]).toEqual(['Asset']);
        const events = steps();
        expect(events.indexOf('leaseAcquire')).toBeLessThan(events.indexOf('write'));
        expect(events.at(-1)).toBe('leaseRelease');
        expect(permissions.assignments()).toEqual([]);
        expect(trail().find((entry) => entry.operationId?.endsWith('-sweep'))?.muted).toBeDefined();
      });

      it('assigns nothing when the sweep takes nothing and nothing of the run is left', async () => {
        await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));
        org.events.length = 0;
        vi.mocked(deps.broker.postToWebview).mockClear();
        reader.read.mockClear();

        await handler.handle(
          buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, muteAutomation: true }),
        );

        expect(errors()).toEqual([]);
        expect(steps()).not.toContain('leaseAcquire');
        expect(answer()).not.toHaveProperty('mutedAutomation');
      });
    });

    it('asks the sweep’s question before the lease, and holds none while it waits', async () => {
      const guard = deps.infraServices?.productionGuard as ProductionGuard;
      const check = guard.check.bind(guard);
      vi.spyOn(guard, 'check').mockImplementation((request) => {
        org.events.push('question' as never);
        return check(request);
      });
      let held: number | undefined;
      const confirmed = guard.confirmIfNeeded.bind(guard);
      vi.spyOn(guard, 'confirmIfNeeded').mockImplementation((asked, tier) => {
        held = permissions.assignments().length;
        return confirmed(asked, tier);
      });

      await handler.handle(
        buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, muteAutomation: true }),
      );

      expect(errors()).toEqual([]);
      expect(answer()?.mutedAutomation).toMatchObject({ state: 'muted', assigned: ['Data_Load'] });
      expect(held).toBe(0);
      const events = [...org.events, 'result'] as Parameters<typeof writePathOrderDefects>[0];
      expect(events.filter((step) => step === 'question')).toHaveLength(2);
      expect(events.indexOf('leaseAcquire')).toBeGreaterThan(events.lastIndexOf('question'));
      expect(writePathOrderDefects(events)).toEqual([]);
    });

    it('assigns nothing once a stop came while the sweep asked', async () => {
      const guard = deps.infraServices?.productionGuard as ProductionGuard;
      const registry = deps.infraServices?.backgroundRegistry;
      const confirmed = guard.confirmIfNeeded.bind(guard);
      vi.spyOn(guard, 'confirmIfNeeded').mockImplementation((asked, tier) => {
        for (const op of registry?.getRunning() ?? []) registry?.abort(op.operationId);
        return confirmed(asked, tier);
      });

      await handler.handle(
        buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, muteAutomation: true }),
      );

      expect(answer()?.status).toBe('cancelled');
      expect(steps()).not.toContain('leaseAcquire');
      expect(org.ids('Case')).toEqual([CASE]);
    });

    it('gives the lease back on a stop during the sweep, none of the run’s records gone', async () => {
      org.hooks.onDestroy = () => {
        const registry = deps.infraServices?.backgroundRegistry;
        for (const op of registry?.getRunning() ?? []) registry?.abort(op.operationId);
      };

      await handler.handle(
        buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, muteAutomation: true }),
      );

      expect(answer()?.status).toBe('cancelled');
      expect(org.ids('Case')).toEqual([CASE]);
      expect(steps().at(-1)).toBe('leaseRelease');
      expect(permissions.assignments()).toEqual([]);
    });

    it('gives the lease back when the removal fails, and records what the sweep deleted', async () => {
      // The removal throws once its first record has gone: past the sweep's
      // first part, before what waits for the run's records.
      vi.mocked(deps.broker.postToWebview).mockImplementation((message) => {
        if ((message as BaseMessage).type === 'operation:progress') {
          throw new Error('the window went away');
        }
      });

      await handler.handle(
        buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true, muteAutomation: true }),
      );

      expect(errors().map((e) => e.payload.code)).toEqual(['UNDO_ERROR']);
      expect(permissions.assignments()).toEqual([]);
      expect(steps().at(-1)).toBe('leaseRelease');
      expect(org.ids('Asset')).toEqual([ASSET]);
      const sweep = trail().find((entry) => entry.operationId?.endsWith('-sweep'));
      expect(sweep?.details).toMatchObject({ sweep: true, deleted: 1 });
    });
  });

  it('refuses to list a sweep for a run the history does not hold', async () => {
    await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'gone' }));

    expect(posted('forge:undo-sweep:response')).toEqual([]);
    expect(
      posted<BaseMessage & { payload: { code: string } }>('forge:undo-sweep:error')[0]?.payload
        .code,
    ).toBe('NOT_FOUND');
    expect(mockGetConn).not.toHaveBeenCalled();
  });
});
