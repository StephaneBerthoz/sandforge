import { describe, it, expect } from 'vitest';
import { placeholderId, type RehearsedRow } from './RehearsalWriter.js';
import {
  EVERY_ROW_UP_TO,
  ancestorsOf,
  familyOf,
  sampleOf,
  shapeOf,
  withTheirParents,
} from './rehearsalSample.js';

/** A row the run would create, with the placeholder id a writer gives it. */
function row(seq: number, objectApiName: string, fields: Record<string, unknown>): RehearsedRow {
  return { seq, objectApiName, fields, placeholderId: placeholderId('001', seq) };
}

/** The row a value stands for, among `rows`. */
const rowOfIn =
  (rows: readonly RehearsedRow[]) =>
  (value: unknown): RehearsedRow | undefined =>
    rows.find((r) => r.placeholderId === value);

describe('the shape a row is judged as', () => {
  it('is the object, the record type and the fields given a value', () => {
    expect(shapeOf(row(0, 'Account', { Name: 'A', RecordTypeId: '012A', Phone: null }))).toBe(
      'Account|012A|Name,RecordTypeId',
    );
  });

  it('is the same for two rows that differ only in their values', () => {
    expect(shapeOf(row(0, 'Contact', { LastName: 'A', Email: 'x' }))).toBe(
      shapeOf(row(1, 'Contact', { Email: 'y', LastName: 'B' })),
    );
  });

  it('differs with the record type, and with a field left empty', () => {
    const base = shapeOf(row(0, 'Case', { Subject: 'A', RecordTypeId: '012A' }));
    expect(shapeOf(row(1, 'Case', { Subject: 'A', RecordTypeId: '012B' }))).not.toBe(base);
    expect(shapeOf(row(2, 'Case', { Subject: '', RecordTypeId: '012A' }))).not.toBe(base);
  });
});

describe('the sample a rehearsal judges', () => {
  it('is every row when the run creates 200 or fewer', () => {
    const rows = Array.from({ length: EVERY_ROW_UP_TO }, (_, i) =>
      row(i, 'Account', { Name: 'A' }),
    );
    const sample = sampleOf(rows);
    expect(sample.rows).toHaveLength(EVERY_ROW_UP_TO);
    expect([...sample.standsFor.values()].every((n) => n === 1)).toBe(true);
  });

  it('is the first row of each shape past 200, each standing for the rows of its shape', () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      row(i, 'Contact', i % 50 === 0 ? { LastName: 'x', Email: 'y' } : { LastName: 'x' }),
    );
    const sample = sampleOf(rows);
    expect(sample.rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(sample.standsFor.get(0)).toBe(5);
    expect(sample.standsFor.get(1)).toBe(245);
  });
});

describe('how the rows name one another', () => {
  const account = row(0, 'Account', { Name: 'A' });
  const contact = row(1, 'Contact', { LastName: 'C', AccountId: account.placeholderId });
  const opportunity = row(2, 'Opportunity', { AccountId: account.placeholderId });
  const role = row(3, 'OpportunityContactRole', {
    OpportunityId: opportunity.placeholderId,
    ContactId: contact.placeholderId,
  });
  const rows = [account, contact, opportunity, role];
  const family = familyOf(rows, rowOfIn(rows));

  it('gives each row the rows its lookups name', () => {
    expect(family.parents.get(0)).toEqual([]);
    expect(family.parents.get(1)).toEqual([0]);
    expect(family.parents.get(3)).toEqual([1, 2]);
  });

  it('puts a row one level past its furthest parent', () => {
    expect([0, 1, 2, 3].map((seq) => family.levels.get(seq))).toEqual([0, 1, 1, 2]);
  });

  it('reads a real id as naming no row of the run', () => {
    const owned = row(4, 'Case', {
      OwnerId: '005000000000001AAA',
      AccountId: '001000000000009AAA',
    });
    expect(familyOf([owned], rowOfIn([owned])).parents.get(4)).toEqual([]);
  });

  it('walks every row a row needs, each once', () => {
    expect(ancestorsOf(3, family).sort()).toEqual([0, 1, 2]);
    expect(ancestorsOf(0, family)).toEqual([]);
  });

  it('adds to the sample the rows its rows name, in the order the run creates them', () => {
    expect(withTheirParents([role], family).map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(withTheirParents([account], family).map((r) => r.seq)).toEqual([0]);
  });
});
