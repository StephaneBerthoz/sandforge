import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdSpool, idsFileOf } from '../../modules/checkpoint/spooledRunRecords.js';
import type { QueryPage } from '../../modules/forge/queryAllPages.js';
import type { Connection } from 'jsforce';
import { spoolTableIds, tableIdSourceOf, tableIdsQuery, type TableIdSource } from './tableIds.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The ids of whole tables, read a page at a time and written to disk as they
 * come, then read back from it a page at a time.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

type Row = Record<string, unknown>;

/**
 * An org that answers each statement with the ids it holds for its object,
 * `pageSize` a page behind a cursor, and keeps what it was asked: each
 * statement and whether it read the recycle bin, and each next page.
 */
class TableOrg implements TableIdSource {
  readonly asked: Array<{ soql: string; scanAll: boolean }> = [];
  readonly next: string[] = [];
  /** Called as each page after the first is asked. */
  onNext?: (url: string) => Promise<void> | void;
  private readonly cursors = new Map<string, string[]>();

  constructor(
    private readonly tables: Record<string, string[]>,
    private readonly pageSize = 2,
  ) {}

  private page(cursor: string): QueryPage<Row> {
    const left = this.cursors.get(cursor) ?? [];
    const records = left.splice(0, this.pageSize).map((Id) => ({ Id }));
    const done = left.length === 0;
    return { records, done, ...(done ? {} : { nextRecordsUrl: `/query/${cursor}` }) };
  }

  async query(soql: string, options?: { scanAll?: boolean }): Promise<QueryPage<Row>> {
    this.asked.push({ soql, scanAll: options?.scanAll === true });
    const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
    const cursor = `${object}-${this.asked.length}`;
    this.cursors.set(cursor, [...(this.tables[object] ?? [])]);
    return this.page(cursor);
  }

  async queryMore(url: string): Promise<QueryPage<Row>> {
    this.next.push(url);
    await this.onNext?.(url);
    return this.page(url.replace('/query/', ''));
  }
}

let dir: string;

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'table-ids-')), 'spool');
});

afterEach(async () => {
  await rm(join(dir, '..'), { recursive: true, force: true });
});

/** Every id a spool holds of an object, read back a page at a time. */
async function readBack(spool: IdSpool, objectApiName: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const page of spool.pages(objectApiName)) ids.push(...page);
  return ids;
}

const CONTACTS = Array.from({ length: 5 }, (_, n) => fakeId('003', n));
const TASKS = Array.from({ length: 3 }, (_, n) => fakeId('00T', n));

describe('tableIdsQuery', () => {
  it('reads every record of a table, or those a condition keeps', () => {
    expect(tableIdsQuery({ objectApiName: 'Contact' })).toEqual({
      soql: 'SELECT Id FROM Contact',
      scanAll: false,
    });
    expect(tableIdsQuery({ objectApiName: 'Contact', filter: 'AccountId = null' })).toEqual({
      soql: 'SELECT Id FROM Contact WHERE (AccountId = null)',
      scanAll: false,
    });
  });

  it('reads tasks and events through queryAll, for the archived ones, the deleted ones left out', () => {
    expect(tableIdsQuery({ objectApiName: 'Task' })).toEqual({
      soql: 'SELECT Id FROM Task WHERE IsDeleted = false',
      scanAll: true,
    });
    expect(tableIdsQuery({ objectApiName: 'Event', filter: 'WhatId != null' })).toEqual({
      soql: 'SELECT Id FROM Event WHERE (WhatId != null) AND IsDeleted = false',
      scanAll: true,
    });
  });

  it('refuses an object name that is no SOQL identifier', () => {
    expect(() => tableIdsQuery({ objectApiName: 'Contact; DELETE' })).toThrow();
  });
});

describe('spoolTableIds', () => {
  it('follows each cursor to its end and writes every id to disk, read back a page at a time in the order the org gave them', async () => {
    const org = new TableOrg({ Contact: CONTACTS, Task: TASKS });

    const read = await spoolTableIds(org, dir, [
      { objectApiName: 'Contact' },
      { objectApiName: 'Task' },
    ]);

    if (read.stopped) throw new Error('stopped');
    expect(read.spool.objects).toEqual([
      { objectApiName: 'Contact', count: 5 },
      { objectApiName: 'Task', count: 3 },
    ]);
    expect(org.asked).toEqual([
      { soql: 'SELECT Id FROM Contact', scanAll: false },
      { soql: 'SELECT Id FROM Task WHERE IsDeleted = false', scanAll: true },
    ]);
    expect(org.next).toHaveLength(3);
    const spool = await IdSpool.open(dir);
    expect(await readBack(spool, 'Contact')).toEqual(CONTACTS);
    expect(await readBack(spool, 'Task')).toEqual(TASKS);
  });

  it('holds no more than a page: each is on disk before the next is asked', async () => {
    const org = new TableOrg({ Contact: CONTACTS });
    const onDisk: number[] = [];
    org.onNext = async () => {
      const text = await readFile(idsFileOf(dir, 'Contact'), 'utf8');
      onDisk.push(text.split('\n').filter(Boolean).length);
    };

    await spoolTableIds(org, dir, [{ objectApiName: 'Contact' }]);

    expect(onDisk).toEqual([2, 4]);
  });

  it('reads a table of no record as one, with no file to read', async () => {
    const org = new TableOrg({});

    const read = await spoolTableIds(org, dir, [{ objectApiName: 'Contact' }]);

    if (read.stopped) throw new Error('stopped');
    expect(read.spool.objects).toEqual([{ objectApiName: 'Contact', count: 0 }]);
    expect(await readBack(await IdSpool.open(dir), 'Contact')).toEqual([]);
  });

  it('stops between two pages, says how far it read, and leaves no spool', async () => {
    const org = new TableOrg({ Contact: CONTACTS });
    const stop = new AbortController();
    const told: number[] = [];

    const read = await spoolTableIds(org, dir, [{ objectApiName: 'Contact' }], {
      signal: stop.signal,
      onPage: (_object, count) => {
        told.push(count);
        if (count >= 2) stop.abort();
      },
    });

    expect(read).toEqual({ stopped: true, read: [{ objectApiName: 'Contact', count: 2 }] });
    expect(told).toEqual([2]);
    expect(org.next).toEqual([]);
    await expect(IdSpool.open(dir)).rejects.toThrow();
  });

  it('refuses a row with no record id rather than write it', async () => {
    const org = new TableOrg({ Contact: ['not an id'] });

    await expect(spoolTableIds(org, dir, [{ objectApiName: 'Contact' }])).rejects.toThrow(
      'The org answered a Contact row with no record id',
    );
  });

  it('refuses a cursor that keeps answering empty pages without saying it is done', async () => {
    const org: TableIdSource = {
      query: async () => ({ records: [], done: false, nextRecordsUrl: '/query/empty' }),
      queryMore: async () => ({ records: [], done: false, nextRecordsUrl: '/query/empty' }),
    };

    await expect(spoolTableIds(org, dir, [{ objectApiName: 'Contact' }])).rejects.toThrow(
      'kept answering empty pages of Contact',
    );
  });

  it('writes its files for this user alone', async () => {
    const org = new TableOrg({ Contact: CONTACTS });

    await spoolTableIds(org, dir, [{ objectApiName: 'Contact' }]);

    expect((await stat(dir)).mode & 0o077).toBe(0);
    for (const name of await readdir(dir)) {
      expect((await stat(join(dir, name))).mode & 0o077).toBe(0);
    }
  });
});

describe('tableIdSourceOf', () => {
  it('reads a first page through queryAll when asked, through query otherwise, and follows the cursor it names', async () => {
    const asked: unknown[] = [];
    const conn = {
      query: async (soql: string, options: unknown) => {
        asked.push(['query', soql, options]);
        return { records: [], done: true };
      },
      queryMore: async (url: string) => {
        asked.push(['queryMore', url]);
        return { records: [], done: true };
      },
    };
    const source = tableIdSourceOf(conn as unknown as Connection);

    await source.query('SELECT Id FROM Task WHERE IsDeleted = false', { scanAll: true });
    await source.query('SELECT Id FROM Contact');
    await source.queryMore('/services/data/v66.0/query/01g-2000');

    expect(asked).toEqual([
      ['query', 'SELECT Id FROM Task WHERE IsDeleted = false', { scanAll: true }],
      ['query', 'SELECT Id FROM Contact', { scanAll: false }],
      ['queryMore', '/services/data/v66.0/query/01g-2000'],
    ]);
  });
});
