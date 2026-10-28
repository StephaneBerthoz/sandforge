import { mkdirSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import {
  COLLEAGUE,
  T0,
  account,
  changedSince,
  clock,
  previewed,
  removeTaken,
  request,
  resultOf,
  rewound,
  taken,
  type Taken,
} from '../../test/rewindTestOrg.js';
import { readRewindJournal } from './rewindJournal.js';
import {
  noteRewindEnded,
  readRewindLedger,
  rewindLedgerBeside,
  rewindTotalsOf,
} from './rewindLedger.js';
import { undoCheckpoint } from './undoCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The real ledger, watched: when the rewind adds its line, its journal must have ended.
vi.mock('./rewindLedger.js', async (original) => {
  const actual = await original<typeof import('./rewindLedger.js')>();
  return { ...actual, noteRewindEnded: vi.fn(actual.noteRewindEnded) };
});

/*
 * The ends of a rewind and of an undo, on the memory org the bricks run on,
 * as they keep their line in the org's rewind ledger: the line the Seed,
 * Sync and Forge histories mark a run rewound by, which outlives the
 * checkpoint and its journal.
 */

beforeEach(() => {
  clock.now = T0;
  vi.mocked(noteRewindEnded).mockClear();
});

afterEach(() => {
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

const ledgerOf = async (t: Taken) => readRewindLedger(rewindLedgerBeside(t.folder));

describe('the end of a rewind, in its org’s ledger', () => {
  it('keeps one line of a rewind that went through, once its journal ended: the checkpoint’s times, the rewind’s, and what it did in all', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    let journalEnded: string | undefined;
    vi.mocked(noteRewindEnded).mockImplementationOnce(async (ended) => {
      journalEnded = (await readRewindJournal(t.folder, ended.result.rewindId)).endedAt;
      const { noteRewindEnded: actual } =
        await vi.importActual<typeof import('./rewindLedger.js')>('./rewindLedger.js');
      return actual(ended);
    });

    const outcome = await rewound(t, diff.previewId);
    const result = resultOf(outcome);

    expect(result.status).toBe('success');
    expect(journalEnded).toBeDefined();
    const journal = await readRewindJournal(t.folder, result.rewindId);
    const kept = (await t.store.read(t.checkpoint.checkpointId))?.checkpoint;
    const { records, unreadable } = await ledgerOf(t);
    expect(unreadable).toEqual([]);
    expect(records).toEqual([
      {
        kind: 'rewind',
        rewindId: result.rewindId,
        checkpointId: t.checkpoint.checkpointId,
        checkpointName: 'Before UAT',
        organizationId: t.checkpoint.org.organizationId,
        mode: 'picked',
        objects: t.checkpoint.objects.map(({ objectApiName }) => objectApiName),
        readFrom: t.checkpoint.readFrom,
        takenAt: t.checkpoint.takenAt,
        startedAt: journal.head.startedAt,
        endedAt: kept?.lastRewind?.endedAt,
        orgAheadMs: expect.any(Number),
        status: 'success',
        totals: rewindTotalsOf(result),
      },
    ]);
    // The org's clock, read by the rewind against this machine's: the
    // memory org's runs days behind it.
    expect(records[0]?.kind === 'rewind' && records[0].orgAheadMs).toBeLessThan(0);
    expect(rewindTotalsOf(result).deleted).toBeGreaterThan(0);
    if (outcome.rewound) expect(outcome.notes).toEqual([]);
  });

  it('keeps no line of a rewind whose every write the org refused: it ended a failure, the org as it was', async () => {
    const t = await taken();
    clock.now = T0 + 60_000;
    t.org.edit('Account', account(1), { Name: 'Renamed' }, COLLEAGUE);
    const diff = await previewed(t);
    t.org.refuseUpdate.set(account(1), { statusCode: 'UNABLE_TO_LOCK_ROW', message: 'locked' });

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('failure');
    expect((await ledgerOf(t)).records).toEqual([]);
    expect(noteRewindEnded).not.toHaveBeenCalled();
  });

  it('keeps no line of a rewind that had nothing to write', async () => {
    const t = await taken();
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    expect((await ledgerOf(t)).records).toEqual([]);
  });

  it('keeps a line of a rewind stopped part way that wrote, said stopped; taken up, its last line says how it ended', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    const controller = new AbortController();
    const stopping = new Proxy(t.org, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        const call = value as (...args: unknown[]) => unknown;
        if (property !== 'undelete') return call.bind(target);
        return async (...args: unknown[]) => {
          const answer = await call.apply(target, args);
          controller.abort();
          return answer;
        };
      },
    });

    const stopped = resultOf(
      await rewound(t, diff.previewId, {
        deps: {
          org: stopping,
          undelete: (ids) => stopping.undelete(ids),
          signal: controller.signal,
        },
      }),
    );
    expect(stopped.status).toBe('cancelled');
    const first = (await ledgerOf(t)).records;
    expect(first.map((line) => [line.kind, line.rewindId, line.status])).toEqual([
      ['rewind', stopped.rewindId, 'cancelled'],
    ]);

    clock.now += 60_000;
    const again = resultOf(await rewound(t, (await previewed(t)).previewId));

    expect(again.rewindId).toBe(stopped.rewindId);
    expect(again.status).toBe('success');
    expect(
      (await ledgerOf(t)).records.map((line) => [line.kind, line.rewindId, line.status]),
    ).toEqual([
      ['rewind', stopped.rewindId, 'cancelled'],
      ['rewind', stopped.rewindId, 'success'],
    ]);
  });

  it('says in a note of its result a ledger it could not write, and goes through all the same', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    // A folder where the ledger's file goes: it cannot be added to.
    mkdirSync(rewindLedgerBeside(t.folder));

    const outcome = await rewound(t, diff.previewId);

    expect(resultOf(outcome).status).toBe('success');
    expect(outcome.rewound && outcome.notes).toEqual([
      expect.stringMatching(/^The rewind could not be kept in the org’s rewind ledger \(/),
    ]);
  });
});

describe('the end of an undo, in its org’s ledger', () => {
  it('adds a line once the undo went through, after the rewind’s, dated by this machine’s clock', async () => {
    const t = await taken();
    changedSince(t.org);
    const rewind = resultOf(await rewound(t, (await previewed(t)).previewId));
    const read = await t.store.read(t.checkpoint.checkpointId);
    if (!read?.checkpoint) throw new Error('the checkpoint is gone');
    clock.now += 60_000;
    const undoneAt = new Date('2026-10-28T13:00:00.000Z');

    const outcome = await undoCheckpoint(
      {
        org: t.org,
        undelete: (ids) => t.org.undelete(ids),
        store: t.store,
        now: () => undoneAt,
      },
      {
        ...request(t),
        checkpoint: read.checkpoint,
        rewindId: rewind.rewindId,
        acceptAutomation: false,
      },
    );

    expect(outcome.undone && outcome.result.status).toBe('success');
    expect((await ledgerOf(t)).records.map((line) => line.kind)).toEqual(['rewind', 'undo']);
    expect((await ledgerOf(t)).records[1]).toEqual({
      kind: 'undo',
      rewindId: rewind.rewindId,
      checkpointId: t.checkpoint.checkpointId,
      organizationId: t.checkpoint.org.organizationId,
      status: 'success',
      undoneAt: undoneAt.toISOString(),
    });
  });
});
