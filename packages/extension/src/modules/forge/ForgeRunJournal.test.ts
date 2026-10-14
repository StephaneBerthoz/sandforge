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
});
