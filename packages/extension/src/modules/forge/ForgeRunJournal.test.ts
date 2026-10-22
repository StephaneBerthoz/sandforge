import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ForgeGraph } from '@sandforge/shared';
import {
  ForgeRunJournal,
  nodeRunJournal,
  type ForgeRunJournalDeps,
  type ForgeRunResumeHead,
} from './ForgeRunJournal.js';

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
    openRunFile: (filePath) => ({
      size: () => Buffer.byteLength(files.get(filePath) ?? ''),
      append: (text) => void files.set(filePath, (files.get(filePath) ?? '') + text),
      read: (offset, length) =>
        Buffer.from(files.get(filePath) ?? '').subarray(offset, offset + length),
      close: () => {},
    }),
  };
  return { deps, files };
}

const ACCOUNT_A = '001000000000001AAA';
const ACCOUNT_B = '001000000000002AAA';
const CONTACT_A = '003000000000001AAA';
const NEW_ACCOUNT_A = '001000000000101AAA';
const NEW_ACCOUNT_B = '001000000000102AAA';
const NEW_CONTACT_A = '003000000000101AAA';

const STARTED = new Date('2026-10-13T10:00:00.000Z');

/** A run's journal begun, and its first part writing two accounts and a contact. */
async function runThatWrote(journal: ForgeRunJournal, id: string, resume?: ForgeRunResumeHead) {
  await journal.begin(id, 'tgt-org', STARTED, resume);
  const store = journal.open(id);
  store.beginPart(STARTED);
  store.setMapping('created', ACCOUNT_A, NEW_ACCOUNT_A, 'Account');
  store.setMapping('created', ACCOUNT_B, NEW_ACCOUNT_B, 'Account');
  store.checkpoint('Account', { lastId: ACCOUNT_B, read: 2, done: true });
  store.setMapping('created', CONTACT_A, NEW_CONTACT_A, 'Contact');
  store.close();
}

const GRAPH: ForgeGraph = {
  nodes: [],
  edges: [],
  totalRecords: 0,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

/** What a run was started with, as the extension keeps it to take the run up. */
const STARTED_WITH: NonNullable<ForgeRunResumeHead['startedWith']> = {
  graph: GRAPH,
  config: {
    inputMode: 'soql',
    soqlQuery: 'SELECT Id FROM Account',
    depth: 'direct',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    anonymizePII: false,
    skipEmpty: true,
    batchSize: 'auto',
  },
};

const RESUME: ForgeRunResumeHead = {
  sourceOrgId: 'src-org',
  fingerprint: 'a'.repeat(64),
  startedWith: STARTED_WITH,
};

describe("a run's journal", () => {
  it('offers what a run that never ended created for removal, children before their parents', async () => {
    const { deps } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await runThatWrote(journal, 'run-1');

    const left = await journal.leftOver();
    expect(left.map((read) => ForgeRunJournal.planOf(read))).toEqual([
      {
        forgeId: 'run-1',
        targetOrgId: 'tgt-org',
        timestamp: '2026-10-13T10:00:00.000Z',
        duration: 0,
        status: 'partial',
        objects: [
          { objectApiName: 'Contact', ids: [NEW_CONTACT_A] },
          { objectApiName: 'Account', ids: [NEW_ACCOUNT_B, NEW_ACCOUNT_A] },
        ],
        linked: 0,
      },
    ]);
    expect(left[0]?.parts).toBe(1);
    expect(left[0]?.lastEnd).toBeUndefined();
  });

  it('leaves nothing over once the run ended or was kept, nor for a run under way', async () => {
    const { deps } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await runThatWrote(journal, 'ended');
    await journal.end('ended');
    await runThatWrote(journal, 'kept');
    await journal.stop('kept', 'cancelled', 'forge-kept');
    await runThatWrote(journal, 'running');

    expect(await journal.leftOver(new Set(['running']))).toEqual([]);
    expect(await journal.read('ended')).toBeUndefined();
    expect((await journal.read('kept'))?.lastEnd).toMatchObject({
      status: 'cancelled',
      forgeId: 'forge-kept',
    });
  });

  it('says what the run was started with, and what the last of its parts created', async () => {
    const { deps } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await runThatWrote(journal, 'resumable', RESUME);
    await journal.stop('resumable', 'cancelled', 'forge-first');
    // A second part, resuming the first, writes one more account and stops.
    const store = journal.open('resumable');
    expect(store.mapping(ACCOUNT_A)?.earlier).toBe(true);
    store.beginPart(STARTED);
    store.setMapping('created', '001000000000003AAA', '001000000000103AAA', 'Account');
    store.close();

    const read = await journal.read('resumable');
    expect(read?.resume).toEqual(RESUME);
    expect(read?.parts).toBe(2);
    expect(read?.lastEnd).toBeUndefined();
    expect(read?.created).toEqual([{ objectApiName: 'Account', ids: ['001000000000103AAA'] }]);
  });

  it('says beside the journal how its last part ended, until a part resuming it begins', async () => {
    const { deps } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await runThatWrote(journal, 'run', RESUME);
    expect(await journal.lastEnd('run')).toBeUndefined();
    await journal.stop('run', 'cancelled', 'forge-first');
    expect(await journal.lastEnd('run')).toMatchObject({
      status: 'cancelled',
      forgeId: 'forge-first',
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    await journal.resuming('run');
    expect(await journal.lastEnd('run')).toBeUndefined();
    const store = journal.open('run');
    store.beginPart(STARTED);
    store.close();
    // The part resuming it found left over, with how the part before ended.
    const [read] = await journal.leftOver();
    expect(read?.endBefore).toMatchObject({ status: 'cancelled', forgeId: 'forge-first' });
    expect(read?.created).toEqual([]);

    await journal.stop('run', 'failure', 'forge-second');
    expect(await journal.leftOver()).toEqual([]);
    await journal.end('run');
    expect(await journal.lastEnd('run')).toBeUndefined();
    expect(await journal.read('run')).toBeUndefined();
  });

  it('names the run each ended part of the journal was kept as, and none of a journal that is gone', async () => {
    const { deps, files } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await runThatWrote(journal, 'run', RESUME);
    await journal.stop('run', 'cancelled', 'forge-first');
    await journal.resuming('run');
    const store = journal.open('run');
    store.beginPart(STARTED);
    store.setMapping('created', '001000000000003AAA', '001000000000103AAA', 'Account');
    store.close();
    // The part under way has no end yet: it names no run.
    expect(await journal.partsOf('run')).toEqual(['forge-first']);

    await journal.stop('run', 'interrupted', 'run-1');
    // A line a closed window cut short is passed over.
    files.set(journal.pathOf('run'), `${files.get(journal.pathOf('run'))}{"end":{"stat`);
    expect(await journal.partsOf('run')).toEqual(['forge-first', 'run-1']);

    await journal.end('run');
    expect(await journal.partsOf('run')).toEqual([]);
  });

  it('gives what the last part created and linked to by source id, as a history entry keeps it', async () => {
    const { deps } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await journal.begin('remap', 'tgt-org', STARTED);
    const store = journal.open('remap');
    store.beginPart(STARTED);
    store.setMapping('created', ACCOUNT_A, NEW_ACCOUNT_A, 'Account');
    store.setMapping('existing', ACCOUNT_B, NEW_ACCOUNT_B, 'Account');
    store.close();
    const read = await journal.read('remap');
    expect(read?.remap).toEqual({
      table: { [ACCOUNT_A]: NEW_ACCOUNT_A, [ACCOUNT_B]: NEW_ACCOUNT_B },
      createdByObject: [{ objectApiName: 'Account', sourceIds: [ACCOUNT_A] }],
      linked: [ACCOUNT_B],
    });
    expect(read?.created).toEqual([{ objectApiName: 'Account', ids: [NEW_ACCOUNT_A] }]);
  });

  it('reads every part of a journal, or one of them, by its file', async () => {
    const { deps } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await runThatWrote(journal, 'two', RESUME);
    await journal.stop('two', 'cancelled', 'forge-first');
    await journal.resumingAt(journal.pathOf('two'));
    const store = journal.openAt(journal.pathOf('two'));
    store.beginPart(STARTED);
    store.setMapping('created', '001000000000003AAA', '001000000000103AAA', 'Account');
    store.close();
    const file = journal.pathOf('two');

    const all = await journal.readAt(file, 'all');
    // Every part's, in the order a removal takes them: the last written first.
    expect(all?.created).toEqual([
      { objectApiName: 'Contact', ids: [NEW_CONTACT_A] },
      { objectApiName: 'Account', ids: ['001000000000103AAA', NEW_ACCOUNT_B, NEW_ACCOUNT_A] },
    ]);
    const first = await journal.readAt(file, 0);
    expect(first?.remap.createdByObject).toEqual([
      { objectApiName: 'Account', sourceIds: [ACCOUNT_A, ACCOUNT_B] },
      { objectApiName: 'Contact', sourceIds: [CONTACT_A] },
    ]);
    expect((await journal.readAt(file, 1))?.remap.createdByObject).toEqual([
      { objectApiName: 'Account', sourceIds: ['001000000000003AAA'] },
    ]);
    expect((await journal.headAt(file))?.resume).toEqual(RESUME);
    expect(await journal.lastEndAt(file)).toBeUndefined();
  });

  it('keeps the fingerprint of a run whose graph does not read as one the panel sends, without the setup to run it again', async () => {
    const { deps } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    // The command's discovery names no relationship for some lookups.
    await runThatWrote(journal, 'command', {
      ...RESUME,
      recordId: ACCOUNT_A,
      startedWith: {
        ...STARTED_WITH,
        graph: {
          ...GRAPH,
          edges: [
            {
              sourceObject: 'Account',
              targetObject: 'Contact',
              relationshipName: '',
              type: 'lookup',
            },
          ],
        },
      },
    });

    const head = await journal.head('command');
    expect(head?.resume).toEqual({
      sourceOrgId: RESUME.sourceOrgId,
      fingerprint: RESUME.fingerprint,
      recordId: ACCOUNT_A,
    });
  });

  it('keeps a journal whose setup no longer reads removable, and not resumable', async () => {
    const { deps, files } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await runThatWrote(journal, 'odd', RESUME);
    const file = path.join('/storage', 'forge-runs', 'odd.ndjson');
    files.set(file, (files.get(file) ?? '').replace('"fingerprint":"aaaa', '"fingerprint":"zz'));

    const [read] = await journal.leftOver();
    expect(read?.resume).toBeUndefined();
    expect(read?.created).toHaveLength(2);
  });

  it('gives the ids of a part as its summary would hold them: every part mapped, what this part created apart', async () => {
    const { deps } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await runThatWrote(journal, 'run-ids');
    // A second part links to what the first wrote, and creates a contact of its own.
    const store = journal.open('run-ids');
    store.beginPart(STARTED);
    store.setMapping('created', '003000000000002AAA', '003000000000102AAA', 'Contact');
    store.close();

    expect(await journal.idsOf('run-ids', 1)).toEqual({
      table: {
        [ACCOUNT_A]: NEW_ACCOUNT_A,
        [ACCOUNT_B]: NEW_ACCOUNT_B,
        [CONTACT_A]: NEW_CONTACT_A,
        '003000000000002AAA': '003000000000102AAA',
      },
      createdByObject: [{ objectApiName: 'Contact', sourceIds: ['003000000000002AAA'] }],
      existing: [ACCOUNT_A, ACCOUNT_B, CONTACT_A],
    });
    expect(await journal.idsOf('run-gone', 0)).toBeUndefined();
  });

  it('keeps beside the journal what removals of a part left, and drops it with the journal', async () => {
    const { deps, files } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await runThatWrote(journal, 'run-left');
    expect(await journal.leftOf('run-left', 0)).toBeUndefined();

    await journal.keepLeft('run-left', 0, [NEW_CONTACT_A, 'not an id', NEW_ACCOUNT_B]);
    expect(await journal.leftOf('run-left', 0)).toEqual([NEW_CONTACT_A, NEW_ACCOUNT_B]);
    await journal.keepLeft('run-left', 0, [NEW_ACCOUNT_B]);
    expect(await journal.leftOf('run-left', 0)).toEqual([NEW_ACCOUNT_B]);

    await journal.end('run-left');
    expect([...files.keys()]).toEqual([]);
  });

  it('hands a removal the records of a part a page at a time, keeps what it left the same way, and hands over that alone next', async () => {
    const { deps } = memoryDisk();
    const renamed: string[] = [];
    const journal = new ForgeRunJournal({
      ...deps,
      rename: async (from, to) => {
        renamed.push(path.basename(to));
        await deps.appendFile(to, '');
        const text: string[] = [];
        for await (const line of deps.readLines(from)) if (line) text.push(line);
        await deps.rm(to);
        await deps.appendFile(to, text.length > 0 ? `${text.join('\n')}\n` : '');
        await deps.rm(from);
      },
    });
    await runThatWrote(journal, 'run-pages');

    const opened = await journal.recordsOf('run-pages', 0);
    if (!opened) throw new Error('not read');
    expect(opened.records.objects).toEqual([
      { objectApiName: 'Contact', count: 1 },
      { objectApiName: 'Account', count: 2 },
    ]);
    opened.close();

    const counts = await journal.keepLeftPages(
      'run-pages',
      0,
      (async function* left() {
        yield { objectApiName: 'Account', ids: [NEW_ACCOUNT_B] };
      })(),
    );
    expect(counts).toEqual([{ objectApiName: 'Account', count: 1 }]);
    expect(renamed).toEqual(['run-pages.part0.left']);
    expect(await journal.leftOf('run-pages', 0)).toEqual([NEW_ACCOUNT_B]);

    const next = await journal.recordsOf('run-pages', 0);
    const ids: string[] = [];
    for await (const page of next?.records.pages('Account') ?? []) ids.push(...page);
    expect(next?.records.objects).toEqual([{ objectApiName: 'Account', count: 1 }]);
    expect(ids).toEqual([NEW_ACCOUNT_B]);
    next?.close();
  });

  it('keeps beside the journal what removals of a part stamped, over what earlier ones did, and drops it with the journal', async () => {
    const { deps, files } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await runThatWrote(journal, 'run-stamps');
    expect(await journal.stampsOf('run-stamps', 0)).toEqual({});

    await journal.keepStamps('run-stamps', 0, {
      [NEW_ACCOUNT_A]: '2026-10-14T10:00:00.000+0000',
      [NEW_CONTACT_A]: '2026-10-14T10:00:01.000+0000',
    });
    await journal.keepStamps('run-stamps', 0, { [NEW_ACCOUNT_A]: '2026-10-14T11:00:00.000+0000' });
    expect(await journal.stampsOf('run-stamps', 0)).toEqual({
      [NEW_ACCOUNT_A]: '2026-10-14T11:00:00.000+0000',
      [NEW_CONTACT_A]: '2026-10-14T10:00:01.000+0000',
    });

    await journal.end('run-stamps');
    expect([...files.keys()]).toEqual([]);
  });

  it('lists the journals that ended, says which are there, and forgets one by its file', async () => {
    const { deps, files } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await runThatWrote(journal, 'run-ended');
    await runThatWrote(journal, 'run-going');
    await journal.stop('run-ended', 'success', 'forge-1');

    expect(await journal.endedFiles()).toEqual(['run-ended.ndjson']);
    expect(await journal.present(['run-ended', 'run-going', 'run-gone'])).toEqual(
      new Set(['run-ended', 'run-going']),
    );

    await journal.forgetFile('run-ended.ndjson');
    expect([...files.keys()].map((file) => path.basename(file))).toEqual(['run-going.ndjson']);
  });

  it('keeps its journals on disk, under the storage it is given, until the run ends', async () => {
    const storage = await mkdtemp(path.join(os.tmpdir(), 'forge-journal-'));
    try {
      const journal = nodeRunJournal(storage);
      expect(await journal.leftOver()).toEqual([]);
      await runThatWrote(journal, 'on-disk');
      // Another window, reading the same storage, finds it.
      const read = await nodeRunJournal(storage).leftOver();
      expect(read.map((found) => [found.journalId, found.created.length])).toEqual([
        ['on-disk', 2],
      ]);
      await journal.end('on-disk');
      expect(await journal.leftOver()).toEqual([]);
    } finally {
      await rm(storage, { recursive: true, force: true });
    }
  });

  it('keeps the whole lines of a journal whose last line was cut, and none of a file that is not one', async () => {
    const { deps, files } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await journal.begin('cut', 'tgt-org', STARTED);
    const store = journal.open('cut');
    store.beginPart(STARTED);
    store.setMapping('created', ACCOUNT_A, NEW_ACCOUNT_A, 'Account');
    store.close();
    const cut = path.join('/storage', 'forge-runs', 'cut.ndjson');
    files.set(cut, `${files.get(cut) ?? ''}["c","${ACCOUNT_B}","001`);
    // An id that is no id is never offered for a delete.
    files.set(
      path.join('/storage', 'forge-runs', 'forged.ndjson'),
      '{"run":{"journalId":"forged","targetOrgId":"t","startedAt":"x"}}\n' +
        `["c","${ACCOUNT_A}","x' OR Id != '","Account"]\n`,
    );
    files.set(path.join('/storage', 'forge-runs', 'other.ndjson'), 'not a journal\n');

    const left = await journal.leftOver();

    expect(left.map((read) => [read.journalId, read.created])).toEqual([
      ['cut', [{ objectApiName: 'Account', ids: [NEW_ACCOUNT_A] }]],
      ['forged', []],
    ]);
  });

  it('reads the journal a run of 1.50 left, a page to a line', async () => {
    const { deps, files } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    files.set(
      path.join('/storage', 'forge-runs', 'old.ndjson'),
      '{"run":{"journalId":"old","targetOrgId":"tgt-org","startedAt":"2026-10-13T10:00:00.000Z"}}\n' +
        `{"object":"Account","created":[["${ACCOUNT_A}","${NEW_ACCOUNT_A}"]]}\n`,
    );
    const [read] = await journal.leftOver();
    expect(read?.resume).toBeUndefined();
    expect(read?.created).toEqual([{ objectApiName: 'Account', ids: [NEW_ACCOUNT_A] }]);
  });

  it('names the first record its run created, the last, and the last it wrote to since, with its last time', async () => {
    const { deps } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await runThatWrote(journal, 'run-1');
    const store = journal.open('run-1');
    store.sent('Contact', [], [], new Date('2026-10-13T10:05:00.000Z'));
    // The second pass fills in a lookup of the first account.
    store.patched(NEW_ACCOUNT_A, 'ParentId');
    store.close();

    expect(journal.writeBoundsAt(journal.pathOf('run-1'))).toEqual({
      first: { objectApiName: 'Account', id: NEW_ACCOUNT_A },
      lastCreated: { objectApiName: 'Contact', id: NEW_CONTACT_A },
      lastUpdated: { objectApiName: 'Account', id: NEW_ACCOUNT_A },
      lastAt: '2026-10-13T10:05:00.000Z',
    });
  });

  describe('dated as the target dated its writes', () => {
    /** The target: when it created each record it still holds, by id. */
    const holding = (created: Record<string, string>) => {
      const asked: string[] = [];
      return {
        asked,
        query: async <T>(soql: string) => {
          asked.push(soql);
          const id = /WHERE Id = '(\w+)'$/.exec(soql)?.[1] ?? '';
          const at = created[id];
          return {
            totalSize: at ? 1 : 0,
            done: true,
            records: (at ? [{ CreatedDate: at }] : []) as T[],
          };
        },
      };
    };
    const LATER_CONTACT = '003000000000102AAA';

    /** The run of `runThatWrote`, taken up by a second part that created one more contact. */
    async function takenUp(journal: ForgeRunJournal): Promise<void> {
      await runThatWrote(journal, 'run-3');
      const store = journal.open('run-3');
      store.beginPart(new Date('2026-10-13T11:00:00.000Z'));
      store.setMapping('created', '003000000000002AAA', LATER_CONTACT, 'Contact');
      store.close();
    }

    it('from when it created its first record to when it created its last', async () => {
      const journal = new ForgeRunJournal(memoryDisk().deps);
      await takenUp(journal);
      const target = holding({
        [NEW_ACCOUNT_A]: '2026-10-13T10:00:02.000+0000',
        [NEW_CONTACT_A]: '2026-10-13T10:00:09.000+0000',
        [LATER_CONTACT]: '2026-10-13T11:00:03.000+0000',
      });

      expect(await journal.writtenBetween('run-3', target as never)).toEqual({
        first: '2026-10-13T10:00:02.000Z',
        last: '2026-10-13T11:00:03.000Z',
      });
    });

    it('of a part, to the last record that part created once the later part was removed', async () => {
      const journal = new ForgeRunJournal(memoryDisk().deps);
      await takenUp(journal);
      // The second part's contact is gone: its part was removed first.
      const target = holding({
        [NEW_ACCOUNT_A]: '2026-10-13T10:00:02.000+0000',
        [NEW_CONTACT_A]: '2026-10-13T10:00:09.000+0000',
      });

      expect(await journal.writtenBetween('run-3', target as never)).toBeUndefined();
      expect(await journal.writtenBetween('run-3', target as never, 0)).toEqual({
        first: '2026-10-13T10:00:02.000Z',
        last: '2026-10-13T10:00:09.000Z',
      });
    });

    it("of a part alone, as a verification counts what its user created, from the part's first record to its last", async () => {
      const journal = new ForgeRunJournal(memoryDisk().deps);
      await takenUp(journal);
      const target = holding({
        [NEW_ACCOUNT_A]: '2026-10-13T10:00:02.000+0000',
        [NEW_CONTACT_A]: '2026-10-13T10:00:09.000+0000',
        [LATER_CONTACT]: '2026-10-13T11:00:03.000+0000',
      });

      expect(await journal.writtenBetween('run-3', target as never, 0, 'part')).toEqual({
        first: '2026-10-13T10:00:02.000Z',
        last: '2026-10-13T10:00:09.000Z',
      });
      expect(await journal.writtenBetween('run-3', target as never, 1, 'part')).toEqual({
        first: '2026-10-13T11:00:03.000Z',
        last: '2026-10-13T11:00:03.000Z',
      });
    });

    it('of a part, from the first record that part created once the earlier part was removed', async () => {
      const journal = new ForgeRunJournal(memoryDisk().deps);
      await takenUp(journal);
      const target = holding({ [LATER_CONTACT]: '2026-10-13T11:00:03.000+0000' });

      expect(await journal.writtenBetween('run-3', target as never, 1)).toEqual({
        first: '2026-10-13T11:00:03.000Z',
        last: '2026-10-13T11:00:03.000Z',
      });
    });
  });

  it('keeps a journal whose window closed during its first insert call, with no record it names', async () => {
    const { deps } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await journal.begin('run-2', 'tgt-org', STARTED, RESUME);
    const store = journal.open('run-2');
    store.beginPart(STARTED);
    store.sent('Contact', ['LastName'], [{ sourceId: CONTACT_A, fingerprint: 'abcdefg1234567' }]);
    store.close();

    expect(journal.callsInFlight('run-2')).toBe(1);
    const [read] = await journal.leftOver();
    expect(read?.created).toEqual([]);
  });
});
