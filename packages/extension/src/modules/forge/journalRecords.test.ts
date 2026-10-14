import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  forgeRunCreatedRecords,
  forgeRunRecordsLeft,
  idMapRows,
  type ForgeRunObjectRecords,
} from '@sandforge/shared';
import { ForgeRunJournal, type ForgeRunJournalDeps } from './ForgeRunJournal.js';
import type { RunRecords } from './ForgeRunRemoval.js';
import { memoryRunFile } from './ForgeRunStore.js';
import { HashedKeys, JournalPart } from './journalRecords.js';

/** A disk in memory: each file's text, by its path. */
function memoryDisk(): { deps: ForgeRunJournalDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  const deps: ForgeRunJournalDeps = {
    storagePath: '/storage',
    appendFile: async (filePath, content) => {
      files.set(filePath, (files.get(filePath) ?? '') + content);
    },
    readLines: (filePath) =>
      (async function* lines(): AsyncGenerator<string> {
        for (const line of (files.get(filePath) ?? '').split('\n')) yield line;
      })(),
    mkdir: async () => {},
    rm: async (filePath) => {
      files.delete(filePath);
    },
    listFiles: async (dirPath) =>
      [...files.keys()]
        .filter((filePath) => path.dirname(filePath) === dirPath)
        .map((filePath) => path.basename(filePath)),
    openRunFile: (filePath) => memoryRunFile(files.get(filePath) ?? ''),
  };
  return { deps, files };
}

/** The `n`-th source id of an object whose ids begin with `prefix`. */
const src = (prefix: string, n: number): string => `${prefix}S${String(n).padStart(11, '0')}AAA`;
/** The `n`-th target id of an object whose ids begin with `prefix`. */
const tgt = (prefix: string, n: number): string => `${prefix}T${String(n).padStart(11, '0')}AAA`;

const HEAD = {
  run: { journalId: 'j', targetOrgId: 'tgt-org', startedAt: '2026-10-14T08:00:00.000Z' },
};

/**
 * A journal of two parts, with what a journal can hold besides a record
 * created once: a source row linked to a record the run created, a record
 * named by two source rows, a row registered without its object, a row
 * registered again later in its part and in the next one.
 */
const LINES: unknown[] = [
  HEAD,
  { part: { n: 0, startedAt: '2026-10-14T08:00:00.000Z' } },
  ['c', src('001', 1), tgt('001', 1), 'Account'],
  ['c', src('001', 2), tgt('001', 2), 'Account'],
  ['c', src('003', 1), tgt('003', 1), 'Contact'],
  // Linked to the contact the run created: never the part's to remove.
  ['e', src('003', 9), tgt('003', 1), 'Contact'],
  ['c', src('00T', 1), tgt('00T', 1), ''],
  ['c', src('001', 3), tgt('001', 3), 'Account'],
  ['c', src('001', 3), tgt('001', 4), 'Account'],
  // Two rows the target answered with one record.
  ['c', src('003', 4), tgt('003', 4), 'Contact'],
  ['c', src('003', 5), tgt('003', 4), 'Contact'],
  ['i', src('001', 7)],
  { at: { object: 'Account', lastId: src('001', 3), read: 3 } },
  ['o', 'Account', tgt('001', 1), src('001', 1), 'ParentId', src('001', 2), 0],
  { part: { n: 1, startedAt: '2026-10-14T09:00:00.000Z' } },
  ['c', src('001', 5), tgt('001', 5), 'Account'],
  ['c', src('001', 1), tgt('001', 11), 'Account'],
  ['e', src('001', 2), tgt('001', 2), 'Account'],
  ['c', src('003', 6), tgt('003', 6), 'Contact'],
];

/** The journal's text, with the line of a window that closed mid-write at its end. */
const TEXT = `${LINES.map((line) => JSON.stringify(line)).join('\n')}\n["c","001S0000`;

/** What records hand over, each object's pages together. */
async function collected(records: RunRecords): Promise<ForgeRunObjectRecords[]> {
  const out: ForgeRunObjectRecords[] = [];
  for (const { objectApiName, count } of records.objects) {
    const ids: string[] = [];
    for await (const page of records.pages(objectApiName)) ids.push(...page);
    expect(ids).toHaveLength(count);
    out.push({ objectApiName, ids });
  }
  return out;
}

/** What the journal's whole read says of part `part`, as the readers of its ids take it. */
async function readWhole(part: number) {
  const { deps, files } = memoryDisk();
  const journal = new ForgeRunJournal(deps);
  files.set(journal.pathOf('j'), TEXT);
  const ids = await journal.idsOf('j', part);
  if (!ids) throw new Error('no journal');
  return {
    idRemapTable: ids.table,
    idRemapExisting: ids.existing,
    idRemapCreated: ids.createdByObject,
  };
}

describe('JournalPart', () => {
  it.each([0, 1])(
    'hands a removal of part %i the records the journal read whole gives it, in the same order',
    async (part) => {
      const whole = await readWhole(part);
      const paged = JournalPart.read(memoryRunFile(TEXT), part);
      if (!paged) throw new Error('not read');

      const records = paged.runRecords(undefined, 2);
      expect(await collected(records)).toEqual(forgeRunCreatedRecords(whole));
    },
  );

  it('tells the records it hands over, and no other', async () => {
    const paged = JournalPart.read(memoryRunFile(TEXT), 0);
    const records = paged?.runRecords();
    if (!records) throw new Error('not read');
    const handed = (await collected(records)).flatMap(({ ids }) => ids);
    for (const id of handed) expect(records.has(id.slice(0, 15))).toBe(true);
    // Linked to, a record of another part, one named without its object, one never written.
    for (const id of [tgt('003', 1), tgt('001', 5), tgt('00T', 1), tgt('001', 99)]) {
      expect(records.has(id.slice(0, 15))).toBe(false);
    }
  });

  it('hands over only what the removals of the part left, as the history entry takes it', async () => {
    const whole = await readWhole(0);
    const left = [tgt('001', 2), tgt('003', 4)];
    const keys = new HashedKeys();
    for (const id of left) keys.add(id.slice(0, 15));
    const records = JournalPart.read(memoryRunFile(TEXT), 0)?.runRecords(keys);
    if (!records) throw new Error('not read');

    expect(await collected(records)).toEqual(forgeRunRecordsLeft({ ...whole, removalLeft: left }));
    expect(records.has(tgt('001', 11).slice(0, 15))).toBe(false);
  });

  it.each([0, 1])(
    'gives the Id map of part %i the journal read whole gives, row for row',
    async (part) => {
      const whole = await readWhole(part);
      const paged = JournalPart.read(memoryRunFile(TEXT), part);
      expect([...(paged?.idMapRows() ?? [])]).toEqual(idMapRows(whole));
    },
  );

  it('reads no journal of 1.50, whose records are in lines of a page each, and no file that is not a journal', () => {
    const fifty = `${JSON.stringify(HEAD)}\n${JSON.stringify({ object: 'Account', created: [[src('001', 1), tgt('001', 1)]] })}\n`;
    expect(JournalPart.read(memoryRunFile(fifty), 0)).toBeUndefined();
    expect(JournalPart.read(memoryRunFile('not a journal\n'), 0)).toBeUndefined();
  });
});
