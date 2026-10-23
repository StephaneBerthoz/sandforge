import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import { removeRunRecords } from '../forge/ForgeRunRemoval.js';
import { hashA } from '../forge/ForgeRunStore.js';
import { MemoryRemovalOrg } from '../../test/memoryRemovalOrg.js';
import {
  IdSpool,
  IdSpoolWriter,
  RUN_RECORDS_PAGE,
  RecordKeySet,
  SpooledRunRecords,
} from './spooledRunRecords.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** An id in its 18-character form, from a prefix and a number. */
function idOf(prefix: string, n: number): string {
  const id = canonicalRecordId(`${prefix}xx${String(n).padStart(10, '0')}`);
  if (!id) throw new Error(`Not an id: ${prefix} ${n}`);
  return id;
}
const accountId = (n: number): string => idOf('001', n);
const contactId = (n: number): string => idOf('003', n);

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-spooled-records-'));
  made.push(dir);
  return join(dir, 'spool');
}

/** Every page of every object of a spool, in its order. */
async function pagesOf(records: {
  objects: ReadonlyArray<{ objectApiName: string }>;
  pages(objectApiName: string): AsyncIterable<readonly string[]>;
}): Promise<Array<[string, string[]]>> {
  const pages: Array<[string, string[]]> = [];
  for (const { objectApiName } of records.objects) {
    for await (const page of records.pages(objectApiName)) pages.push([objectApiName, [...page]]);
  }
  return pages;
}

describe('RecordKeySet', () => {
  it('holds a record by the first fifteen characters of its id, whichever length it is asked by', () => {
    const keys = new RecordKeySet();

    expect(keys.add(accountId(1), 1)).toBe(true);
    expect(keys.add(accountId(1).slice(0, 15), 2)).toBe(false);

    expect(keys.size).toBe(1);
    expect(keys.has(accountId(1))).toBe(true);
    expect(keys.has(accountId(1).slice(0, 15))).toBe(true);
    expect(keys.flagsOf(accountId(1))).toBe(3);
    expect(keys.has(accountId(2))).toBe(false);
    expect(keys.flagsOf(accountId(2))).toBe(0);
    expect(keys.has('not an id')).toBe(false);
    expect(keys.has(undefined)).toBe(false);
    expect(keys.count((flags) => flags === 3)).toBe(1);
  });

  it('tells apart two records whose keys hash alike, which a set of hashes takes for one', () => {
    // Keys drawn until two share their hash, as two ids of a large org can.
    const seen = new Map<number, string>();
    let pair: [string, string] | undefined;
    for (let n = 0; !pair; n++) {
      const id = accountId(n);
      const hash = hashA(id.slice(0, 15));
      const other = seen.get(hash);
      if (other !== undefined) pair = [other, id];
      else seen.set(hash, id);
    }
    const [held, alike] = pair;
    const keys = new RecordKeySet();

    keys.add(held);

    expect(hashA(held.slice(0, 15))).toBe(hashA(alike.slice(0, 15)));
    expect(keys.has(held)).toBe(true);
    expect(keys.has(alike)).toBe(false);
    keys.add(alike, 4);
    expect(keys.size).toBe(2);
    expect(keys.flagsOf(held)).toBe(0);
    expect(keys.flagsOf(alike)).toBe(4);
  });

  it('keeps every key as it grows past what it first made room for', () => {
    const keys = new RecordKeySet();
    for (let n = 0; n < 5_000; n++) keys.add(contactId(n), n % 2);

    expect(keys.size).toBe(5_000);
    expect(keys.has(contactId(0))).toBe(true);
    expect(keys.has(contactId(4_999))).toBe(true);
    expect(keys.has(contactId(5_000))).toBe(false);
    expect(keys.count((flags) => flags === 1)).toBe(2_500);
  });

  it('refuses to hold what is no Salesforce id', () => {
    expect(() => new RecordKeySet().add('001-not-an-id')).toThrow(RangeError);
  });
});

describe('a spool of ids', () => {
  it('reads back each object’s ids a page at a time, the same pages each time, in the order the objects came, each record once', async () => {
    const writer = new IdSpoolWriter(folder());
    const contacts = Array.from({ length: 5 }, (_, n) => contactId(n));
    for (const id of contacts) await writer.add('Contact', id);
    await writer.add('Account', accountId(1));
    // The same record again, by its fifteen characters: held once.
    expect(await writer.add('Contact', contacts[0].slice(0, 15))).toBe(false);

    const spool = await writer.finish();

    expect(spool.objects).toEqual([
      { objectApiName: 'Contact', count: 5 },
      { objectApiName: 'Account', count: 1 },
    ]);
    expect(spool.count).toBe(6);
    const pages: string[][] = [];
    for await (const page of spool.pages('Contact', 2)) pages.push(page);
    expect(pages).toEqual([contacts.slice(0, 2), contacts.slice(2, 4), contacts.slice(4)]);
    const again: string[][] = [];
    for await (const page of spool.pages('Contact', 2)) again.push(page);
    expect(again).toEqual(pages);
    const none: string[][] = [];
    for await (const page of spool.pages('Opportunity')) none.push(page);
    expect(none).toEqual([]);
  });

  it('hands ids over by pages of two thousand unless asked otherwise, past what it holds in memory before writing', async () => {
    const writer = new IdSpoolWriter(folder());
    const ids = Array.from({ length: RUN_RECORDS_PAGE * 2 + 1 }, (_, n) => accountId(n));
    for (const id of ids) await writer.add('Account', id);

    const spool = await writer.finish();

    const sizes: number[] = [];
    const read: string[] = [];
    for await (const page of spool.pages('Account')) {
      sizes.push(page.length);
      read.push(...page);
    }
    expect(sizes).toEqual([RUN_RECORDS_PAGE, RUN_RECORDS_PAGE, 1]);
    expect(read).toEqual(ids);
  });

  it('keeps its files to their owner, in a folder of their owner’s', async () => {
    const dir = folder();
    const writer = new IdSpoolWriter(dir);
    await writer.add('Account', accountId(1));

    await writer.finish();

    // Windows keeps no POSIX modes: its user profile holds the files apart.
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'Account.ids')).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'spool.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('is read back from its folder as it was written: what a resumed rewind, or its undo, takes up', async () => {
    const dir = folder();
    const writer = new IdSpoolWriter(dir);
    await writer.add('Contact', contactId(1));
    await writer.add('Account', accountId(1));
    await writer.finish();

    const records = await SpooledRunRecords.open(dir);

    expect(records.objects).toEqual([
      { objectApiName: 'Contact', count: 1 },
      { objectApiName: 'Account', count: 1 },
    ]);
    expect(await pagesOf(records)).toEqual([
      ['Contact', [contactId(1)]],
      ['Account', [accountId(1)]],
    ]);
    expect(records.has(accountId(1).slice(0, 15))).toBe(true);
    expect(records.has(accountId(2).slice(0, 15))).toBe(false);
  });

  it('writes an empty spool whole: nothing to read, and nothing taken for a record of it', async () => {
    const dir = folder();

    const records = await SpooledRunRecords.of(new IdSpoolWriter(dir));

    expect(records.objects).toEqual([]);
    expect(await pagesOf(records)).toEqual([]);
    expect((await IdSpool.open(dir)).objects).toEqual([]);
  });

  it('refuses as damaged a spool whose list of objects is not there, or does not read as one', async () => {
    const dir = folder();
    const writer = new IdSpoolWriter(dir);
    await writer.add('Account', accountId(1));
    await writer.finish();
    writeFileSync(join(dir, 'spool.json'), '{"version":2}');

    await expect(IdSpool.open(dir)).rejects.toMatchObject({ code: 'damaged' });
    await expect(IdSpool.open(join(dir, 'elsewhere'))).rejects.toMatchObject({ code: 'damaged' });
  });

  it('refuses as damaged a file changed since it was written: a line that is no id, a line gone, or the file gone', async () => {
    const dir = folder();
    const writer = new IdSpoolWriter(dir);
    for (let n = 0; n < 3; n++) await writer.add('Account', accountId(n));
    const spool = await writer.finish();
    const file = join(dir, 'Account.ids');
    const written = readFileSync(file, 'utf8');
    const read = async (): Promise<string[]> => {
      const ids: string[] = [];
      for await (const page of spool.pages('Account')) ids.push(...page);
      return ids;
    };

    writeFileSync(file, written.replace(accountId(1), 'not-an-id'));
    await expect(read()).rejects.toMatchObject({ code: 'damaged' });
    writeFileSync(file, written.split('\n').slice(1).join('\n'));
    await expect(read()).rejects.toMatchObject({ code: 'damaged' });
    rmSync(file);
    await expect(read()).rejects.toMatchObject({ code: 'damaged' });
    await expect(SpooledRunRecords.open(dir)).rejects.toMatchObject({ code: 'damaged' });
  });

  it('is the plan a removal takes: read a page at a time, its records deleted children first, and nothing else', async () => {
    const org = new MemoryRemovalOrg({
      Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
    });
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    for (let n = 0; n < 3; n++) org.add('Account', { Id: accountId(n) }, at);
    for (let n = 0; n < 5; n++)
      org.add('Contact', { Id: contactId(n), AccountId: accountId(n % 3) }, at);
    // A record the plan does not hold.
    org.add('Account', { Id: accountId(9) }, at);
    const writer = new IdSpoolWriter(folder());
    for (let n = 0; n < 5; n++) await writer.add('Contact', contactId(n));
    for (let n = 0; n < 3; n++) await writer.add('Account', accountId(n));
    const records = await SpooledRunRecords.of(writer);

    const outcome = await removeRunRecords(org, records, {
      runStartedAt: new Date(Date.now() - 11 * 60_000),
      runEndedAt: new Date(Date.now() - 9 * 60_000),
      includeChanged: false,
    });

    expect(outcome.cancelled).toBe(false);
    expect(outcome.objects.map(({ objectApiName, deleted }) => [objectApiName, deleted])).toEqual([
      ['Contact', 5],
      ['Account', 3],
    ]);
    expect(org.all('Account').map((row) => row.Id)).toEqual([accountId(9)]);
    expect(org.all('Contact')).toEqual([]);
    const left: string[] = [];
    for await (const { ids } of outcome.left()) left.push(...ids);
    expect(left).toEqual([]);
  });
});
