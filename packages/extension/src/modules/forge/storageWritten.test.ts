import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  UNCOUNTED_WINDOW_MINUTES,
  noteStorageBegun,
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

    // The run not counted alone, and since it ended: the line names what
    // is taken off, not the run counted before it.
    expect(uncountedWritesOf(ORG, 3, bytesOf, { dir, now: at(6) })).toEqual({
      mb: 1,
      runs: 1,
      minutes: 1,
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

  describe('the runs of a real gate on a scratch org of 500 MB', () => {
    // Its `/limits` counted an insert 15 to 22 s after the run ended, a
    // removal 24 to 28 s after; a clone's gate reads them about 58 s after
    // it starts, a seed's dry run in about 6 s.
    const utc = (time: string): Date => new Date(`2026-11-19T${time}.000Z`);
    /** What the run wrote: 540 records, about 1.05 MB. */
    const RUN = { Account: 5, Contact: 479, Case: 11, Opportunity: 2, Task: 32, FeedItem: 11 };
    const REMOVED = Object.fromEntries(Object.entries(RUN).map(([object, n]) => [object, -n]));
    const RUN_MB = (540 * 2 * 1024) / (1024 * 1024);

    it('takes off what a run wrote after the removal of an earlier one, whose recount raised what the org says', () => {
      noteStorageSaid(ORG, 500, { dir, now: utc('14:01:20') });
      noteStorageWritten(ORG, RUN, { dir, now: utc('14:02:46') });
      noteStorageSaid(ORG, 499, { dir, now: utc('14:03:48') });
      noteStorageSaid(ORG, 499, { dir, now: utc('14:08:34') });
      // Removed, and counted: 499 back to 500.
      noteStorageWritten(ORG, REMOVED, { dir, now: utc('14:09:34') });
      noteStorageSaid(ORG, 500, { dir, now: utc('14:10:42') });
      // Run again: the seed's gate reads 500 fifteen seconds after it, not counted.
      noteStorageWritten(ORG, RUN, { dir, now: utc('14:13:39') });

      const uncounted = uncountedWritesOf(ORG, 500, bytesOf, { dir, now: utc('14:13:54') });
      expect(uncounted).toMatchObject({ runs: 1, minutes: 1 });
      expect(uncounted?.mb).toBeCloseTo(RUN_MB, 6);
      // Counted at 14:14:01: 499, nothing more taken off.
      noteStorageSaid(ORG, 500, { dir, now: utc('14:13:54') });
      expect(uncountedWritesOf(ORG, 499, bytesOf, { dir, now: utc('14:15:02') })).toBeUndefined();
    });

    it('holds a run counted once what the org says has dropped by what it wrote, to the MB it says it in', () => {
      noteStorageSaid(ORG, 500, { dir, now: utc('14:01:20') });
      noteStorageWritten(ORG, RUN, { dir, now: utc('14:02:46') });

      // Three seconds after: not counted, all of it taken off.
      expect(uncountedWritesOf(ORG, 500, bytesOf, { dir, now: utc('14:02:49') })?.mb).toBeCloseTo(
        RUN_MB,
        6,
      );
      // 500 to 499 for 1.05 MB written: counted, nothing of it left to say.
      for (const time of ['14:03:48', '14:05:21', '14:08:34']) {
        expect(uncountedWritesOf(ORG, 499, bytesOf, { dir, now: utc(time) })).toBeUndefined();
      }
    });

    it('takes nothing off once a removal is noted and not yet counted, never more room than the org says', () => {
      noteStorageSaid(ORG, 500, { dir, now: utc('14:20:00') });
      noteStorageWritten(ORG, RUN, { dir, now: utc('14:21:10') });
      noteStorageSaid(ORG, 499, { dir, now: utc('14:28:00') });
      noteStorageWritten(ORG, REMOVED, { dir, now: utc('14:29:34') });

      expect(uncountedWritesOf(ORG, 499, bytesOf, { dir, now: utc('14:29:49') })).toBeUndefined();
      expect(uncountedWritesOf(ORG, 500, bytesOf, { dir, now: utc('14:30:10') })).toBeUndefined();
    });

    it('names the run written after a run and its removal, no gate between them, as the one it takes off', () => {
      // Run for real: A, its removal and A2 within three minutes, nothing
      // said between them, the org still at 500 as the seed's gate read it.
      // It took off 1.06 MB, rightly, but said "what 2 runs … in the last 3
      // minute(s)": A and its removal cancel each other.
      noteStorageSaid(ORG, 500, { dir, now: utc('15:21:00') });
      noteStorageWritten(ORG, RUN, { dir, now: utc('15:22:51') });
      noteStorageWritten(ORG, REMOVED, { dir, now: utc('15:23:50') });
      noteStorageWritten(ORG, RUN, { dir, now: utc('15:25:20') });

      const uncounted = uncountedWritesOf(ORG, 500, bytesOf, { dir, now: utc('15:25:39') });
      expect(uncounted).toMatchObject({ runs: 1, minutes: 1 });
      expect(uncounted?.mb).toBeCloseTo(RUN_MB, 6);
    });
  });

  describe('a run its gate let through, still writing', () => {
    /** The run's process, gone or not, as the gate that reads its note asks. */
    const alive = (running: boolean) => () => running;

    it('takes off what a run let through is to write while it writes, and what it wrote once it ends', () => {
      noteStorageSaid(ORG, 5, { dir, now: at(0) });
      noteStorageBegun(ORG, 'run-a', 2, { dir, now: at(0) });

      // A second run's gate, a minute into the first: nothing ended, nothing counted.
      expect(uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(1), alive: alive(true) })).toEqual({
        mb: 2,
        runs: 1,
        minutes: 1,
        writing: 1,
      });
      noteStorageWritten(ORG, { Contact: 2 * RECORDS_PER_MB }, { dir, now: at(3), run: 'run-a' });
      expect(uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(4), alive: alive(true) })).toEqual({
        mb: 2,
        runs: 1,
        minutes: 1,
      });
    });

    it('takes off what the org has not counted of a run still writing, its part counted since it began left out', () => {
      noteStorageSaid(ORG, 500, { dir, now: at(0) });
      noteStorageBegun(ORG, 'run-a', 30, { dir, now: at(0) });

      // 20 of its 30 MB written and counted: 480 left, 10 MB still to come.
      expect(uncountedWritesOf(ORG, 480, bytesOf, { dir, now: at(4), alive: alive(true) })).toEqual(
        { mb: 10, runs: 1, minutes: 4, writing: 1 },
      );
    });

    it('takes off both runs when two write at once, one ended and one still writing', () => {
      noteStorageSaid(ORG, 50, { dir, now: at(0) });
      noteStorageBegun(ORG, 'run-a', 10, { dir, now: at(0) });
      noteStorageSaid(ORG, 50, { dir, now: at(1) });
      noteStorageBegun(ORG, 'run-b', 4, { dir, now: at(1) });
      noteStorageWritten(ORG, { Contact: 4 * RECORDS_PER_MB }, { dir, now: at(2), run: 'run-b' });

      expect(uncountedWritesOf(ORG, 50, bytesOf, { dir, now: at(3), alive: alive(true) })).toEqual({
        mb: 14,
        runs: 2,
        minutes: 3,
        writing: 1,
      });
    });

    it('counts, past the window, a run still writing against the runs that ended since it began', () => {
      // A run of the whole org writes for an hour; a seed into the same org
      // ended twenty minutes in, counted since.
      noteStorageSaid(ORG, 500, { dir, now: at(0) });
      noteStorageBegun(ORG, 'run-a', 100, { dir, now: at(0) });
      noteStorageWritten(ORG, { Contact: 5 * RECORDS_PER_MB }, { dir, now: at(20) });

      // 500 → 435: the seed's 5 MB and 60 of the clone's.
      expect(
        uncountedWritesOf(ORG, 435, bytesOf, { dir, now: at(45), alive: alive(true) }),
      ).toEqual({ mb: 40, runs: 1, minutes: 45, writing: 1 });
    });

    it('holds a run that ended past the window as counted, however little the org has dropped since', () => {
      noteStorageSaid(ORG, 500, { dir, now: at(0) });
      noteStorageBegun(ORG, 'run-a', 100, { dir, now: at(0) });
      noteStorageWritten(ORG, { Contact: 5 * RECORDS_PER_MB }, { dir, now: at(20) });

      // 2 MB less said, past the window of the seed's end: the seed is not
      // named again, and the clone still writing is taken off whole.
      expect(
        uncountedWritesOf(ORG, 498, bytesOf, { dir, now: at(45), alive: alive(true) }),
      ).toEqual({ mb: 100, runs: 1, minutes: 45, writing: 1 });
    });

    it('takes nothing off for a run that ended having written nothing', () => {
      noteStorageSaid(ORG, 5, { dir, now: at(0) });
      noteStorageBegun(ORG, 'run-a', 2, { dir, now: at(0) });
      noteStorageWritten(ORG, {}, { dir, now: at(1), run: 'run-a' });

      expect(
        uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(2), alive: alive(true) }),
      ).toBeUndefined();
    });

    it('takes nothing off for a run whose process is gone without saying it ended', () => {
      noteStorageSaid(ORG, 5, { dir, now: at(0) });
      noteStorageBegun(ORG, 'run-a', 2, { dir, now: at(0) });

      expect(
        uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(1), alive: alive(false) }),
      ).toBeUndefined();
    });

    it('reads its own process as running, and one no process answers as gone', () => {
      noteStorageSaid(ORG, 5, { dir, now: at(0) });
      noteStorageBegun(ORG, 'run-a', 2, { dir, now: at(0) });

      expect(uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(1) })?.writing).toBe(1);
      const file = join(dir, `${ORG.slice(0, 15)}.ndjson`);
      const lines = readFileSync(file, 'utf8').replace(`"pid":${process.pid}`, '"pid":2147483646');
      writeFileSync(file, lines);
      expect(uncountedWritesOf(ORG, 5, bytesOf, { dir, now: at(1) })).toBeUndefined();
    });

    it('keeps what a run still writing began with once its file is rewritten as it grows', () => {
      noteStorageSaid(ORG, 500, { dir, now: at(0) });
      noteStorageBegun(ORG, 'run-a', 30, { dir, now: at(0) });
      for (let n = 1; n <= 300; n++) noteStorageSaid(ORG, 500, { dir, now: at(n / 10) });

      expect(
        uncountedWritesOf(ORG, 500, bytesOf, { dir, now: at(31), alive: alive(true) }),
      ).toMatchObject({ mb: 30, writing: 1 });
    });

    it('keeps no note of what a run began with nothing to write', () => {
      noteStorageBegun(ORG, 'run-a', 0, { dir, now: at(0) });

      expect(() => readFileSync(join(dir, `${ORG.slice(0, 15)}.ndjson`), 'utf8')).toThrow();
    });
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
      join(resolve('/tmp/journals'), 'storage-written'),
    );
  });
});
