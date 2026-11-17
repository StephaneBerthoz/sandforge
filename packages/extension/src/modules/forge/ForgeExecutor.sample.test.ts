import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphNode, ForgeSampleOptions } from '@sandforge/shared';
import type {
  BulkApiConnection,
  BulkJobHandle,
  JsforceIngestJobResults,
} from '../../core/engine/BulkApiExecutor.js';
import type { IngestJobResultsReading } from '../../core/engine/ingestJobRead.js';
import { SampleSourceOrg } from '../../test/sampleSourceOrg.js';
import { ForgeExecutor, WHOLE_ORG_WINDOW } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeWriteBoundary,
} from './ForgeExecutor.js';
import { ForgeRunStore, memoryRunFile } from './ForgeRunStore.js';
import { cursorPages } from './queryAllPages.js';
import { forgeBulkWrite } from './forgeBulkWrite.js';
import { SamplePlan, removeSamplePlan } from './sample/samplePlanStore.js';
import { SampleRefusedError, type SampleBudgetTerms } from './sample/sampleDrawing.js';
import { sampleGateErrorOf } from './ForgeRunGate.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A clone of the whole org that copies a sample of it (`stream.sample`):
 * against a source in memory that answers the reads of a sample as the org
 * does (`test/sampleSourceOrg.ts`), and a target that takes REST calls and
 * Bulk API 2.0 jobs, the jobs through the writer the extension sends them
 * with (`forgeBulkWrite`). The run draws its plan before its gate, the gate
 * counts it, and the run writes the plan's records, every one, and no other.
 */

type Row = Record<string, unknown>;

/** A fake id: the object's prefix, a letter for the org, a counter; the length of a real one. */
const fakeId = (prefix: string, org: 'S' | 'T', n: number): string =>
  `${prefix}${org}${String(n).padStart(11, '0')}AAA`;

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  updateable: name !== 'Id',
  isReference: false,
  ...overrides,
});

/** Accounts naming a parent account, and contacts that cannot be written without theirs. */
const FIELDS: Record<string, FieldInfo[]> = {
  Account: [
    field('Id'),
    field('Name'),
    field('ParentId', { isReference: true, referenceTo: ['Account'], nillable: true }),
  ],
  Contact: [
    field('Id'),
    field('LastName'),
    field('AccountId', { isReference: true, referenceTo: ['Account'], nillable: false }),
  ],
};

const PREFIX: Record<string, string> = {
  Account: '001',
  Contact: '003',
  Pricebook2: '01s',
  Product2: '01t',
  PricebookEntry: '01u',
  Line__c: 'a0L',
};

function node(objectApiName: string, recordCount: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

function graphOf(accounts: number, contacts: number): ForgeGraph {
  return {
    nodes: [node('Account', accounts), node('Contact', contacts)],
    edges: [
      {
        sourceObject: 'Account',
        targetObject: 'Contact',
        relationshipName: 'Contacts',
        type: 'lookup',
        required: true,
      },
      {
        sourceObject: 'Account',
        targetObject: 'Account',
        relationshipName: 'ChildAccounts',
        type: 'lookup',
      },
    ],
    totalRecords: accounts + contacts,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

/**
 * A source of `count` accounts, each with one contact; every tenth account
 * names the next as its parent.
 */
function sourceOf(count: number): SampleSourceOrg {
  const org = new SampleSourceOrg();
  org.columns.set('Account', ['Id', 'Name', 'ParentId', 'CreatedDate', 'IsDeleted']);
  org.columns.set('Contact', ['Id', 'LastName', 'AccountId', 'CreatedDate', 'IsDeleted']);
  for (let n = 1; n <= count; n++) {
    org.add('Account', {
      Id: fakeId('001', 'S', n),
      Name: `A${n}`,
      ParentId: n % 10 === 0 && n < count ? fakeId('001', 'S', n + 1) : null,
      IsDeleted: false,
    });
    org.add('Contact', {
      Id: fakeId('003', 'S', n),
      LastName: `C${n}`,
      AccountId: fakeId('001', 'S', n),
      IsDeleted: false,
    });
  }
  return org;
}

/** The cells of a CSV a job is sent, as `forgeBulkWrite` writes it: no value of these rows holds a comma or a quote. */
function rowsOfCsv(csv: string): Array<Record<string, string>> {
  const [header, ...lines] = csv.trimEnd().split('\n');
  const columns = header.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? '']));
  });
}

/**
 * A target that creates what it is sent — by REST, and as Bulk API 2.0 jobs
 * answered as the org answers them, each row's cells echoed after its id —
 * and applies the updates it is sent: what it holds, by object, each record
 * with the source id it was written for.
 */
function targetOrg() {
  const held = new Map<string, Map<string, Row>>();
  const jobs: Array<{ object: string; operation: string; rows: number }> = [];
  let created = 0;
  const create = (object: string, row: Row): string => {
    const id = fakeId(PREFIX[object] ?? 'a00', 'T', ++created);
    const table = held.get(object) ?? new Map<string, Row>();
    table.set(id, { ...row });
    held.set(object, table);
    return id;
  };
  const update = (object: string, row: Row): boolean => {
    const record = held.get(object)?.get(String(row['Id']));
    if (!record) return false;
    for (const [name, value] of Object.entries(row)) if (name !== 'Id') record[name] = value;
    return true;
  };
  let jobs2 = 0;
  const conn: BulkApiConnection & IngestJobResultsReading = {
    bulk2: {
      createJob: (options) => {
        const jobId = `750${String(++jobs2).padStart(12, '0')}AAA`;
        let opened = false;
        let uploaded = '';
        let results: JsforceIngestJobResults = {};
        const info = () => ({
          id: jobId,
          operation: options.operation,
          object: options.object,
          state: 'JobComplete' as const,
          createdDate: '2026-11-14T10:00:00.000+0000',
          numberRecordsProcessed: results.successfulResults?.length ?? 0,
          numberRecordsFailed: 0,
        });
        const job: BulkJobHandle = {
          get id() {
            return opened ? jobId : undefined;
          },
          open: async () => {
            opened = true;
          },
          uploadData: async (csv) => {
            uploaded = csv;
          },
          close: async () => {
            const rows = rowsOfCsv(uploaded);
            jobs.push({ object: options.object, operation: options.operation, rows: rows.length });
            results = {
              successfulResults: rows.map((row) => {
                const sent: Row = Object.fromEntries(
                  Object.entries(row).map(([k, v]) => [k, v === '#N/A' ? null : v]),
                );
                const id =
                  options.operation === 'insert'
                    ? create(options.object, sent)
                    : (update(options.object, sent), String(row['Id']));
                return {
                  sf__Id: id,
                  sf__Created: options.operation === 'insert' ? 'true' : 'false',
                  ...row,
                };
              }),
            };
          },
          abort: async () => {},
          check: async () => info(),
          getAllResults: async () => ({
            successfulResults: results.successfulResults ?? [],
            failedResults: [],
            unprocessedRecords: [],
          }),
        };
        return job;
      },
      job: () => ({
        check: async () => ({
          id: '',
          operation: 'insert',
          object: '',
          state: 'JobComplete',
          createdDate: '2026-11-14T10:00:00.000+0000',
          numberRecordsProcessed: 0,
          numberRecordsFailed: 0,
        }),
        getSuccessfulResults: async () => [],
        getAllResults: async () => ({
          successfulResults: [],
          failedResults: [],
          unprocessedRecords: [],
        }),
        abort: async () => {},
      }),
    },
  };
  return { held, jobs, create, update, conn };
}

/** Deps over `source` and a fresh target; `abortAfterInserts` stops the run once the target took that many rows by REST. */
function orgs(
  source: SampleSourceOrg,
  options: {
    stopAfterInserts?: () => number;
    target?: ReturnType<typeof targetOrg>;
    /** What an org answers a statement with before anything else; undefined to go on. */
    answers?: (org: string, soql: string) => Row[] | undefined;
    /** The target's one currency, as the API says it; none for a target of several. */
    targetCurrency?: string;
  } = {},
) {
  const target = options.target ?? targetOrg();
  const holder: { executor?: ForgeExecutor } = {};
  let restInserted = 0;
  const gather = async (soql: string): Promise<Row[]> => {
    const rows: Row[] = [];
    for await (const page of cursorPages(source, soql)) rows.push(...page);
    return rows;
  };
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? []),
    queryRecords: vi.fn(
      async (org: string, soql: string) =>
        options.answers?.(org, soql) ?? (org === 'src' ? gather(soql) : []),
    ),
    queryPages: (org: string, soql: string, read?: { all?: true }) =>
      org === 'src'
        ? cursorPages(source, soql, read)
        : (async function* none(): AsyncGenerator<Row[]> {
            yield [];
          })(),
    countRecords: vi.fn(async (_org: string, soql: string) => (await source.query(soql)).totalSize),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Row[]) => {
      const answers = rows.map((row) => ({
        id: target.create(object, row),
        success: true,
        errors: [],
      }));
      restInserted += rows.length;
      const stopAt = options.stopAfterInserts?.();
      if (stopAt !== undefined && restInserted >= stopAt) holder.executor?.abort();
      return answers;
    }),
    updateRecords: vi.fn(async (_org: string, object: string, rows: Row[]) =>
      rows.map((row) => ({
        id: String(row['Id']),
        success: target.update(object, row),
        errors: [],
      })),
    ),
    isObjectCreatable: async () => true,
    bulkWriteRecords: vi.fn<NonNullable<ForgeExecutorDeps['bulkWriteRecords']>>(
      async (_org, object, operation, records, writeOptions) =>
        forgeBulkWrite(target.conn, writeOptions.bulkManager, object, operation, records, {
          ...(writeOptions.signal ? { signal: writeOptions.signal } : {}),
          ...(writeOptions.onOpened ? { onOpened: writeOptions.onOpened } : {}),
          pollDelay: () => 0,
        }),
    ),
    duplicateRuleObjects: async () => new Set<string>(),
    orgCurrency: async (org: string) => (org === 'tgt' ? options.targetCurrency : undefined),
  } satisfies ForgeExecutorDeps;
  const executor = new ForgeExecutor(deps);
  holder.executor = executor;
  return { executor, deps, target };
}

/** A budget of `kb` KB of the target's storage, its room the same. */
function budgetOf(kb: number): SampleBudgetTerms {
  return {
    budget: { bytes: kb * 1024, limitedBy: 'storage' },
    bytesLimit: 'storage',
    roomBytes: kb * 1024,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A folder of its own for the plans of a test. */
function plansDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-sample-'));
  dirs.push(dir);
  return dir;
}

/** The options a clone of the whole org that copies a sample is run with, as the orchestrator gives them. */
function sampleRun(
  keepAt: string,
  budget: SampleBudgetTerms,
  extra: {
    store?: ForgeRunStore;
    plan?: SamplePlan;
    options?: ForgeSampleOptions;
    dryRun?: boolean;
    writeWindow?: number;
    gate?: ForgeWriteBoundary[];
  } = {},
): ExecuteOptions {
  return {
    writeApi: 'auto',
    ...(extra.dryRun ? { dryRun: true } : {}),
    beforeWrite: async (boundary) => {
      extra.gate?.push(boundary);
    },
    stream: {
      everything: true,
      writeWindow: extra.writeWindow ?? WHOLE_ORG_WINDOW,
      secondPassPageSize: WHOLE_ORG_WINDOW,
      ...(extra.store ? { store: extra.store } : {}),
      sample: {
        options: extra.options ?? {},
        budget: async () => budget,
        keepAt,
        fingerprint: 'setup1',
        ...(extra.plan ? { plan: extra.plan } : {}),
      },
    },
  };
}

/** The source ids of what the run wrote, by object: what the target holds, as the summary maps it. */
function writtenIds(summary: ExecutionSummary): Map<string, string[]> {
  const byObject = new Map<string, string[]>();
  for (const sourceId of Object.keys(summary.remapTable)) {
    const object = sourceId.startsWith('001') ? 'Account' : 'Contact';
    byObject.set(object, [...(byObject.get(object) ?? []), sourceId]);
  }
  for (const ids of byObject.values()) ids.sort();
  return byObject;
}

/** The ids of a plan, by object. */
async function planIds(plan: SamplePlan, object: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const page of plan.ids(object)) ids.push(...page);
  return ids;
}

describe('a clone of the whole org that copies a sample of it', () => {
  it('draws its plan on a dry run, keeps it, shows its gate the plan’s counts, and sends no job nor any write', async () => {
    const source = sourceOf(2_600);
    const { executor, deps } = orgs(source);
    const gate: ForgeWriteBoundary[] = [];
    const keepAt = join(plansDir(), 'dry');

    const summary = await executor.execute(
      graphOf(2_600, 2_600),
      'src',
      'tgt',
      () => {},
      sampleRun(keepAt, budgetOf(8_800), { dryRun: true, gate }),
    );

    const plan = await SamplePlan.open(keepAt, { sourceOrgId: 'src', fingerprint: 'setup1' });
    expect(plan.manifest.drawnBy).toBe('dryRun');
    const accounts = plan.countOf('Account');
    const contacts = plan.countOf('Contact');
    expect(accounts).toBeGreaterThan(2_000);
    expect(accounts).toBeLessThan(2_600);
    // Each contact with its account: none drawn without it.
    expect(contacts).toBeLessThanOrEqual(accounts);
    expect(gate).toHaveLength(1);
    const [boundary] = gate;
    expect(boundary.dryRun).toBe(true);
    expect(boundary.objects.map((o) => [o.objectApiName, o.counted?.rows])).toEqual([
      ['Account', accounts],
      ['Contact', contacts],
    ]);
    expect(boundary.wholeOrg?.sample?.report).toMatchObject({
      seed: 1,
      draw: 'uniform',
      plan: { path: keepAt, sha256: plan.sha256, drawnBy: 'dryRun' },
    });
    // Priced as read by the plan's ids: a statement per list, not a page per 2 000 rows.
    expect(boundary.wholeOrg?.writes.map((w) => [w.objectApiName, w.jobs])).toEqual([
      ['Account', 1],
      ['Contact', 1],
    ]);
    expect(deps.bulkWriteRecords).not.toHaveBeenCalled();
    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(deps.updateRecords).not.toHaveBeenCalled();
    expect(summary.sample).toBeUndefined();
  }, 60_000);

  it('writes exactly the records of its plan, as Bulk API jobs, every contact under its account, and names the plan in its journal', async () => {
    const source = sourceOf(2_600);
    const { executor, deps, target } = orgs(source);
    const file = memoryRunFile();
    const store = ForgeRunStore.open(file);
    const keepAt = join(plansDir(), 'run.sample');

    const summary = await executor.execute(
      graphOf(2_600, 2_600),
      'src',
      'tgt',
      () => {},
      sampleRun(keepAt, budgetOf(8_800), { store }),
    );

    const plan = await SamplePlan.open(keepAt);
    expect(store.samplePlan).toEqual({ dir: keepAt, sha256: plan.sha256 });
    const written = writtenIds(summary);
    expect(written.get('Account')).toEqual(await planIds(plan, 'Account'));
    expect(written.get('Contact')).toEqual(await planIds(plan, 'Contact'));
    expect(
      vi.mocked(deps.bulkWriteRecords).mock.calls.map(([, object, op]) => `${op} ${object}`),
    ).toContain('insert Account');
    expect(target.jobs.filter((job) => job.operation === 'insert').map((j) => j.object)).toEqual([
      'Account',
      'Contact',
    ]);
    // No orphan: every contact in the target names an account the run wrote.
    const accounts = new Set(target.held.get('Account')?.keys());
    for (const contact of target.held.get('Contact')?.values() ?? []) {
      expect(accounts.has(String(contact['AccountId']))).toBe(true);
    }
    expect(summary.errors).toEqual([]);
    expect(summary.failedCount).toBe(0);
    expect(summary.sample?.sha256).toBe(plan.sha256);
    expect(summary.sample?.objects.map((o) => [o.objectApiName, o.written, o.kept])).toEqual([
      ['Account', plan.countOf('Account'), plan.countOf('Account')],
      ['Contact', plan.countOf('Contact'), plan.countOf('Contact')],
    ]);
  }, 60_000);

  it('takes up the plan a dry run drew, reading none of the roots again, and writes its ids', async () => {
    const source = sourceOf(150);
    const keepAt = join(plansDir(), 'dry');
    await orgs(source).executor.execute(
      graphOf(150, 150),
      'src',
      'tgt',
      () => {},
      sampleRun(keepAt, budgetOf(400), { dryRun: true }),
    );
    const plan = await SamplePlan.open(keepAt);
    const sentBefore = source.sent.length;
    const { executor } = orgs(source);

    const summary = await executor.execute(
      graphOf(150, 150),
      'src',
      'tgt',
      () => {},
      sampleRun(join(plansDir(), 'unused'), budgetOf(1), { plan }),
    );

    const after = source.sent.slice(sentBefore).map(({ soql }) => soql);
    expect(after.some((soql) => soql.startsWith('SELECT COUNT() FROM'))).toBe(false);
    expect(writtenIds(summary).get('Account')).toEqual(await planIds(plan, 'Account'));
    expect(writtenIds(summary).get('Contact')).toEqual(await planIds(plan, 'Contact'));
  }, 60_000);

  it('resumes after the last id it wrote, on the same plan, and the two parts write the plan once', async () => {
    const source = sourceOf(150);
    const keepAt = join(plansDir(), 'run.sample');
    const file = memoryRunFile();
    const first = ForgeRunStore.open(file);
    const stopping = orgs(source, { stopAfterInserts: () => 60 });
    await expect(
      stopping.executor.execute(
        graphOf(150, 150),
        'src',
        'tgt',
        () => {},
        sampleRun(keepAt, budgetOf(400), { store: first, writeWindow: 20 }),
      ),
    ).rejects.toThrow(/aborted/);
    first.close();
    const plan = await SamplePlan.open(keepAt);
    const firstWritten = [...(stopping.target.held.get('Account')?.values() ?? [])].length;
    expect(firstWritten).toBeGreaterThan(0);
    expect(firstWritten).toBeLessThan(plan.countOf('Account'));

    const store = ForgeRunStore.open(memoryRunFile(file.text()));
    const stoppedAt = store.checkpoints().get('Account')?.lastId;
    expect(stoppedAt).toBeDefined();
    const sentBefore = source.sent.length;
    // The same target: what the first part wrote is there.
    const before = new Set(stopping.target.held.get('Account')?.keys());
    const resumed = orgs(source, { target: stopping.target });
    const summary = await resumed.executor.execute(
      graphOf(150, 150),
      'src',
      'tgt',
      () => {},
      // A budget nobody reads: the plan is the journal's.
      sampleRun(join(plansDir(), 'unused'), budgetOf(1), { store, writeWindow: 20 }),
    );

    const accounts = [...(resumed.target.held.get('Account')?.values() ?? [])].map((row) =>
      String(row['Name']),
    );
    expect(before.size).toBe(firstWritten);
    // Its accounts read by the plan's ids after the last one written, none before it.
    const named = source.sent
      .slice(sentBefore)
      .filter(({ soql }) => /^SELECT .+ FROM Account WHERE .*Id IN \(/.test(soql))
      .flatMap(({ soql }) => [...soql.matchAll(/'(001S\w+)'/g)].map(([, id]) => id));
    expect(named.length).toBe(
      plan.countOf('Account') - (await planIds(plan, 'Account')).indexOf(stoppedAt ?? '') - 1,
    );
    expect(named.every((id) => id > (stoppedAt ?? ''))).toBe(true);
    expect(accounts).toHaveLength(plan.countOf('Account'));
    expect(new Set(accounts).size).toBe(accounts.length);
    expect(summary.errors.filter((e) => e.objectApiName === '__pass2__')).toEqual([]);
    expect(summary.sample?.objects.find((o) => o.objectApiName === 'Account')?.written).toBe(
      plan.countOf('Account'),
    );
  }, 60_000);

  it('refuses, writing nothing, a sample its budget holds not one root of, rather than succeed with none', async () => {
    for (const options of [{}, { floor: 0 }]) {
      const { executor, deps } = orgs(sourceOf(150));
      const run = executor.execute(
        graphOf(150, 150),
        'src',
        'tgt',
        () => {},
        sampleRun(join(plansDir(), 'tiny'), budgetOf(0), { options }),
      );
      await expect(run).rejects.toBeInstanceOf(SampleRefusedError);
      await expect(run).rejects.toMatchObject({ code: 'SAMPLE_CANNOT_FIT' });
      expect(deps.insertRecords).not.toHaveBeenCalled();
      expect(deps.bulkWriteRecords).not.toHaveBeenCalled();
      // Without floors, the refusal names the smallest sample, and proposes no floor of 0 again.
      const message = await run.then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : ''),
      );
      if ('floor' in options) {
        expect(message).toMatch(/the first root drawn with the records it brings take 2 records/);
        expect(message).not.toMatch(/--fit-floor 0/);
      } else {
        expect(message).toMatch(/--fit-floor 0/);
      }
    }
  }, 60_000);

  it('says what held a sample that cannot fit, and offers to take more only of a bound that can give it', async () => {
    // Held by the data storage the target has left, the refusal proposed to
    // take more of the target (--fit-within), which no setting gives.
    const refusalOf = async (budget: SampleBudgetTerms) => {
      const { executor } = orgs(sourceOf(150));
      return executor
        .execute(
          graphOf(150, 150),
          'src',
          'tgt',
          () => {},
          sampleRun(join(plansDir(), 'held'), budget),
        )
        .then(
          () => undefined,
          (error: unknown) => error as SampleRefusedError & { sample?: Record<string, unknown> },
        );
    };

    const byStorage = await refusalOf(budgetOf(0));
    expect(byStorage?.code).toBe('SAMPLE_CANNOT_FIT');
    expect(byStorage?.message).toContain('past the data storage the target has left');
    expect(byStorage?.message).toContain('free data storage in the target');
    expect(byStorage?.message).not.toContain('--fit-within');
    expect(byStorage?.sample).toMatchObject({ limitedBy: 'storage', budgetMB: 0 });
    expect(byStorage?.sample?.['needMB']).toBeGreaterThan(0);
    expect(byStorage?.sample?.['heaviest']).toEqual(expect.arrayContaining(['Account']));
    // Kept past the gate, which the page reads the way out from.
    expect(sampleGateErrorOf(byStorage, 'draw')?.stop?.sample).toMatchObject({
      limitedBy: 'storage',
      budgetMB: 0,
    });

    const byWithin = await refusalOf({
      budget: { bytes: 0, withinMB: 0, limitedBy: 'within' },
      bytesLimit: 'within',
      roomBytes: 1024 * 1024 * 1024,
    });
    expect(byWithin?.message).toContain('past the MB it may take (--fit-within)');
    expect(byWithin?.message).toContain('or let it take more (--fit-within)');
    expect(byWithin?.sample).toMatchObject({ limitedBy: 'within' });

    // Asked to take 1 MB of a trap org whose storage left 3.6, a sample that
    // needed 14 MB was refused with "or let it take more (--fit-within)":
    // past the storage too, more MB asked lets none of it through.
    const pastBoth = await refusalOf({
      budget: { bytes: 0, withinMB: 0, remainingMB: 0.5, maxMB: 5, limitedBy: 'within' },
      bytesLimit: 'within',
      roomBytes: 1024,
      storageBytes: 1024,
    });
    expect(pastBoth?.message).toContain('past the data storage the target has left');
    expect(pastBoth?.message).toContain('free data storage in the target');
    expect(pastBoth?.message).not.toContain('--fit-within');
    // What the sample may take of that storage, which held it, not the MB asked.
    expect(pastBoth?.sample).toMatchObject({ limitedBy: 'storage', budgetMB: 0 });
    expect(sampleGateErrorOf(pastBoth, 'draw')?.stop?.sample).toMatchObject({
      limitedBy: 'storage',
    });

    // Within what the storage leaves, the MB asked holds it, and more of them lets it through.
    const withinOnly = await refusalOf({
      budget: { bytes: 0, withinMB: 0, remainingMB: 500, maxMB: 500, limitedBy: 'within' },
      bytesLimit: 'within',
      roomBytes: 1024 * 1024 * 1024,
      storageBytes: 1024 * 1024 * 1024,
    });
    expect(withinOnly?.message).toContain('or let it take more (--fit-within)');
    expect(withinOnly?.sample).toMatchObject({ limitedBy: 'within' });

    const byRecords = await refusalOf({
      budget: { bytes: 1024 * 1024 * 1024, maxTotal: 1, limitedBy: 'maxTotal' },
      bytesLimit: 'storage',
      roomBytes: 1024 * 1024 * 1024,
    });
    expect(byRecords?.message).toContain('past the records it may write (--max-total)');
    expect(byRecords?.message).toContain('or raise --max-total');
    expect(byRecords?.message).not.toContain('--fit-within');
    // Sized in MB only where MB held it: a count of records past its bound is no size past one.
    expect(byRecords?.sample).toEqual({
      limitedBy: 'maxTotal',
      heaviest: expect.arrayContaining(['Account']),
    });
  }, 60_000);

  it('refuses to resume a run whose plan is gone, writing nothing', async () => {
    const source = sourceOf(150);
    const keepAt = join(plansDir(), 'run.sample');
    const file = memoryRunFile();
    const first = ForgeRunStore.open(file);
    await expect(
      orgs(source, { stopAfterInserts: () => 40 }).executor.execute(
        graphOf(150, 150),
        'src',
        'tgt',
        () => {},
        sampleRun(keepAt, budgetOf(400), { store: first, writeWindow: 20 }),
      ),
    ).rejects.toThrow(/aborted/);
    first.close();
    await removeSamplePlan(keepAt);
    const { executor, deps } = orgs(source);

    const resumed = executor.execute(
      graphOf(150, 150),
      'src',
      'tgt',
      () => {},
      sampleRun(join(plansDir(), 'unused'), budgetOf(400), {
        store: ForgeRunStore.open(memoryRunFile(file.text())),
      }),
    );

    await expect(resumed).rejects.toBeInstanceOf(SampleRefusedError);
    await expect(resumed).rejects.toMatchObject({ code: 'SAMPLE_PLAN_GONE' });
    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(deps.bulkWriteRecords).not.toHaveBeenCalled();
  }, 60_000);

  it('holds back, counted failed and never sent, a row whose parent changed since the plan, and says gone a record the source no longer holds', async () => {
    const source = sourceOf(150);
    const keepAt = join(plansDir(), 'dry');
    await orgs(source).executor.execute(
      graphOf(150, 150),
      'src',
      'tgt',
      () => {},
      sampleRun(keepAt, budgetOf(400), { dryRun: true }),
    );
    const plan = await SamplePlan.open(keepAt);
    const accountsKept = new Set(await planIds(plan, 'Account'));
    const contactsKept = await planIds(plan, 'Contact');
    const outside = [...Array(150).keys()]
      .map((n) => fakeId('001', 'S', n + 1))
      .find((id) => !accountsKept.has(id));
    expect(outside).toBeDefined();
    // Since the plan: a contact moved under an account outside it, and an account deleted.
    const moved = source.rows.get('Contact')?.find((row) => row['Id'] === contactsKept[0]);
    if (!moved || outside === undefined) throw new Error('no contact');
    (moved as Row)['AccountId'] = outside;
    const goneId = [...accountsKept].sort().at(-1);
    const gone = source.rows.get('Account')?.find((row) => row['Id'] === goneId);
    if (!gone) throw new Error('no account');
    (gone as Row)['IsDeleted'] = true;
    const { executor, deps } = orgs(source);

    const summary = await executor.execute(
      graphOf(150, 150),
      'src',
      'tgt',
      () => {},
      sampleRun(join(plansDir(), 'unused'), budgetOf(1), { plan }),
    );

    const sentContacts = vi
      .mocked(deps.insertRecords)
      .mock.calls.filter(([, object]) => object === 'Contact')
      .flatMap(([, , rows]) => rows);
    expect(sentContacts.some((row) => row['LastName'] === moved['LastName'])).toBe(false);
    const contacts = summary.sample?.objects.find((o) => o.objectApiName === 'Contact');
    const accounts = summary.sample?.objects.find((o) => o.objectApiName === 'Account');
    expect(contacts?.changedSinceTheSample).toBe(1);
    expect(accounts?.goneSinceTheSample).toBe(1);
    expect(summary.failedCount).toBe(1);
  }, 60_000);

  it('weighs at its gate the text of the plan’s emails alone, read by their ids', async () => {
    const source = new SampleSourceOrg();
    source.columns.set('EmailMessage', ['Id', 'Subject', 'TextBody', 'CreatedDate', 'IsDeleted']);
    const body = (n: number): string => 'x'.repeat(1_000 * n);
    for (let n = 1; n <= 150; n++) {
      source.add('EmailMessage', {
        Id: fakeId('02s', 'S', n),
        Subject: `S${n}`,
        TextBody: body(n),
        IsDeleted: false,
      });
    }
    FIELDS['EmailMessage'] = [
      field('Id'),
      field('Subject', { type: 'string' }),
      field('TextBody', { type: 'textarea' }),
    ];
    const gate: ForgeWriteBoundary[] = [];
    const keepAt = join(plansDir(), 'dry');
    try {
      await orgs(source).executor.execute(
        {
          ...graphOf(0, 0),
          nodes: [node('EmailMessage', 150)],
          edges: [],
        },
        'src',
        'tgt',
        () => {},
        // Weighed at some 75 KB each, an email past a tenth of a smaller room is set aside.
        sampleRun(keepAt, budgetOf(1_500), { dryRun: true, gate }),
      );
    } finally {
      delete FIELDS['EmailMessage'];
    }

    const plan = await SamplePlan.open(keepAt);
    const kept = await planIds(plan, 'EmailMessage');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(150);
    const planned = kept.reduce(
      (sum, id) =>
        sum + `S${Number(id.slice(4, 15))}`.length + body(Number(id.slice(4, 15))).length,
      0,
    );
    expect(gate[0]?.wholeOrg?.emailTextBytes).toBe(planned);
  }, 60_000);

  it('weighs each email it draws at the size of the text of two hundred emails of the source, not at nothing', async () => {
    const source = new SampleSourceOrg();
    source.columns.set('EmailMessage', ['Id', 'Subject', 'TextBody', 'CreatedDate', 'IsDeleted']);
    for (let n = 1; n <= 300; n++) {
      source.add('EmailMessage', {
        Id: fakeId('02s', 'S', n),
        Subject: 'S',
        // 9 999 bytes of text each, the subject's included.
        TextBody: 'x'.repeat(9_998),
        IsDeleted: false,
      });
    }
    FIELDS['EmailMessage'] = [
      field('Id'),
      field('Subject', { type: 'string' }),
      field('TextBody', { type: 'textarea' }),
    ];
    const keepAt = join(plansDir(), 'dry');
    try {
      await orgs(source).executor.execute(
        { ...graphOf(0, 0), nodes: [node('EmailMessage', 300)], edges: [] },
        'src',
        'tgt',
        () => {},
        sampleRun(keepAt, budgetOf(400), { dryRun: true }),
      );
    } finally {
      delete FIELDS['EmailMessage'];
    }

    const plan = await SamplePlan.open(keepAt);
    // 400 KB hold forty emails of 9 999 bytes; weighed at nothing, the 300.
    expect(plan.countOf('EmailMessage')).toBe(Math.floor((400 * 1024) / 9_999));
    expect(plan.manifest.sample.storageBytes).toBe(plan.countOf('EmailMessage') * 9_999);
    expect(plan.manifest.sample.budget.limitedBy).toBe('storage');
    // One read of the source's text, of two hundred of its emails.
    expect(
      source.sent.filter(({ soql }) =>
        /^SELECT Id, Subject, TextBody FROM EmailMessage LIMIT 200$/.test(soql),
      ),
    ).toHaveLength(1);
  }, 60_000);

  it('writes empty, owed to no second pass and failing nothing, an optional lookup at a record outside the plan', async () => {
    const source = sourceOf(150);
    const keepAt = join(plansDir(), 'run.sample');

    const summary = await orgs(source).executor.execute(
      graphOf(150, 150),
      'src',
      'tgt',
      () => {},
      // The parent an account names is not copied for it: the lookup stays empty.
      sampleRun(keepAt, budgetOf(400), { options: { parents: 'required' } }),
    );

    const plan = await SamplePlan.open(keepAt);
    const kept = new Set(await planIds(plan, 'Account'));
    const naming = [...kept].filter((id) => {
      const n = Number(id.slice(4, 15));
      return n % 10 === 0 && n < 150 && !kept.has(fakeId('001', 'S', n + 1));
    });
    expect(naming.length).toBeGreaterThan(0);
    expect(summary.errors).toEqual([]);
    expect(summary.sample?.leftEmpty).toEqual([
      { objectApiName: 'Account', field: 'ParentId', rows: naming.length },
    ]);
  }, 60_000);

  it('counts one contact the platform writes for every person account it writes whole, those of contacts its plan does not draw too, at its dry run and its run, and keeps each in its journal', async () => {
    // Run for real, a sample copied 70 person accounts whole and drew 10 of
    // their contacts: its dry run and its run said 10 contacts written by the
    // platform, the target held 70, and its verification counted 60 created
    // besides the run's.
    const PERSONS = 12;
    const BUSINESS = 8;
    const PER_BUSINESS = 40;
    const person = (n: number): string => fakeId('001', 'S', n);
    const personContact = (n: number): string => fakeId('003', 'S', n);
    const personFields: Record<string, FieldInfo[]> = {
      Account: [
        ...FIELDS.Account,
        field('IsPersonAccount', { type: 'boolean', createable: false, updateable: false }),
        field('PersonContactId', {
          isReference: true,
          referenceTo: ['Contact'],
          createable: false,
          updateable: false,
          nillable: true,
        }),
      ],
      Contact: [
        ...FIELDS.Contact,
        field('IsPersonAccount', { type: 'boolean', createable: false, updateable: false }),
      ],
    };
    const source = new SampleSourceOrg();
    source.columns.set('Account', [
      'Id',
      'Name',
      'ParentId',
      'IsPersonAccount',
      'PersonContactId',
      'CreatedDate',
      'IsDeleted',
    ]);
    source.columns.set('Contact', [
      'Id',
      'LastName',
      'AccountId',
      'IsPersonAccount',
      'CreatedDate',
      'IsDeleted',
    ]);
    for (let n = 1; n <= PERSONS; n++) {
      source.add('Account', {
        Id: person(n),
        Name: `P${n}`,
        IsPersonAccount: true,
        PersonContactId: personContact(n),
        IsDeleted: false,
      });
      source.add('Contact', {
        Id: personContact(n),
        LastName: `P${n}`,
        AccountId: person(n),
        IsPersonAccount: true,
        IsDeleted: false,
      });
    }
    let contact = PERSONS;
    for (let n = PERSONS + 1; n <= PERSONS + BUSINESS; n++) {
      source.add('Account', { Id: fakeId('001', 'S', n), Name: `B${n}`, IsDeleted: false });
      for (let c = 0; c < PER_BUSINESS; c++) {
        contact++;
        source.add('Contact', {
          Id: fakeId('003', 'S', contact),
          LastName: `C${contact}`,
          AccountId: fakeId('001', 'S', n),
          IsPersonAccount: false,
          IsDeleted: false,
        });
      }
    }
    /**
     * A target with person accounts: it writes a contact with every person
     * account it takes, which the run asks for by the accounts it wrote as
     * persons.
     */
    const personOrgs = () => {
      const base = orgs(source, {
        answers: (org, soql) => {
          const asked = /^SELECT Id, PersonContactId FROM Account WHERE Id IN \((.*)\)$/.exec(soql);
          if (org !== 'tgt' || !asked) return undefined;
          return [...asked[1].matchAll(/'(\w+)'/g)].map(([, id]) => ({
            Id: id,
            PersonContactId: `003T${id.slice(4)}`,
          }));
        },
      });
      vi.mocked(base.deps.describeFields).mockImplementation(
        async (_org: string, object: string) => personFields[object] ?? [],
      );
      return base;
    };
    const graph = graphOf(PERSONS + BUSINESS, PERSONS + BUSINESS * PER_BUSINESS);
    const keepAt = join(plansDir(), 'dry');
    const dryGate: ForgeWriteBoundary[] = [];
    await personOrgs().executor.execute(
      graph,
      'src',
      'tgt',
      () => {},
      sampleRun(keepAt, budgetOf(300), { dryRun: true, gate: dryGate }),
    );
    const plan = await SamplePlan.open(keepAt);
    expect(plan.manifest.sample.whole.map((w) => w.objectApiName)).toContain('Account');
    const drawn = new Set(await planIds(plan, 'Contact'));
    const personsDrawn = [...Array(PERSONS).keys()].filter((n) => drawn.has(personContact(n + 1)));
    // Some of the persons' contacts in the plan, some not.
    expect(personsDrawn.length).toBeGreaterThan(0);
    expect(personsDrawn.length).toBeLessThan(PERSONS);

    const gate: ForgeWriteBoundary[] = [];
    const store = ForgeRunStore.open(memoryRunFile());
    const run = personOrgs();
    const summary = await run.executor.execute(
      graph,
      'src',
      'tgt',
      () => {},
      sampleRun(join(plansDir(), 'unused'), budgetOf(1), { plan, gate, store }),
    );
    store.close();

    // A contact of the platform's for every person account written, at the
    // dry run as at the run's gate, none of them counted among what is sent.
    for (const boundary of [dryGate[0], gate[0]]) {
      const contacts = boundary?.objects.find((o) => o.objectApiName === 'Contact');
      expect(contacts?.leftOut?.byThePlatform).toBe(PERSONS);
      expect(contacts?.counted?.rows).toBe(drawn.size - personsDrawn.length);
    }
    expect(summary.writtenByThePlatform).toContainEqual({
      objectApiName: 'Contact',
      rows: PERSONS,
    });
    // Each kept with its object and marked written with its account: what a
    // verification and a removal read back from the journal.
    expect(summary.withTheirRecordSourceIds?.filter((id) => id.startsWith('003'))).toHaveLength(
      PERSONS,
    );
    const countsOfContact = store.countsByObject().find((c) => c.objectApiName === 'Contact');
    expect(countsOfContact?.linked).toBe(PERSONS);
    expect(summary.failedCount).toBe(0);
  }, 60_000);
});

/*
 * A sample whose roots are chosen — a window of dates, a filter on the roots
 * of an object, strata —, as the run hands its options to the draw: the
 * describe's types, which strata are held to, and the record types the
 * source names, which the plan names its strata by.
 */
describe('a sample of the whole org whose roots are chosen', () => {
  const BUSINESS = '012S00000000BUSAAA';
  const PARTNER = '012S00000000PRTAAA';
  const CHOSEN_FIELDS: Record<string, FieldInfo[]> = {
    Account: [
      field('Id'),
      field('Name', { type: 'string' }),
      field('ParentId', { isReference: true, referenceTo: ['Account'], nillable: true }),
      field('RecordTypeId', {
        type: 'reference',
        isReference: true,
        referenceTo: ['RecordType'],
        nillable: true,
      }),
      field('CreatedDate', { type: 'datetime', createable: false, updateable: false }),
    ],
    Contact: [
      ...FIELDS.Contact,
      field('CreatedDate', { type: 'datetime', createable: false, updateable: false }),
    ],
  };
  /** A moment `minutes` past the start of March of `year`, as the org writes a record's dates. */
  const madeIn = (year: number, minutes: number): string =>
    new Date(Date.UTC(year, 2, 1, 0, minutes)).toISOString().replace('Z', '+0000');
  const WINDOW_2025 = {
    field: 'CreatedDate' as const,
    from: '2025-01-01T00:00:00Z',
    to: '2026-01-01T00:00:00Z',
  };

  /**
   * 150 accounts, the first fifty made in 2025 and the others in 2026, every
   * tenth a partner, the others businesses, each with a contact.
   */
  function chosenSource(): SampleSourceOrg {
    const org = new SampleSourceOrg();
    org.columns.set('Account', [
      'Id',
      'Name',
      'ParentId',
      'RecordTypeId',
      'CreatedDate',
      'IsDeleted',
    ]);
    org.columns.set('Contact', ['Id', 'LastName', 'AccountId', 'CreatedDate', 'IsDeleted']);
    for (let n = 1; n <= 150; n++) {
      org.add('Account', {
        Id: fakeId('001', 'S', n),
        Name: `A${n}`,
        ParentId: null,
        RecordTypeId: n % 10 === 0 ? PARTNER : BUSINESS,
        CreatedDate: n <= 50 ? madeIn(2025, n) : madeIn(2026, n),
        IsDeleted: false,
      });
      org.add('Contact', {
        Id: fakeId('003', 'S', n),
        LastName: `C${n}`,
        AccountId: fakeId('001', 'S', n),
        CreatedDate: madeIn(2026, 1_000 + n),
        IsDeleted: false,
      });
    }
    return org;
  }

  /** The run's deps over `source`, its describes those of the chosen roots, and the record types it names. */
  function chosenOrgs(source: SampleSourceOrg) {
    const base = orgs(source);
    const deps = {
      ...base.deps,
      describeFields: vi.fn(async (_org: string, object: string) => CHOSEN_FIELDS[object] ?? []),
      describeObject: vi.fn(async (org: string, object: string) => {
        if (org !== 'src' || object !== 'Account') throw new Error('not described');
        const type = (recordTypeId: string, developerName: string) => ({
          recordTypeId,
          developerName,
          name: developerName,
          available: true,
          active: true,
          master: false,
          defaultRecordTypeMapping: false,
        });
        return {
          keyPrefix: '001',
          recordTypes: [type(BUSINESS, 'Business'), type(PARTNER, 'Partner')],
        };
      }),
    } satisfies ForgeExecutorDeps;
    return { ...base, deps, executor: new ForgeExecutor(deps) };
  }

  it('draws its plan among the roots a window and a filter chose, by strata named as the source names its record types, and its result says how by names alone', async () => {
    const options: ForgeSampleOptions = {
      window: WINDOW_2025,
      rootWhere: { Account: "Name != 'A1'" },
      strata: ['Account.RecordTypeId'],
    };
    const keepAt = join(plansDir(), 'dry');

    await chosenOrgs(chosenSource()).executor.execute(
      graphOf(150, 150),
      'src',
      'tgt',
      () => {},
      sampleRun(keepAt, budgetOf(8_800), { dryRun: true, options }),
    );

    const plan = await SamplePlan.open(keepAt);
    const { sample } = plan.manifest;
    // Made in 2025, but the first: 49, each with its contact; five partners.
    expect(plan.countOf('Account')).toBe(49);
    expect(plan.countOf('Contact')).toBe(49);
    expect(sample.budget.limitedBy).toBe('draw');
    expect(sample.objects.find((o) => o.objectApiName === 'Account')).toMatchObject({
      rootsInTheDraw: 49,
      rootsInTheSource: 150,
    });
    expect(sample.roots).toEqual({
      window: WINDOW_2025,
      where: [{ objectApiName: 'Account', where: "Name != 'A1'" }],
      strata: [
        {
          objectApiName: 'Account',
          field: 'RecordTypeId',
          values: [
            { value: BUSINESS, label: 'Business', roots: 44, kept: 44 },
            { value: PARTNER, label: 'Partner', roots: 5, kept: 5 },
          ],
        },
      ],
    });

    const store = ForgeRunStore.open(memoryRunFile());
    const summary = await chosenOrgs(chosenSource()).executor.execute(
      graphOf(150, 150),
      'src',
      'tgt',
      () => {},
      sampleRun(join(plansDir(), 'run.sample'), budgetOf(8_800), { store, options }),
    );
    expect(summary.sample?.roots).toEqual({
      window: WINDOW_2025,
      whereObjects: ['Account'],
      strataFields: ['Account.RecordTypeId'],
    });
    expect(JSON.stringify(summary.sample)).not.toMatch(/A1'|Business|Partner/);
  }, 60_000);

  it('names the floors of the strata among what a sample that cannot fit takes, and fewer strata among the ways out', async () => {
    const { executor, deps } = chosenOrgs(chosenSource());

    const run = executor.execute(
      graphOf(150, 150),
      'src',
      'tgt',
      () => {},
      sampleRun(join(plansDir(), 'tiny'), budgetOf(0), {
        options: { strata: ['Account.RecordTypeId'] },
      }),
    );

    await expect(run).rejects.toMatchObject({
      code: 'SAMPLE_CANNOT_FIT',
      message: expect.stringMatching(
        /2 roots for the floors of 2 values.*stratify fewer objects \(--fit-strata\)/,
      ),
    });
    expect(deps.insertRecords).not.toHaveBeenCalled();
  }, 60_000);

  it('refuses a stratum the describe says is text before any read of the roots, and keeps no plan', async () => {
    const source = chosenSource();
    const keepAt = join(plansDir(), 'refused');

    const run = chosenOrgs(source).executor.execute(
      graphOf(150, 150),
      'src',
      'tgt',
      () => {},
      sampleRun(keepAt, budgetOf(8_800), { dryRun: true, options: { strata: ['Account.Name'] } }),
    );

    await expect(run).rejects.toMatchObject({
      code: 'SAMPLE_DRAW_INVALID',
      sample: { requests: 0 },
    });
    expect(source.sent.some(({ soql }) => soql.includes('COUNT'))).toBe(false);
    await expect(SamplePlan.open(keepAt)).rejects.toMatchObject({ refusal: 'gone' });
  }, 60_000);
});

/*
 * The price catalog, too large for a sample to copy whole: drawn, its records
 * come as the lines the sample keeps name them — a price, the standard price
 * its product needs, the product, the books. The run reads it by the plan's
 * ids and writes no price of the source beyond them.
 */
describe('a sample of the whole org that draws its price catalog', () => {
  const CATALOG_FIELDS: Record<string, FieldInfo[]> = {
    Pricebook2: [
      field('Id'),
      field('Name'),
      field('IsActive', { type: 'boolean' }),
      field('IsStandard', { type: 'boolean', createable: false, updateable: false }),
    ],
    Product2: [field('Id'), field('Name'), field('IsActive', { type: 'boolean' })],
    PricebookEntry: [
      field('Id'),
      field('Pricebook2Id', { isReference: true, referenceTo: ['Pricebook2'], nillable: false }),
      field('Product2Id', { isReference: true, referenceTo: ['Product2'], nillable: false }),
      field('UnitPrice', { type: 'double' }),
      field('IsActive', { type: 'boolean' }),
      field('CurrencyIsoCode', { type: 'picklist' }),
    ],
    Line__c: [
      field('Id'),
      field('Name'),
      field('Price__c', { isReference: true, referenceTo: ['PricebookEntry'], nillable: false }),
    ],
  };
  const STD = fakeId('01s', 'S', 1);
  const PARTNERS = fakeId('01s', 'S', 2);
  const TARGET_STD = fakeId('01s', 'T', 900);
  const LINES = 150;
  /** The standard price of product `n` in `currency`, and its price in the partners' book. */
  const standardOf = (n: number, currency = 'USD'): string =>
    fakeId('01u', 'S', (currency === 'USD' ? 1_000 : 3_000) + n);
  const partnersOf = (n: number, currency = 'USD'): string =>
    fakeId('01u', 'S', (currency === 'USD' ? 2_000 : 4_000) + n);

  /** A catalog of `LINES` products, each with a standard and a partners' price in USD, and a line naming each partners' price. */
  function catalogSource(): SampleSourceOrg {
    const org = new SampleSourceOrg();
    org.columns.set('Pricebook2', ['Id', 'Name', 'IsActive', 'IsStandard', 'IsDeleted']);
    org.columns.set('Product2', ['Id', 'Name', 'IsActive', 'IsDeleted']);
    org.columns.set('PricebookEntry', [
      'Id',
      'Pricebook2Id',
      'Product2Id',
      'UnitPrice',
      'IsActive',
      'CurrencyIsoCode',
      'IsDeleted',
    ]);
    org.columns.set('Line__c', ['Id', 'Name', 'Price__c', 'CreatedDate', 'IsDeleted']);
    org.add(
      'Pricebook2',
      { Id: STD, Name: 'Standard', IsActive: true, IsStandard: true, IsDeleted: false },
      { Id: PARTNERS, Name: 'Partners', IsActive: true, IsStandard: false, IsDeleted: false },
    );
    for (let n = 1; n <= LINES; n++) {
      org.add('Product2', {
        Id: fakeId('01t', 'S', n),
        Name: `P${n}`,
        IsActive: true,
        IsDeleted: false,
      });
      org.add('PricebookEntry', price(standardOf(n), STD, n, 'USD'));
      org.add('PricebookEntry', price(partnersOf(n), PARTNERS, n, 'USD'));
      org.add('Line__c', {
        Id: fakeId('a0L', 'S', n),
        Name: `L${n}`,
        Price__c: partnersOf(n),
        IsDeleted: false,
      });
    }
    return org;
  }

  function price(id: string, book: string, n: number, currency: string): Row {
    return {
      Id: id,
      Pricebook2Id: book,
      Product2Id: fakeId('01t', 'S', n),
      UnitPrice: n,
      IsActive: true,
      CurrencyIsoCode: currency,
      IsDeleted: false,
    };
  }

  const CURRENCIES_SOQL =
    'SELECT IsoCode, ConversionRate, DecimalPlaces, IsActive, IsCorporate FROM CurrencyType';
  const currency = (IsoCode: string, ConversionRate: number, IsCorporate = false): Row => ({
    IsoCode,
    ConversionRate,
    DecimalPlaces: 2,
    IsActive: true,
    IsCorporate,
  });

  /** What the two orgs answer besides the source's tables: the standard book, and their currencies. */
  function catalogAnswers(sourceCurrencies: Row[], targetCurrencies: Row[]) {
    return (org: string, soql: string): Row[] | undefined => {
      if (soql === 'SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1') {
        return [{ Id: org === 'src' ? STD : TARGET_STD }];
      }
      if (soql === CURRENCIES_SOQL) return org === 'src' ? sourceCurrencies : targetCurrencies;
      // The rest of what the currencies are read with: an org that says nothing of it.
      if (!/FROM (Pricebook2|Product2|PricebookEntry|Line__c)\b/.test(soql)) return [];
      return undefined;
    };
  }

  function catalogGraph(): ForgeGraph {
    return {
      nodes: [
        node('Pricebook2', 2),
        node('Product2', LINES),
        node('PricebookEntry', LINES * 2),
        node('Line__c', LINES),
      ],
      edges: [
        {
          sourceObject: 'Pricebook2',
          targetObject: 'PricebookEntry',
          relationshipName: 'PricebookEntries',
          type: 'lookup',
          required: true,
        },
        {
          sourceObject: 'Product2',
          targetObject: 'PricebookEntry',
          relationshipName: 'PricebookEntries',
          type: 'lookup',
          required: true,
        },
        {
          sourceObject: 'PricebookEntry',
          targetObject: 'Line__c',
          relationshipName: 'Lines',
          type: 'lookup',
          required: true,
        },
      ],
      totalRecords: LINES * 4 + 2,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };
  }

  /** The source ids the run wrote of `object`, by the prefix of its ids. */
  const writtenOf = (summary: ExecutionSummary, object: string): string[] =>
    Object.entries(summary.remapTable)
      .filter(([sourceId]) => sourceId.startsWith(PREFIX[object] ?? ''))
      .map(([sourceId]) => sourceId)
      .sort();

  /** Run `body` with the catalog's describes beside the accounts'. */
  async function withCatalog<T>(body: () => Promise<T>): Promise<T> {
    Object.assign(FIELDS, CATALOG_FIELDS);
    try {
      return await body();
    } finally {
      for (const object of Object.keys(CATALOG_FIELDS)) delete FIELDS[object];
    }
  }

  it('reads its books, products and prices by the plan’s ids, links the standard book, and writes no price beyond the plan', async () => {
    const source = catalogSource();
    const usd = [currency('USD', 1, true)];
    const answers = catalogAnswers(usd, usd);
    await withCatalog(async () => {
      const keepAt = join(plansDir(), 'dry');
      await orgs(source, { answers }).executor.execute(
        catalogGraph(),
        'src',
        'tgt',
        () => {},
        sampleRun(keepAt, budgetOf(200), { dryRun: true }),
      );
      const plan = await SamplePlan.open(keepAt);
      const whole = plan.manifest.sample.whole.map((w) => w.objectApiName);
      // Too large for a quarter of the room: drawn, not copied whole.
      expect(whole).toEqual([]);
      const lines = await planIds(plan, 'Line__c');
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThan(LINES);
      const prices = await planIds(plan, 'PricebookEntry');
      const kept = lines.map((id) => Number(id.slice(4, 15)));
      expect(prices).toEqual(
        [...kept.map((n) => standardOf(n)), ...kept.map((n) => partnersOf(n))].sort(),
      );
      expect(await planIds(plan, 'Pricebook2')).toEqual([STD, PARTNERS]);
      const sentBefore = source.sent.length;
      const { executor, target } = orgs(source, { answers });

      const summary = await executor.execute(
        catalogGraph(),
        'src',
        'tgt',
        () => {},
        sampleRun(join(plansDir(), 'unused'), budgetOf(1), { plan }),
      );

      // Read by its ids, never a page of the whole table.
      const reads = source.sent.slice(sentBefore).map(({ soql }) => soql);
      expect(reads.filter((soql) => /FROM PricebookEntry(?! WHERE)/.test(soql))).toEqual([]);
      expect(reads.some((soql) => /FROM PricebookEntry WHERE .*Id IN \(/.test(soql))).toBe(true);
      expect(writtenOf(summary, 'PricebookEntry')).toEqual(prices);
      expect(writtenOf(summary, 'Product2')).toEqual(await planIds(plan, 'Product2'));
      // The standard book linked to the target's, never written; the partners' written.
      expect(summary.remapTable[STD]).toBe(TARGET_STD);
      expect(
        [...(target.held.get('Pricebook2')?.values() ?? [])].map((row) => row['Name']),
      ).toEqual(['Partners']);
      expect(target.held.get('PricebookEntry')?.size).toBe(prices.length);
      expect(summary.failedCount).toBe(0);
      expect(summary.errors.filter((e) => e.objectApiName === '__pass2__')).toEqual([]);
    });
  }, 60_000);

  it('writes no standard price the source made since the plan, and holds back, never sent, the price that needed the one it replaced', async () => {
    const source = catalogSource();
    const usd = [currency('USD', 1, true)];
    const answers = catalogAnswers(usd, usd);
    await withCatalog(async () => {
      const keepAt = join(plansDir(), 'dry');
      await orgs(source, { answers }).executor.execute(
        catalogGraph(),
        'src',
        'tgt',
        () => {},
        sampleRun(keepAt, budgetOf(200), { dryRun: true }),
      );
      const plan = await SamplePlan.open(keepAt);
      const prices = await planIds(plan, 'PricebookEntry');
      const n = Number((await planIds(plan, 'Line__c'))[0]?.slice(4, 15));
      // Since the plan, the standard price of its product made again: a new id.
      const old = source.rows.get('PricebookEntry')?.find((row) => row['Id'] === standardOf(n));
      if (!old) throw new Error('no standard price');
      (old as Row)['IsDeleted'] = true;
      const remade = fakeId('01u', 'S', 5_000 + n);
      source.add('PricebookEntry', price(remade, STD, n, 'USD'));
      const { executor, deps } = orgs(source, { answers });

      const summary = await executor.execute(
        catalogGraph(),
        'src',
        'tgt',
        () => {},
        sampleRun(join(plansDir(), 'unused'), budgetOf(1), { plan }),
      );

      const sent = vi
        .mocked(deps.insertRecords)
        .mock.calls.filter(([, object]) => object === 'PricebookEntry')
        .flatMap(([, , rows]) => rows);
      const written = writtenOf(summary, 'PricebookEntry');
      expect(written).not.toContain(remade);
      expect(written.every((id) => prices.includes(id))).toBe(true);
      // Its partners' price would go without a standard price, which the
      // platform refuses: held back, as the line under it.
      expect(sent.some((row) => row['UnitPrice'] === n && row['Pricebook2Id'] !== TARGET_STD)).toBe(
        false,
      );
      const entries = summary.sample?.objects.find((o) => o.objectApiName === 'PricebookEntry');
      expect(entries?.goneSinceTheSample).toBe(1);
      expect(entries?.changedSinceTheSample).toBe(1);
      expect(summary.failedCount).toBe(2);
    });
  }, 60_000);

  it('takes into its plan, counted, the price a price in a currency the target lacks goes as, and writes no price beyond the plan', async () => {
    const source = catalogSource();
    // Each product priced in GBP besides, which the target does not hold: the
    // even lines name the GBP price of the partners' book.
    for (let n = 1; n <= LINES; n++) {
      source.add('PricebookEntry', price(standardOf(n, 'GBP'), STD, n, 'GBP'));
      source.add('PricebookEntry', price(partnersOf(n, 'GBP'), PARTNERS, n, 'GBP'));
      if (n % 2 === 0) {
        const line = source.rows.get('Line__c')?.find((row) => row['Id'] === fakeId('a0L', 'S', n));
        if (line) (line as Row)['Price__c'] = partnersOf(n, 'GBP');
      }
    }
    const answers = catalogAnswers(
      [currency('USD', 1, true), currency('GBP', 0.8)],
      [currency('USD', 1, true)],
    );
    await withCatalog(async () => {
      const keepAt = join(plansDir(), 'run.sample');
      const gate: ForgeWriteBoundary[] = [];
      const { executor, target } = orgs(source, { answers });

      const summary = await executor.execute(
        catalogGraph(),
        'src',
        'tgt',
        () => {},
        sampleRun(keepAt, budgetOf(400), { gate }),
      );

      const plan = await SamplePlan.open(keepAt);
      const prices = await planIds(plan, 'PricebookEntry');
      const even = (await planIds(plan, 'Line__c'))
        .map((id) => Number(id.slice(4, 15)))
        .filter((n) => n % 2 === 0);
      expect(even.length).toBeGreaterThan(0);
      // The USD prices the GBP ones go as are the plan's, drawn with them.
      for (const n of even) {
        expect(prices).toEqual(expect.arrayContaining([partnersOf(n), standardOf(n)]));
      }
      const written = writtenOf(summary, 'PricebookEntry');
      expect(written.every((id) => prices.includes(id))).toBe(true);
      // The GBP prices go as the USD ones, never written themselves: the
      // line naming one is written with the other.
      for (const n of even) {
        expect(written).not.toContain(partnersOf(n, 'GBP'));
        const line = target.held
          .get('Line__c')
          ?.get(summary.remapTable[fakeId('a0L', 'S', n)] ?? '');
        expect(line?.['Price__c']).toBe(summary.remapTable[partnersOf(n)]);
      }
      const entries = gate[0]?.objects.find((o) => o.objectApiName === 'PricebookEntry');
      expect(entries?.leftOut?.currencyReplaced).toBe(even.length * 2);
      expect(entries?.counted?.rows).toBe(written.length);
      // Every line written, none without its price.
      const pricesWritten = new Set(target.held.get('PricebookEntry')?.keys());
      for (const line of target.held.get('Line__c')?.values() ?? []) {
        expect(pricesWritten.has(String(line['Price__c']))).toBe(true);
      }
      expect(summary.failedCount).toBe(0);
    });
  }, 60_000);

  it('writes a price its plan holds in a currency the target no longer does converted, never the source’s other price beyond the plan', async () => {
    const source = catalogSource();
    for (let n = 1; n <= LINES; n++) {
      source.add('PricebookEntry', price(standardOf(n, 'GBP'), STD, n, 'GBP'));
      source.add('PricebookEntry', price(partnersOf(n, 'GBP'), PARTNERS, n, 'GBP'));
      const line = source.rows.get('Line__c')?.find((row) => row['Id'] === fakeId('a0L', 'S', n));
      if (line) (line as Row)['Price__c'] = partnersOf(n, 'GBP');
    }
    const both = [currency('USD', 1, true), currency('GBP', 0.8)];
    await withCatalog(async () => {
      // Drawn while the target held GBP: no other price taken in.
      const keepAt = join(plansDir(), 'dry');
      await orgs(source, { answers: catalogAnswers(both, both) }).executor.execute(
        catalogGraph(),
        'src',
        'tgt',
        () => {},
        sampleRun(keepAt, budgetOf(200), { dryRun: true }),
      );
      const plan = await SamplePlan.open(keepAt);
      const prices = await planIds(plan, 'PricebookEntry');
      const { executor } = orgs(source, {
        answers: catalogAnswers(both, [currency('USD', 1, true)]),
      });

      const summary = await executor.execute(
        catalogGraph(),
        'src',
        'tgt',
        () => {},
        sampleRun(join(plansDir(), 'unused'), budgetOf(1), { plan }),
      );

      const written = writtenOf(summary, 'PricebookEntry');
      expect(written).toEqual(prices);
      expect(summary.currenciesReplaced?.some((c) => c.from === 'GBP' && c.to === 'USD')).toBe(
        true,
      );
      expect(summary.failedCount).toBe(0);
    });
  }, 60_000);

  it('into a target of one currency, sends one price per product and book, the one in the target’s currency, counts at its dry run what it sends, and writes every line', async () => {
    // A source pricing each product in USD, EUR and GBP, into a target of
    // one currency, EUR: no `CurrencyIsoCode`, and one price per product of
    // a book. Run for real, the clone sent 13 prices and the target refused
    // 7 as `DUPLICATE_VALUE`, which took 2 opportunity lines with them; its
    // dry run had counted 13.
    const source = catalogSource();
    for (let n = 1; n <= LINES; n++) {
      for (const code of ['EUR', 'GBP']) {
        const at = code === 'EUR' ? 6_000 : 8_000;
        source.add('PricebookEntry', price(fakeId('01u', 'S', at + n), STD, n, code));
        source.add('PricebookEntry', price(fakeId('01u', 'S', at + 1_000 + n), PARTNERS, n, code));
      }
      // A line in three names the EUR price, one in three the GBP one.
      const line = source.rows.get('Line__c')?.find((row) => row['Id'] === fakeId('a0L', 'S', n));
      if (line && n % 3 > 0) {
        (line as Row)['Price__c'] = fakeId('01u', 'S', (n % 3 === 1 ? 7_000 : 9_000) + n);
      }
    }
    const eurOf = (n: number, book: string): string =>
      fakeId('01u', 'S', (book === STD ? 6_000 : 7_000) + n);
    const catalog = catalogAnswers(
      [currency('USD', 1, true), currency('EUR', 0.9), currency('GBP', 0.8)],
      [],
    );
    // An org of one currency has no `Organization.DefaultCurrencyIsoCode`,
    // as one answered when asked for it live: the API says its currency
    // (`orgCurrency`).
    const answers = (org: string, soql: string): Row[] | undefined => {
      if (org === 'tgt' && /\bDefaultCurrencyIsoCode\b/.test(soql)) {
        throw new Error(
          "INVALID_FIELD: No such column 'DefaultCurrencyIsoCode' on entity 'Organization'.",
        );
      }
      return catalog(org, soql);
    };

    /** The target's describes: a price there has no currency. */
    const oneCurrency = async (org: string, object: string): Promise<FieldInfo[]> =>
      (FIELDS[object] ?? []).filter(
        (f) => !(org === 'tgt' && object === 'PricebookEntry' && f.name === 'CurrencyIsoCode'),
      );
    /** A target that holds one price per product of a book, whatever it is sent. */
    const onePerPair =
      (target: ReturnType<typeof targetOrg>) => async (_org: string, object: string, rows: Row[]) =>
        rows.map((row) => {
          const pair = `${String(row['Pricebook2Id'])}|${String(row['Product2Id'])}`;
          const held = [...(target.held.get(object)?.values() ?? [])].some(
            (other) => `${String(other['Pricebook2Id'])}|${String(other['Product2Id'])}` === pair,
          );
          if (object === 'PricebookEntry' && held) {
            return {
              id: '',
              success: false,
              errors: ['DUPLICATE_VALUE: This price definition already exists in this price book'],
            };
          }
          return { id: target.create(object, row), success: true, errors: [] };
        });
    await withCatalog(async () => {
      const keepAt = join(plansDir(), 'dry');
      const dryGate: ForgeWriteBoundary[] = [];
      const dry = orgs(source, { answers, targetCurrency: 'EUR' });
      vi.mocked(dry.deps.describeFields).mockImplementation(oneCurrency);
      await dry.executor.execute(
        catalogGraph(),
        'src',
        'tgt',
        () => {},
        sampleRun(keepAt, budgetOf(10_000), { dryRun: true, gate: dryGate }),
      );
      const plan = await SamplePlan.open(keepAt);
      // Room enough for the catalog to go whole, every price of it.
      expect(plan.manifest.sample.whole.map((w) => w.objectApiName)).toContain('PricebookEntry');
      const gate: ForgeWriteBoundary[] = [];
      const { executor, deps, target } = orgs(source, { answers, targetCurrency: 'EUR' });
      vi.mocked(deps.describeFields).mockImplementation(oneCurrency);
      vi.mocked(deps.insertRecords).mockImplementation(onePerPair(target));

      const summary = await executor.execute(
        catalogGraph(),
        'src',
        'tgt',
        () => {},
        sampleRun(join(plansDir(), 'unused'), budgetOf(1), { plan, gate }),
      );

      const sent = vi
        .mocked(deps.insertRecords)
        .mock.calls.filter(([, object]) => object === 'PricebookEntry')
        .flatMap(([, , rows]) => rows);
      const pairs = sent.map(
        (row) => `${String(row['Pricebook2Id'])}|${String(row['Product2Id'])}`,
      );
      // One price per product of a book, never a second the target refuses.
      expect(new Set(pairs).size).toBe(sent.length);
      expect(sent.every((row) => !('CurrencyIsoCode' in row))).toBe(true);
      // The one kept is the price in the target's currency.
      const written = writtenOf(summary, 'PricebookEntry');
      const lines = (await planIds(plan, 'Line__c')).map((id) => Number(id.slice(4, 15)));
      expect(lines.length).toBeGreaterThan(0);
      for (const n of lines) {
        expect(written).toEqual(expect.arrayContaining([eurOf(n, PARTNERS), eurOf(n, STD)]));
      }
      expect(written.every((id) => Math.floor(Number(id.slice(4, 15)) / 2_000) === 3)).toBe(true);
      // Counted at the dry run as at the run, what is sent.
      for (const boundary of [dryGate[0], gate[0]]) {
        const entries = boundary?.objects.find((o) => o.objectApiName === 'PricebookEntry');
        expect(entries?.counted?.rows).toBe(sent.length);
        expect(entries?.leftOut?.currencyReplaced).toBeGreaterThan(0);
      }
      // Every line written, on a price the target holds.
      const pricesWritten = new Set(target.held.get('PricebookEntry')?.keys());
      expect(target.held.get('Line__c')?.size).toBe(lines.length);
      for (const line of target.held.get('Line__c')?.values() ?? []) {
        expect(pricesWritten.has(String(line['Price__c']))).toBe(true);
      }
      expect(summary.failedCount).toBe(0);
    });
  }, 60_000);
});
