import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForgeConfig, ForgeGraph, ForgeRunGateStop } from '@sandforge/shared';
import { energyOrg, fakeId, queryRootsGraph, QueryRootsOrg } from '../../test/queryRootsOrg.js';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  ForgeExecutorDeps,
  ForgeWriteBoundary,
} from './ForgeExecutor.js';
import { forgeExecuteOptions, type ForgeRunOptions } from './ForgeOrchestrator.js';
import { isForgeRunGateError } from './ForgeRunGate.js';
import { ForgeRunStore, memoryRunFile } from './ForgeRunStore.js';
import { keepRootPlan, openRootPlan } from './roots/rootPlanStore.js';
import { rootsSha256 } from './stages/QueryRoots.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A clone from the records a query chooses (`queryScope: 'records'`): each
 * record the query returns, with what the clone of that record copies, a
 * shared one read and written once. Driven as the panel and the command line
 * drive it — the config through `forgeExecuteOptions`, then the executor —
 * against a source in memory that refuses what the org refuses
 * (`test/queryRootsOrg.ts`).
 */

const account = (n: number): string => fakeId('Account', 'S', n);
const contact = (n: number): string => fakeId('Contact', 'S', n);

/** A config that clones the records `soql` chooses. */
function recordsConfig(soql: string, extra: Partial<ForgeConfig> = {}): ForgeConfig {
  return {
    sourceOrgId: 'src',
    targetOrgId: 'tgt',
    inputMode: 'soql',
    soqlQuery: soql,
    queryScope: 'records',
    depth: 'full',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
    ...extra,
  };
}

interface Run {
  summary?: ExecutionSummary;
  error?: unknown;
  /** The rows the run was about to write, by object, at its gate. */
  gate: ForgeWriteBoundary[];
}

/** Run `config` over `graph` as the orchestrator hands it to the executor. */
async function run(
  org: QueryRootsOrg,
  graph: ForgeGraph,
  config: ForgeConfig,
  options: {
    runOptions?: ForgeRunOptions;
    deps?: (executor: () => ForgeExecutor) => Partial<ForgeExecutorDeps>;
  } = {},
): Promise<Run> {
  const gate: ForgeWriteBoundary[] = [];
  const executeOptions = forgeExecuteOptions(
    graph,
    config,
    {
      ...options.runOptions,
      beforeWrite: async (boundary) => {
        gate.push(boundary);
      },
    },
    () => [],
  );
  const holder: { executor?: ForgeExecutor } = {};
  const executor = new ForgeExecutor({
    ...org.deps(),
    ...options.deps?.(() => {
      if (!holder.executor) throw new Error('No executor yet');
      return holder.executor;
    }),
  });
  holder.executor = executor;
  try {
    const summary = await executor.execute(
      graph,
      config.sourceOrgId,
      config.targetOrgId,
      () => {},
      executeOptions,
    );
    return { summary, gate };
  } catch (error: unknown) {
    return { error, gate };
  }
}

/** The ids of `object` the run set out to write, at its gate. */
function idsAtTheGate(gate: readonly ForgeWriteBoundary[], object: string): string[] {
  return gate.flatMap((boundary) =>
    boundary.objects
      .filter((o) => o.objectApiName === object)
      .flatMap((o) => o.rows.map((row) => String(row['Id']))),
  );
}

/** The stop a run was refused with. */
function stopOf(error: unknown): ForgeRunGateStop | undefined {
  return isForgeRunGateError(error) ? error.stop : undefined;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-roots-'));
  dirs.push(dir);
  return dir;
}

describe('a clone from the records a query chooses', () => {
  it('reads every child under the roots alone, never a table whole', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Account', ['Account', 'Contact', 'Opportunity', 'Case']);
    const { summary, error } = await run(
      org,
      graph,
      recordsConfig("SELECT Id FROM Account WHERE Industry = 'Energy'", { dryRun: true }),
    );
    expect(error).toBeUndefined();
    for (const soql of org.statementsOf('Contact')) {
      expect(soql).toMatch(/AccountId IN \(|Id IN \(/);
    }
    expect([...(org.answered.get('Contact') ?? [])].sort()).toEqual(
      [contact(1), contact(2), contact(3)].sort(),
    );
    expect(org.answered.get('Opportunity')).not.toContain(fakeId('Opportunity', 'S', 3));
    expect(org.answered.get('Account')).not.toContain(account(3));
    expect(summary?.roots).toMatchObject({
      objectApiName: 'Account',
      from: 'query',
      query: { where: "Industry = 'Energy'" },
      asked: 2,
      read: 2,
      gone: [],
      written: 2,
      failed: [],
      sha256: rootsSha256([account(1), account(2)]),
    });
  });

  it('reads a parent the roots share once, by its id, writes it once, and says it named and what was read under it', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Contact', ['Contact', 'Account', 'Opportunity']);
    const { summary, error, gate } = await run(
      org,
      graph,
      recordsConfig(`SELECT Id FROM Contact WHERE AccountId = '${account(1)}'`, { dryRun: true }),
    );
    expect(error).toBeUndefined();
    const accountReads = org.statementsOf('Account');
    expect(accountReads).toHaveLength(1);
    expect(accountReads[0]).toContain(`WHERE Id IN ('${account(1)}')`);
    expect(idsAtTheGate(gate, 'Account')).toEqual([account(1)]);
    expect(idsAtTheGate(gate, 'Contact').sort()).toEqual([contact(1), contact(2)].sort());
    const read = new Map(summary?.readByObject.map((o) => [o.objectApiName, o]));
    expect(read.get('Account')?.origin).toEqual({ roots: 0, under: 0, named: 1 });
    expect(read.get('Contact')?.origin).toEqual({ roots: 2, under: 0, named: 0 });
    // A parent read by id brings its other children, as a clone of one record
    // does: said, never hidden.
    expect(read.get('Opportunity')?.readUnder).toEqual(['Account']);
    expect(summary?.roots?.asked).toBe(2);
  });

  it('copies at least every record the clone of each root copies, whatever the roots', async () => {
    const fc = await import('fast-check');
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        fc.array(fc.nat({ max: 5 }), { maxLength: 8 }),
        fc.array(fc.tuple(fc.nat({ max: 5 }), fc.nat({ max: 7 })), { maxLength: 6 }),
        async (energy, contactsOf, cases) => {
          const build = (): QueryRootsOrg => {
            const org = new QueryRootsOrg();
            energy.forEach((isEnergy, n) =>
              org.add('Account', {
                Id: account(n + 1),
                Name: `A${n + 1}`,
                Industry: isEnergy ? 'Energy' : 'Retail',
                ParentId: null,
              }),
            );
            contactsOf.forEach((of, n) =>
              org.add('Contact', {
                Id: contact(n + 1),
                LastName: `C${n + 1}`,
                Department: 'Sales',
                AccountId: account((of % energy.length) + 1),
                ReportsToId: null,
              }),
            );
            cases.forEach(([of, by], n) =>
              org.add('Case', {
                Id: fakeId('Case', 'S', n + 1),
                Subject: `K${n + 1}`,
                AccountId: account((of % energy.length) + 1),
                ContactId: contactsOf.length > 0 ? contact((by % contactsOf.length) + 1) : null,
              }),
            );
            return org;
          };
          const roots = energy.flatMap((isEnergy, n) => (isEnergy ? [account(n + 1)] : []));
          const objects = ['Account', 'Contact', 'Case'];
          const all = build();
          const together = await run(
            all,
            queryRootsGraph(all, 'Account', objects),
            recordsConfig("SELECT Id FROM Account WHERE Industry = 'Energy'", { dryRun: true }),
          );
          if (roots.length === 0) {
            expect(stopOf(together.error)?.code).toBe('NO_ROOTS');
            return;
          }
          expect(together.error).toBeUndefined();
          for (const root of roots) {
            const one = build();
            const alone = await run(one, queryRootsGraph(one, 'Account', objects), oneRecord(root));
            expect(alone.error).toBeUndefined();
            for (const object of objects) {
              const many = new Set(idsAtTheGate(together.gate, object));
              for (const id of idsAtTheGate(alone.gate, object)) expect(many.has(id)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 60_000);

  it('reads 1 200 roots and what is under them in statements the org takes, five hundred ids at most each', async () => {
    const org = new QueryRootsOrg();
    for (let n = 1; n <= 1_200; n++) {
      org.add('Account', { Id: account(n), Name: `A${n}`, Industry: 'Energy', ParentId: null });
      org.add('Contact', {
        Id: contact(n),
        LastName: `C${n}`,
        Department: 'Sales',
        AccountId: account(n),
        ReportsToId: null,
      });
    }
    const graph = queryRootsGraph(org, 'Account', ['Account', 'Contact']);
    const { summary, error } = await run(
      org,
      graph,
      recordsConfig("SELECT Id FROM Account WHERE Industry = 'Energy'", {
        dryRun: true,
        maxRoots: 1_200,
      }),
    );
    expect(error).toBeUndefined();
    expect(summary?.failedReads).toEqual([]);
    const byId = org.statementsOf('Account').filter((soql) => soql.includes('Id IN ('));
    expect(byId.length).toBeGreaterThanOrEqual(3);
    for (const soql of [...byId, ...org.statementsOf('Contact')]) {
      expect(soql.match(/'[0-9A-Za-z]{18}'/g)?.length ?? 0).toBeLessThanOrEqual(500);
    }
    expect(org.statementsOf('Contact').length).toBeGreaterThanOrEqual(3);
    expect(org.answered.get('Contact')?.size).toBe(1_200);
    expect(summary?.roots).toMatchObject({ asked: 1_200, read: 1_200, cap: 1_200 });
  }, 30_000);

  it('refuses a query that chooses more than the run takes, having sent the source its one statement', async () => {
    const org = new QueryRootsOrg();
    for (let n = 1; n <= 201; n++) {
      org.add('Account', { Id: account(n), Name: `A${n}`, Industry: 'Energy', ParentId: null });
    }
    const graph = queryRootsGraph(org, 'Account', ['Account']);
    const { error } = await run(
      org,
      graph,
      recordsConfig("SELECT Id FROM Account WHERE Industry = 'Energy'"),
    );
    expect(stopOf(error)).toEqual({
      code: 'ROOTS_EXCEEDED',
      roots: { objectApiName: 'Account', cap: 200 },
    });
    expect((error as Error).message).toContain('ORDER BY CreatedDate DESC LIMIT 200');
    expect(org.requests).toBe(1);
    expect(org.inserted.size).toBe(0);
  });

  it('takes the LIMIT a query gives when the run takes that many, and refuses a query that chooses none', async () => {
    const org = new QueryRootsOrg();
    for (let n = 1; n <= 201; n++) {
      org.add('Account', { Id: account(n), Name: `A${n}`, Industry: 'Energy', ParentId: null });
    }
    const graph = queryRootsGraph(org, 'Account', ['Account']);
    const limited = await run(
      org,
      graph,
      recordsConfig(
        "SELECT Id FROM Account WHERE Industry = 'Energy' ORDER BY Name DESC LIMIT 50",
        { dryRun: true },
      ),
    );
    expect(limited.error).toBeUndefined();
    expect(org.statements[0]).toBe(
      "SELECT Id FROM Account WHERE (Industry = 'Energy') ORDER BY Name DESC LIMIT 50",
    );
    expect(limited.summary?.roots).toMatchObject({ asked: 50, read: 50, query: { limit: 50 } });

    const none = await run(
      org,
      graph,
      recordsConfig("SELECT Id FROM Account WHERE Industry = 'Mining'"),
    );
    expect(stopOf(none.error)).toEqual({
      code: 'NO_ROOTS',
      roots: { objectApiName: 'Account', cap: 200 },
    });
    expect((none.error as Error).message).toContain(
      `sf data query -q "SELECT COUNT() FROM Account WHERE Industry = 'Mining'"`,
    );
  });

  it('refuses, nothing written, roots that reach more records than the run may hold', async () => {
    const org = energyOrg();
    for (let n = 10; n < 22; n++) {
      org.add('Contact', {
        Id: contact(n),
        LastName: `C${n}`,
        Department: 'Sales',
        AccountId: account(1),
        ReportsToId: null,
      });
    }
    const graph = queryRootsGraph(org, 'Account', ['Account', 'Contact', 'Opportunity']);
    const { error } = await run(
      org,
      graph,
      recordsConfig("SELECT Id FROM Account WHERE Industry = 'Energy'"),
      { runOptions: { roots: { readTotal: 10 } } },
    );
    expect(stopOf(error)).toMatchObject({
      code: 'READ_BOUND_EXCEEDED',
      readBound: { bound: 10, of: 'roots' },
    });
    expect(stopOf(error)?.readBound?.objects.at(-1)).toEqual({
      objectApiName: 'Contact',
      rows: 15,
    });
    expect(org.inserted.size).toBe(0);
  });

  it('refuses, nothing written, a read that would send the source more than a tenth of what it has left', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Account', ['Account', 'Contact', 'Opportunity', 'Case']);
    const { error } = await run(
      org,
      graph,
      recordsConfig("SELECT Id FROM Account WHERE Industry = 'Energy'"),
      { runOptions: { roots: { sourceRequestsLeft: 30 } } },
    );
    expect(stopOf(error)).toMatchObject({
      code: 'API_BUDGET_EXCEEDED',
      api: { kind: 'requests', org: 'source', remaining: 30, reading: { bound: 3 } },
    });
    expect(org.inserted.size).toBe(0);
  });

  it('chooses the roots by the WHERE alone: no other read of their object carries it, the object’s own filter goes on', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Account', ['Account', 'Contact']);
    const config = recordsConfig("SELECT Id FROM Account WHERE Industry = 'Energy'", {
      dryRun: true,
      objectSoqlFilters: { Account: "Name != 'A9'" },
    });
    const options = forgeExecuteOptions(graph, config, undefined, () => []);
    expect(options?.objectSoqlFilters).toEqual({ Account: "Name != 'A9'" });
    expect(options?.roots).toMatchObject({ query: { where: "Industry = 'Energy'" } });

    const { error } = await run(org, graph, config);
    expect(error).toBeUndefined();
    const [roots, ...rest] = org.statementsOf('Account');
    expect(roots).toBe(
      "SELECT Id FROM Account WHERE (Industry = 'Energy') AND (Name != 'A9') ORDER BY Id LIMIT 201",
    );
    expect(rest.length).toBeGreaterThan(0);
    for (const soql of rest) {
      expect(soql).not.toContain('Industry =');
      expect(soql).toContain("AND (Name != 'A9')");
    }
  });

  it('writes roots of the catalog with what is under them, reached from above as the one root is', async () => {
    const org = new QueryRootsOrg();
    org.add(
      'Product2',
      { Id: fakeId('Product2', 'S', 1), Name: 'P1', Family: 'Hardware', IsActive: true },
      { Id: fakeId('Product2', 'S', 2), Name: 'P2', Family: 'Hardware', IsActive: true },
      { Id: fakeId('Product2', 'S', 3), Name: 'P3', Family: 'Software', IsActive: true },
    );
    org.add(
      'Note__c',
      ...[1, 2, 3].map((n) => ({
        Id: fakeId('Note__c', 'S', n),
        Name: `N${n}`,
        Product__c: fakeId('Product2', 'S', n),
      })),
    );
    const graph = queryRootsGraph(org, 'Product2', ['Product2', 'Note__c']);
    const { summary, error } = await run(
      org,
      graph,
      recordsConfig("SELECT Id FROM Product2 WHERE Family = 'Hardware'"),
    );
    expect(error).toBeUndefined();
    expect(org.inserted.get('Product2')?.map((row) => row['Name'])).toEqual(['P1', 'P2']);
    // A row of the catalog brings what is under it only when the run reached
    // it from above: each root is, as the one root of a clone is.
    expect(org.inserted.get('Note__c')?.map((row) => row['Name'])).toEqual(['N1', 'N2']);
    expect(summary?.roots).toMatchObject({ asked: 2, read: 2, written: 2, failed: [] });
  });

  it('writes the roots its dry run kept, not those the query chooses since, and says so', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Account', ['Account', 'Contact']);
    const keepAt = join(scratch(), 'roots.json');
    const query = "SELECT Id FROM Account WHERE Industry = 'Energy'";
    const dry = await run(org, graph, recordsConfig(query, { dryRun: true }), {
      runOptions: { roots: { keepAt, fingerprint: 'f'.repeat(64) } },
    });
    expect(dry.error).toBeUndefined();
    const plan = await openRootPlan(keepAt);
    expect(plan.ids).toEqual([account(1), account(2)]);
    expect(plan.sha256).toBe(dry.summary?.roots?.sha256);
    org.add('Account', { Id: account(4), Name: 'A4', Industry: 'Energy', ParentId: null });

    const statementsBefore = org.statements.length;
    const real = await run(org, graph, recordsConfig(query), { runOptions: { roots: { plan } } });
    expect(real.error).toBeUndefined();
    expect(org.statements.slice(statementsBefore)).not.toContain(
      "SELECT Id FROM Account WHERE (Industry = 'Energy') ORDER BY Id LIMIT 201",
    );
    expect(org.inserted.get('Account')?.map((row) => row['Name'])).toEqual(['A1', 'A2']);
    expect(real.summary?.roots).toMatchObject({ from: 'plan', asked: 2, written: 2 });
  });

  it('reads the query again for a plan a day old, and says what the plan held', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Account', ['Account']);
    const plan = await keepRootPlan(join(scratch(), 'old.json'), {
      sourceOrgId: 'src',
      fingerprint: '',
      objectApiName: 'Account',
      query: { where: "Industry = 'Energy'" },
      from: 'query',
      readAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
      ids: [account(1)],
    });
    const { summary, error } = await run(
      org,
      graph,
      recordsConfig("SELECT Id FROM Account WHERE Industry = 'Energy'", { dryRun: true }),
      { runOptions: { roots: { plan } } },
    );
    expect(error).toBeUndefined();
    expect(summary?.roots).toMatchObject({
      from: 'query',
      asked: 2,
      readAgain: { roots: 1, readAt: plan.readAt },
    });
  });

  it('names each root with its copy in the target, and none on a dry run', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Account', ['Account', 'Contact']);
    const query = "SELECT Id FROM Account WHERE Industry = 'Energy'";
    const dry = await run(org, graph, recordsConfig(query, { dryRun: true }));
    expect(dry.error).toBeUndefined();
    expect(dry.summary?.roots?.ids).toEqual([{ source: account(1) }, { source: account(2) }]);
    const real = await run(org, graph, recordsConfig(query));
    expect(real.error).toBeUndefined();
    const ids = real.summary?.roots?.ids ?? [];
    expect(ids.map((root) => root.source)).toEqual([account(1), account(2)]);
    // Each copy is the record the target gave the root, as the run's map has it.
    for (const root of ids) {
      expect(root.target).toBe(real.summary?.remapTable[root.source]);
      expect(root.target).toMatch(/^001T/);
    }
    expect(real.summary?.roots?.idsLeftOut).toBeUndefined();
  });

  it('tells its gate which roots it writes, how many, and where they came from', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Account', ['Account', 'Contact']);
    const keepAt = join(scratch(), 'roots.json');
    const query = "SELECT Id FROM Account WHERE Industry = 'Energy'";
    const dry = await run(org, graph, recordsConfig(query, { dryRun: true }), {
      runOptions: { roots: { keepAt, fingerprint: 'f'.repeat(64) } },
    });
    expect(dry.gate[0]?.roots).toMatchObject({ objectApiName: 'Account', count: 2, from: 'query' });
    const plan = await openRootPlan(keepAt);
    const real = await run(org, graph, recordsConfig(query), { runOptions: { roots: { plan } } });
    expect(real.gate[0]?.roots).toEqual({
      objectApiName: 'Account',
      count: 2,
      from: 'simulation',
      readAt: plan.readAt,
    });
  });

  it('writes again the roots of the run it retries, whatever their age, and says so', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Account', ['Account']);
    // The run retried chose the first account two days ago; the query now
    // chooses the second as well.
    const plan = await keepRootPlan(join(scratch(), 'retried.json'), {
      sourceOrgId: 'src',
      fingerprint: '',
      objectApiName: 'Account',
      query: { where: "Industry = 'Energy'" },
      from: 'query',
      readAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
      ids: [account(1)],
    });
    const { summary, error, gate } = await run(
      org,
      graph,
      recordsConfig("SELECT Id FROM Account WHERE Industry = 'Energy'"),
      { runOptions: { roots: { plan, planOfTheRunRetried: true } } },
    );
    expect(error).toBeUndefined();
    expect(org.statements.some((soql) => soql.includes('LIMIT 201'))).toBe(false);
    expect(org.inserted.get('Account')?.map((row) => row['Name'])).toEqual(['A1']);
    expect(summary?.roots).toMatchObject({ from: 'plan', asked: 1, ofTheRunRetried: true });
    expect(summary?.roots?.readAgain).toBeUndefined();
    expect(gate[0]?.roots).toMatchObject({ from: 'retried', count: 1 });
  });

  it('refuses the roots a dry run read of another org, or by another query', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Account', ['Account']);
    const kept = {
      fingerprint: '',
      objectApiName: 'Account',
      query: { where: "Industry = 'Energy'" },
      from: 'query' as const,
      readAt: new Date().toISOString(),
      ids: [account(1)],
    };
    const otherOrg = await keepRootPlan(join(scratch(), 'a.json'), { ...kept, sourceOrgId: 'x' });
    const refusedOrg = await run(
      org,
      graph,
      recordsConfig("SELECT Id FROM Account WHERE Industry = 'Energy'"),
      { runOptions: { roots: { plan: otherOrg } } },
    );
    expect(stopOf(refusedOrg.error)).toEqual({
      code: 'ROOTS_PLAN_MISMATCH',
      roots: { objectApiName: 'Account', plan: 'otherOrg' },
    });
    const ours = await keepRootPlan(join(scratch(), 'b.json'), { ...kept, sourceOrgId: 'src' });
    const refusedQuery = await run(
      org,
      graph,
      recordsConfig("SELECT Id FROM Account WHERE Industry = 'Retail'"),
      { runOptions: { roots: { plan: ours } } },
    );
    expect(stopOf(refusedQuery.error)?.roots?.plan).toBe('otherQuery');
    expect(org.statements).toEqual([]);
    expect(org.inserted.size).toBe(0);
  });

  it('resumes with the roots its journal names, reading no query again', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Account', ['Account', 'Contact', 'Opportunity']);
    const query = "SELECT Id FROM Account WHERE Industry = 'Energy'";
    const file = memoryRunFile();
    const first = await run(org, graph, recordsConfig(query), {
      runOptions: { stream: { store: ForgeRunStore.open(file) } },
      deps: (executor) => ({
        insertRecords: async (orgId, object, rows) => {
          const answers = await org.deps().insertRecords(orgId, object, rows);
          executor().abort();
          return answers;
        },
      }),
    });
    expect(String(first.error)).toMatch(/aborted/);
    // A record made since, which the query now chooses: the run goes on with its own.
    org.add('Account', { Id: account(4), Name: 'A4', Industry: 'Energy', ParentId: null });
    const before = org.statements.length;
    const resumed = await run(org, graph, recordsConfig(query), {
      runOptions: { stream: { store: ForgeRunStore.open(memoryRunFile(file.text())) } },
    });
    expect(resumed.error).toBeUndefined();
    expect(
      org.statements
        .slice(before)
        .filter((soql) => soql.startsWith('SELECT Id FROM Account WHERE (')),
    ).toEqual([]);
    expect(resumed.summary?.roots).toMatchObject({
      from: 'plan',
      sha256: rootsSha256([account(1), account(2)]),
    });
    expect(org.answered.get('Account')).not.toContain(account(4));
  });

  it('refuses to resume a run from records whose journal names no roots', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Account', ['Account']);
    // An earlier part that wrote a record, and named no roots.
    const file = memoryRunFile();
    const earlier = ForgeRunStore.open(file);
    earlier.beginPart(new Date());
    earlier.setMapping('created', account(9), fakeId('Account', 'T', 9), 'Account');
    earlier.flush();
    const { error } = await run(
      org,
      graph,
      recordsConfig("SELECT Id FROM Account WHERE Industry = 'Energy'"),
      { runOptions: { stream: { store: ForgeRunStore.open(memoryRunFile(file.text())) } } },
    );
    expect(stopOf(error)).toEqual({
      code: 'ROOTS_PLAN_GONE',
      roots: { objectApiName: 'Account', plan: 'gone' },
    });
    expect(org.statements).toEqual([]);
  });

  it('reads a clone of one record as it always did, by its id alone', async () => {
    const org = energyOrg();
    const graph = queryRootsGraph(org, 'Account', ['Account', 'Contact']);
    const options: ExecuteOptions | undefined = forgeExecuteOptions(
      graph,
      oneRecord(account(1)),
      undefined,
      () => [],
    );
    expect(options?.roots).toBeUndefined();
    expect(options?.rootRecordId).toBe(account(1));
    const { summary, error } = await run(org, graph, oneRecord(account(1)));
    expect(error).toBeUndefined();
    expect(org.statementsOf('Account')[0]).toBe(
      `SELECT Id, Name, Industry, ParentId FROM Account WHERE Id = '${account(1)}'`,
    );
    expect(summary?.roots).toBeUndefined();
    expect(summary?.readByObject.every((o) => o.origin === undefined)).toBe(true);
  });
});

/** A dry run of the clone of one record, as a config gives it. */
function oneRecord(recordId: string): ForgeConfig {
  return {
    sourceOrgId: 'src',
    targetOrgId: 'tgt',
    inputMode: 'record',
    recordId,
    depth: 'full',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
    dryRun: true,
  };
}
