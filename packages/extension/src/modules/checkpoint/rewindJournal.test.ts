import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgCheckpoint } from '@sandforge/shared';

import { MEMORY_ORG_USER } from '../../test/memoryRemovalOrg.js';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg.js';
import { runRecordsOf, type RunRemovalOutcome } from '../forge/ForgeRunRemoval.js';
import { restoreOverwrites } from '../sync/SyncRunRestore.js';
import {
  CheckpointStoreError,
  openCheckpointStore,
  rewindDirOf,
  type CheckpointFolder,
  type OrgLock,
  type OrgCheckpointStore,
} from './OrgCheckpointStore.js';
import {
  IDS_PER_LINE,
  openRewindJournal,
  readRewindJournal,
  removeEarlierJournals,
  reopenRewindJournal,
  rewoundObjects,
  undoPlansOf,
  type ObjectIds,
  type Parented,
  type RewindJournal,
  type RewindJournalRead,
} from './rewindJournal.js';
import type { IdSpool } from './spooledRunRecords.js';
import { fingerprintOf } from './checkpointFingerprint.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The journal a rewind writes before it writes, on a checkpoint's folder made
 * by its store: each line on disk and flushed before the call it names, the
 * values a give-back writes over kept first through the store a Sync run
 * keeps its own in, a stopped rewind's journal taken up again, and the whole
 * read back as the three plans of its undo.
 */

const ORG_ID = '00D000000000001AAA';
const OTHER_ORG = '00D000000000002AAA';
const CHECKPOINT_ID = 'ck-20261022-140512-a1b2';
const AUTOMATED_PROCESS = '005000000000002AAA';

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const account = (n: number): string => id('001', n);
const contact = (n: number): string => id('003', n);

/** Tr of a first pass, on the org's clock, and of a pass taken up later. */
const TR = '2026-10-22T15:00:00.000Z';
const TR_LATER = '2026-10-22T15:40:00.000Z';

const made: string[] = [];
const held: OrgLock[] = [];
let store: OrgCheckpointStore;
let folder: CheckpointFolder;
let lock: OrgLock;

function locked(organizationId: string): OrgLock {
  const taken = store.lock(organizationId, 'rewind', CHECKPOINT_ID);
  if (!('lock' in taken)) throw new Error('the org’s lock is held');
  held.push(taken.lock);
  return taken.lock;
}

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-journal-'));
  made.push(dir);
  const opened = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: join(dir, 'locks'),
  });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal.reason}`);
  store = opened.store;
  folder = await store.create(ORG_ID, CHECKPOINT_ID);
  lock = locked(ORG_ID);
});

afterEach(() => {
  for (const taken of held.splice(0)) taken.release();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function journalOpened(startedAt = TR): Promise<RewindJournal> {
  return openRewindJournal({
    folder,
    lock,
    startedAt,
    userId: MEMORY_ORG_USER,
    automatedProcessUserId: AUTOMATED_PROCESS,
  });
}

/** The lines of a journal on disk, as written. */
function linesOn(journal: RewindJournal): Array<Record<string, unknown>> {
  return readFileSync(join(journal.dir, 'journal.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The values kept of an object, in the order they were kept. */
function valuesOn(journal: RewindJournal, objectApiName: string): Array<Record<string, unknown>> {
  return readFileSync(
    join(journal.dir, 'backups', `${journal.backup}__${objectApiName}.ndjson`),
    'utf8',
  )
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A removal's answer that left `left` of what it was handed. */
function leaving(
  left: Array<{ objectApiName: string; ids: string[] }>,
): Pick<RunRemovalOutcome, 'left'> {
  return {
    left: async function* () {
      yield* left;
    },
  };
}

/** Every flush of a file to the disk, in order with the calls a test records beside. */
async function flushesInto(events: string[]): Promise<void> {
  const probe = await open(join(folder.dir, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const sync = prototype.sync;
  vi.spyOn(prototype, 'sync').mockImplementation(async function (this: unknown) {
    await sync.call(this);
    events.push('flushed');
  });
}

describe('the journal, before each write', () => {
  it('names each batch it brings back on disk, flushed, before the undelete of it is sent', async () => {
    const journal = await journalOpened();
    const events: string[] = [];
    await flushesInto(events);
    const sent: string[][] = [];
    const undelete = journal.bringingBack(
      [
        { objectApiName: 'Account', ids: [account(1), account(2)] },
        { objectApiName: 'Contact', ids: [contact(1)] },
      ],
      async (ids) => {
        events.push('undelete');
        // What the journal holds when the call goes: read from the disk.
        expect(linesOn(journal).at(-1)).toMatchObject({ kind: 'bringingBack', ids });
        sent.push(ids);
        return ids.map((record) => ({ id: record, success: true }));
      },
    );

    await undelete([account(1), account(2)]);
    await undelete([contact(1)]);
    await journal.close();

    expect(sent).toEqual([[account(1), account(2)], [contact(1)]]);
    expect(events).toEqual(['flushed', 'undelete', 'flushed', 'undelete']);
    expect(linesOn(journal).slice(1)).toMatchObject([
      { kind: 'bringingBack', objectApiName: 'Account', ids: [account(1), account(2)] },
      { kind: 'bringingBack', objectApiName: 'Contact', ids: [contact(1)] },
    ]);
  });

  it('sends no batch of records its plan does not hold, the journal never having named them', async () => {
    const journal = await journalOpened();
    const undelete = vi.fn(async (ids: string[]) => ids.map(() => ({ success: true })));
    const call = journal.bringingBack([{ objectApiName: 'Account', ids: [account(1)] }], undelete);

    await expect(call([contact(9)])).rejects.toThrow('none was sent');
    await expect(call([account(1), contact(9)])).rejects.toThrow('none was sent');
    await journal.close();

    expect(undelete).not.toHaveBeenCalled();
    expect(linesOn(journal)).toHaveLength(1);
  });

  it('keeps what an update of the give-back writes over, then names its records, both on disk and flushed before the update goes', async () => {
    const journal = await journalOpened();
    const org = new MemoryRestoreOrg({}, { now: () => Date.parse(TR) + 60_000 });
    org.add('Account', { Id: account(1), Name: 'Changed since', Phone: '555' });
    org.add('Account', { Id: account(2), Name: 'At the checkpoint 2', Phone: '556' });
    const events: string[] = [];
    await flushesInto(events);
    const update = org.update.bind(org);
    vi.spyOn(org, 'update').mockImplementation(async (objectApiName, records) => {
      events.push('update');
      expect(valuesOn(journal, 'Account')).toEqual([{ Id: account(1), Name: 'Changed since' }]);
      expect(linesOn(journal).at(-1)).toMatchObject({
        kind: 'givingBack',
        objectApiName: 'Account',
        ids: [account(1)],
      });
      return update(objectApiName, records);
    });

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: 'snapshot', ids: [account(1), account(2)] }],
      backups: {
        batches: async () => ({
          async *[Symbol.asyncIterator]() {
            yield [
              { Id: account(1), Name: 'At the checkpoint 1', Phone: '555' },
              { Id: account(2), Name: 'At the checkpoint 2', Phone: '556' },
            ];
          },
        }),
      },
      changedAfter: new Date(Date.parse(TR) + 120_000).toISOString(),
      fields: { Account: ['Name', 'Phone'] },
      includeChanged: false,
      keep: journal.keep,
    });
    await journal.close();

    expect(outcome.objects[0]).toMatchObject({ restored: 2, refused: 0 });
    // The values, the folder their new file is in, the line, then the
    // update: each flushed before the next. Windows does not open a folder to
    // flush it (its file system journals the entry itself): no folder flush.
    expect(events).toEqual(
      process.platform === 'win32'
        ? ['flushed', 'flushed', 'update']
        : ['flushed', 'flushed', 'flushed', 'update'],
    );
    const read = await readRewindJournal(folder, journal.rewindId);
    expect(read.did.givenBack).toEqual([{ objectApiName: 'Account', ids: [account(1)] }]);
  });

  it('sends no update whose values could not be kept, names none of its records, and gives back the next object all the same', async () => {
    const journal = await journalOpened();
    // The file the account values go to cannot be written: a folder stands in its place.
    mkdirSync(join(journal.dir, 'backups', `${journal.backup}__Account.ndjson`), {
      recursive: true,
    });
    const org = new MemoryRestoreOrg({}, { now: () => Date.parse(TR) + 60_000 });
    org.add('Account', { Id: account(1), Name: 'Changed since' });
    org.add('Contact', { Id: contact(1), LastName: 'Changed since' });

    const outcome = await restoreOverwrites({
      org,
      plan: [
        { objectApiName: 'Account', backup: 'snapshot', ids: [account(1)] },
        { objectApiName: 'Contact', backup: 'snapshot', ids: [contact(1)] },
      ],
      backups: {
        batches: async (_backup, objectApiName) => ({
          async *[Symbol.asyncIterator]() {
            yield objectApiName === 'Account'
              ? [{ Id: account(1), Name: 'At the checkpoint' }]
              : [{ Id: contact(1), LastName: 'At the checkpoint' }];
          },
        }),
      },
      changedAfter: new Date(Date.parse(TR) + 120_000).toISOString(),
      includeChanged: false,
      keep: journal.keep,
    });
    await journal.close();

    expect(outcome.objects.map(({ restored, refused }) => ({ restored, refused }))).toEqual([
      { restored: 0, refused: 1 },
      { restored: 1, refused: 0 },
    ]);
    expect(outcome.objects[0].reasons[0]).toContain(
      'nothing is written over that cannot be put back',
    );
    expect(org.updates.map((call) => call.objectApiName)).toEqual(['Contact']);
    expect(org.all('Account')[0].Name).toBe('Changed since');
    const read = await readRewindJournal(folder, journal.rewindId);
    expect(read.did.givenBack).toEqual([{ objectApiName: 'Contact', ids: [contact(1)] }]);
  });

  it('names what a removal sets out to delete before it is handed the plan, a page at a time, and at most 2,000 ids a line', async () => {
    const journal = await journalOpened();
    const contacts = Array.from({ length: 4_500 }, (_, n) => contact(n + 1));
    await journal.deleting(
      runRecordsOf([
        { objectApiName: 'Contact', ids: contacts },
        { objectApiName: 'Account', ids: [account(1)] },
      ]),
    );
    await journal.close();

    const lines = linesOn(journal).slice(1);
    expect(lines.map((line) => [line.kind, line.step, line.objectApiName])).toEqual([
      ['deleting', 1, 'Contact'],
      ['deleting', 1, 'Contact'],
      ['deleting', 1, 'Contact'],
      ['deleting', 1, 'Account'],
    ]);
    expect(lines.map((line) => (line.ids as string[]).length)).toEqual([
      IDS_PER_LINE,
      IDS_PER_LINE,
      500,
      1,
    ]);
  });
});

describe('the journal of what a rewind makes again', () => {
  it('names the records it makes again by the Ids the checkpoint holds them by before the insert, then by the Ids the org gave them beside those, and reads them back as made', async () => {
    const journal = await journalOpened();
    try {
      await journal.recreating('Account', [account(1), account(2)]);
      await journal.recreated('Account', [{ from: account(1), id: account(91) }]);

      const lines = linesOn(journal).slice(1);
      expect(
        lines.map(({ kind, objectApiName, ids, from }) => ({ kind, objectApiName, ids, from })),
      ).toEqual([
        {
          kind: 'recreating',
          objectApiName: 'Account',
          ids: [account(1), account(2)],
          from: undefined,
        },
        { kind: 'recreated', objectApiName: 'Account', ids: [account(91)], from: [account(1)] },
      ]);
      const read = await journal.read();
      expect(read.did.recreated).toEqual([{ objectApiName: 'Account', ids: [account(91)] }]);
      // Each a write about to go, or one answered.
      expect(read.lastWriteAt).toBeDefined();
    } finally {
      await journal.close();
    }
  });

  it('refuses as damaged a line of records made again that names fewer Ids they had than records', async () => {
    const journal = await journalOpened();
    await journal.close();
    appendFileSync(
      join(journal.dir, 'journal.ndjson'),
      `${JSON.stringify({
        kind: 'recreated',
        objectApiName: 'Account',
        ids: [account(91), account(92)],
        from: [account(1)],
        at: new Date().toISOString(),
      })}\n`,
    );

    await expect(readRewindJournal(folder, journal.rewindId)).rejects.toMatchObject({
      code: 'damaged',
    });
  });
});

describe('the journal, read back', () => {
  it('says the removal deleted what it set out to less what it left, once it answered; all of it when it never did', async () => {
    const journal = await journalOpened();
    await journal.deleting([
      { objectApiName: 'Contact', ids: [contact(1), contact(2)] },
      { objectApiName: 'Account', ids: [account(1), account(2)] },
    ]);
    // Changed after Tr by a colleague: the removal left it.
    await journal.deleted(leaving([{ objectApiName: 'Account', ids: [account(2)] }]));
    // A second pass, whose removal never answered: a crash.
    await journal.deleting([{ objectApiName: 'Account', ids: [account(3)] }]);
    await journal.close();

    const read = await readRewindJournal(folder, journal.rewindId);
    expect(read.did.deleted).toEqual([
      { objectApiName: 'Contact', ids: [contact(1), contact(2)] },
      { objectApiName: 'Account', ids: [account(1), account(3)] },
    ]);
  });

  it('holds what came back with a parent as brought back, each record once whichever length its id is named in', async () => {
    const journal = await journalOpened();
    await journal.withParent('Contact', [contact(1), contact(2)]);
    await journal.bringingBack([{ objectApiName: 'Account', ids: [account(1)] }], async () => [])([
      account(1),
    ]);
    await journal.withParent('Contact', [contact(1).slice(0, 15)]);
    await journal.close();

    const read = await readRewindJournal(folder, journal.rewindId);
    expect(read.did.broughtBack).toEqual([
      { objectApiName: 'Contact', ids: [contact(1), contact(2)] },
      { objectApiName: 'Account', ids: [account(1)] },
    ]);
  });

  it('holds the carriers it brought back, and what came back with them beside the record each hangs from itself, apart from what came back with a parent to keep', async () => {
    const journal = await journalOpened();
    await journal.withParent('Contact', [contact(1)], [account(1)], { carriers: true });
    await journal.withParent('Note', [id('002', 1)], [contact(1)], { carriers: true });
    await journal.bringingBack([{ objectApiName: 'Account', ids: [account(1)] }], async () => [], {
      carriers: true,
    })([account(1)]);
    await journal.withParent('Contact', [contact(2)], [account(2)]);
    await journal.bringingBack([{ objectApiName: 'Account', ids: [account(2)] }], async () => [])([
      account(2),
    ]);
    await journal.close();

    const read = await readRewindJournal(folder, journal.rewindId);
    expect(read.did.carriers).toEqual([{ objectApiName: 'Account', ids: [account(1)] }]);
    expect(read.did.carried).toEqual([
      { objectApiName: 'Contact', ids: [contact(1)], parents: [account(1)] },
      { objectApiName: 'Note', ids: [id('002', 1)], parents: [contact(1)] },
    ]);
    expect(read.did.withParents).toEqual([
      { objectApiName: 'Contact', ids: [contact(2)], parents: [account(2)] },
    ]);
  });

  it('holds what came back with a parent beside that parent, as named, and refuses as damaged a line that names fewer parents than records', async () => {
    const journal = await journalOpened();
    await journal.withParent('Contact', [contact(1), contact(2)], [account(1), account(1)]);
    await journal.withParent('Opportunity', [id('006', 1)]);
    await expect(journal.withParent('Contact', [contact(3)], [])).rejects.toThrow(
      'Each record that comes back with a parent is named beside that parent.',
    );
    await journal.close();

    const read = await readRewindJournal(folder, journal.rewindId);
    expect(read.did.withParents).toEqual([
      {
        objectApiName: 'Contact',
        ids: [contact(1), contact(2)],
        parents: [account(1), account(1)],
      },
    ]);

    const file = join(rewindDirOf(folder, journal.rewindId), 'journal.ndjson');
    appendFileSync(
      file,
      `${JSON.stringify({
        kind: 'withParent',
        objectApiName: 'Contact',
        ids: [contact(4), contact(5)],
        parents: [account(2)],
        at: new Date().toISOString(),
      })}\n`,
    );
    await expect(readRewindJournal(folder, journal.rewindId)).rejects.toThrow(
      'The rewind’s journal names records that came back with a parent without it.',
    );
  });

  it('holds what was given back once the deletes it waited for were through, with the objects that held it, and names nothing for an object held by none', async () => {
    const journal = await journalOpened();
    await journal.heldInPlace('Opportunity', ['OpportunityLineItem'], [id('006', 1), id('006', 2)]);
    await journal.heldInPlace('Opportunity', ['Line__c'], [id('006', 2).slice(0, 15)]);
    await journal.heldInPlace('Account', [], [account(1)]);
    await journal.close();

    expect(linesOn(journal).filter((line) => line.kind === 'heldInPlace')).toHaveLength(2);
    const read = await readRewindJournal(folder, journal.rewindId);
    expect(read.did.heldInPlace).toEqual([
      {
        objectApiName: 'Opportunity',
        ids: [id('006', 1), id('006', 2)],
        by: ['OpportunityLineItem', 'Line__c'],
      },
    ]);
    // Naming them writes nothing to the org: the last write is not moved.
    expect(read.lastWriteAt).toBeUndefined();
  });

  it('says which records it deleted before a record they point at that went too — deleted, or taken along by a record deleted — over every pass, never one whose record a removal left, nor one it never deleted (F41)', async () => {
    const kase = (n: number): string => id('500', n);
    const journal = await journalOpened();
    await journal.beforeParent('Case', [
      // Before an account deleted.
      { id: kase(1), parent: account(1) },
      // Before an account the removal left: the case can come back.
      { id: kase(2), parent: account(2) },
      // Before a contact taken along by its account, never handed to a removal.
      { id: kase(3), parent: contact(9) },
      // Before an account the removal left, and one it deleted.
      { id: kase(4), parent: account(2) },
      { id: kase(4), parent: account(1) },
      // Named, then left by the removal itself.
      { id: kase(5), parent: account(1) },
    ]);
    await journal.deleting([
      { objectApiName: 'Case', ids: [kase(1), kase(2), kase(3), kase(4), kase(5)] },
      { objectApiName: 'Account', ids: [account(1), account(2)] },
    ]);
    await journal.deleted(
      leaving([
        { objectApiName: 'Case', ids: [kase(5)] },
        { objectApiName: 'Account', ids: [account(2)] },
      ]),
    );
    // A second pass: a case before an account it deletes then.
    await journal.beforeParent('Case', [{ id: kase(6), parent: account(3) }]);
    await journal.deleting([
      { objectApiName: 'Case', ids: [kase(6)] },
      { objectApiName: 'Account', ids: [account(3)] },
    ]);
    await journal.deleted(leaving([]));
    await journal.close();

    expect(linesOn(journal).filter((line) => line.kind === 'beforeParent')).toEqual([
      expect.objectContaining({
        objectApiName: 'Case',
        ids: [kase(1), kase(2), kase(3), kase(4), kase(4), kase(5)],
        parents: [account(1), account(2), contact(9), account(2), account(1), account(1)],
      }),
      expect.objectContaining({ ids: [kase(6)], parents: [account(3)] }),
    ]);
    const read = await readRewindJournal(folder, journal.rewindId);
    expect(read.did.deletedBeforeParent).toEqual([
      { objectApiName: 'Case', ids: [kase(1), kase(3), kase(4), kase(6)] },
    ]);
  });

  it('refuses as damaged a line of records deleted before a record they point at without each one’s record', async () => {
    const journal = await journalOpened();
    await journal.close();
    appendFileSync(
      join(journal.dir, 'journal.ndjson'),
      `${JSON.stringify({
        kind: 'beforeParent',
        objectApiName: 'Case',
        ids: [id('500', 1), id('500', 2)],
        parents: [account(1)],
        at: '2026-10-22T15:00:09.000Z',
      })}\n${JSON.stringify({ kind: 'wrote', at: '2026-10-22T15:00:10.000Z' })}\n`,
    );

    await expect(readRewindJournal(folder, journal.rewindId)).rejects.toMatchObject({
      code: 'damaged',
    });
  });

  it('dates the rewind’s last write by its write lines, never by a pass taken up later, which wrote nothing by being taken up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-22T15:00:05.000Z'));
    const first = await journalOpened();
    vi.setSystemTime(Date.parse('2026-10-22T15:00:09.000Z'));
    await first.withParent('Contact', [contact(1)]);
    await first.close();
    vi.setSystemTime(Date.parse('2026-10-22T15:40:02.000Z'));
    const resumed = await journalOpened(TR_LATER);
    const read = await resumed.read();
    await resumed.close();

    expect(read.passes).toEqual([
      { startedAt: TR, userId: MEMORY_ORG_USER },
      { startedAt: TR_LATER, userId: MEMORY_ORG_USER },
    ]);
    expect(read.lastWriteAt).toBe('2026-10-22T15:00:09.000Z');
  });

  it('keeps what the rewind’s removals left on records, stamps merged and spans in turn, for its next pass', async () => {
    const journal = await journalOpened();
    await journal.removal({
      removalStamps: { [account(1)]: '2026-10-22T15:01:00.000Z' },
      removalSpans: [
        {
          first: '2026-10-22T15:00:00.000Z',
          last: '2026-10-22T15:01:10.000Z',
          userId: MEMORY_ORG_USER,
        },
      ],
    });
    await journal.removal({
      removalStamps: { [account(2)]: '2026-10-22T15:02:00.000Z' },
      removalSpans: [
        {
          first: '2026-10-22T15:02:00.000Z',
          last: '2026-10-22T15:02:10.000Z',
          userId: MEMORY_ORG_USER,
        },
      ],
    });
    // Nothing to keep: no line.
    await journal.removal({ removalStamps: {}, removalSpans: [] });
    await journal.close();

    const read = await readRewindJournal(folder, journal.rewindId);
    expect(read.rewind.removalStamps).toEqual({
      [account(1)]: '2026-10-22T15:01:00.000Z',
      [account(2)]: '2026-10-22T15:02:00.000Z',
    });
    expect(read.rewind.removalSpans?.map((span) => span.first)).toEqual([
      '2026-10-22T15:00:00.000Z',
      '2026-10-22T15:02:00.000Z',
    ]);
    expect(linesOn(journal).filter((line) => line.kind === 'removal')).toHaveLength(2);
  });
});

describe('the journal across resumes', () => {
  it('takes up the journal of a rewind stopped part way, its lines and its values kept, the values kept first standing', async () => {
    const first = await journalOpened();
    await first.keep('Account', [{ Id: account(1), Name: 'Before the rewind' }]);
    await first.close();

    const resumed = await journalOpened(TR_LATER);
    // A second pass writes over the record again: what it holds now is what
    // the first pass wrote, which is not what it held before the rewind.
    await resumed.keep('Account', [{ Id: account(1), Name: 'At the checkpoint' }]);
    const read = await resumed.read();
    await resumed.close();

    expect(resumed.rewindId).toBe(first.rewindId);
    expect(resumed.resumed).toBe(true);
    expect(valuesOn(resumed, 'Account')).toEqual([
      { Id: account(1), Name: 'Before the rewind' },
      { Id: account(1), Name: 'At the checkpoint' },
    ]);
    expect(read.did.givenBack).toEqual([{ objectApiName: 'Account', ids: [account(1)] }]);
    const before = JSON.parse(readFileSync(join(resumed.dir, 'before.json'), 'utf8')) as {
      openings: Array<{ totalRecords: number }>;
    };
    expect(before.openings.map((opening) => opening.totalRecords)).toEqual([1, 1]);
  });

  it('starts a new journal once the last rewind went through, or was undone', async () => {
    const first = await journalOpened();
    await first.end();
    await first.close();
    const second = await journalOpened(TR_LATER);
    await second.undone({}, 'success');
    await second.close();
    const third = await journalOpened(TR_LATER);
    await third.close();

    expect(new Set([first.rewindId, second.rewindId, third.rewindId]).size).toBe(3);
    expect([second.resumed, third.resumed]).toEqual([false, false]);
  });

  it('takes up the rewind stopped part way when another rewind of the checkpoint began in the same second and went through', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-22T15:00:00.400Z'));
    // A rewind that began in that second too and went through, its id
    // sorting after any other of the second.
    const ended = 'rw-20261022-150000-zzzz';
    mkdirSync(join(rewindDirOf(folder, ended), 'backups'), { recursive: true });
    const at = '2026-10-22T15:00:00.100Z';
    appendFileSync(
      join(rewindDirOf(folder, ended), 'journal.ndjson'),
      `${JSON.stringify({
        kind: 'head',
        version: 1,
        rewindId: ended,
        checkpointId: CHECKPOINT_ID,
        organizationId: folder.organizationId,
        startedAt: TR,
        userId: MEMORY_ORG_USER,
        backup: `sync-before-${ended}`,
        at,
      })}\n${JSON.stringify({ kind: 'end', at })}\n`,
    );
    const stopped = await journalOpened();
    await stopped.withParent('Contact', [contact(1)]);
    await stopped.close();

    const resumed = await journalOpened(TR_LATER);
    await resumed.close();

    expect(stopped.rewindId).not.toBe(ended);
    expect(resumed.rewindId).toBe(stopped.rewindId);
    expect(resumed.resumed).toBe(true);
  });

  it('drops a line a crash cut short, which no write followed, and adds the next after the last whole one', async () => {
    const first = await journalOpened();
    await first.withParent('Contact', [contact(1)]);
    await first.close();
    appendFileSync(
      join(first.dir, 'journal.ndjson'),
      `{"kind":"withParent","objectApiName":"Contact","ids":["${contact(2)}"],"at":"2026-10-22T15:00:0`,
    );

    const resumed = await journalOpened(TR_LATER);
    await resumed.withParent('Contact', [contact(3)]);
    const read = await resumed.read();
    await resumed.close();

    expect(read.did.broughtBack).toEqual([
      { objectApiName: 'Contact', ids: [contact(1), contact(3)] },
    ]);
    expect(readFileSync(join(first.dir, 'journal.ndjson'), 'utf8').endsWith('}\n')).toBe(true);
  });

  it('uses a rewind’s folder left without a head as a new journal: nothing was written to the org', async () => {
    const dir = rewindDirOf(folder, 'rw-20261022-145959-zzzz');
    mkdirSync(dir, { recursive: true });

    const journal = await journalOpened();
    await journal.close();

    expect(journal.rewindId).toBe('rw-20261022-145959-zzzz');
    expect(journal.resumed).toBe(false);
    expect(linesOn(journal)).toMatchObject([{ kind: 'head', startedAt: TR }]);
  });

  it('refuses a journal damaged before its last line: no rewind starts over it, and no undo reads it', async () => {
    const first = await journalOpened();
    await first.close();
    appendFileSync(join(first.dir, 'journal.ndjson'), 'not a line of the journal\n');
    appendFileSync(
      join(first.dir, 'journal.ndjson'),
      `${JSON.stringify({ kind: 'wrote', at: '2026-10-22T15:00:09.000Z' })}\n`,
    );

    await expect(journalOpened(TR_LATER)).rejects.toThrow(CheckpointStoreError);
    await expect(journalOpened(TR_LATER)).rejects.toMatchObject({ code: 'damaged' });
    await expect(readRewindJournal(folder, first.rewindId)).rejects.toMatchObject({
      code: 'damaged',
    });
    await expect(reopenRewindJournal(folder, first.rewindId, lock)).rejects.toMatchObject({
      code: 'damaged',
    });
  });

  it('is written under the lock of the checkpoint’s org alone', async () => {
    const other = locked(OTHER_ORG);

    await expect(
      openRewindJournal({ folder, lock: other, startedAt: TR, userId: MEMORY_ORG_USER }),
    ).rejects.toMatchObject({ code: 'invalid' });
    const first = await journalOpened();
    await first.close();
    await expect(reopenRewindJournal(folder, first.rewindId, other)).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'is its owner’s alone: its folders 0700, its lines, its values and what is said of them 0600',
    async () => {
      const journal = await journalOpened();
      await journal.keep('Account', [{ Id: account(1), Name: 'Before the rewind' }]);
      await journal.close();

      const mode = (path: string): number => statSync(path).mode & 0o777;
      expect(mode(journal.dir)).toBe(0o700);
      expect(mode(join(journal.dir, 'backups'))).toBe(0o700);
      expect(mode(join(journal.dir, 'journal.ndjson'))).toBe(0o600);
      expect(mode(join(journal.dir, 'before.json'))).toBe(0o600);
      expect(mode(join(journal.dir, 'backups', `${journal.backup}__Account.ndjson`))).toBe(0o600);
    },
  );
});

describe('the undo’s plans, kept on disk', () => {
  /** What a journal names, line by line, as a test gives it. */
  interface Did {
    deleted?: ObjectIds[];
    broughtBack?: Array<ObjectIds & { carriers?: true }>;
    givenBack?: ObjectIds[];
    heldInPlace?: Array<ObjectIds & { by: string[] }>;
    withParents?: Array<ObjectIds & { parents: string[]; carriers?: true }>;
    recreated?: Array<ObjectIds & { from: string[] }>;
  }

  /**
   * The plans of a journal on disk that names `did` — each removal answered,
   * leaving nothing — after an undo that left `undo`: read back object by
   * object, as an undo takes them, then let go.
   */
  async function plansOf(did: Did, undo?: RewindJournalRead['undo']) {
    const journal = await journalOpened();
    await journal.close();
    const at = new Date().toISOString();
    const lines: Array<Record<string, unknown>> = [
      ...(did.broughtBack ?? []).map((o) => ({ kind: 'bringingBack', ...o, at })),
      ...(did.withParents ?? []).map((o) => ({ kind: 'withParent', ...o, at })),
      ...(did.recreated ?? []).map((o) => ({ kind: 'recreated', ...o, at })),
      ...(did.deleted ?? []).map((o) => ({ kind: 'deleting', step: 1, ...o, at })),
      ...((did.deleted ?? []).length > 0 ? [{ kind: 'deleted', step: 1, at }] : []),
      ...(did.givenBack ?? []).map((o) => ({ kind: 'givingBack', ...o, at })),
      ...(did.heldInPlace ?? []).map((o) => ({ kind: 'heldInPlace', ...o, at })),
      ...(undo ? [{ kind: 'undo', state: { version: 1, ...undo }, status: 'partial', at }] : []),
    ];
    appendFileSync(
      join(rewindDirOf(folder, journal.rewindId), 'journal.ndjson'),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
    );
    const plans = await undoPlansOf(folder, journal.rewindId, OBJECTS);
    try {
      const idsOf = async (
        spool: Pick<IdSpool, 'objects' | 'pages'>,
        keep: (id: string) => boolean = () => true,
      ): Promise<ObjectIds[]> => {
        const out: ObjectIds[] = [];
        for (const { objectApiName } of spool.objects) {
          const ids: string[] = [];
          for await (const page of spool.pages(objectApiName)) ids.push(...page.filter(keep));
          if (ids.length > 0) out.push({ objectApiName, ids });
        }
        return out;
      };
      const held = (await idsOf(plans.giveBack, (id) => plans.held.keys.has(id))).map(
        ({ objectApiName, ids }) => ({
          objectApiName,
          ids,
          by: plans.held.objects.find((o) => o.objectApiName === objectApiName)?.by ?? [],
        }),
      );
      const along: Array<ObjectIds & { parents: string[] }> = [];
      for (const { objectApiName } of plans.goesWithParent.objects) {
        const pairs: Parented[] = [];
        for await (const page of plans.goesWithParent.pages(objectApiName)) pairs.push(...page);
        along.push({
          objectApiName,
          ids: pairs.map(({ id }) => id),
          parents: pairs.map(({ parent }) => parent),
        });
      }
      return {
        backup: journal.backup,
        rewound: rewoundObjects(plans),
        remade: plans.remade.objects,
        carriedAlone: plans.carriedAlone.objects,
        compensated: plans.compensated,
        plans: {
          remove: await idsOf(plans.remove.spool),
          bringBack: await idsOf(plans.bringBack),
          giveBack: (await idsOf(plans.giveBack)).map((o) => ({ ...o, backup: journal.backup })),
          ...(held.length > 0 ? { held } : {}),
          ...(along.length > 0 ? { goesWithParent: along } : {}),
        },
      };
    } finally {
      await plans.dispose();
    }
  }

  const OBJECTS = [
    { objectApiName: 'Contact', readOrder: 0 },
    { objectApiName: 'Account', readOrder: 1 },
  ];

  it('brings back what the rewind deleted parents first, sends back what it brought back children first, and gives back what it wrote over', async () => {
    const { plans, backup } = await plansOf({
      deleted: [
        { objectApiName: 'Contact', ids: [contact(1)] },
        { objectApiName: 'Account', ids: [account(1)] },
      ],
      broughtBack: [
        { objectApiName: 'Account', ids: [account(2)] },
        { objectApiName: 'Contact', ids: [contact(2)] },
        // A child outside the checkpoint that came back with its account.
        { objectApiName: 'Note', ids: [id('002', 1)] },
      ],
      givenBack: [{ objectApiName: 'Account', ids: [account(3)] }],
    });

    expect(plans).toEqual({
      remove: [
        { objectApiName: 'Note', ids: [id('002', 1)] },
        { objectApiName: 'Contact', ids: [contact(2)] },
        { objectApiName: 'Account', ids: [account(2)] },
      ],
      bringBack: [
        { objectApiName: 'Account', ids: [account(1)] },
        { objectApiName: 'Contact', ids: [contact(1)] },
      ],
      giveBack: [
        {
          objectApiName: 'Account',
          ids: [account(3)],
          backup,
        },
      ],
    });
  });

  it('sends to the recycle bin what the rewind made again with new Ids, children first, beside what it brought back, and names them as made again: it was not there before the rewind', async () => {
    const { plans, rewound, remade } = await plansOf({
      broughtBack: [{ objectApiName: 'Account', ids: [account(2)] }],
      recreated: [
        { objectApiName: 'Account', ids: [account(91)], from: [account(1)] },
        {
          objectApiName: 'Contact',
          ids: [contact(91), contact(92)],
          from: [contact(1), contact(2)],
        },
      ],
    });

    expect(plans.remove).toEqual([
      { objectApiName: 'Contact', ids: [contact(91), contact(92)] },
      { objectApiName: 'Account', ids: [account(2), account(91)] },
    ]);
    expect(plans.bringBack).toEqual([]);
    expect(rewound).toEqual([
      { objectApiName: 'Contact', deleted: 0, broughtBack: 2, givenBack: 0 },
      { objectApiName: 'Account', deleted: 0, broughtBack: 2, givenBack: 0 },
    ]);
    expect(remade).toEqual([
      { objectApiName: 'Account', count: 1 },
      { objectApiName: 'Contact', count: 2 },
    ]);
  });

  it('leaves out of both what the rewind brought back and deleted again: it is in the recycle bin as it was', async () => {
    const { plans } = await plansOf({
      broughtBack: [
        { objectApiName: 'Account', ids: [account(1)] },
        // Came back with its account, created then deleted since: a second pass deleted it.
        { objectApiName: 'Contact', ids: [contact(1)] },
      ],
      deleted: [{ objectApiName: 'Contact', ids: [contact(1).slice(0, 15)] }],
    });

    expect(plans.remove).toEqual([{ objectApiName: 'Account', ids: [account(1)] }]);
    expect(plans.bringBack).toEqual([]);
  });

  it('sends back to the bin with its parent what came back with a record it sends back, never on its own; one whose parent it does not send back goes on its own, as before (K16)', async () => {
    const { plans, rewound } = await plansOf({
      broughtBack: [
        { objectApiName: 'Account', ids: [account(1), account(2)] },
        { objectApiName: 'Contact', ids: [contact(1), contact(2), contact(3)] },
      ],
      // The second account came back, then a second pass deleted it again.
      deleted: [{ objectApiName: 'Account', ids: [account(2)] }],
      withParents: [
        {
          objectApiName: 'Contact',
          ids: [contact(1), contact(2)],
          parents: [account(1).slice(0, 15), account(2).slice(0, 15)],
        },
      ],
    });

    expect(plans.remove).toEqual([
      // Came back with the account deleted again, or named with no parent: on its own.
      { objectApiName: 'Contact', ids: [contact(2), contact(3)] },
      { objectApiName: 'Account', ids: [account(1)] },
    ]);
    expect(plans.goesWithParent).toEqual([
      { objectApiName: 'Contact', ids: [contact(1)], parents: [account(1).slice(0, 15)] },
    ]);
    // Nothing of it is sent: the estimate counts no delete of it.
    // The account deleted again is in the bin as it was: nothing brings it back.
    expect(plans.bringBack).toEqual([]);
    expect(rewound).toEqual([
      { objectApiName: 'Contact', deleted: 0, broughtBack: 2, givenBack: 0 },
      { objectApiName: 'Account', deleted: 0, broughtBack: 1, givenBack: 0 },
    ]);
  });

  it('leaves in the bin what went back there with a carrier the rewind brought back for a moment and deleted again, as far down as it hangs; sends on its own what the rewind moved off it, with what hangs from that record', async () => {
    const carrier = account(1).slice(0, 15);
    const moved = contact(1);
    const note = id('002', 1);
    const { plans, carriedAlone, compensated, rewound } = await plansOf({
      // Named as they came back: the carrier's children before it, each
      // beside the record it hangs from itself.
      withParents: [
        {
          objectApiName: 'Contact',
          ids: [moved, contact(2)],
          parents: [carrier, carrier],
          carriers: true,
        },
        { objectApiName: 'Contact', ids: [contact(3)], parents: [contact(2)], carriers: true },
        { objectApiName: 'Note', ids: [note], parents: [moved.slice(0, 15)], carriers: true },
      ],
      broughtBack: [{ objectApiName: 'Account', ids: [account(1)], carriers: true }],
      // The second pass deleted the carrier; the made since went with it.
      deleted: [{ objectApiName: 'Account', ids: [account(1)] }],
      // The contact of the checkpoint, and the note under it, given back.
      givenBack: [
        { objectApiName: 'Contact', ids: [moved] },
        { objectApiName: 'Note', ids: [note] },
      ],
    });

    expect(plans.remove).toEqual([{ objectApiName: 'Contact', ids: [moved] }]);
    expect(plans.goesWithParent).toEqual([
      { objectApiName: 'Note', ids: [note], parents: [moved.slice(0, 15)] },
    ]);
    expect(plans.bringBack).toEqual([]);
    expect(carriedAlone).toEqual([{ objectApiName: 'Contact', count: 1 }]);
    expect(
      [account(1), contact(2), contact(3), moved, note].map((each) => compensated.has(each)),
    ).toEqual([true, true, true, false, false]);
    expect(rewound).toEqual([
      { objectApiName: 'Contact', deleted: 0, broughtBack: 1, givenBack: 1 },
      { objectApiName: 'Note', deleted: 0, broughtBack: 0, givenBack: 1 },
    ]);
  });

  it('names, of what it gives back, the records held in place by records the rewind deleted, and counts them apart for the estimate', async () => {
    const { plans, rewound } = await plansOf(
      {
        deleted: [{ objectApiName: 'Contact', ids: [contact(1)] }],
        givenBack: [{ objectApiName: 'Account', ids: [account(1), account(2), account(3)] }],
        heldInPlace: [
          // One the undo before it gave back already, and one never given back.
          {
            objectApiName: 'Account',
            ids: [account(1), account(2), account(4)],
            by: ['Contact'],
          },
        ],
      },
      { restoreLeft: [account(1), account(3)] },
    );

    expect(plans.held).toEqual([{ objectApiName: 'Account', ids: [account(1)], by: ['Contact'] }]);
    expect(rewound).toEqual([
      { objectApiName: 'Contact', deleted: 1, broughtBack: 0, givenBack: 0 },
      { objectApiName: 'Account', deleted: 0, broughtBack: 0, givenBack: 2, givenBackHeld: 1 },
    ]);
  });

  it('takes up only what the undo before it left of each plan', async () => {
    const { plans, rewound } = await plansOf(
      {
        broughtBack: [{ objectApiName: 'Account', ids: [account(1), account(2)] }],
        deleted: [{ objectApiName: 'Contact', ids: [contact(1), contact(2)] }],
        givenBack: [{ objectApiName: 'Account', ids: [account(3), account(4)] }],
      },
      {
        removalLeft: [account(2)],
        undeleteLeft: [contact(1)],
        restoreLeft: [],
      },
    );

    expect(plans).toEqual({
      remove: [{ objectApiName: 'Account', ids: [account(2)] }],
      bringBack: [{ objectApiName: 'Contact', ids: [contact(1)] }],
      giveBack: [],
    });
    expect(rewound).toEqual([
      { objectApiName: 'Contact', deleted: 1, broughtBack: 0, givenBack: 0 },
      { objectApiName: 'Account', deleted: 0, broughtBack: 1, givenBack: 0 },
    ]);
  });
});

describe('the journals of earlier rewinds', () => {
  const OTHER_CHECKPOINT = 'ck-20261022-090000-c3d4';
  const at = (time: string) => () => new Date(`2026-10-22T${time}.000Z`);
  const PRINT = fingerprintOf([
    { name: 'Id', type: 'id', createable: false, updateable: false, nillable: false },
  ]);

  /** A ready checkpoint of the org, its last rewind the one named. */
  function checkpointFile(
    checkpointId: string,
    name: string,
    lastRewind: OrgCheckpoint['lastRewind'],
    organizationId = ORG_ID,
  ): OrgCheckpoint {
    return {
      version: 1,
      checkpointId,
      name,
      org: {
        organizationId,
        alias: 'DEV-ED',
        username: 'admin@example.com',
        instanceUrl: 'https://example-dev-ed.my.salesforce.com',
        isSandbox: false,
        organizationType: 'Developer Edition',
        tier: 'developer',
      },
      takenBy: { userId: MEMORY_ORG_USER, viewAllData: true, modifyAllData: true },
      readFrom: '2026-10-22T08:00:00.000Z',
      takenAt: '2026-10-22T08:01:00.000Z',
      scope: { mode: 'everything', leftOut: [] },
      objects: [
        {
          objectApiName: 'Account',
          records: 1,
          inBin: 0,
          readOrder: 0,
          readMode: 'query',
          undeletable: true,
          cascadeParents: [],
          fingerprint: PRINT.digest,
          fields: ['Id'],
          leftOutFields: [],
        },
      ],
      ignoredFields: [],
      snapshotId: 'op-1',
      movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
      bytes: 1024,
      expiresAt: null,
      status: 'ready',
      takenOn: { host: 'workstation', pid: 4242 },
      ...(lastRewind ? { lastRewind } : {}),
    };
  }

  /** A rewind of `of` that began at `time`, ended or undone as asked, or left open. */
  async function rewindOf(
    of: CheckpointFolder,
    time: string,
    ending: 'end' | 'undo' | 'open',
    under: OrgLock = lock,
  ): Promise<string> {
    const journal = await openRewindJournal({
      folder: of,
      lock: under,
      startedAt: TR,
      userId: MEMORY_ORG_USER,
      now: at(time),
    });
    await journal.keep('Account', [{ Id: account(1), Name: 'Before the rewind' }]);
    if (ending === 'end') await journal.end();
    if (ending === 'undo') {
      await journal.end();
      await journal.undone({}, 'success');
    }
    await journal.close();
    return journal.rewindId;
  }

  it('deletes, once a rewind of the org ended, the journals of its earlier rewinds — of its checkpoint and of the org’s others — and names each; keeps the one that ended, one stopped part way, one it cannot read, and what another org holds', async () => {
    const other = await store.create(ORG_ID, OTHER_CHECKPOINT);
    const elsewhere = await store.create(OTHER_ORG, CHECKPOINT_ID);
    const first = await rewindOf(folder, '10:00:00', 'end');
    const undone = await rewindOf(folder, '10:30:00', 'undo');
    const otherEnded = await rewindOf(other, '09:00:00', 'end');
    const otherStopped = await rewindOf(other, '11:00:00', 'open');
    const otherLock = locked(OTHER_ORG);
    const elsewhereEnded = await rewindOf(elsewhere, '09:30:00', 'end', otherLock);
    // A journal that cannot be read, and a rewind stopped before its head.
    const damaged = 'rw-20261022-101500-dddd';
    mkdirSync(rewindDirOf(folder, damaged), { recursive: true });
    appendFileSync(join(rewindDirOf(folder, damaged), 'journal.ndjson'), 'not a line\n');
    const blank = 'rw-20261022-102000-bbbb';
    mkdirSync(rewindDirOf(folder, blank), { recursive: true });
    const ended = await rewindOf(folder, '12:00:00', 'end');
    await store.write(
      checkpointFile(CHECKPOINT_ID, 'Before UAT', {
        rewindId: ended,
        undoUntil: '2026-11-06T12:00:00.000Z',
        endedAt: '2026-10-22T12:05:00.000Z',
      }),
    );
    await store.write(
      checkpointFile(OTHER_CHECKPOINT, 'Baseline', {
        rewindId: otherStopped,
        undoUntil: '2026-11-06T11:00:00.000Z',
      }),
    );
    await store.write(
      checkpointFile(
        CHECKPOINT_ID,
        'Elsewhere',
        { rewindId: elsewhereEnded, undoUntil: '2026-11-06T09:30:00.000Z' },
        OTHER_ORG,
      ),
    );

    const removed = await removeEarlierJournals(store, lock, {
      checkpointId: CHECKPOINT_ID,
      rewindId: ended,
    });

    expect(removed).toEqual([
      { checkpointId: OTHER_CHECKPOINT, name: 'Baseline', rewindId: otherEnded },
      { checkpointId: CHECKPOINT_ID, name: 'Before UAT', rewindId: first },
      { checkpointId: CHECKPOINT_ID, name: 'Before UAT', rewindId: undone },
    ]);
    for (const { checkpointId, rewindId } of removed) {
      expect(existsSync(rewindDirOf(store.folderOf(ORG_ID, checkpointId), rewindId))).toBe(false);
    }
    for (const [of, rewindId] of [
      [folder, ended],
      [folder, damaged],
      [folder, blank],
      [other, otherStopped],
      [elsewhere, elsewhereEnded],
    ] as const) {
      expect(existsSync(rewindDirOf(of, rewindId))).toBe(true);
    }
    // The rewind stopped part way is still taken up by its checkpoint's next one.
    const resumed = await openRewindJournal({
      folder: other,
      lock,
      startedAt: TR_LATER,
      userId: MEMORY_ORG_USER,
    });
    await resumed.close();
    expect(resumed.rewindId).toBe(otherStopped);
  });

  it('keeps the org’s last rewind, which Undo reaches, when the rewind that ended is an earlier one taken up', async () => {
    const other = await store.create(ORG_ID, OTHER_CHECKPOINT);
    const taken = await rewindOf(folder, '10:00:00', 'end');
    const last = await rewindOf(other, '11:00:00', 'end');
    await store.write(
      checkpointFile(CHECKPOINT_ID, 'Before UAT', {
        rewindId: taken,
        undoUntil: '2026-11-06T10:00:00.000Z',
      }),
    );
    await store.write(
      checkpointFile(OTHER_CHECKPOINT, 'Baseline', {
        rewindId: last,
        undoUntil: '2026-11-06T11:00:00.000Z',
      }),
    );

    const removed = await removeEarlierJournals(store, lock, {
      checkpointId: CHECKPOINT_ID,
      rewindId: taken,
    });

    expect(removed).toEqual([]);
    expect(existsSync(rewindDirOf(other, last))).toBe(true);
    expect(existsSync(rewindDirOf(folder, taken))).toBe(true);
  });
});
