import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  factCombinations,
  MEMORY_ORG_USER,
  type MemoryChild,
  type MemoryOrgFacts,
  type MemoryRow,
} from '../../test/memoryRemovalOrg.js';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg.js';
import { removeRunRecords } from '../forge/ForgeRunRemoval.js';
import {
  restoreOverwrites,
  type BackupReader,
  type SyncRestoreOutcome,
} from '../sync/SyncRunRestore.js';
import { undeleteRunDeletions, type SyncUndeleteOutcome } from '../sync/SyncRunUndelete.js';
import {
  openCheckpointStore,
  type CheckpointFolder,
  type OrgCheckpointStore,
  type OrgLock,
} from './OrgCheckpointStore.js';
import {
  openRewindJournal,
  readRewindJournal,
  rewoundObjects,
  undoPlans,
} from './rewindJournal.js';
import { relationshipsOf, undoEstimate, type EstimatedObject } from './rewindEstimate.js';
import { undoRewind, type UndoRewindOutcome } from './undoRewind.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * Undo, on the memory org the bricks run on, of a rewind made of the bricks
 * a rewind goes through: its journal opened before it writes, its deletions
 * named, then the removal of what was created since, which in its sweep
 * brings back what was deleted since — the children that come back with it
 * named first — and gives back what was changed since, each update's values
 * kept first. The org's clock is this machine's, moved by the test.
 *
 * The org before the rewind, as a colleague left it since the checkpoint:
 * - A1 renamed; A2 renamed, then deleted with its contact C2;
 * - N1 created with its contact N1c, and NC created;
 * - R made to report to NC instead of BOSS.
 * The rewind gives A1 and R their checkpoint values back, brings A2 back
 * with C2 and gives A2 its own, and deletes N1c, NC and N1.
 */

const ORG_ID = '00D000000000001AAA';
const COLLEAGUE = '005000000000003AAA';
const AUTOMATED_PROCESS = '005000000000002AAA';
const SNAPSHOT = 'op-1792700000000';

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const A1 = id('001', 1);
const A2 = id('001', 2);
const N1 = id('001', 3);
const C2 = id('003', 2);
const N1C = id('003', 3);
const NC = id('003', 4);
const BOSS = id('003', 5);
const R = id('003', 6);

const LONG_AGO = Date.parse('2026-10-01T09:00:00.000Z');
/** T0 and T1, the checkpoint's start and end, on the org's clock. */
const T0 = Date.parse('2026-10-22T14:05:12.731Z');
const T1 = T0 + 70_000;
/** When the colleague worked, after the checkpoint. */
const SINCE = Date.parse('2026-10-22T14:20:00.000Z');
/** When the rewind's first pass began. */
const TR = Date.parse('2026-10-22T15:00:00.250Z');

const CHILDREN: Record<string, MemoryChild[]> = {
  Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
  // A lookup the org clears when the record it names is deleted.
  Contact: [{ childSObject: 'Contact', field: 'ReportsToId' }],
};

/** The checkpoint's objects, children first, and the fields its snapshot holds. */
const OBJECTS: EstimatedObject[] = [
  {
    objectApiName: 'Contact',
    records: 5,
    fields: ['Id', 'SystemModstamp', 'LastName', 'AccountId', 'ReportsToId'],
  },
  { objectApiName: 'Account', records: 2, fields: ['Id', 'SystemModstamp', 'Name'] },
];
const READ_ORDER = [
  { objectApiName: 'Contact', readOrder: 0 },
  { objectApiName: 'Account', readOrder: 1 },
];

/** The checkpoint's snapshot: the values at T0 of what the rewind gives back. */
const AT_T0: Record<string, Array<Record<string, unknown>>> = {
  Account: [
    { Id: A1, Name: 'A1 at the checkpoint' },
    { Id: A2, Name: 'A2 at the checkpoint' },
  ],
  Contact: [{ Id: R, LastName: 'R', AccountId: null, ReportsToId: BOSS }],
};
const snapshot: BackupReader = {
  batches: async (operationId, objectApiName, size) => {
    const rows = operationId === SNAPSHOT ? AT_T0[objectApiName] : undefined;
    if (!rows) return null;
    return {
      async *[Symbol.asyncIterator]() {
        for (let at = 0; at < rows.length; at += size) yield rows.slice(at, at + size);
      },
    };
  },
};

/** What the org holds, live and in the bin, of what a test compares: no stamp. */
interface OrgState {
  live: Record<string, unknown[]>;
  bin: Record<string, unknown[]>;
}

function stateOf(org: MemoryRestoreOrg): OrgState {
  const pick = (row: MemoryRow): Record<string, unknown> => ({
    Id: row.Id,
    Name: row.Name ?? null,
    LastName: row.LastName ?? null,
    AccountId: row.AccountId ?? null,
    ReportsToId: row.ReportsToId ?? null,
  });
  const sorted = (rows: MemoryRow[]): unknown[] =>
    rows.map(pick).sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
  return {
    live: { Account: sorted(org.all('Account')), Contact: sorted(org.all('Contact')) },
    bin: { Account: sorted(org.inBin('Account')), Contact: sorted(org.inBin('Contact')) },
  };
}

/** The org before the rewind: see the module's comment. */
function orgBeforeTheRewind(facts: Partial<MemoryOrgFacts> = {}): MemoryRestoreOrg {
  vi.setSystemTime(LONG_AGO);
  const org = new MemoryRestoreOrg(CHILDREN, { now: () => Date.now(), facts });
  org.add('Account', { Id: A1, Name: 'A1 at the checkpoint' });
  org.add('Account', { Id: A2, Name: 'A2 at the checkpoint' });
  org.add('Contact', { Id: C2, LastName: 'C2', AccountId: A2 });
  org.add('Contact', { Id: BOSS, LastName: 'Boss' });
  org.add('Contact', { Id: R, LastName: 'R', ReportsToId: BOSS });
  vi.setSystemTime(SINCE);
  org.edit('Account', A1, { Name: 'A1 since' }, COLLEAGUE);
  org.edit('Account', A2, { Name: 'A2 since' }, COLLEAGUE);
  org.trash('Account', A2, COLLEAGUE);
  org.add('Account', { Id: N1, Name: 'N1' });
  org.add('Contact', { Id: N1C, LastName: 'N1c', AccountId: N1 });
  org.add('Contact', { Id: NC, LastName: 'NC' });
  org.edit('Contact', R, { ReportsToId: NC }, COLLEAGUE);
  return org;
}

/** The calls to the org a stop is counted in. */
const CALLS = new Set([
  'query',
  'queryAll',
  'queryMore',
  'queryDeleted',
  'request',
  'update',
  'destroy',
  'undelete',
  'serverTime',
  'userId',
  'describe',
  'describeGlobal',
]);

/**
 * The org, stopped once it has answered `calls` calls: the signal is aborted
 * as the last of them goes, and the bricks stop before their next one.
 */
function stoppedAfter(
  org: MemoryRestoreOrg,
  calls: number,
  controller: AbortController,
): { org: MemoryRestoreOrg; sent: () => number } {
  let sent = 0;
  const stopping = new Proxy(org, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const call = value as (...args: unknown[]) => unknown;
      if (typeof property !== 'string' || !CALLS.has(property)) return call.bind(target);
      return (...args: unknown[]) => {
        sent++;
        const answer = call.apply(target, args);
        if (sent >= calls) controller.abort();
        return answer;
      };
    },
  });
  return { org: stopping, sent: () => sent };
}

const made: string[] = [];
const held: OrgLock[] = [];
let store: OrgCheckpointStore;
let lock: OrgLock;
let checkpoints = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-undo-'));
  made.push(dir);
  const opened = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: join(dir, 'locks'),
  });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal.reason}`);
  store = opened.store;
  const taken = store.lock(ORG_ID, 'rewind');
  if (!('lock' in taken)) throw new Error('the org’s lock is held');
  lock = taken.lock;
  held.push(lock);
});

afterEach(() => {
  for (const taken of held.splice(0)) taken.release();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A checkpoint's folder of its own, as its take makes it. */
function checkpointFolder(): Promise<CheckpointFolder> {
  checkpoints++;
  return store.create(ORG_ID, `ck-20261022-140512-${checkpoints.toString(36).padStart(4, '0')}`);
}

/**
 * One pass of the rewind, its journal opened first (a new one, or the one of
 * a pass stopped part way): whether it went through. Stopped, it keeps what
 * its removal answered unless `dies`, which leaves the journal as a process
 * killed after its last call would.
 */
async function rewindPass(
  folder: CheckpointFolder,
  org: MemoryRestoreOrg,
  options: { signal?: AbortSignal; dies?: boolean; undeleted?: () => void } = {},
): Promise<boolean> {
  const { signal } = options;
  const tr = new Date().toISOString();
  const journal = await openRewindJournal({
    folder,
    lock,
    startedAt: tr,
    userId: MEMORY_ORG_USER,
    automatedProcessUserId: AUTOMATED_PROCESS,
  });
  try {
    const state = (await journal.read()).rewind;
    const plan = [
      { objectApiName: 'Contact', ids: [N1C, NC] },
      { objectApiName: 'Account', ids: [N1] },
    ];
    const bringBack = [{ objectApiName: 'Account', ids: [A2] }];
    let undeleted: SyncUndeleteOutcome | undefined;
    let restored: SyncRestoreOutcome | undefined;
    await journal.deleting(plan);
    const outcome = await removeRunRecords(org, plan, {
      runStartedAt: new Date(T1),
      runEndedAt: new Date(tr),
      includeChanged: false,
      ...(state.removalStamps ? { removalStamps: state.removalStamps } : {}),
      ...(state.removalSpans ? { removalSpans: state.removalSpans } : {}),
      sweep: async () => {
        // The removal read its records: the rewind writes some seconds after
        // it read the org.
        vi.setSystemTime(Date.now() + 20_000);
        await journal.withParent('Contact', [C2]);
        undeleted = await undeleteRunDeletions({
          org,
          plan: bringBack,
          undelete: journal.bringingBack(bringBack, (ids) => org.undelete(ids)),
          stampsFor: () => true,
          ...(signal ? { signal } : {}),
        });
        if (undeleted.cancelled || signal?.aborted) return undeleted.wrote;
        options.undeleted?.();
        restored = await restoreOverwrites({
          org,
          plan: [
            { objectApiName: 'Account', backup: SNAPSHOT, ids: [A1, A2] },
            { objectApiName: 'Contact', backup: SNAPSHOT, ids: [R] },
          ],
          backups: snapshot,
          changedAfter: tr,
          ownWriters: [MEMORY_ORG_USER, AUTOMATED_PROCESS],
          fields: { Account: ['Name'], Contact: ['LastName', 'AccountId', 'ReportsToId'] },
          includeChanged: false,
          keep: journal.keep,
          ...(state.removalStamps ? { stamps: state.removalStamps } : {}),
          ...(signal ? { signal } : {}),
        });
        return undeleted.wrote || restored.wrote;
      },
      ...(signal ? { signal } : {}),
    });
    if (options.dies && signal?.aborted) return false;
    await journal.deleted(outcome);
    await journal.removal({
      removalStamps: { ...undeleted?.stamps, ...restored?.stamps, ...outcome.stamps },
      ...(outcome.span ? { removalSpans: [outcome.span] } : {}),
    });
    if (outcome.cancelled || undeleted?.cancelled || restored?.cancelled || signal?.aborted) {
      return false;
    }
    await journal.end();
    return true;
  } finally {
    await journal.close();
  }
}

/** The rewind, through to the end, a pass a minute after the one before. */
async function rewound(folder: CheckpointFolder, org: MemoryRestoreOrg): Promise<string> {
  vi.setSystemTime(TR);
  if (!(await rewindPass(folder, org))) throw new Error('the rewind did not go through');
  return onlyRewindOf(folder);
}

/** The one rewind a checkpoint's folder holds the journal of. */
function onlyRewindOf(folder: CheckpointFolder): string {
  const rewinds = readdirSync(folder.rewindsDir);
  expect(rewinds).toHaveLength(1);
  return rewinds[0];
}

function undo(
  folder: CheckpointFolder,
  rewindId: string,
  org: MemoryRestoreOrg,
  signal?: AbortSignal,
): Promise<UndoRewindOutcome> {
  return undoRewind({
    folder,
    rewindId,
    lock,
    objects: READ_ORDER,
    org,
    undelete: (ids) => org.undelete(ids),
    ...(signal ? { signal } : {}),
  });
}

describe('undoRewind, on the memory org', () => {
  it('returns the org to how it was before the rewind under every hypothesis the probes left about stamps, cascades and cleared lookups', async () => {
    const combinations = factCombinations([
      'deleteStamps',
      'childDeletedAloneStays',
      'undeleterIsLastModifier',
      'clearedLookupRestamps',
      'undeleteRestoresLookups',
    ]);
    expect(combinations).toHaveLength(32);
    for (const facts of combinations) {
      const org = orgBeforeTheRewind(facts);
      const before = stateOf(org);
      const folder = await checkpointFolder();
      const rewindId = await rewound(folder, org);
      expect(stateOf(org)).not.toEqual(before);

      vi.setSystemTime(TR + 10 * 60_000);
      const outcome = await undo(folder, rewindId, org);

      expect({ facts, state: stateOf(org) }).toEqual({ facts, state: before });
      expect({ facts, status: outcome.status }).toEqual({ facts, status: 'success' });
    }
  });

  it('brings back what the rewind deleted, gives back what it wrote over and sends back to the bin what it brought back, each counted', async () => {
    const org = orgBeforeTheRewind();
    const folder = await checkpointFolder();
    const rewindId = await rewound(folder, org);

    vi.setSystemTime(TR + 10 * 60_000);
    const outcome = await undo(folder, rewindId, org);

    expect(outcome.planned).toEqual({ remove: 2, bringBack: 3, giveBack: 3 });
    expect(outcome.deleted.map(({ objectApiName, deleted }) => [objectApiName, deleted])).toEqual([
      ['Contact', 1],
      ['Account', 1],
    ]);
    expect(
      outcome.undeleted.map(({ objectApiName, undeleted }) => [objectApiName, undeleted]),
    ).toEqual([
      ['Account', 1],
      ['Contact', 2],
    ]);
    expect(
      outcome.restored.map(({ objectApiName, restored }) => [objectApiName, restored]),
    ).toEqual([
      ['Account', 2],
      ['Contact', 1],
    ]);
    // R names NC again, which the undo brought back before it gave R its value.
    expect(org.all('Contact').find((row) => row.Id === R)?.ReportsToId).toBe(NC);
    expect(outcome.residual).toEqual([]);
    expect(outcome.notes).toEqual([]);
  });

  it('returns the org to how it was before the rewind from a rewind stopped at any of its calls, then taken up again on its journal', async () => {
    const counted = orgBeforeTheRewind();
    const counting = stoppedAfter(counted, Number.POSITIVE_INFINITY, new AbortController());
    await rewound(await checkpointFolder(), counting.org);
    const calls = counting.sent();
    expect(calls).toBeGreaterThan(15);

    for (let stopAt = 1; stopAt <= calls; stopAt++) {
      const org = orgBeforeTheRewind();
      const before = stateOf(org);
      const folder = await checkpointFolder();
      const controller = new AbortController();
      vi.setSystemTime(TR);
      const first = await rewindPass(folder, stoppedAfter(org, stopAt, controller).org, {
        signal: controller.signal,
      });
      if (!first) {
        vi.setSystemTime(TR + 60_000);
        expect({ stopAt, through: await rewindPass(folder, org) }).toEqual({
          stopAt,
          through: true,
        });
      }
      const rewindId = onlyRewindOf(folder);
      expect((await readRewindJournal(folder, rewindId)).passes).toHaveLength(first ? 1 : 2);

      vi.setSystemTime(TR + 10 * 60_000);
      const outcome = await undo(folder, rewindId, org);

      expect({ stopAt, state: stateOf(org) }).toEqual({ stopAt, state: before });
      expect({ stopAt, status: outcome.status }).toEqual({ stopAt, status: 'success' });
    }
  });

  it('returns the org to how it was before the rewind from a rewind stopped, or killed, at any of its calls and never taken up', async () => {
    const counting = stoppedAfter(
      orgBeforeTheRewind(),
      Number.POSITIVE_INFINITY,
      new AbortController(),
    );
    await rewound(await checkpointFolder(), counting.org);
    const calls = counting.sent();

    for (const dies of [false, true]) {
      for (let stopAt = 1; stopAt <= calls; stopAt++) {
        const org = orgBeforeTheRewind();
        const before = stateOf(org);
        const folder = await checkpointFolder();
        const controller = new AbortController();
        vi.setSystemTime(TR);
        await rewindPass(folder, stoppedAfter(org, stopAt, controller).org, {
          signal: controller.signal,
          dies,
        });

        vi.setSystemTime(TR + 10 * 60_000);
        const outcome = await undo(folder, onlyRewindOf(folder), org);

        expect({ dies, stopAt, state: stateOf(org) }).toEqual({ dies, stopAt, state: before });
        expect({ dies, stopAt, status: outcome.status }).toEqual({
          dies,
          stopAt,
          status: 'success',
        });
      }
    }
  });

  it('returns the org to how it was before the rewind from an undo stopped at any of its calls, then run again', async () => {
    const countingOrg = orgBeforeTheRewind();
    const countingFolder = await checkpointFolder();
    const countingRewind = await rewound(countingFolder, countingOrg);
    vi.setSystemTime(TR + 10 * 60_000);
    const counting = stoppedAfter(countingOrg, Number.POSITIVE_INFINITY, new AbortController());
    await undo(countingFolder, countingRewind, counting.org);
    const calls = counting.sent();
    expect(calls).toBeGreaterThan(10);

    for (let stopAt = 1; stopAt <= calls; stopAt++) {
      const org = orgBeforeTheRewind();
      const before = stateOf(org);
      const folder = await checkpointFolder();
      const rewindId = await rewound(folder, org);
      const controller = new AbortController();
      vi.setSystemTime(TR + 10 * 60_000);
      await undo(folder, rewindId, stoppedAfter(org, stopAt, controller).org, controller.signal);

      vi.setSystemTime(TR + 11 * 60_000);
      const again = await undo(folder, rewindId, org);

      expect({ stopAt, state: stateOf(org) }).toEqual({ stopAt, state: before });
      expect({ stopAt, status: again.status }).toEqual({ stopAt, status: 'success' });
    }
  });

  it('keeps what a colleague changed since the rewind as they made it, and counts it: the undo is partial', async () => {
    const org = orgBeforeTheRewind();
    const folder = await checkpointFolder();
    const rewindId = await rewound(folder, org);
    vi.setSystemTime(TR + 5 * 60_000);
    org.edit('Account', A1, { Name: 'A1 by the colleague, after the rewind' }, COLLEAGUE);
    org.edit('Contact', C2, { LastName: 'C2 by the colleague, after the rewind' }, COLLEAGUE);

    vi.setSystemTime(TR + 10 * 60_000);
    const outcome = await undo(folder, rewindId, org);

    expect(org.all('Account').find((row) => row.Id === A1)?.Name).toBe(
      'A1 by the colleague, after the rewind',
    );
    // C2 came back with A2 and was changed since: it stays, and so does A2,
    // which it depends on.
    expect(org.all('Contact').find((row) => row.Id === C2)?.LastName).toBe(
      'C2 by the colleague, after the rewind',
    );
    expect(org.all('Account').map((row) => row.Id)).toContain(A2);
    expect(outcome.restored.find((object) => object.objectApiName === 'Account')).toMatchObject({
      restored: 1,
      keptChanged: 1,
    });
    expect(outcome.deleted.find((object) => object.objectApiName === 'Contact')).toMatchObject({
      deleted: 0,
      keptChanged: 1,
    });
    expect(outcome.status).toBe('partial');
  });

  it('takes along to the bin, with what the rewind brought back, what the org created under it in answer while the rewind ran', async () => {
    const org = orgBeforeTheRewind();
    const folder = await checkpointFolder();
    const answered = id('003', 7);
    vi.setSystemTime(TR);
    const through = await rewindPass(folder, org, {
      undeleted: () => {
        // An Apex trigger after undelete opens a contact under the account,
        // and the rewind goes on writing for a while after it.
        org.add('Contact', { Id: answered, LastName: 'Opened by a trigger', AccountId: A2 });
        vi.setSystemTime(Date.now() + 30_000);
      },
    });
    expect(through).toBe(true);

    vi.setSystemTime(TR + 10 * 60_000);
    const outcome = await undo(folder, onlyRewindOf(folder), org);

    expect(outcome.status).toBe('success');
    expect(org.inBin('Account').map((row) => row.Id)).toContain(A2);
    expect(org.all('Contact').map((row) => row.Id)).not.toContain(answered);
  });

  it('names what still differs once given back: a field the org’s automation set again on save, by who last changed it', async () => {
    const org = orgBeforeTheRewind();
    const folder = await checkpointFolder();
    const rewindId = await rewound(folder, org);
    const update = org.update.bind(org);
    vi.spyOn(org, 'update').mockImplementation(async (objectApiName, records) => {
      const answer = await update(objectApiName, records);
      // A flow that runs on update names the account again.
      if (objectApiName === 'Account' && records.some((record) => record.Id === A1)) {
        org.edit('Account', A1, { Name: 'Named by a flow' }, AUTOMATED_PROCESS);
      }
      return answer;
    });

    vi.setSystemTime(TR + 10 * 60_000);
    const outcome = await undo(folder, rewindId, org);

    expect(outcome.residual).toEqual([
      { objectApiName: 'Account', count: 1, ids: [A1], by: { [AUTOMATED_PROCESS]: 1 } },
    ]);
    expect(outcome.status).toBe('partial');
  });

  it('sends the org exactly what its estimate counts from the journal, the guard, the limits and the automation read apart', async () => {
    const org = orgBeforeTheRewind();
    const folder = await checkpointFolder();
    const rewindId = await rewound(folder, org);
    const relationships = new Map(
      await Promise.all(
        ['Account', 'Contact'].map(
          async (name) => [name, relationshipsOf(await org.describe(name))] as const,
        ),
      ),
    );
    const plans = undoPlans(await readRewindJournal(folder, rewindId), READ_ORDER);
    const estimate = undoEstimate({
      objects: OBJECTS,
      rewound: rewoundObjects(plans),
      automationRequests: 0,
      relationships,
    });
    const actFixed = undoEstimate({ objects: OBJECTS, rewound: [], automationRequests: 0 });
    const sentBefore = org.requests + org.soapCalls;

    vi.setSystemTime(TR + 10 * 60_000);
    const outcome = await undo(folder, rewindId, org);

    expect(outcome.status).toBe('success');
    expect(org.requests + org.soapCalls - sentBefore).toBe(
      estimate.apiRequests - actFixed.apiRequests,
    );
    expect(estimate.records).toBe(2 + 3 + 3);
  });

  it('sends no removal for a rewind that brought nothing back, and gives back 2,000 records a call, as its estimate counts', async () => {
    vi.setSystemTime(LONG_AGO);
    const org = new MemoryRestoreOrg(CHILDREN, { now: () => Date.now() });
    const accounts = Array.from({ length: 2_001 }, (_, n) => id('001', 100 + n));
    for (const account of accounts) org.add('Account', { Id: account, Name: 'Before the rewind' });
    const folder = await checkpointFolder();
    vi.setSystemTime(TR);
    const journal = await openRewindJournal({
      folder,
      lock,
      startedAt: new Date().toISOString(),
      userId: MEMORY_ORG_USER,
    });
    for (let at = 0; at < accounts.length; at += 200) {
      const batch = accounts.slice(at, at + 200);
      await journal.keep(
        'Account',
        batch.map((account) => ({ Id: account, Name: 'Before the rewind' })),
      );
      for (const account of batch) org.edit('Account', account, { Name: 'At the checkpoint' });
    }
    await journal.end();
    await journal.close();
    const estimate = undoEstimate({
      objects: OBJECTS,
      rewound: rewoundObjects(undoPlans(await readRewindJournal(folder, journal.rewindId))),
      automationRequests: 0,
    });
    const actFixed = undoEstimate({ objects: OBJECTS, rewound: [], automationRequests: 0 });
    const sentBefore = org.requests + org.soapCalls;
    const soapBefore = org.soapCalls;

    vi.setSystemTime(TR + 10 * 60_000);
    const outcome = await undo(folder, journal.rewindId, org);

    expect(outcome.status).toBe('success');
    expect(org.all('Account').every((row) => row.Name === 'Before the rewind')).toBe(true);
    expect(org.requests + org.soapCalls - sentBefore).toBe(
      estimate.apiRequests - actFixed.apiRequests,
    );
    // The clock, once a chunk: no removal read the clock and the user.
    expect(org.soapCalls - soapBefore).toBe(2);
  });

  it('gives back, of a record written over by two passes, the values it held before the first', async () => {
    vi.setSystemTime(LONG_AGO);
    const org = new MemoryRestoreOrg(CHILDREN, { now: () => Date.now() });
    org.add('Account', { Id: A1, Name: 'Before the rewind' });
    const folder = await checkpointFolder();
    vi.setSystemTime(TR);
    const first = await openRewindJournal({
      folder,
      lock,
      startedAt: new Date().toISOString(),
      userId: MEMORY_ORG_USER,
    });
    await first.keep('Account', [{ Id: A1, Name: 'Before the rewind' }]);
    org.edit('Account', A1, { Name: 'At the checkpoint' });
    await first.close();
    // Between the stop and the resume, a colleague changes it; the second
    // pass writes over that too.
    vi.setSystemTime(TR + 60_000);
    org.edit('Account', A1, { Name: 'Between the two passes' }, COLLEAGUE);
    vi.setSystemTime(TR + 2 * 60_000);
    const resumed = await openRewindJournal({
      folder,
      lock,
      startedAt: new Date().toISOString(),
      userId: MEMORY_ORG_USER,
    });
    await resumed.keep('Account', [{ Id: A1, Name: 'Between the two passes' }]);
    org.edit('Account', A1, { Name: 'At the checkpoint' });
    await resumed.end();
    await resumed.close();

    vi.setSystemTime(TR + 10 * 60_000);
    const outcome = await undo(folder, resumed.rewindId, org);

    expect(resumed.rewindId).toBe(first.rewindId);
    expect(org.all('Account')[0].Name).toBe('Before the rewind');
    expect(outcome.status).toBe('success');
  });

  it('sends nothing for a rewind that wrote nothing, and ends a success', async () => {
    const org = orgBeforeTheRewind();
    const folder = await checkpointFolder();
    vi.setSystemTime(TR);
    const journal = await openRewindJournal({
      folder,
      lock,
      startedAt: new Date().toISOString(),
      userId: MEMORY_ORG_USER,
    });
    await journal.end();
    await journal.close();
    const sentBefore = org.requests + org.soapCalls;

    const outcome = await undo(folder, journal.rewindId, org);

    expect(outcome.status).toBe('success');
    expect(org.requests + org.soapCalls).toBe(sentBefore);
    expect((await readRewindJournal(folder, journal.rewindId)).undos).toMatchObject([
      { status: 'success' },
    ]);
  });

  it('stops before its first write when asked of an object the user may not delete, and keeps nothing of it', async () => {
    const org = orgBeforeTheRewind();
    const folder = await checkpointFolder();
    const rewindId = await rewound(folder, org);
    const after = stateOf(org);
    org.undeletable.add('Account');

    vi.setSystemTime(TR + 10 * 60_000);
    const outcome = await undoRewind({
      folder,
      rewindId,
      lock,
      objects: READ_ORDER,
      org,
      undelete: (ids) => org.undelete(ids),
      onUndeletable: async () => false,
    });

    expect(outcome).toMatchObject({ status: 'cancelled', stoppedForUndeletable: true });
    expect(stateOf(org)).toEqual(after);
    expect((await readRewindJournal(folder, rewindId)).undos).toEqual([]);
  });

  it('sends nothing under the lock of another org', async () => {
    const org = orgBeforeTheRewind();
    const folder = await checkpointFolder();
    const rewindId = await rewound(folder, org);
    const other = store.lock('00D000000000002AAA', 'undo');
    if (!('lock' in other)) throw new Error('the org’s lock is held');
    held.push(other.lock);
    const sentBefore = org.requests + org.soapCalls;

    await expect(
      undoRewind({
        folder,
        rewindId,
        lock: other.lock,
        objects: READ_ORDER,
        org,
        undelete: (ids) => org.undelete(ids),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(org.requests + org.soapCalls).toBe(sentBefore);
  });
});
