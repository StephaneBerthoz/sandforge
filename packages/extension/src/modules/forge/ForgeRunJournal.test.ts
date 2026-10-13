import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ForgeRunJournal, nodeRunJournal, type ForgeRunJournalDeps } from './ForgeRunJournal.js';

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
  };
  return { deps, files };
}

const ACCOUNT_A = '001000000000001AAA';
const ACCOUNT_B = '001000000000002AAA';
const CONTACT_A = '003000000000001AAA';
const NEW_ACCOUNT_A = '001000000000101AAA';
const NEW_ACCOUNT_B = '001000000000102AAA';
const NEW_CONTACT_A = '003000000000101AAA';

describe("a run's journal", () => {
  it('offers what a run that never ended created for removal, children before their parents', async () => {
    const { deps } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    await journal.begin('run-1', 'tgt-org', new Date('2026-10-13T10:00:00.000Z'));
    await journal.page('run-1', {
      objectApiName: 'Account',
      checkpoint: { lastId: ACCOUNT_B, read: 2 },
      created: [
        { sourceId: ACCOUNT_A, targetId: NEW_ACCOUNT_A },
        { sourceId: ACCOUNT_B, targetId: NEW_ACCOUNT_B },
      ],
    });
    await journal.page('run-1', { objectApiName: 'Contact', created: [] });
    await journal.page('run-1', {
      objectApiName: 'Contact',
      created: [{ sourceId: CONTACT_A, targetId: NEW_CONTACT_A }],
    });

    expect(await journal.leftOver()).toEqual([
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
  });

  it('leaves nothing over once the run ended, nor for a run under way, nor for one that created nothing', async () => {
    const { deps } = memoryDisk();
    const journal = new ForgeRunJournal(deps);
    const page = {
      objectApiName: 'Account',
      created: [{ sourceId: ACCOUNT_A, targetId: NEW_ACCOUNT_A }],
    };
    await journal.begin('ended', 'tgt-org', new Date());
    await journal.page('ended', page);
    await journal.end('ended');
    await journal.begin('running', 'tgt-org', new Date());
    await journal.page('running', page);
    await journal.begin('empty', 'tgt-org', new Date());

    expect(await journal.leftOver(new Set(['running']))).toEqual([]);
  });

  it('keeps its journals on disk, under the storage it is given, until the run ends', async () => {
    const storage = await mkdtemp(path.join(os.tmpdir(), 'forge-journal-'));
    try {
      const journal = nodeRunJournal(storage);
      expect(await journal.leftOver()).toEqual([]);
      await journal.begin('on-disk', 'tgt-org', new Date('2026-10-13T10:00:00.000Z'));
      await journal.page('on-disk', {
        objectApiName: 'Account',
        created: [{ sourceId: ACCOUNT_A, targetId: NEW_ACCOUNT_A }],
      });
      // Another window, reading the same storage, finds it.
      const read = await nodeRunJournal(storage).leftOver();
      expect(read.map((plan) => [plan.forgeId, plan.objects])).toEqual([
        ['on-disk', [{ objectApiName: 'Account', ids: [NEW_ACCOUNT_A] }]],
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
    await journal.begin('cut', 'tgt-org', new Date('2026-10-13T10:00:00.000Z'));
    await journal.page('cut', {
      objectApiName: 'Account',
      created: [{ sourceId: ACCOUNT_A, targetId: NEW_ACCOUNT_A }],
    });
    const cut = path.join('/storage', 'forge-runs', 'cut.ndjson');
    files.set(cut, `${files.get(cut) ?? ''}{"object":"Account","created":[["001`);
    // An id that is no id is never offered for a delete.
    files.set(
      path.join('/storage', 'forge-runs', 'forged.ndjson'),
      '{"run":{"journalId":"forged","targetOrgId":"t","startedAt":"x"}}\n' +
        `{"object":"Account","created":[["${ACCOUNT_A}","x' OR Id != '"]]}\n`,
    );
    files.set(path.join('/storage', 'forge-runs', 'other.ndjson'), 'not a journal\n');

    const plans = await journal.leftOver();

    expect(plans.map((plan) => [plan.forgeId, plan.objects])).toEqual([
      ['cut', [{ objectApiName: 'Account', ids: [NEW_ACCOUNT_A] }]],
    ]);
  });
});
