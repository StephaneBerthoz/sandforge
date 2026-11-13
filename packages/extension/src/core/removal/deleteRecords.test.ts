import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';

import { limitSplitting } from '../common/governorLimit.js';
import type { BulkApiConnection } from '../engine/BulkApiExecutor.js';
import {
  BULK_DELETE_THRESHOLD,
  FILE_NOT_FOR_GOOD,
  HARD_DELETE_NOT_ENABLED,
  HARD_DELETE_UNAVAILABLE,
  LOCK_RESENDS,
  bulkDeleteJob,
  deleteBatch,
  deleteByJob,
  deleteRounds,
  deletionOrg,
  goesByJob,
  lockResendNote,
  retryRounds,
  sendDeletes,
  type BulkDeleteAnswer,
  type DeleteOutcome,
  type DeletionOrg,
} from './deleteRecords.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The deletes every removal goes through: over REST or as Bulk API 2.0 jobs,
 * to the recycle bin or for good, a record the org could not lock sent again.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** What the org says when it refuses a `hardDelete` job to a user without Bulk API Hard Delete, as asked live. */
const NO_HARD_DELETE =
  'hardDelete operation requires special user profile permission, please contact your system administrator';

/** The org's refusal of a record it could not lock, as a write is refused with it. */
const LOCKED = {
  statusCode: 'UNABLE_TO_LOCK_ROW',
  message: 'unable to obtain exclusive access to this record',
};

/**
 * An org of a few records: REST deletes and jobs kept apart, a record locked
 * for a number of tries, and the jobs it answers as told.
 */
class DeletesOrg implements DeletionOrg {
  readonly live = new Set<string>();
  readonly rest: string[][] = [];
  readonly jobs: Array<{ operation: 'delete' | 'hardDelete'; ids: string[] }> = [];
  /** Tries a record is refused for a lock, by id. */
  readonly locked = new Map<string, number>();
  /** Refusals other than a lock, by id: `CODE: message`. */
  readonly refusals = new Map<string, { statusCode: string; message: string }>();
  /** What the next jobs answer instead of deleting, in turn. */
  readonly jobAnswers: BulkDeleteAnswer[] = [];
  hardDelete = true;
  bulkDestroy?: DeletionOrg['bulkDestroy'];
  bulkHardDestroy?: DeletionOrg['bulkHardDestroy'];

  constructor(ids: readonly string[], options: { jobs?: boolean } = {}) {
    for (const id of ids) this.live.add(id);
    if (options.jobs !== false) {
      this.bulkDestroy = async (_object, ids) => this.job('delete', ids);
      this.bulkHardDestroy = async (_object, ids) => {
        if (!this.hardDelete) {
          return { kind: 'untouched', reason: NO_HARD_DELETE, code: HARD_DELETE_NOT_ENABLED };
        }
        return this.job('hardDelete', ids);
      };
    }
  }

  private answer(id: string): { success: true } | { success: false; error: typeof LOCKED } {
    const tries = this.locked.get(id) ?? 0;
    if (tries > 0) {
      this.locked.set(id, tries - 1);
      return { success: false, error: LOCKED };
    }
    const refusal = this.refusals.get(id);
    if (refusal) return { success: false, error: refusal };
    if (!this.live.delete(id)) {
      return { success: false, error: { statusCode: 'ENTITY_IS_DELETED', message: 'gone' } };
    }
    return { success: true };
  }

  private job(operation: 'delete' | 'hardDelete', ids: readonly string[]): BulkDeleteAnswer {
    this.jobs.push({ operation, ids: [...ids] });
    const told = this.jobAnswers.shift();
    if (told) return told;
    return {
      kind: 'answered',
      rows: ids.map((id) => {
        const answer = this.answer(id);
        return answer.success
          ? { success: true as const }
          : {
              success: false as const,
              error: `${answer.error.statusCode}:${answer.error.message}:--`,
            };
      }),
    };
  }

  async destroy(_object: string, ids: string[]): Promise<unknown> {
    this.rest.push([...ids]);
    return ids.map((id) => {
      const answer = this.answer(id);
      return answer.success ? { id, success: true } : { success: false, errors: [answer.error] };
    });
  }

  async query(): Promise<{ totalSize: number; records: unknown[] }> {
    return { totalSize: 0, records: [] };
  }

  async describe(): Promise<unknown> {
    return { fields: [], childRelationships: [] };
  }

  async update(): Promise<unknown> {
    return [];
  }

  async queryDeleted(): Promise<{ records: unknown[] }> {
    return { records: [] };
  }
}

/** A wait that waits for nothing, and keeps what it was asked. */
function noWait(): { wait: (ms: number) => Promise<void>; asked: number[] } {
  const asked: number[] = [];
  return { asked, wait: async (ms) => void asked.push(ms) };
}

/** A Bulk API connection that keeps the jobs it was asked to open, and refuses to open one as told. */
function fakeBulk(openFails?: Error): {
  connection: BulkApiConnection;
  opened: string[];
} {
  const opened: string[] = [];
  const connection: BulkApiConnection = {
    bulk2: {
      createJob: (options) => {
        opened.push(options.operation);
        return {
          id: '750000000000001AAA',
          open: async () => {
            if (openFails) throw openFails;
          },
          uploadData: async () => {},
          close: async () => {},
          abort: async () => {},
          check: async () => ({ state: 'JobComplete', numberRecordsProcessed: 1 }),
          getAllResults: async () => ({
            successfulResults: [
              { sf__Id: fakeId('001', 1), sf__Created: 'false', Id: fakeId('001', 1) },
            ],
          }),
        };
      },
    },
  };
  return { connection, opened };
}

/** The org's refusal of a job it will not open, as jsforce throws it. */
function refusedJob(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { name: errorCode, errorCode });
}

describe('bulkDeleteJob', () => {
  it('opens a hardDelete job when asked to delete for good, and a delete job otherwise', async () => {
    const { connection, opened } = fakeBulk();

    await bulkDeleteJob(connection, 'Account', [fakeId('001', 1)]);
    await bulkDeleteJob(connection, 'Account', [fakeId('001', 1)], undefined, 'hardDelete');

    expect(opened).toEqual(['delete', 'hardDelete']);
  });

  it("answers a hardDelete job the org refuses as it opens untouched, with the org's code and words", async () => {
    const { connection } = fakeBulk(refusedJob(HARD_DELETE_NOT_ENABLED, NO_HARD_DELETE));

    const answer = await bulkDeleteJob(
      connection,
      'Account',
      [fakeId('001', 1)],
      undefined,
      'hardDelete',
    );

    expect(answer).toEqual({
      kind: 'untouched',
      reason: NO_HARD_DELETE,
      code: HARD_DELETE_NOT_ENABLED,
      requests: 1,
    });
  });

  it('gives the jobs of a connection made for deletes their operation: delete to the bin, hardDelete for good', async () => {
    const { connection, opened } = fakeBulk();
    const org = deletionOrg(connection as unknown as Connection, 'test');

    await org.bulkDestroy?.('Account', [fakeId('001', 1)]);
    await org.bulkHardDestroy?.('Account', [fakeId('001', 1)]);

    expect(opened).toEqual(['delete', 'hardDelete']);
  });

  it('holds a job of a connection made for deletes to the states of an ingest job: one the org still holds open after its close is no job that deleted nothing', async () => {
    // jsforce's handle, as jsforce 3 shapes it: its `check` answers the org's
    // JSON. Taken for the executor's by a cast, a job still open after its
    // close read as one that processed nothing, and its records went to REST
    // while the org could still delete them by the job.
    const connection = {
      bulk2: {
        createJob: () => ({
          id: '750000000000001AAA',
          open: async () => ({ id: '750000000000001AAA', state: 'Open' }),
          uploadData: async () => {},
          close: async () => {},
          abort: async () => {},
          check: async () => ({ id: '750000000000001AAA', state: 'Open' }),
          getAllResults: async () => ({
            successfulResults: [],
            failedResults: [],
            unprocessedRecords: [],
          }),
        }),
      },
    };
    const org = deletionOrg(connection as unknown as Connection, 'test');

    await expect(org.bulkDestroy?.('Account', [fakeId('001', 1)])).rejects.toThrow(
      'Bulk API job 750000000000001AAA is still open after its close was sent',
    );
  });
});

describe('deleteRounds', () => {
  const ids = [fakeId('003', 1), fakeId('003', 2), fakeId('003', 3)];

  it('sends a few records over REST to the recycle bin, and by job for good, however few', async () => {
    const org = new DeletesOrg(ids);

    expect(await deleteRounds(org, 'Contact', [...ids])).toEqual([{ ids, byJob: false }]);
    expect(await deleteRounds(org, 'Contact', [...ids], 'hard')).toEqual([{ ids, byJob: true }]);
  });

  it('sends no file by job, to the bin or for good', async () => {
    const org = new DeletesOrg(ids);

    expect(await deleteRounds(org, 'ContentDocument', [...ids], 'hard')).toEqual([
      { ids, byJob: false },
    ]);
  });

  it('says which records go by job: to the bin from the threshold where the org takes jobs, for good always', () => {
    const jobs = new DeletesOrg([]);
    const noJobs = new DeletesOrg([], { jobs: false });

    expect(goesByJob(jobs, 'Contact', BULK_DELETE_THRESHOLD - 1)).toBe(false);
    expect(goesByJob(jobs, 'Contact', BULK_DELETE_THRESHOLD)).toBe(true);
    expect(goesByJob(noJobs, 'Contact', BULK_DELETE_THRESHOLD)).toBe(false);
    expect(goesByJob(noJobs, 'Contact', 1, 'hard')).toBe(true);
    expect(goesByJob(jobs, 'ContentVersion', 1, 'hard')).toBe(false);
  });
});

describe('deleteBatch, a record the org could not lock', () => {
  const ids = [fakeId('003', 1), fakeId('003', 2), fakeId('003', 3)];

  it('sends again the records refused for a lock alone, after a wait, and says how many times', async () => {
    const org = new DeletesOrg(ids);
    org.locked.set(ids[1], 2);
    const { wait, asked } = noWait();

    const outcomes = await deleteBatch(org, 'Contact', ids, { wait });

    expect(outcomes).toEqual([
      { kind: 'deleted' },
      { kind: 'deleted', lockResends: 2 },
      { kind: 'deleted' },
    ]);
    expect(org.rest).toEqual([ids, [ids[1]], [ids[1]]]);
    // A wait before each send again, doubled each time, its upper half left to chance.
    expect(asked).toHaveLength(2);
    expect(asked[0]).toBeGreaterThanOrEqual(1_000);
    expect(asked[0]).toBeLessThanOrEqual(2_000);
    expect(asked[1]).toBeGreaterThanOrEqual(2_000);
    expect(asked[1]).toBeLessThanOrEqual(4_000);
  });

  it(`sends one again ${LOCK_RESENDS} times at most, then leaves it refused for the lock`, async () => {
    const org = new DeletesOrg(ids);
    org.locked.set(ids[0], LOCK_RESENDS + 1);

    const [outcome] = await deleteBatch(org, 'Contact', [ids[0]], noWait());

    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record',
      dependency: false,
      locked: true,
      lockResends: LOCK_RESENDS,
    });
    expect(org.rest).toHaveLength(1 + LOCK_RESENDS);
  });

  it('never sends again a record refused for anything but a lock', async () => {
    const org = new DeletesOrg(ids);
    org.refusals.set(ids[0], { statusCode: 'DELETE_FAILED', message: 'held by a case' });

    const [outcome] = await deleteBatch(org, 'Contact', [ids[0]], noWait());

    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'DELETE_FAILED: held by a case',
      dependency: true,
    });
    expect(org.rest).toHaveLength(1);
  });

  it('sends nothing again once stopped: the record stays refused for the lock', async () => {
    const org = new DeletesOrg(ids);
    org.locked.set(ids[0], 1);

    const [outcome] = await deleteBatch(org, 'Contact', [ids[0]], {
      ...noWait(),
      stopped: () => true,
    });

    expect(outcome).toMatchObject({ kind: 'refused', locked: true });
    expect(org.rest).toHaveLength(1);
  });
});

describe('deleteByJob', () => {
  const ids = [fakeId('001', 1), fakeId('001', 2)];

  it('deletes for good through a hardDelete job alone, never a delete job nor REST', async () => {
    const org = new DeletesOrg(ids);

    const outcomes = await deleteByJob(org, 'Account', ids, 'hard');

    expect(outcomes).toEqual([{ kind: 'deleted' }, { kind: 'deleted' }]);
    expect(org.jobs).toEqual([{ operation: 'hardDelete', ids }]);
    expect(org.rest).toEqual([]);
  });

  it("ends with the org's refusal when it will not open a hardDelete job for the user, nothing sent", async () => {
    const org = new DeletesOrg(ids);
    org.hardDelete = false;

    const answer = await deleteByJob(org, 'Account', ids, 'hard');

    expect(answer).toEqual({ hardRefused: expect.stringContaining(NO_HARD_DELETE) });
    expect(org.live.size).toBe(2);
    expect(org.rest).toEqual([]);
  });

  it('ends with a refusal when the org cannot send a job for good at all', async () => {
    const org = new DeletesOrg(ids, { jobs: false });

    expect(await deleteByJob(org, 'Account', ids, 'hard')).toEqual({
      hardRefused: HARD_DELETE_UNAVAILABLE,
    });
  });

  it('refuses for good the records of a job not handed over, rather than leave them to REST', async () => {
    const org = new DeletesOrg(ids);
    org.jobAnswers.push({
      kind: 'untouched',
      reason: "Entity 'Account' is not supported by the Bulk API",
    });

    const outcomes = await deleteByJob(org, 'Account', ids, 'hard');

    expect(outcomes).toEqual(
      ids.map(() => ({
        kind: 'refused',
        reason:
          "Not deleted for good: the job was not handed over — Entity 'Account' is not supported by the Bulk API",
        dependency: false,
      })),
    );
    expect(org.rest).toEqual([]);
  });

  it('leaves a job to the recycle bin the org deleted none of to REST', async () => {
    const org = new DeletesOrg(ids);
    org.jobAnswers.push({ kind: 'untouched', reason: 'no' });

    expect(await deleteByJob(org, 'Account', ids)).toBe('untouched');
  });

  it('sends again by a job of the same kind the records the org could not lock', async () => {
    const org = new DeletesOrg(ids);
    org.locked.set(ids[0], 1);

    const outcomes = await deleteByJob(org, 'Account', ids, 'hard', noWait());

    expect(outcomes).toEqual([{ kind: 'deleted', lockResends: 1 }, { kind: 'deleted' }]);
    expect(org.jobs).toEqual([
      { operation: 'hardDelete', ids },
      { operation: 'hardDelete', ids: [ids[0]] },
    ]);
  });
});

describe('sendDeletes', () => {
  const ids = [fakeId('003', 1), fakeId('003', 2)];

  it('deletes for good by job with nothing over REST, and settles each record', async () => {
    const org = new DeletesOrg(ids);
    const settled: Array<[readonly string[], readonly DeleteOutcome[]]> = [];

    const end = await sendDeletes(org, 'Contact', [...ids], {
      mode: 'hard',
      stopped: () => false,
      splitting: limitSplitting(),
      settle: (sent, outcomes) => void settled.push([sent, outcomes]),
    });

    expect(end).toEqual({ stopped: false });
    expect(settled).toEqual([[ids, [{ kind: 'deleted' }, { kind: 'deleted' }]]]);
    expect(org.rest).toEqual([]);
  });

  it("stops with the org's refusal to delete for good, nothing settled", async () => {
    const org = new DeletesOrg(ids);
    org.hardDelete = false;
    const settle = vi.fn();

    const end = await sendDeletes(org, 'Contact', [...ids], {
      mode: 'hard',
      stopped: () => false,
      splitting: limitSplitting(),
      settle,
    });

    expect(end).toEqual({ stopped: true, hardRefused: expect.stringContaining(NO_HARD_DELETE) });
    expect(settle).not.toHaveBeenCalled();
    expect(org.live.size).toBe(2);
  });

  it('refuses a file for good unsent', async () => {
    const files = [fakeId('069', 1)];
    const org = new DeletesOrg(files);
    const settle = vi.fn();

    await sendDeletes(org, 'ContentDocument', [...files], {
      mode: 'hard',
      stopped: () => false,
      splitting: limitSplitting(),
      settle,
    });

    expect(settle).toHaveBeenCalledWith(files, [
      { kind: 'refused', reason: FILE_NOT_FOR_GOOD, dependency: false },
    ]);
    expect(org.rest).toEqual([]);
    expect(org.jobs).toEqual([]);
  });
});

describe('retryRounds', () => {
  it('goes round again while a round deletes something more, and stops at the first that takes nothing', async () => {
    // Three records, each going only once the one before it has gone.
    const waiting = ['a', 'b', 'c'];
    let deleted = 0;
    const rounds: number[] = [];

    const stopped = await retryRounds(['object'], {
      stopped: () => false,
      idsOf: () => waiting,
      send: async (_object, _ids, round) => {
        rounds.push(round);
        if (waiting.length > 0) {
          waiting.shift();
          deleted++;
        }
        return false;
      },
      deleted: () => deleted,
    });

    expect(stopped).toBe(false);
    expect(rounds).toEqual([0, 1, 2]);
    expect(waiting).toEqual([]);
  });

  it('says it was stopped, and sends nothing once it is', async () => {
    const send = vi.fn(async () => false);

    expect(
      await retryRounds(['object'], {
        stopped: () => true,
        idsOf: () => ['a'],
        send,
        deleted: () => 0,
      }),
    ).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('lockResendNote', () => {
  it('says how many records the org could not lock and what became of them', () => {
    expect(lockResendNote(['deleted', 'deleted', 'refused'])).toEqual([
      `The org could not lock 3 record(s) (UNABLE_TO_LOCK_ROW), each sent again up to ${LOCK_RESENDS} times, a wait before each: 2 deleted, 1 still refused.`,
    ]);
    expect(lockResendNote([])).toEqual([]);
  });
});
