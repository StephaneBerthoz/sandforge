import { describe, expect, it, vi } from 'vitest';
import type { ForgeTargetAutomation } from '@sandforge/shared';

import { seedSweepInput, seedWrittenBetween } from './seedRunSweep';

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
