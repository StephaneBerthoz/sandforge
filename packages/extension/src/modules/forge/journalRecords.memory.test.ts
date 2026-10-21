import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeRunRecords, type RemovalOrg } from './ForgeRunRemoval.js';
import { nodeRunFile } from './ForgeRunStore.js';
import { JournalPart } from './journalRecords.js';

/*
 * A removal and an Id map of a run of a million records, read from its
 * journal on disk: what either holds while it runs is a page of ids and a few
 * bytes a record, never every id of the run.
 */

const RECORDS = 1_000_000;

/** The `n`-th source id and target id of the run's contacts. */
const src = (n: number): string => `003S${String(n).padStart(11, '0')}AAA`;
const tgt = (n: number): string => `003T${String(n).padStart(11, '0')}AAA`;

const dir = mkdtempSync(join(tmpdir(), 'forge-journal-memory-'));
const journalPath = join(dir, 'run.ndjson');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The journal of a run of whole tables that created a million contacts, written on disk. */
function writeTheJournal(): void {
  appendFileSync(
    journalPath,
    `${JSON.stringify({ run: { journalId: 'j', targetOrgId: 't', startedAt: '2026-10-14T08:00:00.000Z' } })}\n` +
      `${JSON.stringify({ part: { n: 0, startedAt: '2026-10-14T08:00:00.000Z' } })}\n`,
  );
  for (let at = 0; at < RECORDS; at += 20_000) {
    const lines: string[] = [];
    for (let n = at; n < at + 20_000; n++) {
      lines.push(JSON.stringify(['c', src(n), tgt(n), 'Contact']));
    }
    appendFileSync(journalPath, `${lines.join('\n')}\n`);
  }
}

/** What the process holds now: its heap, and the buffers outside it. */
function held(): number {
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

/** The most held at any time since `reset`, sampled as the org is called. */
const peak = {
  value: 0,
  reset(): void {
    this.value = held();
  },
  sample(): void {
    this.value = Math.max(this.value, held());
  },
};

/** The target: every record there, unchanged since the run, and every delete taken. */
function targetOrg(): RemovalOrg & { deleted: number } {
  let calls = 0;
  const org = {
    deleted: 0,
    query: async (soql: string) => {
      if (++calls % 100 === 0) peak.sample();
      const list = /WHERE Id IN \((.*)\)$/.exec(soql)?.[1];
      if (!list) return { totalSize: 0, records: [] };
      const records = list.split(', ').map((quoted) => ({
        Id: quoted.slice(1, -1),
        CreatedDate: '2026-10-14T08:00:01.000+0000',
        LastModifiedDate: '2026-10-14T08:00:01.000+0000',
      }));
      return { totalSize: records.length, records };
    },
    destroy: async (_object: string, ids: string[]) => {
      if (++calls % 100 === 0) peak.sample();
      org.deleted += ids.length;
      return ids.map((id) => ({ id, success: true, errors: [] }));
    },
    update: async () => [],
    describe: async (name: string) => ({ name, label: name, fields: [], childRelationships: [] }),
    describeGlobal: async () => ({ sobjects: [] }),
    serverTime: async () => '2026-10-14T10:00:00.000Z',
    userId: async () => '005000000000001AAA',
    queryDeleted: async () => ({ records: [] }),
  };
  return org;
}

/**
 * Run as the extension ships, never under Stryker, whose workers it names
 * (STRYKER_MUTATOR_WORKER): instrumented, the heap holds the counters as
 * well, and a million rows through counted code took past the five minutes
 * Stryker gives its initial test run on a CI runner, failing it with no test
 * failed.
 */
const describeShipped =
  process.env['STRYKER_MUTATOR_WORKER'] === undefined ? describe : describe.skip;

describeShipped('the readers of a journal of a million records', () => {
  writeTheJournal();

  // A million lines through the disk: under a minute here, past two on a
  // Windows runner's disk. The bound is the one ForgeExecutor.memory.test.ts uses.
  it('removes every record of the run holding a page of ids at a time, not the run', async () => {
    const before = held();
    peak.reset();
    const file = nodeRunFile(journalPath);
    try {
      const part = JournalPart.read(file, 0);
      const records = part?.runRecords();
      if (!records) throw new Error('not read');
      peak.sample();
      const org = targetOrg();

      const outcome = await removeRunRecords(org, records, {
        runStartedAt: new Date('2026-10-14T08:00:00.000Z'),
        runEndedAt: new Date('2026-10-14T09:00:00.000Z'),
        includeChanged: false,
      });

      expect(org.deleted).toBe(RECORDS);
      expect(outcome.objects).toEqual([
        expect.objectContaining({ objectApiName: 'Contact', planned: RECORDS, deleted: RECORDS }),
      ]);
      expect(outcome.gone).toEqual([]);
      for await (const page of outcome.left()) expect(page.ids).toEqual([]);
      // A million ids held as strings, in a plan, its keys and its dates, take
      // several hundred MB; read a page at a time, the indexes of the journal
      // and a date and a mark for each record take a fraction of it.
      expect(peak.value - before).toBeLessThan(250 * 1024 * 1024);
    } finally {
      file.close();
    }
  }, 600_000);

  it('gives the Id map of the run row by row, holding no more than a row', () => {
    const before = held();
    peak.reset();
    const file = nodeRunFile(journalPath);
    try {
      const part = JournalPart.read(file, 0);
      if (!part) throw new Error('not read');
      let rows = 0;
      for (const row of part.idMapRows()) {
        if (++rows % 50_000 === 0) peak.sample();
        if (rows === RECORDS)
          expect(row).toEqual({
            objectApiName: 'Contact',
            sourceId: src(RECORDS - 1),
            targetId: tgt(RECORDS - 1),
            outcome: 'created',
          });
      }
      expect(rows).toBe(RECORDS);
      expect(peak.value - before).toBeLessThan(160 * 1024 * 1024);
    } finally {
      file.close();
    }
  }, 600_000);
});
