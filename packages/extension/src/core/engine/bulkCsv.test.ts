import { Writable } from 'node:stream';
import jsforce from 'jsforce';
import type { Connection } from 'jsforce';
import { describe, expect, it } from 'vitest';
import { BULK_NULL_CELL, buildBulkCsv, resultCells, rowKey } from './bulkCsv.js';

/** The rows a Frozen load writes: every empty value left out, so their fields differ. */
const PROBE_ROWS: Record<string, unknown>[] = [
  { Name: 'Row 0', Unit__c: 'EACH' },
  { Name: 'Row 1' },
  { Name: 'Row 2', Unit__c: 'BOX', Description: 'second row has no unit, third a description' },
];

describe('buildBulkCsv', () => {
  it('writes a header naming every field any row carries, and leaves a cell empty where a row carries no value', () => {
    // jsforce wrote the header from the first row alone: the description of
    // the third row was dropped, and the target created it without one.
    const csv = buildBulkCsv('insert', PROBE_ROWS);

    expect(csv.columns).toEqual(['Name', 'Unit__c', 'Description']);
    expect(csv.text).toBe(
      'Name,Unit__c,Description\n' +
        'Row 0,EACH,\n' +
        'Row 1,,\n' +
        'Row 2,BOX,"second row has no unit, third a description"\n',
    );
    expect(csv.rows).toEqual([
      ['Row 0', 'EACH', ''],
      ['Row 1', '', ''],
      ['Row 2', 'BOX', 'second row has no unit, third a description'],
    ]);
  });

  it('sends a null as #N/A, which blanks the field, and an absent value as an empty cell, which leaves it alone', () => {
    const csv = buildBulkCsv('update', [
      { Id: '001000000000001AAA', Description: null },
      { Id: '001000000000002AAA', Phone: '0102030405' },
    ]);

    expect(csv.text).toBe(
      'Id,Description,Phone\n' +
        `001000000000001AAA,${BULK_NULL_CELL},\n` +
        '001000000000002AAA,,0102030405\n',
    );
  });

  it('quotes a cell holding a comma, a quote or a line break, and nothing else', () => {
    const csv = buildBulkCsv('insert', [
      { Name: 'a, b', Description: 'say "hi"', Notes__c: 'one\ntwo', Code__c: 'a;b|c ' },
    ]);

    expect(csv.text).toBe(
      'Name,Description,Notes__c,Code__c\n"a, b","say ""hi""","one\ntwo",a;b|c \n',
    );
  });

  it('writes checkboxes, numbers and dates as text, and the fields of a related record as columns of their own', () => {
    const csv = buildBulkCsv('upsert', [
      {
        Ext__c: 'E-1',
        Active__c: true,
        Quantity__c: 3,
        Seen__c: new Date('2026-10-02T10:00:00.000Z'),
        Account: { attributes: { type: 'Account' }, External__c: 'A-1' },
      },
    ]);

    expect(csv.columns).toEqual([
      'Ext__c',
      'Active__c',
      'Quantity__c',
      'Seen__c',
      'Account.External__c',
    ]);
    expect(csv.rows[0]).toEqual(['E-1', 'true', '3', '2026-10-02T10:00:00.000Z', 'A-1']);
  });

  it('leaves out attributes and type, sends no Id on an insert, and nothing but the Id on a delete', () => {
    const record = {
      attributes: { type: 'Account', url: '/x' },
      type: 'Account',
      Id: '001000000000001AAA',
      Name: 'Acme',
    };

    expect(buildBulkCsv('insert', [record]).columns).toEqual(['Name']);
    expect(buildBulkCsv('update', [record]).columns).toEqual(['Id', 'Name']);
    expect(buildBulkCsv('delete', [record]).text).toBe('Id\n001000000000001AAA\n');
    expect(buildBulkCsv('hardDelete', [record]).columns).toEqual(['Id']);
  });

  it('names a field written in two cases once, as the first row named it', () => {
    // The platform reads field names without case: a header naming one twice
    // is refused, and every row with it.
    const csv = buildBulkCsv('insert', [
      { Name: 'a', description: 'first' },
      { Name: 'b', Description: 'second' },
    ]);

    expect(csv.columns).toEqual(['Name', 'description']);
    expect(csv.rows).toEqual([
      ['a', 'first'],
      ['b', 'second'],
    ]);
  });

  it('quotes the only cell of a row when it is empty, so the row is not a blank line', () => {
    const csv = buildBulkCsv('delete', [{ Id: '001000000000001AAA' }, {}]);

    expect(csv.text).toBe('Id\n001000000000001AAA\n""\n');
  });

  it('identifies a row by its Id on an update or a delete, by its external id on an upsert, and by every cell on an insert', () => {
    const rows = [{ Id: '001000000000001AAA', ext__c: 'E-1', Name: 'a' }];

    expect(buildBulkCsv('update', rows).identity).toEqual([0]);
    expect(buildBulkCsv('delete', rows).identity).toEqual([0]);
    expect(buildBulkCsv('upsert', rows, 'Ext__c').identity).toEqual([1]);
    expect(buildBulkCsv('insert', rows).identity).toEqual([0, 1]);
    // An upsert whose rows lack the key column is matched on all of them.
    expect(buildBulkCsv('upsert', [{ Name: 'a', Phone: '1' }], 'Ext__c').identity).toEqual([0, 1]);
  });
});

describe('rowKey', () => {
  /** The key of a result row that echoes `echo` under the upload's columns. */
  const echoKey = (
    csv: ReturnType<typeof buildBulkCsv>,
    echo: Record<string, string>,
    match: 'exact' | 'canonical',
  ): string => rowKey(resultCells(csv.columns, echo), csv.identity, match);

  it('finds a row in the results by the cells it was sent with, whatever fields its record carried', () => {
    // The results echo every column of the header: the second row comes back
    // with an empty unit and description, which its record never named.
    const csv = buildBulkCsv('insert', PROBE_ROWS);
    const echo = {
      sf__Id: '01t000000000002AAA',
      sf__Created: 'true',
      Name: 'Row 1',
      Unit__c: '',
      Description: '',
    };

    expect(echoKey(csv, echo, 'exact')).toBe(rowKey(csv.rows[1], csv.identity, 'exact'));
    expect(echoKey(csv, echo, 'exact')).not.toBe(rowKey(csv.rows[0], csv.identity, 'exact'));
  });

  it('reads a null, sent as #N/A, and a line break as the results echo them', () => {
    const csv = buildBulkCsv('insert', [{ Name: 'a', Description: null, Notes__c: 'one\r\ntwo' }]);
    const echo = { Name: 'a', Description: '', Notes__c: 'one\ntwo' };

    expect(echoKey(csv, echo, 'exact')).toBe(rowKey(csv.rows[0], csv.identity, 'exact'));
  });

  it('matches a number, a checkbox, a date and a record id in the form the platform writes them back', () => {
    // As a real target echoed them: 3 as 3.0, 1.50 as 1.5, TRUE as true, a
    // date and time with its milliseconds and in UTC, an id in 18 characters.
    const csv = buildBulkCsv('insert', [
      {
        Quantity__c: 3,
        Price__c: '1.50',
        Active__c: 'TRUE',
        Seen__c: '2026-10-02T12:00:00.000+0200',
        Since__c: '2026-10-02T10:00:00',
        Parent__c: '001Fk00000AbCdE',
      },
    ]);
    const echo = {
      Quantity__c: '3.0',
      Price__c: '1.5',
      Active__c: 'true',
      Seen__c: '2026-10-02T10:00:00.000Z',
      Since__c: '2026-10-02T10:00:00.000Z',
      Parent__c: '001Fk00000AbCdEIAV',
    };
    const sent = rowKey(csv.rows[0], csv.identity, 'canonical');

    expect(echoKey(csv, echo, 'exact')).not.toBe(rowKey(csv.rows[0], csv.identity, 'exact'));
    expect(echoKey(csv, echo, 'canonical')).toBe(sent);
  });

  it('keeps text as it was sent: the results echo its spaces, and another text is another row', () => {
    const csv = buildBulkCsv('insert', [{ Code__c: ' spaced ' }, { Code__c: 'spaced' }]);

    expect(rowKey(csv.rows[0], csv.identity, 'canonical')).not.toBe(
      rowKey(csv.rows[1], csv.identity, 'canonical'),
    );
    expect(echoKey(csv, { Code__c: ' spaced ' }, 'exact')).toBe(
      rowKey(csv.rows[0], csv.identity, 'exact'),
    );
  });
});

/** The parts of a jsforce ingest job these tests reach into. */
interface JobInternals {
  jobInfo?: { operation: string };
  createIngestRequest: (request: { method: string; path?: string }) => unknown;
}

/**
 * A real jsforce ingest job whose upload is caught instead of sent: the body
 * it would have PUT to the job's batches, and nothing leaves the machine.
 */
function jobCatchingItsUpload(operation: 'insert' | 'update'): {
  job: ReturnType<Connection['bulk2']['createJob']>;
  body: () => string;
} {
  const conn = new jsforce.Connection({
    instanceUrl: 'https://example.invalid',
    accessToken: 'token',
    version: '66.0',
  });
  const job = conn.bulk2.createJob({ operation, object: 'Account' });
  const chunks: Buffer[] = [];
  let finished: () => void = () => undefined;
  const sent = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const sink = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      finished();
      callback();
    },
  });
  const internals = job as unknown as JobInternals;
  // What `open()` would have answered; jsforce reads the operation from it.
  internals.jobInfo = { operation };
  internals.createIngestRequest = () =>
    Object.assign(
      sent.then(() => ({})),
      { stream: () => sink },
    );
  return { job, body: () => Buffer.concat(chunks).toString('utf8') };
}

describe('what jsforce does with the data of a job', () => {
  it('writes the header from the first record alone when it is handed records', async () => {
    // Why the CSV is built here: the third row's description never reached
    // the target, and the second row went with an empty unit cell it did not
    // carry.
    const { job, body } = jobCatchingItsUpload('insert');

    await job.uploadData(PROBE_ROWS);

    expect(body().split('\n')[0]).toBe('Name,Unit__c');
    expect(body()).not.toContain('third a description');
  });

  it('uploads CSV text as it is, header included', async () => {
    const { job, body } = jobCatchingItsUpload('insert');
    const csv = buildBulkCsv('insert', PROBE_ROWS);

    await job.uploadData(csv.text);

    expect(body()).toBe(csv.text);
  });

  it('refuses a second upload to the same job', async () => {
    // The streaming path uploaded its chunks one call each: a write of more
    // than one chunk threw at the second, with nothing written.
    const { job } = jobCatchingItsUpload('update');
    await job.uploadData('Id,Name\n001000000000001AAA,a\n');

    await expect(job.uploadData('Id,Name\n001000000000002AAA,b\n')).rejects.toThrow(
      'Data can only be uploaded to a job once',
    );
  });
});
