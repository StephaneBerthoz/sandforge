import { describe, expect, it, vi } from 'vitest';

import type {
  BulkApiConnection,
  BulkJobCheckResult,
  BulkJobHandle,
  JsforceIngestJobResults,
} from '../../core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import type { IngestJobInfo, IngestJobResultsReading } from '../../core/engine/ingestJobRead.js';
import { BulkJobLostError, FORGE_BULK_JOB_ROWS, forgeBulkWrite } from './forgeBulkWrite.js';

const JOB = '750000000000001AAA';
const id = (n: number): string => `003${String(n).padStart(12, '0')}AAA`;

type Row = Record<string, string>;

/** How the fake org answers the job it is sent, and the job read back by its id. */
interface Script {
  openError?: string;
  uploadError?: string;
  /** The close throws, after the org took it when `closeTaken`. */
  closeError?: string;
  closeTaken?: boolean;
  /** What each read of the job's state answers, in turn; an Error throws. */
  checks?: Array<BulkJobCheckResult | Error>;
  /** The job's results, from the rows it was sent. */
  results?: (rows: Row[]) => JsforceIngestJobResults;
  /** What each read of the job by its id answers, in turn; an Error throws. */
  byId?: Array<IngestJobInfo | Error>;
  /** The abort of the job read back by its id throws this. */
  abortError?: string;
}

/** Every row written, its id the next one, its cells echoed. */
const allWritten = (rows: Row[]): JsforceIngestJobResults => ({
  successfulResults: rows.map((row, i) => ({ sf__Id: id(i + 1), sf__Created: 'true', ...row })),
});

/** An org that takes one job as `script` says, and records what it was sent. */
function fakeOrg(script: Script = {}) {
  const created: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let uploaded = '';
  let closed = false;
  let aborted = false;
  const rowsOf = (): Row[] => {
    const [header, ...lines] = uploaded.trimEnd().split('\n');
    const columns = header.split(',');
    return lines.map((line) => {
      const cells = line.split(',');
      return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? '']));
    });
  };
  const results = (): JsforceIngestJobResults => (script.results ?? allWritten)(rowsOf());
  const checks = [...(script.checks ?? [{ state: 'JobComplete' as const }])];
  const byId = [...(script.byId ?? [{ state: 'JobComplete' }])];
  const conn: BulkApiConnection & IngestJobResultsReading = {
    bulk2: {
      createJob: (options) => {
        created.push({ ...options });
        let jobId: string | undefined;
        const job: BulkJobHandle = {
          get id() {
            return jobId;
          },
          open: async () => {
            calls.push('open');
            if (script.openError) throw new Error(script.openError);
            jobId = JOB;
          },
          uploadData: async (csv) => {
            calls.push('upload');
            if (script.uploadError) throw new Error(script.uploadError);
            uploaded = csv;
          },
          close: async () => {
            calls.push('close');
            if (script.closeError) {
              closed = script.closeTaken === true;
              throw new Error(script.closeError);
            }
            closed = true;
          },
          abort: async () => {
            calls.push('abort');
            aborted = true;
          },
          check: async () => {
            calls.push('check');
            const next = checks.length > 1 ? checks.shift() : checks[0];
            if (next instanceof Error) throw next;
            return next ?? { state: 'JobComplete' };
          },
          getAllResults: async () => {
            calls.push('results');
            return results();
          },
        };
        return job;
      },
      job: (_type, options) => ({
        check: async () => {
          calls.push(`read ${options.id}`);
          const next = (byId.length > 1 ? byId.shift() : byId[0]) ?? { state: 'JobComplete' };
          if (next instanceof Error) throw next;
          if (next.state === 'Open' && closed) return { ...next, state: 'JobComplete' };
          return next;
        },
        getSuccessfulResults: async () => results().successfulResults ?? [],
        getAllResults: async () => {
          calls.push(`results ${options.id}`);
          return results();
        },
        abort: async () => {
          calls.push(`abort ${options.id}`);
          if (script.abortError) throw new Error(script.abortError);
          aborted = true;
        },
      }),
    },
  };
  return {
    conn,
    created,
    calls,
    uploaded: () => uploaded,
    aborted: () => aborted,
  };
}

const quick = { pollDelay: () => 0 };

describe('forgeBulkWrite', () => {
  it("answers each row from the job's results, by the cells it echoes, and names the job by the id the org gave it once open", async () => {
    const org = fakeOrg();
    const opened: string[] = [];

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A' }, { LastName: 'B' }],
      { ...quick, onOpened: (jobId) => opened.push(jobId) },
    );

    expect(answer.rows).toEqual(['answered', 'answered']);
    expect(answer.answers.map((a) => [a.success, a.id])).toEqual([
      [true, id(1)],
      [true, id(2)],
    ]);
    expect(answer.answers[0]).toMatchObject({ created: true, errors: [] });
    expect(answer.jobId).toBe(JOB);
    expect(opened).toEqual([JOB]);
    expect(answer.unmatchedIds).toEqual([]);
  });

  it('keeps out of the job the rows whose cells another row carries, to be written each on its own', async () => {
    const org = fakeOrg();

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'Twin' }, { LastName: 'Alone' }, { LastName: 'Twin' }],
      quick,
    );

    expect(org.uploaded()).toBe('LastName\nAlone\n');
    expect(answer.rows).toEqual(['twin', 'answered', 'twin']);
    expect(answer.answers[0]).toMatchObject({ success: false, id: '' });
    expect(answer.answers[1]).toMatchObject({ success: true, id: id(1) });
  });

  it('opens no job when every row is a twin', async () => {
    const org = fakeOrg();

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'Twin' }, { LastName: 'Twin' }],
      quick,
    );

    expect(org.created).toEqual([]);
    expect(answer).toMatchObject({ rows: ['twin', 'twin'], requests: 0 });
  });

  it('sends an empty value of an insert as #N/A, which blanks the field as REST does, and leaves an update alone', async () => {
    const insert = fakeOrg();
    await forgeBulkWrite(
      insert.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A', Email: '' }],
      quick,
    );
    expect(insert.uploaded()).toBe('LastName,Email\nA,#N/A\n');

    const update = fakeOrg();
    await forgeBulkWrite(
      update.conn,
      new BulkApiManager(1),
      'Contact',
      'update',
      [{ Id: id(9), Email: '' }],
      quick,
    );
    expect(update.uploaded()).toBe(`Id,Email\n${id(9)},\n`);
  });

  it('reads a refusal for its code and the fields it named when it is one error, and keeps the text of any other', async () => {
    const org = fakeOrg({
      results: (rows) => ({
        failedResults: [
          {
            sf__Error: 'REQUIRED_FIELD_MISSING:Required fields are missing: [Name]:Name --',
            ...rows[0],
          },
          {
            sf__Error:
              'FIELD_CUSTOM_VALIDATION_EXCEPTION:a:F1 -- FIELD_INTEGRITY_EXCEPTION:b:F2 --',
            ...rows[1],
          },
        ],
      }),
    });

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Account',
      'insert',
      [{ Phone: '1' }, { Phone: '2' }],
      quick,
    );

    expect(answer.rows).toEqual(['answered', 'answered']);
    expect(answer.answers[0]).toEqual({
      id: '',
      success: false,
      errors: ['REQUIRED_FIELD_MISSING: Required fields are missing: [Name]'],
      errorDetails: [
        {
          statusCode: 'REQUIRED_FIELD_MISSING',
          message: 'Required fields are missing: [Name]',
          fields: ['Name'],
        },
      ],
    });
    expect(answer.answers[1]).toEqual({
      id: '',
      success: false,
      errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION:a:F1 -- FIELD_INTEGRITY_EXCEPTION:b:F2 --'],
    });
  });

  it('says a write untouched when the job failed to open or to take its upload, every row unwritten', async () => {
    for (const script of [{ openError: 'socket hang up' }, { uploadError: 'ECONNRESET' }]) {
      const org = fakeOrg(script);
      const answer = await forgeBulkWrite(
        org.conn,
        new BulkApiManager(1),
        'Contact',
        'insert',
        [{ LastName: 'A' }, { LastName: 'B' }],
        quick,
      );
      expect(answer.untouched).toEqual({ reason: script.openError ?? script.uploadError });
      expect(answer.rows).toEqual(['unprocessed', 'unprocessed']);
      expect(org.calls).not.toContain('close');
    }
  });

  it('says the object unsupported when the org says the Bulk API does not write it', async () => {
    const org = fakeOrg({
      openError: "InvalidEntity : Entity 'Thing__c' is not supported by the Bulk API",
    });

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Thing__c',
      'insert',
      [{ Name: 'A' }],
      quick,
    );

    expect(answer.untouched).toMatchObject({ unsupported: true });
  });

  it('says a write untouched when its job ended having processed no row, as a refused header fails it', async () => {
    const org = fakeOrg({
      checks: [{ state: 'Failed', errorMessage: 'InvalidBatch : Field name not found : Nope__c' }],
      results: (rows) => ({ unprocessedRecords: rows }),
    });

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A', Nope__c: 'x' }],
      quick,
    );

    expect(answer.untouched).toEqual({ reason: 'InvalidBatch : Field name not found : Nope__c' });
    expect(answer.rows).toEqual(['unprocessed']);
    expect(answer.jobId).toBe(JOB);
  });

  it('reads back a job whose close failed: found open, it was never closed, is aborted, and wrote nothing', async () => {
    const org = fakeOrg({
      closeError: 'socket hang up',
      byId: [{ state: 'Open', createdDate: new Date().toISOString() }],
    });

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A' }],
      quick,
    );

    expect(answer.untouched).toEqual({ reason: 'socket hang up' });
    expect(answer.rows).toEqual(['unprocessed']);
    expect(org.calls).toContain(`abort ${JOB}`);
  });

  it('reads back again a job found open whose abort is refused: the close lost on its way reached the org, and its rows are answered from its results', async () => {
    const org = fakeOrg({
      closeError: 'ETIMEDOUT',
      byId: [{ state: 'Open' }, { state: 'InProgress' }, { state: 'JobComplete' }],
      abortError: 'INVALIDJOBSTATE: job is not open',
    });

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A' }],
      quick,
    );

    expect(answer.untouched).toBeUndefined();
    expect(answer.rows).toEqual(['answered']);
    expect(answer.answers[0]).toMatchObject({ success: true, id: id(1) });
    expect(org.calls.filter((c) => c === `read ${JOB}`)).toHaveLength(3);
  });

  it('reads back a job whose close was taken though the answer was lost, and answers its rows from its results', async () => {
    const org = fakeOrg({
      closeError: 'socket hang up',
      closeTaken: true,
      byId: [{ state: 'Open' }],
    });

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A' }],
      quick,
    );

    expect(answer.untouched).toBeUndefined();
    expect(answer.rows).toEqual(['answered']);
    expect(org.aborted()).toBe(false);
  });

  it('reads a closed job back by its id when a read of its state fails, until it ends, then answers from its results', async () => {
    const org = fakeOrg({
      checks: [new Error('ETIMEDOUT')],
      byId: [new Error('ECONNRESET'), { state: 'InProgress' }, { state: 'JobComplete' }],
      results: (rows) => ({
        successfulResults: [{ sf__Id: id(1), sf__Created: 'true', ...rows[1] }],
        failedResults: [{ sf__Error: 'DUPLICATES_DETECTED:dup:--', ...rows[0] }],
      }),
    });
    const pollDelay = vi.fn((_attempt: number) => 0);

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A' }, { LastName: 'B' }],
      { pollDelay },
    );

    expect(answer.rows).toEqual(['answered', 'answered']);
    expect(answer.answers[0]).toMatchObject({ success: false });
    expect(answer.answers[1]).toMatchObject({ success: true, id: id(1) });
    expect(org.calls.filter((c) => c === `read ${JOB}`)).toHaveLength(3);
    // Waited between reads as the job was polled, longer each time.
    expect(pollDelay.mock.calls.map(([attempt]) => attempt)).toEqual([0, 1]);
    // Opened, sent, closed, one read of its state, three reads back, its results read three ways.
    expect(answer.requests).toBe(3 + 1 + 3 + 3);
  });

  it('throws once a closed job cannot be read back, never taking it for one that wrote nothing', async () => {
    const org = fakeOrg({ checks: [new Error('ETIMEDOUT')], byId: [{ state: 'InProgress' }] });

    const lost = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'Twin' }, { LastName: 'A' }, { LastName: 'Twin' }],
      quick,
    ).catch((err: unknown) => err);

    expect(lost).toBeInstanceOf(BulkJobLostError);
    expect((lost as BulkJobLostError).jobId).toBe(JOB);
    // The rows kept out of it as twins, never sent: no row the target may hold.
    expect((lost as BulkJobLostError).twins).toEqual([0, 2]);
    // Ten reads by id, each counted.
    expect(org.calls.filter((c) => c === `read ${JOB}`)).toHaveLength(10);
    expect((lost as BulkJobLostError).requests).toBe(3 + 1 + 10);
  });

  it('says rows aborted, nothing written, when the cancel comes before the job is closed', async () => {
    const stop = new AbortController();
    stop.abort();
    const org = fakeOrg();

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A' }],
      { ...quick, signal: stop.signal },
    );

    expect(answer.aborted).toBe(true);
    expect(answer.rows).toEqual(['unprocessed']);
    expect(org.calls).not.toContain('close');
  });

  it('says a row may have been written when no result was matched to it while the job wrote a record no row was matched to', async () => {
    const org = fakeOrg({
      results: (rows) => ({
        successfulResults: [
          { sf__Id: id(1), sf__Created: 'true', ...rows[0] },
          // Echoed otherwise than sent: matched to no row.
          { sf__Id: id(2), sf__Created: 'true', LastName: 'b, as echoed' },
        ],
      }),
    });

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A' }, { LastName: 'B' }],
      quick,
    );

    expect(answer.rows).toEqual(['answered', 'may-have-written']);
    expect(answer.unmatchedIds).toEqual([id(2)]);
    expect(answer.answers[1]).toMatchObject({ success: false, id: '' });
  });

  it('says a row may have been written when the job wrote, without its id, a record no row was matched to', async () => {
    const org = fakeOrg({
      results: (rows) => ({
        successfulResults: [
          { sf__Id: id(1), sf__Created: 'true', ...rows[0] },
          // No id, and echoed otherwise than sent: a record written, laid on no row.
          { sf__Created: 'true', LastName: 'b, as echoed' },
        ],
      }),
    });

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A' }, { LastName: 'B' }],
      quick,
    );

    expect(answer.rows).toEqual(['answered', 'may-have-written']);
    expect(answer.unmatchedIds).toEqual([]);
  });

  it('says a row unwritten when the job listed it unprocessed, or wrote nothing it could not lay on a row', async () => {
    const org = fakeOrg({
      checks: [{ state: 'Failed', errorMessage: 'Max retries reached' }],
      results: (rows) => ({
        successfulResults: [{ sf__Id: id(1), sf__Created: 'true', ...rows[0] }],
        unprocessedRecords: [rows[1]],
      }),
    });

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A' }, { LastName: 'B' }, { LastName: 'C' }],
      quick,
    );

    expect(answer.untouched).toBeUndefined();
    expect(answer.rows).toEqual(['answered', 'unprocessed', 'unprocessed']);
  });

  it('says a row written without its id may have been written, never a success without a record', async () => {
    const org = fakeOrg({
      results: (rows) => ({ successfulResults: [{ sf__Created: 'true', ...rows[0] }] }),
    });

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A' }],
      quick,
    );

    expect(answer.rows).toEqual(['may-have-written']);
  });

  it('counts every call the job sent: opened, sent, closed, each read of its state, its results read three ways', async () => {
    const org = fakeOrg({
      checks: [{ state: 'InProgress' }, { state: 'InProgress' }, { state: 'JobComplete' }],
    });
    const pollDelay = vi.fn((_attempt: number) => 0);

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      [{ LastName: 'A' }],
      { pollDelay },
    );

    expect(answer.requests).toBe(3 + 3 + 3);
    expect(pollDelay.mock.calls.map(([attempt]) => attempt)).toEqual([0, 1]);
  });

  it('opens the job with its operation, its object and its external id, and never an assignment rule', async () => {
    const org = fakeOrg();

    await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Lead',
      'upsert',
      [{ Key__c: 'k1', LastName: 'A' }],
      { ...quick, externalIdField: 'Key__c' },
    );

    expect(org.created).toEqual([
      { operation: 'upsert', object: 'Lead', externalIdFieldName: 'Key__c' },
    ]);
  });

  it('waits five, ten, twenty, then thirty seconds between two reads of its state unless told', async () => {
    vi.useFakeTimers();
    try {
      const org = fakeOrg({
        checks: [
          { state: 'InProgress' },
          { state: 'InProgress' },
          { state: 'InProgress' },
          { state: 'InProgress' },
          { state: 'JobComplete' },
        ],
      });
      const writing = forgeBulkWrite(org.conn, new BulkApiManager(1), 'Contact', 'insert', [
        { LastName: 'A' },
      ]);
      const reads = (): number => org.calls.filter((c) => c === 'check').length;
      await vi.advanceTimersByTimeAsync(0);
      expect(reads()).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reads()).toBe(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads()).toBe(3);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(reads()).toBe(4);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(reads()).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads()).toBe(5);
      await writing;
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a write past what one job takes, before anything is sent: cutting it is the caller', async () => {
    const org = fakeOrg();
    const records = Array.from({ length: FORGE_BULK_JOB_ROWS + 1 }, (_, i) => ({
      LastName: `L${i}`,
    }));

    const answer = await forgeBulkWrite(
      org.conn,
      new BulkApiManager(1),
      'Contact',
      'insert',
      records,
      quick,
    );

    expect(answer.untouched?.reason).toContain(`${FORGE_BULK_JOB_ROWS + 1} rows`);
    expect(org.created).toEqual([]);
  });
});
