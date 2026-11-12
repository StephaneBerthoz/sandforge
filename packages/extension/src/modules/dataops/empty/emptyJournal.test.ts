import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EmptyJournalDamaged,
  EmptyJournalStore,
  IDS_PER_LINE,
  JOURNAL_FILE,
  defaultEmptyRoot,
  isEmptyRunId,
  newEmptyRunId,
} from './emptyJournal.js';

const ORG = '00D000000000001AAA';
const id = (n: number): string => `003${String(n).padStart(12, '0')}AAA`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sandforge-empty-journal-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A journal begun of two passes, at `when`. */
async function begun(store: EmptyJournalStore, when = new Date('2026-11-12T10:00:00Z')) {
  return store.begin(ORG, {
    runId: newEmptyRunId(when),
    orgName: 'dev',
    startedAt: when.toISOString(),
    readAt: when.toISOString(),
    previewId: 'ep-1',
    mode: 'objects',
    deleteMode: 'recycle',
    request: { mode: 'objects', objects: ['Account', 'Contact'] },
    passes: [
      { objectApiName: 'Account', records: 2, sent: 2 },
      { objectApiName: 'Contact', records: 3, sent: 1 },
    ],
    toDraftAlong: [],
    beforeParent: [],
  });
}

describe('the journal of an emptying', () => {
  it('names its runs so they sort in the order they began, and keeps them under the user’s journal folder', () => {
    const first = newEmptyRunId(new Date('2026-11-12T10:00:00Z'));
    const second = newEmptyRunId(new Date('2026-11-12T10:00:01Z'));
    expect(isEmptyRunId(first)).toBe(true);
    expect(first < second).toBe(true);
    expect(isEmptyRunId('../etc')).toBe(false);
    expect(defaultEmptyRoot({ SANDFORGE_JOURNAL_DIR: '/data/sf' })).toBe('/data/sf/empty');
  });

  it('is its owner’s alone to read', async () => {
    const journal = await begun(new EmptyJournalStore(root));
    expect(statSync(join(journal.dir, JOURNAL_FILE)).mode & 0o777).toBe(0o600);
  });

  it('is open from its first attempt until one ends through, and closed by its undo', async () => {
    const store = new EmptyJournalStore(root);
    const journal = await begun(store);
    expect((await journal.state()).open).toBe(false);
    await journal.attempt(false, new Date());
    await journal.settled('Account', [id(1)], []);
    expect((await journal.state()).open).toBe(true);
    await journal.ended('cancelled', [], new Date());
    expect((await journal.state()).open).toBe(true);
    await journal.attempt(true, new Date());
    await journal.ended('partial', [], new Date());
    const ended = await journal.state();
    expect(ended).toMatchObject({ open: false, attempts: 2, deletedAny: true, undone: false });
    await journal.undone('success', new Date());
    expect((await journal.state()).undone).toBe(true);
  });

  it('closes a run that failed before it deleted anything: there is nothing to take up', async () => {
    const journal = await begun(new EmptyJournalStore(root));
    await journal.attempt(false, new Date());
    await journal.ended('failure', [], new Date());
    expect((await journal.state()).open).toBe(false);
  });

  it('writes an answer of many ids in lines of a few thousand, and reads them back in order', async () => {
    const journal = await begun(new EmptyJournalStore(root));
    const deleted = Array.from({ length: IDS_PER_LINE + 5 }, (_, n) => id(n + 1));
    await journal.settled('Contact', deleted, [id(99_999)]);
    const lines = [];
    for await (const line of journal.settledOf('Contact')) lines.push(line);
    expect(lines.map((line) => line.deleted.length)).toEqual([IDS_PER_LINE, 5]);
    expect(lines.flatMap((line) => line.deleted)).toEqual(deleted);
    expect(lines[0].gone).toEqual([id(99_999)]);
  });

  it('drops its last line when a stop of the process cut it short, and refuses one damaged before it', async () => {
    const store = new EmptyJournalStore(root);
    const journal = await begun(store);
    await journal.attempt(false, new Date());
    appendFileSync(join(journal.dir, JOURNAL_FILE), '{"kind":"settled","objectApiN');
    expect((await journal.state()).attempts).toBe(1);

    appendFileSync(join(journal.dir, JOURNAL_FILE), '\n{"kind":"end"}\n');
    await expect(journal.state()).rejects.toBeInstanceOf(EmptyJournalDamaged);
  });

  it('lists the runs of an org, the last one last, and opens none it does not keep', async () => {
    const store = new EmptyJournalStore(root);
    const first = await begun(store, new Date('2026-11-12T10:00:00Z'));
    const second = await begun(store, new Date('2026-11-12T11:00:00Z'));
    expect((await store.runsOf(ORG)).map((run) => run.runId)).toEqual([
      first.head.runId,
      second.head.runId,
    ]);
    expect((await store.lastOf(ORG))?.runId).toBe(second.head.runId);
    await expect(store.open(ORG, 'em-20260101-000000-zzzz')).rejects.toBeInstanceOf(
      EmptyJournalDamaged,
    );
    await store.remove(ORG, first.head.runId);
    expect(await store.runsOf(ORG)).toHaveLength(1);
    expect(await new EmptyJournalStore(join(root, 'none')).runsOf(ORG)).toEqual([]);
  });
});
