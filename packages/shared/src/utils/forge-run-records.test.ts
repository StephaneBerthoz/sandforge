import { describe, expect, it } from 'vitest';

import type { ForgeExecutionResult } from '../types/forge.types.js';
import { forgeRunCreatedRecords } from './forge-run-records.js';

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
