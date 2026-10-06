import { describe, expect, it } from 'vitest';

import type { ForgeExecutionResult } from '../types/forge.types.js';
import {
  forgeRemovalPlanLeft,
  forgeRemovalPlanOf,
  forgeRunCreatedRecords,
  forgeRunLinkedKept,
  forgeRunRecordsLeft,
  removalTookAll,
} from './forge-run-records.js';

/** A source id and the target id the run gave it: `<prefix>` then a counter. */
const src = (prefix: string, n: number): string => `${prefix}00000000000${n}AAA`;
const tgt = (prefix: string, n: number): string => `${prefix}99999999999${n}AAA`;

type Entry = Pick<ForgeExecutionResult, 'idRemapTable' | 'idRemapExisting' | 'idRemapCreated'>;

/** A run that wrote two accounts, then three contacts under them. */
function accountsThenContacts(): Entry {
  return {
    idRemapTable: {
      [src('001', 1)]: tgt('001', 1),
      [src('001', 2)]: tgt('001', 2),
      [src('003', 1)]: tgt('003', 1),
      [src('003', 2)]: tgt('003', 2),
      [src('003', 3)]: tgt('003', 3),
    },
    idRemapExisting: [],
    idRemapCreated: [
      { objectApiName: 'Account', sourceIds: [src('001', 1), src('001', 2)] },
      { objectApiName: 'Contact', sourceIds: [src('003', 1), src('003', 2), src('003', 3)] },
    ],
  };
}

describe('forgeRunCreatedRecords', () => {
  it('takes the children before their parents, the reverse of the order the run wrote them', () => {
    expect(forgeRunCreatedRecords(accountsThenContacts())).toEqual([
      { objectApiName: 'Contact', ids: [tgt('003', 3), tgt('003', 2), tgt('003', 1)] },
      { objectApiName: 'Account', ids: [tgt('001', 2), tgt('001', 1)] },
    ]);
  });

  it('leaves out a row linked to a record the target already held', () => {
    const entry = accountsThenContacts();
    // The second account was refused as a duplicate and linked to the target's own.
    entry.idRemapTable = { ...entry.idRemapTable, [src('001', 2)]: tgt('001', 8) };
    entry.idRemapExisting = [src('001', 2)];

    const accounts = forgeRunCreatedRecords(entry).find((o) => o.objectApiName === 'Account');

    expect(accounts?.ids).toEqual([tgt('001', 1)]);
  });

  it('leaves out a record a linked row points at, even one another row wrote', () => {
    const entry = accountsThenContacts();
    // A second source contact was refused as a copy of the first and linked to it.
    entry.idRemapTable = { ...entry.idRemapTable, [src('003', 4)]: tgt('003', 1) };
    entry.idRemapExisting = [src('003', 4)];

    const contacts = forgeRunCreatedRecords(entry).find((o) => o.objectApiName === 'Contact');

    expect(contacts?.ids).toEqual([tgt('003', 3), tgt('003', 2)]);
  });

  it('leaves out what the table maps without the run having created it', () => {
    // The standard price book and reference data matched by name are in the
    // table so their children point at the right rows; no object names them.
    const entry = accountsThenContacts();
    entry.idRemapTable = {
      ...entry.idRemapTable,
      [src('01s', 1)]: tgt('01s', 1),
      [src('01m', 1)]: tgt('01m', 1),
    };

    const ids = forgeRunCreatedRecords(entry).flatMap((o) => o.ids);

    expect(ids).toHaveLength(5);
    expect(ids).not.toContain(tgt('01s', 1));
    expect(ids).not.toContain(tgt('01m', 1));
  });

  it('names a record once, whichever length its id was written in', () => {
    const entry = accountsThenContacts();
    entry.idRemapTable = { ...entry.idRemapTable, [src('003', 3)]: tgt('003', 2).slice(0, 15) };

    const contacts = forgeRunCreatedRecords(entry).find((o) => o.objectApiName === 'Contact');

    expect(contacts?.ids).toEqual([tgt('003', 2).slice(0, 15), tgt('003', 1)]);
  });

  it('skips a target that is not a record id and an object no query could name', () => {
    const entry: Entry = {
      idRemapTable: { [src('001', 1)]: 'not an id', [src('a00', 1)]: tgt('a00', 1) },
      idRemapExisting: [],
      idRemapCreated: [
        { objectApiName: 'Account', sourceIds: [src('001', 1)] },
        { objectApiName: 'Bad Name; DELETE', sourceIds: [src('a00', 1)] },
      ],
    };

    expect(forgeRunCreatedRecords(entry)).toEqual([]);
  });

  it('has nothing to remove for a run recorded before runs kept what they created', () => {
    const entry = accountsThenContacts();
    delete entry.idRemapCreated;

    expect(forgeRunCreatedRecords(entry)).toEqual([]);
    expect(forgeRunCreatedRecords({})).toEqual([]);
  });
});

/** What a removal leaves on the entry: when it ended, and how many went each way. */
const mark = (kept: number, refused = 0) => ({
  removedAt: '2026-09-29T15:51:27.295Z',
  deleted: 3,
  alreadyGone: 0,
  kept,
  refused,
});

describe('forgeRunLinkedKept', () => {
  it('leaves out of what a removal keeps the records the platform wrote with one the run created', () => {
    // Deleted by the platform with their record — a person account's contact,
    // a contact's direct relation, an email's task: counted as kept, the
    // confirmation said they stayed in the org.
    expect(
      forgeRunLinkedKept({
        idRemapExisting: [
          src('001', 2),
          src('003', 1),
          src('003', 2),
          src('07k', 1),
          src('00T', 1),
        ],
        idRemapWithTheirRecord: [src('003', 1), src('07k', 1), src('00T', 1)],
      }),
    ).toEqual([src('001', 2), src('003', 2)]);
  });

  it('keeps every linked record of an entry recorded before it said which go with their record', () => {
    expect(forgeRunLinkedKept({ idRemapExisting: [src('001', 2)] })).toEqual([src('001', 2)]);
    expect(forgeRunLinkedKept({})).toEqual([]);
  });
});

describe('removalTookAll', () => {
  it('says the removals are through once the last one left none of the records in the org', () => {
    expect(removalTookAll(mark(0))).toBe(true);
  });

  it('says there is more to take while the last one kept some, or had some refused', () => {
    expect(removalTookAll(mark(2))).toBe(false);
    expect(removalTookAll(mark(0, 1))).toBe(false);
  });

  it('says there is more to take after a removal cancelled before it reached them all', () => {
    // It deleted three, kept none, had none refused: the rest it never reached.
    expect(removalTookAll({ ...mark(0), notReached: 2 })).toBe(false);
    // Cancelled once it had reached them all, it left none in the org.
    expect(removalTookAll({ ...mark(0), notReached: 0 })).toBe(true);
  });

  it('says nothing was taken before a removal marked the run', () => {
    expect(removalTookAll(undefined)).toBe(false);
  });

  it('says there is more to take while the last one could not see some of the records', () => {
    expect(removalTookAll({ ...mark(0), notVisible: 1 })).toBe(false);
  });
});

describe('forgeRemovalPlanOf', () => {
  /** A finished run of accounts and contacts, as the history keeps it. */
  function historyEntry(overrides: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult {
    return {
      ...accountsThenContacts(),
      forgeId: 'forge-7',
      status: 'success',
      graph: {
        nodes: [],
        edges: [],
        totalRecords: 0,
        estimatedSizeMB: 0,
        estimatedDurationSeconds: 0,
      },
      duration: 4_000,
      timestamp: '2026-09-20T10:05:00.000Z',
      idRemapCount: 5,
      targetOrgId: 'org-target',
      ...overrides,
    };
  }

  it('keeps the target ids of what the run created, in the order a removal takes them', () => {
    const plan = forgeRemovalPlanOf(historyEntry());

    expect(plan).toEqual({
      forgeId: 'forge-7',
      targetOrgId: 'org-target',
      timestamp: '2026-09-20T10:05:00.000Z',
      duration: 4_000,
      status: 'success',
      objects: forgeRunCreatedRecords(accountsThenContacts()),
      linked: 0,
    });
  });

  it('keeps nothing but ids, dates and counts of the run', () => {
    const plan = forgeRemovalPlanOf(
      historyEntry({
        config: {
          inputMode: 'record',
          recordId: src('001', 1).slice(0, 15),
          depth: 'direct',
          anonymizePII: false,
          skipEmpty: true,
          batchSize: 'auto',
        },
        readByObject: [{ objectApiName: 'Contact', read: 3 }],
      }),
    );

    expect(Object.keys(plan ?? {}).sort()).toEqual(
      ['duration', 'forgeId', 'linked', 'objects', 'status', 'targetOrgId', 'timestamp'].sort(),
    );
  });

  it('carries what the removals of the run left, and the rows out of reach, as counts', () => {
    const plan = forgeRemovalPlanOf(
      historyEntry({
        cancelled: true,
        undo: { ...mark(1), removedAt: '2026-09-21T09:00:00.000Z' },
        removalLeft: [tgt('003', 3)],
        mayHaveBeenWritten: [
          { objectApiName: 'Contact', sourceIds: [src('003', 7), src('003', 8)] },
        ],
      }),
    );

    expect(plan?.cancelled).toBe(true);
    expect(plan?.mayHaveBeenWritten).toBe(2);
    expect(plan && forgeRemovalPlanLeft(plan)).toEqual([
      { objectApiName: 'Contact', ids: [tgt('003', 3)] },
    ]);
  });

  it('keeps no plan of a run that created nothing, or names no org', () => {
    expect(forgeRemovalPlanOf(historyEntry({ idRemapCreated: [] }))).toBeUndefined();
    expect(forgeRemovalPlanOf(historyEntry({ targetOrgId: undefined }))).toBeUndefined();
    expect(forgeRemovalPlanOf(historyEntry({ idRemapCreated: undefined }))).toBeUndefined();
  });
});

describe('forgeRemovalPlanLeft', () => {
  const objects = forgeRunCreatedRecords(accountsThenContacts());

  it('takes what the plan names while no removal took any of it', () => {
    expect(forgeRemovalPlanLeft({ objects })).toEqual(objects);
  });

  it('takes nothing once a removal left none of the records in the org', () => {
    expect(forgeRemovalPlanLeft({ objects, undo: mark(0), removalLeft: [] })).toEqual([]);
  });

  it('takes what a removal could not see, which it left', () => {
    expect(
      forgeRemovalPlanLeft({
        objects,
        undo: { ...mark(0), notVisible: 1 },
        removalLeft: [tgt('001', 2)],
      }),
    ).toEqual([{ objectApiName: 'Account', ids: [tgt('001', 2)] }]);
  });
});

describe('forgeRunRecordsLeft', () => {
  it('takes what the run created while no removal took any of it', () => {
    expect(forgeRunRecordsLeft(accountsThenContacts())).toEqual(
      forgeRunCreatedRecords(accountsThenContacts()),
    );
  });

  it('takes what the removals left, in the order of the whole, once one left some', () => {
    const entry = {
      ...accountsThenContacts(),
      undo: mark(3),
      // A contact kept for a change since, and the account it hangs from: the
      // 18-letter ids as the plan names them, or their first fifteen.
      removalLeft: [tgt('001', 1), tgt('003', 2).slice(0, 15)],
    };

    expect(forgeRunRecordsLeft(entry)).toEqual([
      { objectApiName: 'Contact', ids: [tgt('003', 2)] },
      { objectApiName: 'Account', ids: [tgt('001', 1)] },
    ]);
  });

  it('takes what a cancelled removal did not reach, which it marked', () => {
    const entry = {
      ...accountsThenContacts(),
      undo: { ...mark(0), notReached: 2 },
      removalLeft: [tgt('001', 1), tgt('001', 2)],
    };

    expect(forgeRunRecordsLeft(entry)).toEqual([
      { objectApiName: 'Account', ids: [tgt('001', 2), tgt('001', 1)] },
    ]);
  });

  it('takes nothing once a removal left none of the records in the org', () => {
    expect(forgeRunRecordsLeft({ ...accountsThenContacts(), undo: mark(0) })).toEqual([]);
    // An entry marked before removals kept what they left: its mark says so.
    expect(
      forgeRunRecordsLeft({ ...accountsThenContacts(), undo: mark(0), removalLeft: [] }),
    ).toEqual([]);
  });

  it('takes what the run created from an entry marked before removals kept what they left', () => {
    // The removal finds the records that went gone, and takes the rest.
    expect(forgeRunRecordsLeft({ ...accountsThenContacts(), undo: mark(2) })).toEqual(
      forgeRunCreatedRecords(accountsThenContacts()),
    );
  });

  it('reads past what is not an id in what the removals left: the entry comes back from storage', () => {
    const entry = {
      ...accountsThenContacts(),
      undo: mark(1),
      removalLeft: [tgt('003', 3), 42 as unknown as string],
    };

    expect(forgeRunRecordsLeft(entry)).toEqual([
      { objectApiName: 'Contact', ids: [tgt('003', 3)] },
    ]);
  });
});
