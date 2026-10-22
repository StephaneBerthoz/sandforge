import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compositeOrg,
  stampedRows,
  type CompositeOrgOptions,
  type FakeOrgCall,
  type FakeOrgRow,
} from '../../test/compositeOrg.js';
import { FORGE_QUERY_MAX_RECORDS } from '../forge/queryAllPages.js';
import { OrgReadStopped, compositeReader, type OrgRow } from './compositeQueries.js';
import {
  ENDED_BEFORE_DONE,
  binLedgerRead,
  changeReadsFrom,
  countRead,
  countRecords,
  deletedRead,
  idScanRead,
  movedRead,
  preCheck,
  preCheckRead,
  readChanges,
  readStreams,
  soqlInstant,
  spoolReads,
  spooledRows,
  streamRead,
} from './orgStreams.js';

/** T0, with milliseconds, as the org's clock gives it. */
const T0 = '2026-10-22T14:05:12.731Z';
/** Long before the checkpoint. */
const BEFORE = '2026-10-01T09:00:00Z';
/** After the checkpoint. */
const SINCE = '2026-10-22T15:00:00Z';

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'sandforge-org-streams-'));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** The composites of `calls`, each as its subrequests. */
function composites(calls: readonly FakeOrgCall[]): string[][] {
  return calls.flatMap((call) => (call.kind === 'composite' ? [call.subrequests] : []));
}

/** Every row of a spool file. */
async function rowsIn(file: string): Promise<OrgRow[]> {
  const rows: OrgRow[] = [];
  for await (const row of spooledRows(file)) rows.push(row);
  return rows;
}

/** A reader over a fake org holding `tables`. */
function readerOf(tables: Record<string, FakeOrgRow[]>, options: CompositeOrgOptions = {}) {
  const org = compositeOrg({ tables, ...options });
  return { org, reader: compositeReader(org.conn) };
}

describe('the statements: literals to the second, as the org reads them', () => {
  it('writes an instant to the second, rounded down, whatever its milliseconds or offset', () => {
    expect(soqlInstant('2026-10-22T14:05:12.731Z')).toBe('2026-10-22T14:05:12Z');
    expect(soqlInstant('2026-10-22T16:05:12.999+02:00')).toBe('2026-10-22T14:05:12Z');
    expect(soqlInstant(Date.parse('2026-10-22T14:05:12Z'))).toBe('2026-10-22T14:05:12Z');
    expect(() => soqlInstant('soon')).toThrow(/Not a date/);
  });

  it('starts the change reads five minutes before the checkpoint, to the second', () => {
    expect(changeReadsFrom(T0)).toBe('2026-10-22T14:00:12Z');
  });

  it('reads the bin at the checkpoint as what is stamped before its second, with queryAll', () => {
    expect(binLedgerRead('Account', T0)).toEqual({
      objectApiName: 'Account',
      soql: 'SELECT Id FROM Account WHERE IsDeleted = true AND SystemModstamp < 2026-10-22T14:05:12Z',
      scanAll: true,
    });
  });

  it('reads what moved and what was deleted since the change reads’ start, the cascade parent fields beside the stamps', () => {
    expect(movedRead('Contact', 'query', T0, ['AccountId', 'Id'])).toEqual({
      objectApiName: 'Contact',
      soql:
        'SELECT Id, SystemModstamp, CreatedDate, LastModifiedDate, LastModifiedById, AccountId ' +
        'FROM Contact WHERE SystemModstamp >= 2026-10-22T14:00:12Z',
      scanAll: false,
    });
    expect(deletedRead('Contact', T0, ['AccountId'])).toEqual({
      objectApiName: 'Contact',
      soql:
        'SELECT Id, SystemModstamp, CreatedDate, AccountId FROM Contact ' +
        'WHERE IsDeleted = true AND SystemModstamp >= 2026-10-22T14:00:12Z',
      scanAll: true,
    });
  });

  it('reads Tasks and Events with queryAll and IsDeleted = false everywhere, archived ones among them', () => {
    expect(movedRead('Task', 'scanAllLive', T0)).toMatchObject({
      soql: expect.stringMatching(
        /FROM Task WHERE SystemModstamp >= 2026-10-22T14:00:12Z AND IsDeleted = false$/,
      ),
      scanAll: true,
    });
    expect(countRead('Event', 'scanAllLive')).toEqual({
      objectApiName: 'Event',
      soql: 'SELECT COUNT() FROM Event WHERE IsDeleted = false',
      scanAll: true,
    });
    expect(idScanRead('Task', 'scanAllLive')).toEqual({
      objectApiName: 'Task',
      soql: 'SELECT Id FROM Task WHERE IsDeleted = false',
      scanAll: true,
    });
    expect(countRead('Case', 'query')).toEqual({
      objectApiName: 'Case',
      soql: 'SELECT COUNT() FROM Case',
      scanAll: false,
    });
    expect(idScanRead('Case', 'query').soql).toBe('SELECT Id FROM Case');
  });

  it('pre-checks with queryAll, the recycle bin and archived activities included', () => {
    expect(preCheckRead('Account')).toEqual({
      objectApiName: 'Account',
      soql: 'SELECT SystemModstamp FROM Account ORDER BY SystemModstamp DESC LIMIT 1',
      scanAll: true,
    });
  });

  it('refuses an object or a field that is no API name', () => {
    expect(() => preCheckRead('Account WHERE x')).toThrow(/Invalid Salesforce object/);
    expect(() => movedRead('Contact', 'query', T0, ['AccountId, Name'])).toThrow(
      /Invalid Salesforce API name/,
    );
  });

  it('selects the bin at the checkpoint exactly: a record deleted in T0’s own second, before T0, is not in it', async () => {
    const { reader } = readerOf({
      Account: [
        { Id: 'BEFORE', SystemModstamp: '2026-10-22T14:05:11.000Z', IsDeleted: true },
        { Id: 'SAME_SECOND', SystemModstamp: '2026-10-22T14:05:12.000Z', IsDeleted: true },
        { Id: 'LIVE', SystemModstamp: BEFORE },
      ],
    });
    const ids: unknown[] = [];

    await readStreams(reader, [binLedgerRead('Account', T0)], (_, rows) => {
      ids.push(...rows.map((row) => row.Id));
    });

    expect(ids).toEqual(['BEFORE']);
  });
});

describe('streamRead: whole, or failed', () => {
  it('fails a read whose cursor says it is not done and names no next page, with the rows it did take', async () => {
    const { org } = readerOf(
      { Account: stampedRows('Account', 10, SINCE) },
      { pageSize: () => 4, brokenCursor: () => 'noNextPage' },
    );

    const outcome = await streamRead(org.conn, idScanRead('Account', 'query'), () => undefined);

    expect(outcome).toEqual({
      objectApiName: 'Account',
      read: false,
      rows: 4,
      reason: ENDED_BEFORE_DONE,
    });
  });

  it('fails a read whose cursor answers empty pages without end, once five came in a row', async () => {
    const { org } = readerOf(
      { Account: stampedRows('Account', 10, SINCE) },
      { pageSize: () => 4, brokenCursor: () => 'emptyPages' },
    );

    const outcome = await streamRead(org.conn, idScanRead('Account', 'query'), () => undefined);

    expect(outcome).toMatchObject({ read: false, rows: 4, reason: ENDED_BEFORE_DONE });
    expect(org.calls.filter((call) => call.kind === 'queryMore')).toHaveLength(5);
  });

  it('fails a read whose page could not be taken, with why', async () => {
    const { org } = readerOf({ Account: stampedRows('Account', 3, SINCE) });

    const outcome = await streamRead(org.conn, idScanRead('Account', 'query'), () => {
      throw new Error('ENOSPC: no space left on device');
    });

    expect(outcome).toEqual({
      objectApiName: 'Account',
      read: false,
      rows: 0,
      reason: 'ENOSPC: no space left on device',
    });
  });

  it('reads the recycle bin when the read asks it, through any source that can', async () => {
    const { org } = readerOf({
      Account: [
        { Id: 'GONE', SystemModstamp: SINCE, IsDeleted: true, CreatedDate: BEFORE },
        { Id: 'LIVE', SystemModstamp: SINCE, CreatedDate: BEFORE },
      ],
    });
    const ids: unknown[] = [];

    const outcome = await streamRead(org.conn, deletedRead('Account', T0), (rows) => {
      ids.push(...rows.map((row) => row.Id));
    });

    expect(outcome).toEqual({ objectApiName: 'Account', read: true, rows: 1, totalSize: 1 });
    expect(ids).toEqual(['GONE']);
  });
});

describe('readStreams: five objects a call, their cursors drained before the next five', () => {
  it('reads 2,001 records deleted since and 50,001 changed since whole, past any cap, in pages of any size', async () => {
    const sizes = [2_000, 1_972, 2_000, 7];
    const { reader } = readerOf(
      {
        Contact: stampedRows('Contact', 2_001, SINCE, { IsDeleted: true, CreatedDate: BEFORE }),
        Account: stampedRows('Account', FORGE_QUERY_MAX_RECORDS + 1, SINCE, {
          CreatedDate: BEFORE,
        }),
      },
      { pageSize: (page) => sizes[page % sizes.length] },
    );
    const taken = [0, 0];

    const outcomes = await readStreams(
      reader,
      [deletedRead('Contact', T0), movedRead('Account', 'query', T0)],
      (index, rows) => {
        taken[index] += rows.length;
      },
    );

    expect(outcomes.map((outcome) => outcome.read && outcome.rows)).toEqual([2_001, 50_001]);
    expect(taken).toEqual([2_001, 50_001]);
  });

  it('fails the read whose cursor the org released, and reads the others whole', async () => {
    const { reader } = readerOf(
      {
        Account: stampedRows('Account', 10, SINCE),
        Contact: stampedRows('Contact', 10, SINCE),
      },
      { pageSize: () => 4, cursorLimit: 1 },
    );

    const outcomes = await readStreams(
      reader,
      [idScanRead('Account', 'query'), idScanRead('Contact', 'query')],
      () => undefined,
    );

    expect(outcomes).toEqual([
      {
        objectApiName: 'Account',
        read: false,
        rows: 4,
        reason: 'INVALID_QUERY_LOCATOR: invalid query locator',
      },
      { objectApiName: 'Contact', read: true, rows: 10, totalSize: 10 },
    ]);
  });

  it('opens the next five cursors only once the five before them are drained', async () => {
    const objects = ['Account', 'Contact', 'Case', 'Lead', 'Opportunity', 'Task'];
    const { org, reader } = readerOf(
      Object.fromEntries(objects.map((object) => [object, stampedRows(object, 9, SINCE)])),
      { pageSize: () => 4 },
    );

    const outcomes = await readStreams(
      reader,
      objects.map((object) => idScanRead(object, 'query')),
      () => undefined,
    );

    expect(outcomes.every((outcome) => outcome.read && outcome.rows === 9)).toBe(true);
    expect(composites(org.calls).map((subs) => subs.map((sub) => sub.split(':')[0]))).toEqual([
      ['query', 'query', 'query', 'query', 'query'],
      ['next', 'next', 'next', 'next', 'next'],
      ['next', 'next', 'next', 'next', 'next'],
      ['query'],
      ['next'],
      ['next'],
    ]);
  });

  it('stops between two pages when the run is stopped', async () => {
    const stop = new AbortController();
    const { org } = readerOf({ Account: stampedRows('Account', 10, SINCE) }, { pageSize: () => 4 });
    const reader = compositeReader(org.conn, stop.signal);

    await expect(
      readStreams(
        reader,
        [idScanRead('Account', 'query')],
        () => {
          stop.abort();
        },
        stop.signal,
      ),
    ).rejects.toBeInstanceOf(OrgReadStopped);
    expect(composites(org.calls)).toHaveLength(1);
  });
});

describe('spoolReads', () => {
  it('writes each row to its read’s file as pages arrive, without the org’s attributes, readable by its owner alone', async () => {
    const { reader } = readerOf(
      {
        Account: stampedRows('Account', 5, SINCE, { CreatedDate: BEFORE, LastModifiedById: 'U1' }),
      },
      { pageSize: () => 2 },
    );
    const file = join(folder, 'preview', 'Account.live.ndjson');

    const [outcome] = await spoolReads(reader, [{ ...movedRead('Account', 'query', T0), file }]);
    const rows = await rowsIn(file);

    expect(outcome).toMatchObject({ read: true, rows: 5 });
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      Id: 'ACC000000000000AAA',
      SystemModstamp: '2026-10-22T15:00:00.000Z',
      CreatedDate: BEFORE,
      LastModifiedDate: null,
      LastModifiedById: 'U1',
    });
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(folder, 'preview')).mode & 0o777).toBe(0o700);
    }
  });

  it('leaves an empty file for a read that found nothing, and no file for one that failed', async () => {
    const { reader } = readerOf(
      { Account: [], Contact: stampedRows('Contact', 10, SINCE) },
      {
        pageSize: () => 4,
        brokenCursor: (soql) => (soql.includes('Contact') ? 'noNextPage' : undefined),
      },
    );
    const empty = join(folder, 'Account.ids');
    const failed = join(folder, 'Contact.ids');

    const outcomes = await spoolReads(reader, [
      { ...idScanRead('Account', 'query'), file: empty },
      { ...idScanRead('Contact', 'query'), file: failed },
    ]);

    expect(outcomes.map((outcome) => outcome.read)).toEqual([true, false]);
    expect(await readFile(empty, 'utf8')).toBe('');
    await expect(readFile(failed, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a spool line that holds no record', async () => {
    const { reader } = readerOf({ Account: [] });
    const file = join(folder, 'Account.ids');
    await spoolReads(reader, [{ ...idScanRead('Account', 'query'), file }]);
    await appendFile(file, '[1,2]\n');

    await expect(rowsIn(file)).rejects.toThrow(/holds a line that is no record/);
  });
});

describe('preCheck', () => {
  it('says an object moved when its newest record, live or in the bin, is stamped since the change reads’ start', async () => {
    const { org, reader } = readerOf({
      // Deleted since: the bin holds the newest stamp.
      Account: [
        { Id: 'A1', SystemModstamp: BEFORE },
        { Id: 'A2', SystemModstamp: SINCE, IsDeleted: true },
      ],
      // Untouched since long before.
      Contact: [{ Id: 'C1', SystemModstamp: BEFORE }],
      // Changed four minutes before T0: inside the overlap, so it counts.
      Case: [{ Id: 'K1', SystemModstamp: '2026-10-22T14:01:00Z' }],
      // An archived task changed since: queryAll reads it.
      Task: [{ Id: 'T1', SystemModstamp: SINCE, IsArchived: true }],
      // No record at all.
      Event: [],
    });

    const checks = await preCheck(reader, ['Account', 'Contact', 'Case', 'Task', 'Event'], T0);

    expect(checks).toEqual([
      { objectApiName: 'Account', latest: '2026-10-22T15:00:00.000Z', moved: true },
      { objectApiName: 'Contact', latest: '2026-10-01T09:00:00.000Z', moved: false },
      { objectApiName: 'Case', latest: '2026-10-22T14:01:00.000Z', moved: true },
      { objectApiName: 'Task', latest: '2026-10-22T15:00:00.000Z', moved: true },
      { objectApiName: 'Event', latest: null, moved: false },
    ]);
    expect(composites(org.calls).map((subs) => subs.length)).toEqual([5]);
  });

  it('says an object stamped in the change reads’ first second moved, as the reads select it', async () => {
    const { reader } = readerOf({
      Account: [{ Id: 'A1', SystemModstamp: '2026-10-22T14:00:12.000Z' }],
      Contact: [{ Id: 'C1', SystemModstamp: '2026-10-22T14:00:11.000Z' }],
    });

    const checks = await preCheck(reader, ['Account', 'Contact'], T0);

    expect(checks.map((check) => 'moved' in check && check.moved)).toEqual([true, false]);
  });

  it('names an object the org would not pre-check, and one that answered no date', async () => {
    const { reader } = readerOf({ Account: [{ Id: 'A1', SystemModstamp: 'yesterday' }] });

    const checks = await preCheck(reader, ['Account', 'Missing__c'], T0);

    expect(checks).toEqual([
      { objectApiName: 'Account', unread: 'Account answered a SystemModstamp that is not a date.' },
      {
        objectApiName: 'Missing__c',
        unread: "INVALID_TYPE: sObject type 'Missing__c' is not supported.",
      },
    ]);
  });
});

describe('countRecords', () => {
  it('counts live records, five objects a call, Tasks with their archived ones and none of the bin', async () => {
    const { org, reader } = readerOf({
      Account: stampedRows('Account', 4, BEFORE),
      Task: [
        { Id: 'T1', SystemModstamp: BEFORE },
        { Id: 'T2', SystemModstamp: BEFORE, IsArchived: true },
        { Id: 'T3', SystemModstamp: BEFORE, IsDeleted: true },
      ],
    });

    const counts = await countRecords(reader, [
      { objectApiName: 'Account', readMode: 'query' },
      { objectApiName: 'Task', readMode: 'scanAllLive' },
      { objectApiName: 'Missing__c', readMode: 'query' },
    ]);

    expect(counts).toEqual([
      { objectApiName: 'Account', count: 4 },
      { objectApiName: 'Task', count: 2 },
      {
        objectApiName: 'Missing__c',
        unread: "INVALID_TYPE: sObject type 'Missing__c' is not supported.",
      },
    ]);
    expect(composites(org.calls)).toHaveLength(1);
  });
});

describe('readChanges', () => {
  it('reads what moved and was deleted since only for the objects that moved, and counts those and the ones the checkpoint holds', async () => {
    const { org, reader } = readerOf({
      Account: [
        { Id: 'A_OLD', SystemModstamp: BEFORE, CreatedDate: BEFORE },
        { Id: 'A_NEW', SystemModstamp: SINCE, CreatedDate: SINCE },
        { Id: 'A_GONE', SystemModstamp: SINCE, CreatedDate: BEFORE, IsDeleted: true },
        { Id: 'A_BIN', SystemModstamp: BEFORE, CreatedDate: BEFORE, IsDeleted: true },
      ],
      Contact: [{ Id: 'C_OLD', SystemModstamp: BEFORE, CreatedDate: BEFORE }],
      Lead: [],
    });

    const changes = await readChanges(
      reader,
      [
        { objectApiName: 'Account', readMode: 'query', held: true },
        { objectApiName: 'Contact', readMode: 'query', held: true },
        { objectApiName: 'Lead', readMode: 'query', held: false },
      ],
      T0,
      folder,
    );

    expect(changes).toEqual([
      {
        objectApiName: 'Account',
        latest: '2026-10-22T15:00:00.000Z',
        moved: true,
        live: { file: join(folder, 'Account.live.ndjson'), rows: 1 },
        deleted: { file: join(folder, 'Account.deleted.ndjson'), rows: 1 },
        count: 2,
      },
      { objectApiName: 'Contact', latest: '2026-10-01T09:00:00.000Z', moved: false, count: 1 },
      { objectApiName: 'Lead', latest: null, moved: false },
    ]);
    expect((await rowsIn(join(folder, 'Account.live.ndjson'))).map((row) => row.Id)).toEqual([
      'A_NEW',
    ]);
    expect((await rowsIn(join(folder, 'Account.deleted.ndjson'))).map((row) => row.Id)).toEqual([
      'A_GONE',
    ]);
    // Pre-checks, then L and D of the one object that moved, then two counts.
    expect(composites(org.calls).map((subs) => subs.length)).toEqual([3, 2, 2]);
  });

  it('names an object one of whose reads failed as unread, never as unchanged, and reads the others', async () => {
    const { reader } = readerOf(
      {
        Account: stampedRows('Account', 10, SINCE, { CreatedDate: BEFORE }),
        Contact: stampedRows('Contact', 3, SINCE, { CreatedDate: BEFORE }),
      },
      {
        pageSize: () => 4,
        brokenCursor: (soql) =>
          soql.startsWith('SELECT Id, SystemModstamp, CreatedDate, LastModifiedDate') &&
          soql.includes('FROM Account')
            ? 'emptyPages'
            : undefined,
      },
    );

    const changes = await readChanges(
      reader,
      [
        { objectApiName: 'Account', readMode: 'query', held: true },
        { objectApiName: 'Contact', readMode: 'query', held: true },
      ],
      T0,
      folder,
    );

    expect(changes[0]).toEqual({ objectApiName: 'Account', unread: ENDED_BEFORE_DONE });
    expect(changes[1]).toMatchObject({ objectApiName: 'Contact', moved: true, count: 3 });
    await expect(readFile(join(folder, 'Account.live.ndjson'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
