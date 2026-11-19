import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RewindDiffObject } from '@sandforge/shared';

import { MemoryRemovalOrg } from '../../test/memoryRemovalOrg.js';
import { runRecordsOf } from '../forge/ForgeRunRemoval.js';
import { classFileOf } from './rewindDiff.js';
import {
  confirmedDuplicateSets,
  DUPLICATE_SET_OBJECT,
  nameDuplicateSets,
  rewindDuplicateSets,
  setsLeftOf,
  setsNamed,
  withDuplicateSets,
} from './rewindDuplicateSets.js';

const ITEM = 'DuplicateRecordItem';
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const contact = (n: number): string => id('003', n);
const set = (n: number): string => id('0GK', n);
const item = (n: number): string => id('0GL', n);

/** The checkpoint's end, with its milliseconds, and the read the rewind acts on. */
const TAKEN_AT = '2026-11-17T09:45:19.412Z';
const READ_AT = '2026-11-17T10:02:00.000Z';
const SPAN = { takenAt: TAKEN_AT, readAt: READ_AT };

/** A set made at `at`, its items naming `named`. */
function setOf(org: MemoryRemovalOrg, n: number, at: string, named: readonly string[]): void {
  org.add(DUPLICATE_SET_OBJECT, { Id: set(n) }, at);
  named.forEach((record, place) => {
    org.add(ITEM, { Id: item(n * 10 + place), RecordId: record, DuplicateRecordSetId: set(n) }, at);
  });
}

const deleting = (...ids: string[]) => ({
  has: (key: string) => ids.some((one) => one.slice(0, 15) === key),
});

describe('rewindDuplicateSets', () => {
  it('reads the sets made from the second after the checkpoint’s end: one made in its second may have been there', async () => {
    const org = new MemoryRemovalOrg();
    setOf(org, 1, '2026-11-17T09:45:19.000Z', [contact(1), contact(2)]);
    setOf(org, 2, '2026-11-17T09:45:20.000Z', [contact(1), contact(2)]);

    const sets = await rewindDuplicateSets(org, deleting(contact(1), contact(2)), SPAN);

    expect(sets.map((read) => read.id)).toEqual([set(2)]);
  });

  it('takes a set naming one record that stays beside them, and leaves one naming two', async () => {
    const org = new MemoryRemovalOrg();
    const at = '2026-11-17T09:50:00.000Z';
    setOf(org, 1, at, [contact(1), contact(8)]);
    setOf(org, 2, at, [contact(2), contact(8), contact(9)]);

    const sets = await rewindDuplicateSets(org, deleting(contact(1), contact(2)), SPAN);

    expect(sets.map((read) => ({ id: read.id, names: read.names }))).toEqual([
      { id: set(1), names: [contact(1).slice(0, 15)] },
    ]);
  });

  it('leaves a set that holds no item any more: nothing tells it the rewind’s', async () => {
    const org = new MemoryRemovalOrg();
    org.add(DUPLICATE_SET_OBJECT, { Id: set(1) }, '2026-11-17T09:50:00.000Z');

    expect(await rewindDuplicateSets(org, deleting(contact(1)), SPAN)).toEqual([]);
  });

  it('reads none of an org that will not say, and none for dates it cannot read', async () => {
    const refusing = {
      query: () => Promise.reject(new Error("sObject type 'DuplicateRecordSet' is not supported.")),
    };

    expect(await rewindDuplicateSets(refusing, deleting(contact(1)), SPAN)).toEqual([]);
    expect(
      await rewindDuplicateSets(new MemoryRemovalOrg(), deleting(contact(1)), {
        takenAt: 'not a date',
        readAt: READ_AT,
      }),
    ).toEqual([]);
  });
});

describe('nameDuplicateSets', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rewind-sets-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A diff object whose records to delete created since are `ids`, spooled as the diff spools them. */
  function toDelete(objectApiName: string, ids: readonly string[]): RewindDiffObject {
    writeFileSync(
      classFileOf(dir, objectApiName, 'createdSince'),
      ids.map((one) => `${JSON.stringify({ Id: one })}\n`).join(''),
    );
    return {
      objectApiName,
      toDelete: { createdSince: ids.length, broughtBackSince: 0, comesBackWithParent: 0 },
      toGiveBack: { records: 0, fields: 0, clearedLookups: 0 },
      toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0 },
      cannotUndo: [],
      outside: [{ objectApiName: ITEM, count: 2, parents: 2 }],
      touched: 0,
      unexplained: 0,
      lastChangedBy: {},
      notCompared: [],
    };
  }

  it('names the sets under the records they report, and keeps their ids for the rewind alone', async () => {
    const org = new MemoryRemovalOrg();
    setOf(org, 1, '2026-11-17T09:50:00.000Z', [contact(1), contact(2)]);
    const contacts = toDelete('Contact', [contact(1), contact(2), contact(3)]);
    const diff = { objects: [contacts], readAt: READ_AT };

    expect(await confirmedDuplicateSets(dir)).toEqual(new Set());
    expect(await nameDuplicateSets(org, diff, dir, TAKEN_AT)).toBe(1);

    expect(contacts.outside).toEqual([
      { objectApiName: ITEM, count: 2, parents: 2 },
      { objectApiName: DUPLICATE_SET_OBJECT, count: 1, parents: 2 },
    ]);
    expect(setsNamed(diff)).toBe(1);
    expect(await confirmedDuplicateSets(dir)).toEqual(new Set([set(1).slice(0, 15)]));
    expect(statSync(join(dir, 'duplicate-record-sets.ids')).mode & 0o777).toBe(0o600);
  });

  it('reads nothing of an org when nothing is to be deleted, or no item of a set hangs from it, and keeps no list', async () => {
    const queries: string[] = [];
    const org = {
      query: (soql: string) => {
        queries.push(soql);
        return Promise.resolve({ records: [] });
      },
    };
    const none = { objects: [toDelete('Contact', [])], readAt: READ_AT };
    const noItem = {
      objects: [{ ...toDelete('Account', [id('001', 1)]), outside: [] }],
      readAt: READ_AT,
    };

    expect(await nameDuplicateSets(org, none, dir, TAKEN_AT)).toBe(0);
    expect(await nameDuplicateSets(org, noItem, dir, TAKEN_AT)).toBe(0);
    expect(queries).toEqual([]);
    expect(setsNamed(none) + setsNamed(noItem)).toBe(0);
    expect(await confirmedDuplicateSets(dir)).toEqual(new Set());
  });
});

describe('setsLeftOf', () => {
  it('finds the sets still in the org by their keys, each with the items it still holds', async () => {
    const org = new MemoryRemovalOrg();
    const at = '2026-11-17T09:50:00.000Z';
    setOf(org, 1, at, [contact(1), contact(2)]);
    setOf(org, 2, at, []);

    const left = await setsLeftOf(
      org,
      [set(1), set(2), set(3)].map((one) => one.slice(0, 15)),
    );

    expect(left.sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual([
      { id: set(1), items: 2 },
      { id: set(2), items: 0 },
    ]);
  });
});

describe('withDuplicateSets', () => {
  it('hands the sets to the removal before the records they report, which it deletes first', async () => {
    const records = runRecordsOf([{ objectApiName: 'Contact', ids: [contact(1)] }]);

    const handed = withDuplicateSets(records, [set(1)]);

    expect(handed.objects).toEqual([
      { objectApiName: DUPLICATE_SET_OBJECT, count: 1 },
      { objectApiName: 'Contact', count: 1 },
    ]);
    const pages: string[][] = [];
    for await (const page of handed.pages(DUPLICATE_SET_OBJECT)) pages.push([...page]);
    expect(pages).toEqual([[set(1)]]);
    expect(handed.has(set(1).slice(0, 15))).toBe(true);
    expect(handed.has(contact(1).slice(0, 15))).toBe(true);
    expect(withDuplicateSets(records, [])).toBe(records);
  });
});
