import { describe, it, expect, vi, beforeEach } from 'vitest';
import { removeSyncRun, type SyncRemovalConfigs } from './SyncRunRemoval';
import type { SyncRunKept, SyncRunRemovalState } from './SyncRunCreations';
import { syncRemovalPlan, syncRestorePlan } from './SyncRunCreations';
import type { BackupReader } from './SyncRunRestore';
import { MemoryRemovalOrg } from '../../test/memoryRemovalOrg';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const A1 = fakeId('001', 1);
const A2 = fakeId('001', 2);
const C1 = fakeId('003', 1);
const DOC = fakeId('069', 1);

/** Minutes before now, as the org dates a record. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** A run ten minutes ago that created two accounts, a contact under the first, and a file. */
function run(removal?: SyncRunRemovalState): SyncRunKept {
  return {
    runId: 'run-1',
    configId: 'cfg-1',
    configName: 'Accounts',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    startedAt: minutesAgo(11),
    lastWrittenAt: minutesAgo(10),
    end: { at: minutesAgo(10), status: 'success' },
    created: [
      { objectApiName: 'Account', ids: [A1, A2] },
      { objectApiName: 'Contact', ids: [C1] },
      { objectApiName: 'ContentDocument', ids: [DOC] },
    ],
    ...(removal ? { removal } : {}),
  };
}

/** The target as the run left it. */
function target(): MemoryRemovalOrg {
  const org = new MemoryRemovalOrg({
    Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
  });
  const at = minutesAgo(10);
  org.add('Account', { Id: A1 }, at);
  org.add('Account', { Id: A2 }, at);
  org.add('Contact', { Id: C1, AccountId: A1 }, at);
  org.add('ContentDocument', { Id: DOC }, at);
  return org;
}

/** What the removals of the run did, kept in memory. */
function stateStore() {
  let state: SyncRunRemovalState = {};
  return {
    get state() {
      return state;
    },
    updateRemoval: vi.fn(
      async (_runId: string, change: (s: SyncRunRemovalState) => SyncRunRemovalState) => {
        state = change(state);
      },
    ),
  };
}

function configs(saved = true): SyncRemovalConfigs & {
  forgetFiles: ReturnType<typeof vi.fn>;
  markRemoved: ReturnType<typeof vi.fn>;
} {
  return {
    isSaved: () => saved,
    forgetFiles: vi.fn(
      (_id: string, orgs: { sourceOrgId: string; targetOrgId: string }, ids: readonly string[]) =>
        ids.map((targetId) => ({
          ...orgs,
          objectApiName: 'Account',
          kind: 'document' as const,
          sourceId: fakeId('069', 9),
          targetId,
          linked: [],
          copiedAt: minutesAgo(10),
        })),
    ),
    markRemoved: vi.fn((_id: string, _orgs: unknown, objects: readonly string[]) => [...objects]),
  };
}

describe('removeSyncRun', () => {
  let org: MemoryRemovalOrg;

  beforeEach(() => {
    org = target();
  });

  it('removes what the run created, the file first, the children before their parents', async () => {
    const store = stateStore();

    const { result, planned } = await removeSyncRun({
      run: run(),
      org,
      includeChanged: false,
      store,
    });

    expect(planned).toBe(4);
    expect(result.status).toBe('success');
    expect(org.deletes.map((d) => d.objectApiName)).toEqual([
      'ContentDocument',
      'Contact',
      'Account',
    ]);
    expect(org.all('Account')).toEqual([]);
    expect(org.all('ContentDocument')).toEqual([]);
    expect(result.objects.map((o) => [o.objectApiName, o.deleted])).toEqual([
      ['ContentDocument', 1],
      ['Contact', 1],
      ['Account', 2],
    ]);
    // Marked, with nothing left for a later removal.
    expect(store.state.undo).toMatchObject({ deleted: 4, alreadyGone: 0, kept: 0, refused: 0 });
    expect(store.state.removalLeft).toEqual([]);
    expect(syncRemovalPlan({ ...run(), removal: store.state })).toEqual([]);
  });

  it('keeps a record changed since the run unless asked to remove it too, and leaves it to the next removal', async () => {
    org.touch('Account', A2, new Date(Date.now() + 60_000).toISOString());
    const store = stateStore();

    const kept = await removeSyncRun({ run: run(), org, includeChanged: false, store });

    expect(kept.result.status).toBe('partial');
    expect(org.all('Account').map((row) => row.Id)).toEqual([A2]);
    expect(kept.result.objects.find((o) => o.objectApiName === 'Account')).toMatchObject({
      deleted: 1,
      keptChanged: 1,
    });
    expect(store.state.removalLeft).toEqual([A2]);

    const again = await removeSyncRun({
      run: run(store.state),
      org,
      includeChanged: true,
      store,
    });

    expect(again.planned).toBe(1);
    expect(again.result).toMatchObject({ status: 'success', leftBy: kept.result.finishedAt });
    expect(org.all('Account')).toEqual([]);
  });

  it('says the reasons of a refused delete, and counts it refused', async () => {
    org.refuse.set(A2, 'ENTITY_IS_LOCKED: approval pending');

    const { result } = await removeSyncRun({
      run: run(),
      org,
      includeChanged: false,
      store: stateStore(),
    });

    const accounts = result.objects.find((o) => o.objectApiName === 'Account');
    expect(accounts).toMatchObject({ deleted: 1, refused: 1 });
    expect(accounts?.reasons.join(' ')).toContain('approval pending');
    expect(result.status).toBe('partial');
  });

  it('stops before its next call once cancelled, and says it was', async () => {
    const stop = new AbortController();
    org.beforeDelete = () => stop.abort();
    const store = stateStore();

    const { result } = await removeSyncRun({
      run: run(),
      org,
      includeChanged: false,
      store,
      signal: stop.signal,
    });

    expect(result.status).toBe('cancelled');
    // The file went before the cancel was seen; the records stay, for the next removal.
    expect(org.deletes).toHaveLength(1);
    expect(org.all('Account')).toHaveLength(2);
    expect(store.state.undo).toMatchObject({ deleted: 1, notReached: 3 });
    expect(syncRemovalPlan({ ...run(), removal: store.state }).flatMap((o) => o.ids)).toHaveLength(
      3,
    );
  });

  it('drops what went from the configuration: the copies of files deleted, and the watermarks of what went', async () => {
    const saved = configs();

    const { result } = await removeSyncRun({
      run: run(),
      org,
      includeChanged: false,
      store: stateStore(),
      configs: saved,
    });

    expect(saved.forgetFiles).toHaveBeenCalledWith(
      'cfg-1',
      { sourceOrgId: 'src-org', targetOrgId: 'tgt-org' },
      [DOC],
    );
    expect(saved.markRemoved).toHaveBeenCalledWith(
      'cfg-1',
      { sourceOrgId: 'src-org', targetOrgId: 'tgt-org' },
      ['Contact', 'Account'],
      result.finishedAt,
    );
    expect(result).toMatchObject({ readWhole: ['Contact', 'Account'], filesForgotten: 1 });
  });

  it('leaves a configuration no longer saved alone', async () => {
    const gone = configs(false);

    const { result } = await removeSyncRun({
      run: run(),
      org,
      includeChanged: false,
      store: stateStore(),
      configs: gone,
    });

    expect(gone.forgetFiles).not.toHaveBeenCalled();
    expect(result.readWhole).toBeUndefined();
  });

  it('says, without failing the removal, what could not be kept of it', async () => {
    const { result, notes } = await removeSyncRun({
      run: run(),
      org,
      includeChanged: false,
      store: {
        updateRemoval: async () => {
          throw new Error('EACCES: permission denied');
        },
      },
    });

    expect(result.status).toBe('success');
    expect(notes).toEqual([
      'What this removal did could not be kept (EACCES: permission denied): the next removal ' +
        'of the run may set out to take records already gone.',
    ]);
  });
});

describe('removeSyncRun, of a run that wrote over records of the target', () => {
  const HELD = fakeId('003', 7);
  const OLD_ACCOUNT = fakeId('001', 9);
  const BACKUP = 'sync-before-run-1';

  /** The backups store, holding the contact's values from before the run. */
  const backups: BackupReader = {
    batches: async (operationId, objectApiName) =>
      operationId === BACKUP && objectApiName === 'Contact'
        ? {
            async *[Symbol.asyncIterator]() {
              yield [{ Id: HELD, AccountId: OLD_ACCOUNT, LastName: 'Before' }];
            },
          }
        : null,
  };

  /** A run that created an account, and upserted onto a contact the target held, under it. */
  function overwriting(removal?: SyncRunRemovalState): SyncRunKept {
    return {
      ...run(removal),
      lastWriteAt: minutesAgo(10),
      created: [{ objectApiName: 'Account', ids: [A1] }],
      overwritten: [{ objectApiName: 'Contact', backup: BACKUP, ids: [HELD] }],
    };
  }

  /** The target as that run left it: the contact the target held, under the run's account. */
  function written(): MemoryRestoreOrg {
    const org = new MemoryRestoreOrg({
      Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
    });
    org.add('Account', { Id: OLD_ACCOUNT }, minutesAgo(600));
    org.add('Account', { Id: A1 }, minutesAgo(10));
    org.add(
      'Contact',
      { Id: HELD, AccountId: A1, LastName: 'After', CreatedDate: minutesAgo(600) },
      minutesAgo(10),
    );
    return org;
  }

  it('gives back what it wrote over before deleting what it created, which nothing then depends on', async () => {
    const org = written();
    const store = stateStore();

    const { result, plannedBack } = await removeSyncRun({
      run: overwriting(),
      org,
      includeChanged: false,
      store,
      backups,
    });

    expect(plannedBack).toBe(1);
    expect(result.status).toBe('success');
    // Put back under the account it was under, the run's account deleted, not kept for it.
    expect(org.all('Contact')).toEqual([
      expect.objectContaining({ Id: HELD, AccountId: OLD_ACCOUNT, LastName: 'Before' }),
    ]);
    expect(org.all('Account').map((row) => row.Id)).toEqual([OLD_ACCOUNT]);
    expect(result.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Account', deleted: 1, keptDependents: 0 }),
    ]);
    expect(result.restored).toEqual([
      expect.objectContaining({ objectApiName: 'Contact', planned: 1, restored: 1 }),
    ]);
    expect(store.state).toMatchObject({ restoreLeft: [], restoredAt: result.finishedAt });
    expect(syncRestorePlan({ ...overwriting(), removal: store.state })).toEqual([]);
  });

  it('removes a run that only wrote over records, and leaves one changed since to the next removal', async () => {
    const org = written();
    org.touch('Contact', HELD, new Date(Date.now() + 60_000).toISOString());
    const store = stateStore();
    const onlyOver: SyncRunKept = { ...overwriting(), created: [] };

    const kept = await removeSyncRun({ run: onlyOver, org, includeChanged: false, store, backups });

    expect(kept.result.status).toBe('failure');
    expect(kept.result.restored).toEqual([
      expect.objectContaining({ planned: 1, restored: 0, keptChanged: 1 }),
    ]);
    expect(org.all('Contact')[0]).toMatchObject({ AccountId: A1, LastName: 'After' });
    expect(store.state.restoreLeft).toEqual([HELD]);
    expect(store.state.restoredAt).toBeUndefined();

    const again = await removeSyncRun({
      run: { ...onlyOver, removal: store.state },
      org,
      includeChanged: true,
      store,
      backups,
    });
    expect(again.result.status).toBe('success');
    expect(org.all('Contact')[0]).toMatchObject({ AccountId: OLD_ACCOUNT, LastName: 'Before' });
    expect(store.state.restoreLeft).toEqual([]);
  });

  it('keeps the records it wrote over offered when the backups cannot be read here, and says so', async () => {
    const org = written();
    const store = stateStore();

    const { result, notes } = await removeSyncRun({
      run: overwriting(),
      org,
      includeChanged: false,
      store,
    });

    expect(result.restored).toBeUndefined();
    expect(notes).toEqual([
      'The values from before the run of 1 record(s) it wrote over could not be read here: ' +
        'they were not put back, and the next removal offers them again.',
    ]);
    expect(syncRestorePlan({ ...overwriting(), removal: store.state })).toHaveLength(1);
  });
});
