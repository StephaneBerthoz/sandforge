import { describe, expect, it, vi } from 'vitest';
import type { ForgeTargetAutomation } from '@sandforge/shared';

import {
  seedSweepInput,
  seedWrittenBetween,
  writerOf,
  writesWindow,
  writtenSince,
} from './seedRunSweep';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/**
 * An org answering `SELECT Id, CreatedDate FROM <Object> WHERE Id IN (…)`
 * through its recycle bin too: each record's date by id.
 */
function orgDating(dates: Record<string, string>) {
  const statements: string[] = [];
  const queryDeleted = vi.fn(async (soql: string) => {
    statements.push(soql);
    const list = /WHERE Id IN \((.*)\)$/.exec(soql)?.[1] ?? '';
    const ids = list.split(', ').map((quoted) => quoted.slice(1, -1));
    return {
      records: ids
        .filter((id) => dates[id] !== undefined)
        .map((id) => ({ Id: id, CreatedDate: dates[id] })),
    };
  });
  return { org: { queryDeleted }, statements };
}

describe('seedWrittenBetween', () => {
  it('dates the run from the earliest to the latest insert of its records, in every object', async () => {
    const { org, statements } = orgDating({
      [fakeId('001', 1)]: '2026-10-18T09:00:05.000+0000',
      [fakeId('003', 1)]: '2026-10-18T09:00:09.000+0000',
      [fakeId('003', 2)]: '2026-10-18T09:00:07.000+0000',
    });

    const written = await seedWrittenBetween(org, [
      { objectApiName: 'Account', ids: [fakeId('001', 1)] },
      { objectApiName: 'Contact', ids: [fakeId('003', 1), fakeId('003', 2)] },
    ]);

    expect(written).toEqual({
      first: '2026-10-18T09:00:05.000Z',
      last: '2026-10-18T09:00:09.000Z',
    });
    expect(statements[0]).toBe(
      `SELECT Id, CreatedDate FROM Account WHERE Id IN ('${fakeId('001', 1)}')`,
    );
  });

  it('reads two hundred records a statement', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => fakeId('003', i + 1));
    const { org, statements } = orgDating(
      Object.fromEntries(ids.map((id) => [id, '2026-10-18T09:00:00.000+0000'])),
    );

    await seedWrittenBetween(org, [{ objectApiName: 'Contact', ids }]);

    expect(statements).toHaveLength(3);
  });

  it('dates nothing when none of the records could be read, and the sweep then sweeps nothing', async () => {
    const { org } = orgDating({});

    expect(
      await seedWrittenBetween(org, [{ objectApiName: 'Contact', ids: [fakeId('003', 1)] }]),
    ).toBeUndefined();
  });

  it('refuses an object name that is not one, before anything is read', async () => {
    const { org, statements } = orgDating({});

    await expect(
      seedWrittenBetween(org, [{ objectApiName: 'Contact WHERE', ids: [fakeId('003', 1)] }]),
    ).rejects.toThrow(/Invalid Salesforce API name/);
    expect(statements).toEqual([]);
  });
});

describe('seedSweepInput', () => {
  it('never sweeps a record the run created, and looks where the target’s flows create', async () => {
    const { org } = orgDating({ [fakeId('003', 1)]: '2026-10-18T09:00:00.000+0000' });
    const automation = {
      objectsRead: ['Contact'],
      objects: [
        {
          objectApiName: 'Contact',
          flows: [
            {
              apiName: 'Welcome',
              label: 'Welcome',
              timing: 'afterSave',
              startsOn: 'create',
              condition: 'read',
              permissions: [],
              creates: ['Task'],
            },
          ],
          triggers: [],
        },
      ],
      unread: [],
    } as unknown as ForgeTargetAutomation;

    const input = await seedSweepInput(
      org,
      [{ objectApiName: 'Contact', ids: [fakeId('003', 1)] }],
      automation,
    );

    expect(input.writtenBetween).toEqual({
      first: '2026-10-18T09:00:00.000Z',
      last: '2026-10-18T09:00:00.000Z',
    });
    expect(input.remap.has(fakeId('003', 1).slice(0, 15))).toBe(true);
    expect(input.automation).toEqual({ creates: ['Task'] });
  });
});

describe('writtenSince', () => {
  /** The run's records, as the target dated them: from 10:02 to 10:03. */
  const WRITTEN = { first: '2026-09-20T10:02:00.000Z', last: '2026-09-20T10:03:00.000Z' };
  /** This machine's clock now, five minutes behind the org's. */
  const now = () => new Date('2026-10-01T08:00:00.000Z');
  const orgClock = async () => '2026-10-01T08:05:00.000Z';

  it('begins the window at the run’s first write, moved onto the org’s clock', async () => {
    // An update at 09:55 by this machine's clock is 10:00 by the org's: what
    // the target's automation did on it was left out of a window that began
    // at the first record the run created.
    expect(
      await writtenSince(WRITTEN, { at: '2026-09-20T09:55:00.000Z', serverTime: orgClock, now }),
    ).toEqual({ first: '2026-09-20T10:00:00.000Z', last: WRITTEN.last });
  });

  it('ends the window at the run’s last write when it came after its last record, moved onto the org’s clock', async () => {
    // The run updated accounts until 10:09 by this machine's clock, 10:14 by
    // the org's, after the last record it created: the tasks the target's
    // flows opened on them were outside a window that closed at 10:04.
    expect(
      await writtenSince(WRITTEN, {
        at: '2026-09-20T09:58:00.000Z',
        lastAt: '2026-09-20T10:09:00.000Z',
        serverTime: orgClock,
        now,
      }),
    ).toEqual({ first: WRITTEN.first, last: '2026-09-20T10:14:00.000Z' });
    // A last write before the last record the org dated leaves it.
    expect(
      await writtenSince(WRITTEN, {
        at: '2026-09-20T09:58:00.000Z',
        lastAt: '2026-09-20T09:57:30.000Z',
        serverTime: orgClock,
        now,
      }),
    ).toEqual(WRITTEN);
  });

  it('keeps the window of a run whose first write is its first creation', async () => {
    expect(
      await writtenSince(WRITTEN, { at: '2026-09-20T09:58:00.000Z', serverTime: orgClock, now }),
    ).toEqual(WRITTEN);
  });

  it('keeps the window as its records date it when the org’s clock cannot be read', async () => {
    const unread = async (): Promise<string> => {
      throw new Error('INVALID_SESSION_ID');
    };

    expect(
      await writtenSince(WRITTEN, { at: '2026-09-20T09:00:00.000Z', serverTime: unread, now }),
    ).toEqual(WRITTEN);
    expect(
      await writtenSince(WRITTEN, {
        at: '2026-09-20T09:00:00.000Z',
        serverTime: async () => 'not a date',
        now,
      }),
    ).toEqual(WRITTEN);
  });

  it('dates nothing for a run whose records could not be read, nor for a first write that is no date', async () => {
    expect(
      await writtenSince(undefined, { at: '2026-09-20T09:55:00.000Z', serverTime: orgClock, now }),
    ).toBeUndefined();
    expect(await writtenSince(WRITTEN, { at: 'soon', serverTime: orgClock, now })).toEqual(WRITTEN);
    expect(await writtenSince(WRITTEN, undefined)).toEqual(WRITTEN);
  });

  it('dates a run that created nothing by its writes alone, moved onto the org’s clock', async () => {
    // An upsert that matched every row: no record of the run dates a window.
    expect(
      await writesWindow({
        at: '2026-09-20T09:55:00.000Z',
        lastAt: '2026-09-20T09:57:00.000Z',
        serverTime: orgClock,
        now,
      }),
    ).toEqual({ first: '2026-09-20T10:00:00.000Z', last: '2026-09-20T10:02:00.000Z' });
    // One dated line: the window is that write.
    expect(
      await writesWindow({ at: '2026-09-20T09:55:00.000Z', serverTime: orgClock, now }),
    ).toEqual({ first: '2026-09-20T10:00:00.000Z', last: '2026-09-20T10:00:00.000Z' });
  });

  it('dates no run that created nothing whose writes are not dated, or whose org’s clock cannot be read', async () => {
    const unread = async (): Promise<string> => {
      throw new Error('INVALID_SESSION_ID');
    };

    expect(await writesWindow(undefined)).toBeUndefined();
    expect(await writesWindow({ at: 'soon', serverTime: orgClock, now })).toBeUndefined();
    expect(
      await writesWindow({ at: '2026-09-20T09:55:00.000Z', serverTime: unread, now }),
    ).toBeUndefined();
  });

  it('hands the sweep the window from the first write to the last', async () => {
    const { org } = orgDating({ [fakeId('003', 1)]: '2026-09-20T10:02:00.000+0000' });

    const input = await seedSweepInput(
      org,
      [{ objectApiName: 'Contact', ids: [fakeId('003', 1)] }],
      { objectsRead: [], objects: [], unread: [] } as unknown as ForgeTargetAutomation,
      undefined,
      {
        at: '2026-09-20T09:55:00.000Z',
        lastAt: '2026-09-20T10:01:00.000Z',
        serverTime: orgClock,
        now,
      },
    );

    expect(input.writtenBetween).toEqual({
      first: '2026-09-20T10:00:00.000Z',
      last: '2026-09-20T10:06:00.000Z',
    });
  });
});

describe('a Sync run that created nothing and only wrote over records', () => {
  /** Its writes, as the org dated them: 10:00 to 10:02. */
  const WRITTEN = { first: '2026-09-20T10:00:00.000Z', last: '2026-09-20T10:02:00.000Z' };
  const USER = fakeId('005', 1);
  const COLLEAGUE = fakeId('005', 2);

  /** An org answering who last modified each record, and when. */
  function orgModified(rows: Record<string, { by: string; at: string }>) {
    const statements: string[] = [];
    const query = vi.fn(async (soql: string) => {
      statements.push(soql);
      const list = /WHERE Id IN \((.*)\)$/.exec(soql)?.[1] ?? '';
      const records = list
        .split(', ')
        .map((quoted) => quoted.slice(1, -1))
        .filter((id) => rows[id] !== undefined)
        .map((id) => ({ Id: id, LastModifiedById: rows[id].by, LastModifiedDate: rows[id].at }));
      return { totalSize: records.length, records };
    });
    return { org: { query, queryDeleted: vi.fn(async () => ({ records: [] })) }, statements };
  }

  it('reads the user it wrote as from who last modified, in its window, the records it wrote over', async () => {
    const { org, statements } = orgModified({
      [fakeId('001', 1)]: { by: USER, at: '2026-09-20T10:01:00.000+0000' },
      // Put back by a removal since: out of the window, it tells nothing.
      [fakeId('001', 2)]: { by: COLLEAGUE, at: '2026-10-01T08:00:00.000+0000' },
    });

    const user = await writerOf(
      org,
      [{ objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] }],
      WRITTEN,
    );

    expect(user).toBe(USER);
    expect(statements).toEqual([
      `SELECT Id, LastModifiedById, LastModifiedDate FROM Account WHERE Id IN ('${fakeId('001', 1)}', '${fakeId('001', 2)}')`,
    ]);
  });

  it('tells no user when two wrote in the window, or none did', async () => {
    const two = orgModified({
      [fakeId('001', 1)]: { by: USER, at: '2026-09-20T10:01:00.000+0000' },
      [fakeId('001', 2)]: { by: COLLEAGUE, at: '2026-09-20T10:01:30.000+0000' },
    });
    const none = orgModified({
      [fakeId('001', 1)]: { by: USER, at: '2026-10-01T08:00:00.000+0000' },
    });
    const over = [{ objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] }];

    expect(await writerOf(two.org, over, WRITTEN)).toBeUndefined();
    expect(await writerOf(none.org, over, WRITTEN)).toBeUndefined();
  });

  it('takes the minute after its last write into the window, as the sweep does', async () => {
    const { org } = orgModified({
      [fakeId('001', 1)]: { by: USER, at: '2026-09-20T10:02:50.000+0000' },
    });

    expect(
      await writerOf(org, [{ objectApiName: 'Account', ids: [fakeId('001', 1)] }], WRITTEN),
    ).toBe(USER);
  });

  it('hands the sweep its window from its writes, its user, and the records it wrote over never to sweep', async () => {
    const { org } = orgModified({
      [fakeId('001', 1)]: { by: USER, at: '2026-09-20T10:01:00.000+0000' },
    });

    const input = await seedSweepInput(
      org,
      [],
      { objectsRead: [], objects: [], unread: [] } as unknown as ForgeTargetAutomation,
      undefined,
      {
        at: WRITTEN.first,
        lastAt: WRITTEN.last,
        serverTime: async () => '2026-10-01T08:00:00.000Z',
        now: () => new Date('2026-10-01T08:00:00.000Z'),
      },
      [{ objectApiName: 'Account', ids: [fakeId('001', 1)] }],
    );

    expect(input.writtenBetween).toEqual(WRITTEN);
    expect(input.user).toBe(USER);
    expect(input.remap.has(fakeId('001', 1).slice(0, 15))).toBe(true);
  });

  it('reads no user from the records it wrote over when it created some: those tell it', async () => {
    const { org } = orgModified({
      [fakeId('001', 1)]: { by: USER, at: '2026-09-20T10:01:00.000+0000' },
    });
    const dated = {
      ...org,
      queryDeleted: vi.fn(async () => ({
        records: [{ Id: fakeId('003', 1), CreatedDate: '2026-09-20T10:01:00.000+0000' }],
      })),
    };

    const input = await seedSweepInput(
      dated,
      [{ objectApiName: 'Contact', ids: [fakeId('003', 1)] }],
      { objectsRead: [], objects: [], unread: [] } as unknown as ForgeTargetAutomation,
      undefined,
      undefined,
      [{ objectApiName: 'Account', ids: [fakeId('001', 1)] }],
    );

    expect(input.user).toBeUndefined();
    expect(org.query).not.toHaveBeenCalled();
  });
});
