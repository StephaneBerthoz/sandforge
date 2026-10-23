import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { RemovalOrg } from '../forge/ForgeRunRemoval.js';
import { openCheckpointStore, rewindDirOf, type CheckpointFolder } from './OrgCheckpointStore.js';
import { openRewindJournal, undoPlansOf } from './rewindJournal.js';
import { undoRewind } from './undoRewind.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The undo of a rewind that deleted a million records — the accounts a load
 * made since the checkpoint — read from its journal on disk: what it holds
 * while it plans and while it brings them back is a page of ids and a few
 * bytes a record, never every id of the rewind. Held in memory, its plans
 * took some 700 MB.
 */

const RECORDS = 1_000_000;
const ORG_ID = '00D000000000001AAA';
const CHECKPOINT_ID = 'ck-20261022-140512-a1b2';

/** The `n`-th account the rewind deleted. */
const account = (n: number): string => `001${String(n).padStart(12, '0')}AAA`;

const dir = mkdtempSync(join(tmpdir(), 'sandforge-undo-memory-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What the process holds now: its heap, and the buffers outside it. */
function held(): number {
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

/** The most held while `run` runs, sampled every few milliseconds. */
async function peakWhile<T>(run: () => Promise<T>): Promise<{ result: T; peak: number }> {
  let peak = held();
  const sampling = setInterval(() => {
    peak = Math.max(peak, held());
  }, 5);
  try {
    const result = await run();
    peak = Math.max(peak, held());
    return { result, peak };
  } finally {
    clearInterval(sampling);
  }
}

/** The ids a statement names in its `IN (…)` list. */
function idsIn(soql: string): string[] {
  const list = /IN \((.*)\)/.exec(soql)?.[1] ?? '';
  return list === '' ? [] : list.split(', ').map((quoted) => quoted.slice(1, -1));
}

/** The org: every account the rewind deleted in its recycle bin, each brought back as asked. */
function binOrg(): RemovalOrg & { undeleted: number } {
  const org = {
    undeleted: 0,
    queryDeleted: async (soql: string) => ({ records: idsIn(soql).map((Id) => ({ Id })) }),
    query: async () => ({ totalSize: 0, records: [] }),
    update: async () => [],
    destroy: async () => [],
    describe: async (name: string) => ({ name, label: name, fields: [], childRelationships: [] }),
    describeGlobal: async () => ({ sobjects: [] }),
    serverTime: async () => '2026-10-22T16:00:00.000Z',
    userId: async () => '005000000000001AAA',
  };
  return org as unknown as RemovalOrg & { undeleted: number };
}

/**
 * A checkpoint's folder holding the journal of a rewind that deleted a
 * million accounts, a removal of them named five hundred lines of two
 * thousand ids, and answered.
 */
async function rewoundAMillion(): Promise<{
  folder: CheckpointFolder;
  rewindId: string;
  lock: { release(): void; organizationId: string };
}> {
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal.reason}`);
  const folder = await opened.store.create(ORG_ID, CHECKPOINT_ID);
  const taken = opened.store.lock(ORG_ID, 'rewind', CHECKPOINT_ID);
  if (!('lock' in taken)) throw new Error('the org’s lock is held');
  const journal = await openRewindJournal({
    folder,
    lock: taken.lock,
    startedAt: '2026-10-22T15:00:00.000Z',
    userId: '005000000000001AAA',
  });
  await journal.close();
  const file = join(rewindDirOf(folder, journal.rewindId), 'journal.ndjson');
  const at = new Date().toISOString();
  for (let page = 0; page < RECORDS; page += 100_000) {
    const lines: string[] = [];
    for (let line = page; line < page + 100_000; line += 2_000) {
      const ids = Array.from({ length: 2_000 }, (_, n) => account(line + n));
      lines.push(JSON.stringify({ kind: 'deleting', step: 1, objectApiName: 'Account', ids, at }));
    }
    appendFileSync(file, `${lines.join('\n')}\n`);
  }
  appendFileSync(file, `${JSON.stringify({ kind: 'deleted', step: 1, at })}\n`);
  appendFileSync(file, `${JSON.stringify({ kind: 'end', at })}\n`);
  return { folder, rewindId: journal.rewindId, lock: taken.lock };
}

/**
 * Run as the extension ships, never under Stryker, whose workers it names
 * (STRYKER_MUTATOR_WORKER): instrumented, a million ids through counted code
 * take past the time Stryker gives its initial test run.
 */
const describeShipped =
  process.env['STRYKER_MUTATOR_WORKER'] === undefined ? describe : describe.skip;

describeShipped('the undo of a rewind of a million records', () => {
  it('plans from the journal on disk and brings every record back holding a page of ids at a time, not the rewind', async () => {
    const { folder, rewindId, lock } = await rewoundAMillion();
    const objects = [{ objectApiName: 'Account', readOrder: 0 }];
    try {
      const before = held();
      const planned = await peakWhile(async () => {
        const plans = await undoPlansOf(folder, rewindId, objects);
        try {
          return plans.bringBack.objects;
        } finally {
          await plans.dispose();
        }
      });
      expect(planned.result).toEqual([{ objectApiName: 'Account', count: RECORDS }]);
      // A million ids held as strings, in the journal's lines and the plans'
      // maps, took some 700 MB; kept on disk, the plans hold a few sets of
      // keys of some 25 bytes a record.
      expect(planned.peak - before).toBeLessThan(200 * 1024 * 1024);

      const org = binOrg();
      const undone = await peakWhile(() =>
        undoRewind({
          folder,
          rewindId,
          lock: lock as never,
          objects,
          org,
          undelete: async (ids) => {
            org.undeleted += ids.length;
            return ids.map((id) => ({ id, success: true, errors: [] }));
          },
        }),
      );
      expect(undone.result.status).toBe('success');
      expect(org.undeleted).toBe(RECORDS);
      expect(undone.result.undeleted).toEqual([
        expect.objectContaining({ objectApiName: 'Account', planned: RECORDS, undeleted: RECORDS }),
      ]);
      expect(undone.peak - before).toBeLessThan(250 * 1024 * 1024);
    } finally {
      lock.release();
    }
  }, 600_000);
});
