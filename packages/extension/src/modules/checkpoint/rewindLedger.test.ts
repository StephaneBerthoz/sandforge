import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CheckpointRewindEnded,
  CheckpointRewindUndone,
  RewindResult,
} from '@sandforge/shared';

import {
  openCheckpointStore,
  organizationKey,
  type OrgCheckpointStore,
  type OrgLock,
} from './OrgCheckpointStore.js';
import {
  LEDGER_KEPT_LINES,
  LEDGER_MAX_LINES,
  OrgClockWatch,
  REWIND_LEDGER_FILE,
  appendToRewindLedger,
  noteRewindEnded,
  noteRewindUndone,
  readRewindLedger,
  readRewindLedgers,
  rewindEndedRecord,
  rewindLedgerBeside,
  rewindLedgerFileOf,
  rewindTotalsOf,
} from './rewindLedger.js';

const ORG = '00D000000000001AAA';
const OTHER = '00D000000000002AAA';
/** The names their folders go by: the 18-character form of each. */
const ORG_KEY = organizationKey(ORG);
const OTHER_KEY = organizationKey(OTHER);

const ENDED: CheckpointRewindEnded = {
  kind: 'rewind',
  rewindId: 'rw-20261028-120000-aaaa',
  checkpointId: 'ck-20261028-100000-aaaa',
  checkpointName: 'Before UAT',
  organizationId: ORG,
  mode: 'picked',
  objects: ['Account', 'Contact'],
  readFrom: '2026-10-28T10:00:00.000Z',
  takenAt: '2026-10-28T10:05:00.000Z',
  startedAt: '2026-10-28T12:00:00.000Z',
  endedAt: '2026-10-28T12:10:00.000Z',
  orgAheadMs: 1_200,
  status: 'success',
  totals: { deleted: 2, restored: 1, undeleted: 1, recreated: 0 },
};

const UNDONE: CheckpointRewindUndone = {
  kind: 'undo',
  rewindId: ENDED.rewindId,
  checkpointId: ENDED.checkpointId,
  organizationId: ORG,
  status: 'partial',
  undoneAt: '2026-10-28T13:00:00.000Z',
};

let dir: string;
let store: OrgCheckpointStore;
let lock: OrgLock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-ledger-'));
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(opened.refusal.reason);
  store = opened.store;
  const held = store.lock(ORG, 'rewind');
  if (!('lock' in held)) throw new Error('the lock is held');
  lock = held.lock;
});

afterEach(() => {
  lock.release();
  rmSync(dir, { recursive: true, force: true });
});

const ledger = (): string => rewindLedgerFileOf(store.root, ORG);
const lines = (): string[] =>
  readFileSync(ledger(), 'utf8')
    .split('\n')
    .filter((line) => line !== '');

describe('the rewind ledger', () => {
  it('is a file of its own in the org’s folder of the store, beside its checkpoints and in none of them', () => {
    const folder = store.folderOf(ORG, ENDED.checkpointId);

    expect(ledger()).toBe(join(store.root, ORG_KEY, REWIND_LEDGER_FILE));
    expect(rewindLedgerBeside(folder)).toBe(ledger());
    // Either form of the Organization Id names the one ledger.
    expect(rewindLedgerFileOf(store.root, ORG.slice(0, 15))).toBe(ledger());
  });

  it('adds a line under the org’s lock, its owner’s alone, and reads it back as written', async () => {
    await appendToRewindLedger(ledger(), lock, ENDED);
    await appendToRewindLedger(ledger(), lock, UNDONE);

    expect(await readRewindLedger(ledger())).toEqual({ records: [ENDED, UNDONE], unreadable: [] });
    if (process.platform !== 'win32') expect(statSync(ledger()).mode & 0o777).toBe(0o600);
  });

  it('refuses a line under another org’s lock, writing nothing', async () => {
    await expect(
      appendToRewindLedger(rewindLedgerFileOf(store.root, OTHER), lock, {
        ...ENDED,
        organizationId: OTHER,
      }),
    ).rejects.toThrow('under its lock');
    expect(await readRewindLedger(rewindLedgerFileOf(store.root, OTHER))).toEqual({
      records: [],
      unreadable: [],
    });
  });

  it('writes only what its schema parsed: no record’s id, no value, whatever the line was handed', async () => {
    const handed = {
      ...ENDED,
      ids: ['001000000000001AAA'],
      values: { Name: 'Acme' },
    } as CheckpointRewindEnded;

    await appendToRewindLedger(ledger(), lock, handed);

    const written = JSON.parse(lines()[0] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(Object.keys(ENDED).sort());
    // Walked whole: no string anywhere in it is shaped like a record's id.
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(written);
    const recordIds = strings.filter(
      (text) => /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(text) && !text.startsWith('00D'),
    );
    expect(recordIds).toEqual([]);
  });

  it('refuses a line that does not parse, writing nothing', async () => {
    await expect(
      appendToRewindLedger(ledger(), lock, { ...ENDED, startedAt: 'noon' }),
    ).rejects.toThrow('does not parse');
    expect(await readRewindLedger(ledger())).toEqual({ records: [], unreadable: [] });
  });

  it('leaves out a line that does not parse, says which, and reads the others', async () => {
    await appendToRewindLedger(ledger(), lock, ENDED);
    appendFileSync(ledger(), '{"kind":"rewind","rewindId":\n');
    appendFileSync(ledger(), `${JSON.stringify({ kind: 'take' })}\n`);
    await appendToRewindLedger(ledger(), lock, UNDONE);

    expect(await readRewindLedger(ledger())).toEqual({
      records: [ENDED, UNDONE],
      unreadable: [2, 3],
    });
  });

  it('closes a line a killed process left without its end before it adds one', async () => {
    mkdirSync(dirname(ledger()), { recursive: true });
    writeFileSync(ledger(), `${JSON.stringify(ENDED)}\n{"kind":"rew`);

    await appendToRewindLedger(ledger(), lock, UNDONE);

    expect(await readRewindLedger(ledger())).toEqual({ records: [ENDED, UNDONE], unreadable: [2] });
  });

  it('keeps its latest lines once it passes its bound, its earlier ones dropped', async () => {
    const bounds = { maxLines: 4, keptLines: 2 };
    const nth = (n: number): CheckpointRewindEnded => ({
      ...ENDED,
      rewindId: `rw-20261028-12000${n}-aaaa`,
    });

    for (let n = 1; n <= 4; n++) await appendToRewindLedger(ledger(), lock, nth(n), bounds);
    expect(lines()).toHaveLength(4);
    await appendToRewindLedger(ledger(), lock, nth(5), bounds);

    expect((await readRewindLedger(ledger())).records.map(({ rewindId }) => rewindId)).toEqual([
      nth(4).rewindId,
      nth(5).rewindId,
    ]);
    if (process.platform !== 'win32') expect(statSync(ledger()).mode & 0o777).toBe(0o600);
    expect([LEDGER_MAX_LINES, LEDGER_KEPT_LINES]).toEqual([400, 200]);
  });

  it('reads each org’s ledger once, whichever form of its id names it', async () => {
    await appendToRewindLedger(ledger(), lock, ENDED);

    const reads = await readRewindLedgers(store.root, [ORG, ORG.slice(0, 15), OTHER]);

    expect([...reads.keys()]).toEqual([ORG_KEY, OTHER_KEY]);
    expect(reads.get(ORG_KEY)?.records).toEqual([ENDED]);
    expect(reads.get(OTHER_KEY)).toEqual({ records: [], unreadable: [] });
  });
});

describe('the org’s clock, as a rewind last read it', () => {
  it('is how far the org’s answer was ahead of the middle of the call, the last reading standing', async () => {
    let machine = 1_000_000;
    const watch = new OrgClockWatch(() => machine);
    const org = {
      answer: '',
      async serverTime(): Promise<string> {
        machine += 400;
        return this.answer;
      },
      other(): string {
        return 'through';
      },
    };
    const watched = watch.watched(org);
    expect(watch.aheadMs()).toBeUndefined();

    org.answer = new Date(1_000_000 + 200 + 5_000).toISOString();
    await watched.serverTime();
    expect(watch.aheadMs()).toBe(5_000);

    org.answer = new Date(machine + 200 - 3_000).toISOString();
    await watched.serverTime();
    expect(watch.aheadMs()).toBe(-3_000);
    expect(watch.orgNow().getTime()).toBe(machine - 3_000);
    // What else the org answers goes through as it was.
    expect(watched.other()).toBe('through');
  });

  it('keeps the last reading when the org answers what is no date', async () => {
    const watch = new OrgClockWatch(() => 0);
    let answer = new Date(2_000).toISOString();
    const watched = watch.watched({ serverTime: async () => answer });

    await watched.serverTime();
    answer = 'not a date';
    await watched.serverTime();

    expect(watch.aheadMs()).toBe(2_000);
  });
});

describe('the lines of a rewind and of an undo', () => {
  const RESULT = {
    rewindId: ENDED.rewindId,
    status: 'cancelled',
    deleted: [
      { objectApiName: 'Account', deleted: 2 },
      { objectApiName: 'Contact', deleted: 3 },
    ],
    restored: [{ objectApiName: 'Account', restored: 1, restoredWithout: 1 }],
    undeleted: [{ objectApiName: 'Contact', undeleted: 4 }],
    recreated: [{ objectApiName: 'Account', created: 1 }],
  } as unknown as RewindResult;

  it('counts what a rewind did in all, never which records', () => {
    expect(rewindTotalsOf(RESULT)).toEqual({ deleted: 5, restored: 2, undeleted: 4, recreated: 1 });
  });

  it('dates the end of a rewind stopped part way by this machine’s clock moved to the org’s', async () => {
    const checkpoint = {
      checkpointId: ENDED.checkpointId,
      name: ENDED.checkpointName,
      org: { organizationId: ORG },
      scope: { mode: 'picked' },
      objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }],
      readFrom: ENDED.readFrom,
      takenAt: ENDED.takenAt,
    } as never;
    const watch = new OrgClockWatch(() => Date.parse('2026-10-28T12:04:00.000Z'));
    await watch.watched({ serverTime: async () => '2026-10-28T12:04:01.500Z' }).serverTime();

    const line = rewindEndedRecord({
      checkpoint,
      result: RESULT,
      startedAt: ENDED.startedAt,
      clock: watch,
    });

    expect(line).toEqual({
      ...ENDED,
      orgAheadMs: 1_500,
      endedAt: '2026-10-28T12:04:01.500Z',
      status: 'cancelled',
      totals: { deleted: 5, restored: 2, undeleted: 4, recreated: 1 },
    });
  });

  it('turns a ledger that cannot be written into a note, never a failure', async () => {
    const folder = store.folderOf(ORG, ENDED.checkpointId);
    // A folder where the ledger's file should be: it cannot be opened to append.
    mkdirSync(rewindLedgerBeside(folder), { recursive: true });

    const rewound = await noteRewindEnded({
      folder,
      lock,
      checkpoint: {
        checkpointId: ENDED.checkpointId,
        name: ENDED.checkpointName,
        org: { organizationId: ORG },
        scope: { mode: 'picked' },
        objects: [],
        readFrom: ENDED.readFrom,
        takenAt: ENDED.takenAt,
      } as never,
      result: RESULT,
      startedAt: ENDED.startedAt,
      endedAt: ENDED.endedAt,
      clock: new OrgClockWatch(() => 0),
    });
    const undone = await noteRewindUndone({
      folder,
      lock,
      checkpoint: { checkpointId: ENDED.checkpointId, org: { organizationId: ORG } } as never,
      rewindId: ENDED.rewindId,
      status: 'success',
      undoneAt: UNDONE.undoneAt,
    });

    expect(rewound).toMatch(/^The rewind could not be kept in the org’s rewind ledger \(/);
    expect(rewound).toContain('histories will not mark the runs it took back');
    expect(undone).toMatch(/^The undo could not be kept in the org’s rewind ledger \(/);
  });

  it('adds an undo’s line, and answers no note once it did', async () => {
    const folder = store.folderOf(ORG, ENDED.checkpointId);

    const note = await noteRewindUndone({
      folder,
      lock,
      checkpoint: { checkpointId: ENDED.checkpointId, org: { organizationId: ORG } } as never,
      rewindId: ENDED.rewindId,
      status: 'partial',
      undoneAt: UNDONE.undoneAt,
    });

    expect(note).toBeUndefined();
    expect((await readRewindLedger(ledger())).records).toEqual([UNDONE]);
  });
});
