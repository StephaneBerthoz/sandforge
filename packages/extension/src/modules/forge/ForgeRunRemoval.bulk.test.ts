import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';
import type { ForgeRunObjectRecords } from '@sandforge/shared';

import {
  BULK_DELETE_JOB_RECORDS,
  BULK_DELETE_THRESHOLD,
  bulkDeleteJob,
  removalOrg,
  removeRunRecords,
  type BulkDeleteAnswer,
  type RemovalOrg,
  type RunRecords,
} from './ForgeRunRemoval.js';
import type {
  BulkApiConnection,
  BulkJobCheckResult,
  JsforceIngestJobResults,
} from '../../core/engine/BulkApiExecutor.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A removal deletes the records of an object past the threshold through Bulk
 * API 2.0 delete jobs, and reports each of them as it reports a delete over
 * REST: run against a scratch org, 12 000 contacts went in sixty calls of
 * 200 and over six minutes, most of them spent reading what hangs from them.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const RUN_STARTED = '2026-09-20T10:00:00.000Z';
const DURING_RUN = '2026-09-20T10:02:00.000+0000';
const RUN_ENDED = '2026-09-20T10:05:00.000Z';
const BEFORE_RUN = '2026-09-19T09:00:00.000+0000';
const USER = fakeId('005', 1);

type Row = Record<string, unknown> & { Id: string };

interface Child {
  childSObject: string;
  field: string;
  cascadeDelete: boolean;
  restrictedDelete?: boolean;
}

/**
 * An org of maps, quick at tens of thousands of rows, that takes a removal's
 * reads, its deletes over REST and its delete jobs, each kept apart.
 */
class JobOrg implements RemovalOrg {
  readonly rows = new Map<string, Map<string, Row>>();
  readonly bin = new Set<string>();
  readonly children = new Map<string, Child[]>();
  /** Every REST delete, object and how many records. */
  readonly calls: Array<{ objectApiName: string; ids: string[] }> = [];
  /** Every delete job, object and how many records. */
  readonly jobs: Array<{ objectApiName: string; ids: string[] }> = [];
  readonly queries: string[] = [];
  /** What a job answers for a record instead of deleting it, by id: its `sf__Error`. */
  readonly jobErrors = new Map<string, string>();
  /** What the next jobs answer instead of deleting anything, in turn. */
  readonly jobAnswers: Array<BulkDeleteAnswer | Error> = [];
  /** Told of each job before it is answered. */
  beforeJob?: (ids: readonly string[], signal?: AbortSignal) => void;
  /** Objects whose every record a probe of a relationship to them answers none for. */
  readonly probes: Array<{ child: string; field: string }> = [];
  /** Relationship probes that fail, by child object. */
  readonly failingProbes = new Set<string>();

  add(objectApiName: string, ...rows: Row[]): void {
    const table = this.rows.get(objectApiName) ?? new Map<string, Row>();
    for (const row of rows) {
      table.set(row.Id.slice(0, 15), {
        CreatedDate: DURING_RUN,
        LastModifiedDate: DURING_RUN,
        ...row,
      });
    }
    this.rows.set(objectApiName, table);
  }

  count(objectApiName: string): number {
    return this.rows.get(objectApiName)?.size ?? 0;
  }

  async describe(objectApiName: string): Promise<unknown> {
    return {
      name: objectApiName,
      label: objectApiName,
      fields: [],
      childRelationships: this.children.get(objectApiName) ?? [],
    };
  }

  async describeGlobal(): Promise<unknown> {
    const names = new Set([
      ...this.rows.keys(),
      ...[...this.children.values()].flat().map((child) => child.childSObject),
    ]);
    return {
      sobjects: [...names].map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        layoutable: true,
      })),
    };
  }

  async query(soql: string): Promise<{ totalSize: number; records: unknown[] }> {
    this.queries.push(soql);
    const probe = /^SELECT Id FROM (\w+) WHERE (\w+) != null LIMIT 1$/.exec(soql);
    if (probe) {
      const [, child, field] = probe;
      this.probes.push({ child, field });
      if (this.failingProbes.has(child)) throw new Error('Implementation restriction');
      const any = [...(this.rows.get(child)?.values() ?? [])].find((row) => row[field] != null);
      return { totalSize: any ? 1 : 0, records: any ? [{ Id: any.Id }] : [] };
    }
    const match = /^SELECT (.+) FROM (\w+) WHERE (\w+) IN \((.*)\)(?: LIMIT \d+)?$/.exec(soql);
    if (!match) throw new Error(`unexpected query: ${soql}`);
    const [, columns, object, field, list] = match;
    const wanted = new Set(list.split(', ').map((quoted) => quoted.slice(1, 16)));
    const table = this.rows.get(object) ?? new Map<string, Row>();
    const rows =
      field === 'Id'
        ? [...wanted].flatMap((key) => (table.has(key) ? [table.get(key) as Row] : []))
        : [...table.values()].filter((row) => wanted.has(String(row[field]).slice(0, 15)));
    const records = rows.map((row) =>
      Object.fromEntries(columns.split(', ').map((column) => [column, row[column]])),
    );
    return { totalSize: records.length, records };
  }

  async queryDeleted(soql: string): Promise<{ records: unknown[] }> {
    const match = /IN \((.*)\) AND IsDeleted = true$/.exec(soql);
    const wanted = (match?.[1] ?? '').split(', ').map((quoted) => quoted.slice(1, 16));
    return {
      records: wanted.filter((key) => this.bin.has(key)).map((key) => ({ Id: `${key}AAA` })),
    };
  }

  async update(): Promise<unknown> {
    return [];
  }

  async serverTime(): Promise<string> {
    return new Date().toISOString();
  }

  async userId(): Promise<string> {
    return USER;
  }

  /** Delete one record and what cascades from it, as the org does; or say why not. */
  private take(objectApiName: string, id: string): 'deleted' | 'gone' {
    const table = this.rows.get(objectApiName);
    const key = id.slice(0, 15);
    if (!table?.has(key)) return 'gone';
    table.delete(key);
    this.bin.add(key);
    for (const child of this.children.get(objectApiName) ?? []) {
      if (!child.cascadeDelete) continue;
      for (const row of [...(this.rows.get(child.childSObject)?.values() ?? [])]) {
        if (String(row[child.field]).slice(0, 15) === key) this.take(child.childSObject, row.Id);
      }
    }
    return 'deleted';
  }

  async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    this.calls.push({ objectApiName, ids: [...ids] });
    return ids.map((id) => {
      const error = this.jobErrors.get(id);
      if (error) {
        const [statusCode, message] = error.split(':');
        return { id, success: false, errors: [{ statusCode, message }] };
      }
      return this.take(objectApiName, id) === 'deleted'
        ? { id, success: true, errors: [] }
        : {
            id,
            success: false,
            errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }],
          };
    });
  }

  async bulkDestroy(
    objectApiName: string,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<BulkDeleteAnswer> {
    this.beforeJob?.(ids, signal);
    if (signal?.aborted) return { kind: 'aborted' };
    this.jobs.push({ objectApiName, ids: [...ids] });
    const scripted = this.jobAnswers.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted) return scripted;
    return {
      kind: 'answered',
      rows: ids.map((id) => {
        const error = this.jobErrors.get(id);
        if (error) return { success: false, error };
        return this.take(objectApiName, id) === 'deleted'
          ? { success: true }
          : { success: false, error: 'ENTITY_IS_DELETED:entity is deleted:--' };
      }),
    };
  }
}

const OPTIONS = {
  runStartedAt: new Date(RUN_STARTED),
  runEndedAt: new Date(RUN_ENDED),
  includeChanged: false,
};

/** `count` contacts under one account, all of the run's. */
function contactsUnderAnAccount(count: number): { org: JobOrg; plan: ForgeRunObjectRecords[] } {
  const org = new JobOrg();
  const account = fakeId('001', 1);
  const contacts = Array.from({ length: count }, (_, n) => fakeId('003', n + 1));
  org.children.set('Account', [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
  ]);
  org.add('Account', { Id: account });
  org.add('Contact', ...contacts.map((Id) => ({ Id, AccountId: account })));
  return {
    org,
    plan: [
      { objectApiName: 'Contact', ids: contacts },
      { objectApiName: 'Account', ids: [account] },
    ],
  };
}

/** `plan` handed over `size` records a page, as a journal hands them. */
function inPages(plan: readonly ForgeRunObjectRecords[], size: number): RunRecords {
  const keys = new Set(plan.flatMap(({ ids }) => ids.map((id) => id.slice(0, 15))));
  return {
    objects: plan.map(({ objectApiName, ids }) => ({ objectApiName, count: ids.length })),
    pages: async function* (objectApiName) {
      const ids = plan.find((object) => object.objectApiName === objectApiName)?.ids ?? [];
      for (let at = 0; at < ids.length; at += size) yield ids.slice(at, at + size);
    },
    has: (key) => keys.has(key),
  };
}

/** The records a removal says it left, per object, counted. */
async function leftCounts(outcome: Awaited<ReturnType<typeof removeRunRecords>>) {
  const left = new Map<string, number>();
  for await (const { objectApiName, ids } of outcome.left()) {
    left.set(objectApiName, (left.get(objectApiName) ?? 0) + ids.length);
  }
  return left;
}

describe('a removal past the bulk threshold', () => {
  it('deletes the records of an object past the threshold by one job, children before their parents', async () => {
    const { org, plan } = contactsUnderAnAccount(10_500);

    const outcome = await removeRunRecords(org, plan, OPTIONS);

    expect(org.jobs.map((job) => [job.objectApiName, job.ids.length])).toEqual([
      ['Contact', 10_500],
    ]);
    // The account, one record, goes over REST once its contacts have gone.
    expect(org.calls.map((call) => [call.objectApiName, call.ids.length])).toEqual([
      ['Account', 1],
    ]);
    expect(outcome.cancelled).toBe(false);
    expect(outcome.objects.map((o) => [o.objectApiName, o.planned, o.deleted, o.refused])).toEqual([
      ['Contact', 10_500, 10_500, 0],
      ['Account', 1, 1, 0],
    ]);
    expect(outcome.gone).toHaveLength(10_501);
    expect(org.count('Contact')).toBe(0);
  });

  it('sends an object of fewer records than the threshold over REST, two hundred at a time, as before', async () => {
    const { org, plan } = contactsUnderAnAccount(BULK_DELETE_THRESHOLD - 1);

    const outcome = await removeRunRecords(org, plan, OPTIONS);

    expect(org.jobs).toEqual([]);
    expect(org.calls.filter((call) => call.objectApiName === 'Contact')).toHaveLength(50);
    expect(outcome.objects[0]).toMatchObject({ planned: 9_999, deleted: 9_999 });
  });

  it('deletes files over REST alone, two hundred a call, past the threshold too: never by a job (T16)', async () => {
    const files = Array.from({ length: 12_000 }, (_, n) => fakeId('069', n + 1));
    const plan = [{ objectApiName: 'ContentDocument', ids: files }];
    for (const handed of [plan, inPages(plan, 2_000)]) {
      const org = new JobOrg();
      org.add('ContentDocument', ...files.map((Id) => ({ Id })));

      const outcome = await removeRunRecords(org, handed, OPTIONS);

      expect(org.jobs).toEqual([]);
      expect(org.calls).toHaveLength(60);
      expect(org.calls.every((call) => call.ids.length === 200)).toBe(true);
      expect(outcome.objects[0]).toMatchObject({ planned: 12_000, deleted: 12_000 });
    }
  });

  it('deletes over REST, whatever it holds, where the org takes no job', async () => {
    const { org, plan } = contactsUnderAnAccount(10_500);
    const rest: RemovalOrg = {
      query: (soql) => org.query(soql),
      queryDeleted: (soql) => org.queryDeleted(soql),
      destroy: (objectApiName, ids) => org.destroy(objectApiName, ids),
      update: () => org.update(),
      describe: (objectApiName) => org.describe(objectApiName),
      describeGlobal: () => org.describeGlobal(),
      serverTime: () => org.serverTime(),
      userId: () => org.userId(),
    };

    const outcome = await removeRunRecords(rest, plan, OPTIONS);

    expect(org.jobs).toEqual([]);
    expect(org.calls.filter((call) => call.objectApiName === 'Contact')).toHaveLength(53);
    expect(outcome.objects[0]).toMatchObject({ planned: 10_500, deleted: 10_500 });
  });

  it('gathers the pages a journal hands over into one job, where no page alone reaches the threshold', async () => {
    const { org, plan } = contactsUnderAnAccount(12_000);

    const outcome = await removeRunRecords(org, inPages(plan, 2_000), OPTIONS);

    expect(org.jobs.map((job) => job.ids.length)).toEqual([12_000]);
    expect(outcome.objects[0]).toMatchObject({ planned: 12_000, deleted: 12_000 });
    expect(await leftCounts(outcome)).toEqual(new Map());
  });

  it('cuts the records past a job into jobs of one size', async () => {
    const { org, plan } = contactsUnderAnAccount(BULK_DELETE_JOB_RECORDS + 500);

    const outcome = await removeRunRecords(org, plan, OPTIONS);

    expect(org.jobs.map((job) => job.ids.length)).toEqual([25_250, 25_250]);
    expect(outcome.objects[0]).toMatchObject({ deleted: 50_500 });
  });

  it('reports each record a job refused or found gone as a delete over REST reports it, and tries the refused ones again', async () => {
    const { org, plan } = contactsUnderAnAccount(10_500);
    const contacts = plan[0].ids;
    org.jobErrors.set(
      contacts[1],
      'DELETE_FAILED:Your attempt to delete this contact could not be completed because it is associated with the following cases.: 00001000\n:--',
    );
    org.jobErrors.set(contacts[2], 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY:A flow refused it:--');
    org.jobErrors.set(contacts[3], 'No result returned by Bulk API job (job Failed)');

    const outcome = await removeRunRecords(org, plan, OPTIONS);

    const [contact] = outcome.objects;
    expect(org.jobs.map((job) => job.ids.length)).toEqual([10_500]);
    expect(contact).toMatchObject({ planned: 10_500, deleted: 10_497, alreadyGone: 0, refused: 3 });
    expect(contact.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: A flow refused it'),
        expect.stringContaining(
          'DELETE_FAILED: Your attempt to delete this contact could not be completed',
        ),
        'No result returned by Bulk API job (job Failed)',
        expect.stringContaining('Refused at first, sent again once the rest had gone'),
      ]),
    );
    // The three refused went once more, over REST: three records are far from a job's worth.
    expect(org.calls.filter((call) => call.objectApiName === 'Contact')).toEqual([
      { objectApiName: 'Contact', ids: [contacts[1], contacts[2], contacts[3]] },
    ]);
    // Their account stays: the org would take them along with it.
    expect(outcome.objects[1]).toMatchObject({ deleted: 0, keptDependents: 1 });
    expect(await leftCounts(outcome)).toEqual(
      new Map([
        ['Contact', 3],
        ['Account', 1],
      ]),
    );
  });

  it('counts a record a job found deleted since it was read as already gone', async () => {
    const { org, plan } = contactsUnderAnAccount(10_500);
    const contacts = plan[0].ids;
    org.jobErrors.set(contacts[7], 'ENTITY_IS_DELETED:entity is deleted:--');

    const outcome = await removeRunRecords(org, plan, OPTIONS);

    expect(outcome.objects[0]).toMatchObject({
      deleted: 10_499,
      alreadyGone: 1,
      refused: 0,
      reasons: [],
    });
    // Settled by the job's answer: never sent again.
    expect(org.calls.filter((call) => call.objectApiName === 'Contact')).toEqual([]);
  });

  it('never sends in the job a record that records staying in the org depend on', async () => {
    const { org, plan } = contactsUnderAnAccount(10_500);
    const contacts = plan[0].ids;
    org.children.set('Contact', [{ childSObject: 'Task', field: 'WhoId', cascadeDelete: true }]);
    // Someone's task, from before the run, on one of the run's contacts.
    org.add('Task', {
      Id: fakeId('00T', 1),
      WhoId: contacts[42],
      CreatedDate: BEFORE_RUN,
      LastModifiedDate: BEFORE_RUN,
      CreatedById: fakeId('005', 2),
    });

    const outcome = await removeRunRecords(org, plan, OPTIONS);

    expect(org.jobs[0].ids).toHaveLength(10_499);
    expect(org.jobs[0].ids).not.toContain(contacts[42]);
    expect(outcome.objects[0]).toMatchObject({
      deleted: 10_499,
      keptDependents: 1,
      heldBy: ['Task'],
    });
    expect(org.count('Task')).toBe(1);
  });

  it('deletes over REST, record by record, what a job that failed whole left untouched', async () => {
    const { org, plan } = contactsUnderAnAccount(10_500);
    org.jobAnswers.push({ kind: 'untouched', reason: 'InvalidBatch : Failed to process the job' });

    const outcome = await removeRunRecords(org, plan, OPTIONS);

    expect(org.jobs).toHaveLength(1);
    expect(org.calls.filter((call) => call.objectApiName === 'Contact')).toHaveLength(53);
    expect(outcome.objects[0]).toMatchObject({ deleted: 10_500, refused: 0, reasons: [] });
    expect(org.count('Contact')).toBe(0);
  });

  it('counts every record of a job that failed once the org had it refused, and reads which went on the second try', async () => {
    const { org, plan } = contactsUnderAnAccount(10_500);
    org.jobAnswers.push(new Error('Polling the job failed: socket hang up'));

    const outcome = await removeRunRecords(org, plan, OPTIONS);

    // The second try sends all 2 500 again, by a job of their own.
    expect(org.jobs.map((job) => job.ids.length)).toEqual([10_500, 10_500]);
    expect(outcome.objects[0]).toMatchObject({ deleted: 10_500, refused: 0 });
    expect(outcome.objects[0].reasons).toEqual([
      'Refused at first, sent again once the rest had gone: 10500 deleted.',
    ]);
  });

  it('stops before a job the org does not have yet, and leaves every record of it', async () => {
    const { org, plan } = contactsUnderAnAccount(10_500);
    const stop = new AbortController();
    org.beforeJob = () => stop.abort();

    const outcome = await removeRunRecords(org, plan, { ...OPTIONS, signal: stop.signal });

    expect(outcome.cancelled).toBe(true);
    expect(org.jobs).toEqual([]);
    expect(org.count('Contact')).toBe(10_500);
    // Neither deleted nor refused: the org never had them.
    expect(outcome.objects[0]).toMatchObject({ objectApiName: 'Contact', deleted: 0, refused: 0 });
    expect(await leftCounts(outcome)).toEqual(
      new Map([
        ['Contact', 10_500],
        ['Account', 1],
      ]),
    );
  });

  it('is stopped between two jobs, with what the first deleted counted', async () => {
    const { org, plan } = contactsUnderAnAccount(BULK_DELETE_JOB_RECORDS + 500);
    const stop = new AbortController();
    let jobs = 0;
    org.beforeJob = () => {
      if (++jobs === 2) stop.abort();
    };

    const outcome = await removeRunRecords(org, plan, { ...OPTIONS, signal: stop.signal });

    expect(outcome.cancelled).toBe(true);
    expect(org.jobs.map((job) => job.ids.length)).toEqual([25_250]);
    expect(outcome.objects[0]).toMatchObject({ deleted: 25_250 });
    expect(await leftCounts(outcome)).toEqual(
      new Map([
        ['Contact', 25_250],
        ['Account', 1],
      ]),
    );
  });
});

describe('the dependents check past one read of records', () => {
  it('reads a relationship no record of which points anywhere once, not for every 200', async () => {
    const { org, plan } = contactsUnderAnAccount(2_500);
    org.children.set('Contact', [
      { childSObject: 'Task', field: 'WhoId', cascadeDelete: true },
      { childSObject: 'Note', field: 'ParentId', cascadeDelete: true },
    ]);
    // A task the run made under one of its contacts: Task is read, Note is not.
    org.add('Task', { Id: fakeId('00T', 1), WhoId: plan[0].ids[0] });

    const outcome = await removeRunRecords(org, plan, OPTIONS);

    const reads = (object: string) =>
      org.queries.filter(
        (soql) => soql.includes(` FROM ${object} WHERE`) && soql.includes(' IN ('),
      );
    expect(org.probes).toEqual([
      { child: 'Task', field: 'WhoId' },
      { child: 'Note', field: 'ParentId' },
    ]);
    expect(reads('Note')).toEqual([]);
    expect(reads('Task')).toHaveLength(13);
    expect(outcome.objects[0]).toMatchObject({ deleted: 2_500, keptDependents: 0 });
  });

  it('reads for every 200 records a relationship the org will not be asked of whole', async () => {
    const { org, plan } = contactsUnderAnAccount(2_500);
    org.children.set('Contact', [
      { childSObject: 'ContentDocumentLink', field: 'LinkedEntityId', cascadeDelete: true },
    ]);
    org.failingProbes.add('ContentDocumentLink');

    await removeRunRecords(org, plan, OPTIONS);

    expect(
      org.queries.filter((soql) =>
        soql.includes('FROM ContentDocumentLink WHERE LinkedEntityId IN'),
      ),
    ).toHaveLength(13);
  });

  it('asks no date of a dependent object again once it said it keeps no such column', async () => {
    const { org, plan } = contactsUnderAnAccount(2_500);
    org.children.set('Contact', [
      { childSObject: 'Link', field: 'LinkedEntityId', cascadeDelete: true },
    ]);
    org.add('Link', {
      Id: fakeId('06A', 1),
      LinkedEntityId: plan[0].ids[0],
      SystemModstamp: DURING_RUN,
    });
    const query = org.query.bind(org);
    const reads: string[] = [];
    org.query = async (soql) => {
      if (!/FROM Link WHERE LinkedEntityId IN/.test(soql)) return query(soql);
      reads.push(soql);
      if (soql.includes('CreatedDate')) {
        throw Object.assign(new Error("No such column 'CreatedDate' on entity 'Link'"), {
          errorCode: 'INVALID_FIELD',
        });
      }
      return query(soql);
    };

    await removeRunRecords(org, plan, OPTIONS);

    // Thirteen reads of 200 by the system stamp, and the date it does not keep asked of
    // the first reads alone, four of them sent at once.
    expect(reads.filter((soql) => soql.includes('SystemModstamp'))).toHaveLength(13);
    expect(reads.filter((soql) => soql.includes('CreatedDate'))).toHaveLength(4);
  });

  it('reads the records and what hangs from them a few at a time, not one after the other', async () => {
    const { org, plan } = contactsUnderAnAccount(2_500);
    org.children.set('Contact', [
      { childSObject: 'Task', field: 'WhoId', cascadeDelete: true },
      { childSObject: 'Event', field: 'WhoId', cascadeDelete: true },
    ]);
    org.add('Task', { Id: fakeId('00T', 1), WhoId: plan[0].ids[0], SystemModstamp: DURING_RUN });
    org.add('Event', { Id: fakeId('00U', 1), WhoId: plan[0].ids[1], SystemModstamp: DURING_RUN });
    const query = org.query.bind(org);
    const inFlight = { now: 0, most: new Map<string, number>() };
    org.query = async (soql) => {
      const kind = / FROM Contact WHERE Id IN /.test(soql)
        ? 'records'
        : / WHERE WhoId IN /.test(soql)
          ? 'dependents'
          : 'other';
      inFlight.now++;
      inFlight.most.set(kind, Math.max(inFlight.most.get(kind) ?? 0, inFlight.now));
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight.now--;
      return query(soql);
    };

    const outcome = await removeRunRecords(org, plan, OPTIONS);

    expect(outcome.objects[0]).toMatchObject({ deleted: 2_500 });
    expect(inFlight.most.get('records')).toBe(4);
    expect(inFlight.most.get('dependents')).toBe(4);
  });

  it('asks a date again after a read that failed by chance', async () => {
    const { org, plan } = contactsUnderAnAccount(400);
    org.children.set('Contact', [{ childSObject: 'Task', field: 'WhoId', cascadeDelete: true }]);
    org.add('Task', { Id: fakeId('00T', 1), WhoId: plan[0].ids[0], SystemModstamp: DURING_RUN });
    const query = org.query.bind(org);
    const reads: string[] = [];
    org.query = async (soql) => {
      if (!/FROM Task WHERE WhoId IN/.test(soql)) return query(soql);
      reads.push(soql);
      if (reads.length === 1) throw new Error('socket hang up');
      return query(soql);
    };

    await removeRunRecords(org, plan, OPTIONS);

    // Two reads of 200, each asking the dates first; the one that failed went on by its stamp.
    expect(reads.filter((soql) => soql.includes('CreatedDate'))).toHaveLength(2);
    expect(reads.filter((soql) => soql.includes('SystemModstamp'))).toHaveLength(1);
  });
});

/** A jsforce Bulk API 2.0 job as the removal drives it, answering what a test says. */
function fakeBulk(answer: {
  results?: JsforceIngestJobResults;
  status?: BulkJobCheckResult;
  openFails?: string;
}) {
  const opened: Array<{ operation: string; object: string; csv?: string; aborted?: boolean }> = [];
  const connection: BulkApiConnection = {
    bulk2: {
      createJob: (options) => {
        const job: (typeof opened)[number] = {
          operation: options.operation,
          object: options.object,
        };
        opened.push(job);
        return {
          id: '750000000000001AAA',
          open: async () => {
            if (answer.openFails) throw new Error(answer.openFails);
          },
          uploadData: async (csv) => {
            job.csv = csv;
          },
          close: async () => {},
          abort: async () => {
            job.aborted = true;
          },
          check: async () => answer.status ?? { state: 'JobComplete', numberRecordsProcessed: 3 },
          getAllResults: async () => answer.results ?? {},
        };
      },
    },
  };
  return { connection, opened };
}

describe('bulkDeleteJob', () => {
  const ids = [fakeId('003', 1), fakeId('003', 2), fakeId('003', 3)];

  it('opens a delete job, never a hard delete, with the ids alone, and answers each record in their order', async () => {
    const { connection, opened } = fakeBulk({
      results: {
        // The org answers in an order of its own.
        failedResults: [{ sf__Id: '', sf__Error: 'DELETE_FAILED:held by a case:--', Id: ids[2] }],
        successfulResults: [
          { sf__Id: ids[1], sf__Created: 'false', Id: ids[1] },
          { sf__Id: ids[0], sf__Created: 'false', Id: ids[0] },
        ],
      },
    });

    const answer = await bulkDeleteJob(connection, 'Contact', ids);

    expect(opened).toEqual([
      { operation: 'delete', object: 'Contact', csv: `Id\n${ids.join('\n')}\n` },
    ]);
    expect(answer).toEqual({
      kind: 'answered',
      rows: [
        { success: true },
        { success: true },
        { success: false, error: 'DELETE_FAILED:held by a case:--' },
      ],
      // Opened, sent, closed, its state read once, its results three ways.
      requests: 7,
    });
  });

  it('says a job that failed before it processed a record left them all untouched', async () => {
    const { connection } = fakeBulk({
      status: {
        state: 'Failed',
        numberRecordsProcessed: 0,
        errorMessage: 'InvalidBatch : bad CSV',
      },
      results: { unprocessedRecords: ids.map((Id) => ({ Id })) },
    });

    expect(await bulkDeleteJob(connection, 'Contact', ids)).toEqual({
      kind: 'untouched',
      reason: 'InvalidBatch : bad CSV',
      requests: 7,
    });
  });

  it('answers what a job that failed part way processed, and why for the rest', async () => {
    const { connection } = fakeBulk({
      status: { state: 'Failed', numberRecordsProcessed: 1, errorMessage: 'Max retries reached' },
      results: {
        successfulResults: [{ sf__Id: ids[0], sf__Created: 'false', Id: ids[0] }],
        unprocessedRecords: [{ Id: ids[1] }, { Id: ids[2] }],
      },
    });

    const answer = await bulkDeleteJob(connection, 'Contact', ids);

    expect(answer.kind).toBe('answered');
    if (answer.kind !== 'answered') return;
    expect(answer.rows[0]).toEqual({ success: true });
    expect(answer.rows[1]).toEqual({
      success: false,
      error: 'Record not processed by Bulk API job (Max retries reached)',
    });
  });

  it('says a job the org would not open left them untouched, for REST to take them', async () => {
    const { connection } = fakeBulk({
      openFails: "Entity 'Thing__c' is not supported by the Bulk API",
    });

    expect(await bulkDeleteJob(connection, 'Thing__c', ids)).toEqual({
      kind: 'untouched',
      reason: "Entity 'Thing__c' is not supported by the Bulk API",
      requests: 1,
    });
  });

  it('is what the org a removal works on deletes by, over the connection’s Bulk API 2.0', async () => {
    const { connection, opened } = fakeBulk({
      results: { successfulResults: ids.map((Id) => ({ sf__Id: Id, sf__Created: 'false', Id })) },
    });

    const org = removalOrg(connection as unknown as Connection, 'test');
    const answer = await org.bulkDestroy?.('Contact', ids);

    expect(opened.map((job) => job.operation)).toEqual(['delete']);
    expect(answer).toEqual({
      kind: 'answered',
      rows: ids.map(() => ({ success: true })),
      requests: 7,
    });
  });

  it('counts every read of the state of a job the org took a while over, each one of its requests', async () => {
    vi.useFakeTimers();
    try {
      const { connection } = fakeBulk({
        results: { successfulResults: ids.map((Id) => ({ sf__Id: Id, sf__Created: 'false', Id })) },
      });
      const states: Array<BulkJobCheckResult['state']> = [
        'InProgress',
        'InProgress',
        'JobComplete',
      ];
      const create = connection.bulk2.createJob.bind(connection.bulk2);
      connection.bulk2.createJob = (options) => ({
        ...create(options),
        check: async () => ({ state: states.shift() ?? 'JobComplete', numberRecordsProcessed: 3 }),
      });

      const answering = bulkDeleteJob(connection, 'Contact', ids);
      await vi.runAllTimersAsync();
      const answer = await answering;

      expect(answer.kind).toBe('answered');
      // Opened, sent, closed, three reads of its state, its results three ways.
      expect(answer.requests).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a job stopped before it was closed, and says nothing of it was deleted', async () => {
    const { connection, opened } = fakeBulk({});
    const stop = new AbortController();
    stop.abort();

    expect(await bulkDeleteJob(connection, 'Contact', ids, stop.signal)).toEqual({
      kind: 'aborted',
      // Opened, then aborted: nothing sent for the org to process.
      requests: 2,
    });
    expect(opened[0]).toMatchObject({ operation: 'delete', aborted: true });
  });
});
