import { describe, expect, it, vi } from 'vitest';
import type { ForgeTargetAutomation } from '@sandforge/shared';

import { seedSweepInput, seedWrittenBetween, writtenSince } from './seedRunSweep';

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

  it('hands the sweep the window from the first write', async () => {
    const { org } = orgDating({ [fakeId('003', 1)]: '2026-09-20T10:02:00.000+0000' });

    const input = await seedSweepInput(
      org,
      [{ objectApiName: 'Contact', ids: [fakeId('003', 1)] }],
      { objectsRead: [], objects: [], unread: [] } as unknown as ForgeTargetAutomation,
      undefined,
      { at: '2026-09-20T09:55:00.000Z', serverTime: orgClock, now },
    );

    expect(input.writtenBetween).toEqual({
      first: '2026-09-20T10:00:00.000Z',
      last: '2026-09-20T10:02:00.000Z',
    });
  });
});
