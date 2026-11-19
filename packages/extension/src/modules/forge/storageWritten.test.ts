import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UNCOUNTED_WINDOW_MINUTES,
  noteStorageSaid,
  noteStorageWritten,
  storageWrittenDirOf,
  uncountedWritesOf,
  writtenOfCounts,
  type RecordBytesOf,
} from './storageWritten';

const ORG = '00D000000000001AAA';
const OTHER = '00D000000000002AAA';
const at = (minutes: number): Date => new Date(Date.UTC(2026, 10, 19, 9, 0) + minutes * 60_000);
/** 2 KB a record, as most take: 512 records a MB. */
const bytesOf: RecordBytesOf = (_object, rows) => rows * 2 * 1024;
const RECORDS_PER_MB = 512;

describe('what runs from this machine wrote to an org that its /limits has not counted yet', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-storage-written-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes off all a run wrote while /limits still says what it said before the run', () => {
    noteStorageSaid(ORG, 5, { dir, now: at(0) });
    noteStorageWritten(ORG, { Contact: 2 * RECORDS_PER_MB }, { dir, now: at(2) });

    expect(uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(3) })).toEqual({
      mb: 2,
      runs: 1,
      minutes: 1,
    });
  });

  it('takes off nothing once /limits has counted what the run wrote', () => {
    noteStorageSaid(ORG, 5, { dir, now: at(0) });
    noteStorageWritten(ORG, { Contact: 998 }, { dir, now: at(2) });

    expect(uncountedWritesOf(ORG, 3, bytesOf, { dir, now: at(6) })).toBeUndefined();
  });

  it('takes off what /limits has not counted yet of two runs, one counted and one not', () => {
    noteStorageSaid(ORG, 5, { dir, now: at(0) });
    noteStorageWritten(
      ORG,
      { Account: RECORDS_PER_MB, Contact: RECORDS_PER_MB },
      { dir, now: at(1) },
    );
    noteStorageSaid(ORG, 3, { dir, now: at(4) });
    noteStorageWritten(ORG, { Lead: RECORDS_PER_MB }, { dir, now: at(5) });

    expect(uncountedWritesOf(ORG, 3, bytesOf, { dir, now: at(6) })).toEqual({
      mb: 1,
      runs: 2,
      minutes: 5,
    });
  });

  it('reads what was said in the same millisecond as a run ended as said before it, in the order noted', () => {
    noteStorageSaid(ORG, 5, { dir, now: at(1) });
    noteStorageWritten(ORG, { Contact: 2 * RECORDS_PER_MB }, { dir, now: at(1) });

    expect(uncountedWritesOf(ORG, 3, bytesOf, { dir, now: at(2) })).toBeUndefined();
    expect(uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(2) })?.mb).toBe(2);
  });

  it('counts a removal against what its run wrote', () => {
    noteStorageSaid(ORG, 5, { dir, now: at(0) });
    noteStorageWritten(ORG, { Contact: 2 * RECORDS_PER_MB }, { dir, now: at(1) });
    noteStorageWritten(ORG, { Contact: -2 * RECORDS_PER_MB }, { dir, now: at(3) });

    // Counted, then freed: back to what it said before the run.
    expect(uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(5) })).toBeUndefined();
  });

  it('sizes what was written by the sizes of the gate that asks', () => {
    noteStorageSaid(ORG, 500, { dir, now: at(0) });
    noteStorageWritten(ORG, { Campaign: 128 }, { dir, now: at(1) });

    const campaigns: RecordBytesOf = (object, rows) =>
      rows * (object === 'Campaign' ? 8 : 2) * 1024;
    expect(uncountedWritesOf(ORG, 500, campaigns, { dir, now: at(2) })?.mb).toBe(1);
  });

  it(`forgets a run once ${UNCOUNTED_WINDOW_MINUTES} minutes have passed since it ended`, () => {
    noteStorageSaid(ORG, 5, { dir, now: at(0) });
    noteStorageWritten(ORG, { Contact: 2 * RECORDS_PER_MB }, { dir, now: at(1) });

    expect(
      uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(1 + UNCOUNTED_WINDOW_MINUTES - 1) }),
    ).toBeDefined();
    expect(
      uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(1 + UNCOUNTED_WINDOW_MINUTES + 1) }),
    ).toBeUndefined();
  });

  it('takes off all a run wrote when nothing said what the org had left before it', () => {
    noteStorageWritten(ORG, { Contact: 205 }, { dir, now: at(1) });

    expect(uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(2) })?.mb).toBeCloseTo(0.4, 2);
  });

  it('keeps each org apart, under its 15-character id whatever the length it is given in', () => {
    noteStorageSaid(ORG, 5, { dir, now: at(0) });
    noteStorageWritten(ORG.slice(0, 15), { Contact: RECORDS_PER_MB }, { dir, now: at(1) });

    expect(uncountedWritesOf(OTHER, 5, bytesOf, { dir, now: at(2) })).toBeUndefined();
    expect(uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(2) })?.mb).toBe(1);
  });

  it('keeps nothing for what is not an org id, nor for a run that wrote nothing', () => {
    noteStorageWritten('../TGT', { Contact: RECORDS_PER_MB }, { dir, now: at(1) });
    noteStorageWritten(ORG, { Contact: 0 }, { dir, now: at(1) });

    expect(uncountedWritesOf('../TGT', 5, bytesOf, { dir, now: at(2) })).toBeUndefined();
    expect(() => readFileSync(join(dir, '..', 'TGT.ndjson'), 'utf8')).toThrow();
    expect(() => readFileSync(join(dir, `${ORG.slice(0, 15)}.ndjson`), 'utf8')).toThrow();
  });

  it('passes over a line it cannot read, and never throws for a folder it cannot write', () => {
    noteStorageSaid(ORG, 5, { dir, now: at(0) });
    writeFileSync(join(dir, `${ORG.slice(0, 15)}.ndjson`), 'not json\n{"at":1}\n', { flag: 'a' });
    noteStorageWritten(ORG, { Contact: RECORDS_PER_MB }, { dir, now: at(1) });

    expect(uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(2) })?.mb).toBe(1);
    const file = join(dir, 'a-file');
    writeFileSync(file, '');
    const below = { dir: join(file, 'below') };
    expect(() => noteStorageWritten(ORG, { Contact: 1 }, below)).not.toThrow();
    expect(uncountedWritesOf(ORG, 5, bytesOf, below)).toBeUndefined();
  });

  it('keeps no more than the last day, once the file grows', () => {
    for (let n = 0; n < 300; n++) noteStorageSaid(ORG, 5, { dir, now: at(-3 * 24 * 60 + n) });
    noteStorageSaid(ORG, 5, { dir, now: at(0) });

    const lines = readFileSync(join(dir, `${ORG.slice(0, 15)}.ndjson`), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    expect(lines.length).toBeLessThan(300);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps its folder and each file its owner’s alone, a file rewritten as it grows among them',
    () => {
      const own = join(dir, 'storage-written');
      noteStorageSaid(ORG, 5, { dir: own, now: at(0) });
      const file = join(own, `${ORG.slice(0, 15)}.ndjson`);

      expect(statSync(own).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      for (let n = 0; n < 300; n++) noteStorageSaid(OTHER, 5, { dir: own, now: at(n) });
      expect(statSync(join(own, `${OTHER.slice(0, 15)}.ndjson`)).mode & 0o777).toBe(0o600);
    },
  );

  it('counts what a run created, upserted and deleted, per object, from its audit counts', () => {
    expect(
      writtenOfCounts([
        { objectApiName: 'Account', created: 3, deleted: 0, upserted: 2 },
        { objectApiName: 'Contact', created: 0, deleted: 4 },
      ]),
    ).toEqual({ Account: 5, Contact: -4 });
  });

  it('lives in the folder the journals are kept in', () => {
    expect(storageWrittenDirOf({ SANDFORGE_JOURNAL_DIR: '/tmp/journals' })).toBe(
      join('/tmp/journals', 'storage-written'),
    );
  });
});
