import { describe, it, expect, vi } from 'vitest';
import { BYTES_PER_MB, type ForgeTargetAutomation, type ForgeTargetFlow } from '@sandforge/shared';
import { fitConnection, fitOrg } from '../../test/fitOrg';
import type { LargeOrgRow } from '../../test/largeOrg';
import { fitBudgetOf, type FitBudget } from '../forge/fitBudget.js';
import { AutopilotExecutor } from './AutopilotExecutor.js';
import { AutopilotGrappeAdapter } from './AutopilotGrappeAdapter.js';
import { AutopilotOrchestrator, type AutopilotFitAsk } from './AutopilotOrchestrator.js';
import { autopilotWritePlan } from './AutopilotRunGate.js';
import { ComplianceEngine } from './ComplianceEngine.js';
import { DependencyGraphBuilder } from './DependencyGraphBuilder.js';
import { ExecutionPlanGenerator } from './ExecutionPlanGenerator.js';
import { RecordIdRemapper } from './RecordIdRemapper.js';
import { SchemaScanner, type AutopilotConnection } from './SchemaScanner.js';
import { SmartAnonymizer } from './SmartAnonymizer.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const KB = 1024;

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const account = (n: number): string => id('001', n);
const contact = (n: number): string => id('003', n);
const caseId = (n: number): string => id('500', n);

/** A budget of exactly `bytes`. */
function budgetOf(bytes: number): FitBudget {
  return {
    bytes,
    terms: { remainingMB: 500, maxMB: 500, share: 0.8, roundingMB: 0.5, limitedBy: 'storage' },
  };
}

const NO_AUTOMATION: ForgeTargetAutomation = {
  objectsRead: [],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 0,
};

/**
 * The integrity case of the real gate: a hierarchy of three accounts, the
 * second with a key contact of the first's, contacts and cases under them,
 * and accounts with none of those.
 */
function integrityRows(): Record<string, LargeOrgRow[]> {
  return {
    Account: [
      { Id: account(1), Name: 'Hier 1', ParentId: null },
      {
        Id: account(2),
        Name: 'Hier 2',
        ParentId: account(1),
        Primary_Contact__c: contact(1),
        Territory__c: id('a01', 1),
      },
      { Id: account(3), Name: 'Hier 3', ParentId: account(1) },
      { Id: account(4), Name: 'Alone', Territory__c: id('a01', 2) },
    ],
    Contact: [
      { Id: contact(1), Name: 'Of Hier 1', AccountId: account(1) },
      { Id: contact(2), Name: 'Of Hier 2', AccountId: account(2) },
      { Id: contact(3), Name: 'No account', AccountId: null },
      { Id: contact(4), Name: 'No account', AccountId: null },
    ],
    Case: [
      { Id: caseId(1), Name: 'Of Hier 1', AccountId: account(1), ContactId: contact(1) },
      { Id: caseId(2), Name: 'Of Hier 2', AccountId: account(2), ContactId: contact(2) },
    ],
    Territory__c: [
      { Id: id('a01', 1), Name: 'North', Region__c: id('a02', 1) },
      { Id: id('a01', 2), Name: 'South', Region__c: id('a02', 2) },
    ],
    Region__c: [
      { Id: id('a02', 1), Name: 'One' },
      { Id: id('a02', 2), Name: 'Two' },
    ],
  };
}

/** The objects a run writes through; what it created, by object, in `created`. */
function orchestratorOver(conn: ReturnType<typeof fitConnection>['conn']) {
  const created: Array<{ object: string; record: Record<string, unknown> }> = [];
  const pagesRead: string[] = [];
  const anonymizer = new SmartAnonymizer();
  const orchestrator = new AutopilotOrchestrator({
    schemaScanner: new SchemaScanner(),
    graphBuilder: new DependencyGraphBuilder(),
    complianceEngine: new ComplianceEngine(),
    anonymizer,
    planGenerator: new ExecutionPlanGenerator(),
    remapper: new RecordIdRemapper(),
    grappeAdapter: new AutopilotGrappeAdapter(),
    createExecutor: () =>
      new AutopilotExecutor({
        query: async (objectApiName) => {
          pagesRead.push(objectApiName);
          return (await conn.query(`SELECT FIELDS(ALL) FROM ${objectApiName} ORDER BY Id`))
            .records as Record<string, unknown>[];
        },
        queryByIds: async (objectApiName, ids) =>
          (
            await conn.query(
              `SELECT FIELDS(ALL) FROM ${objectApiName} WHERE Id IN ` +
                `(${ids.map((value) => `'${value}'`).join(', ')})`,
            )
          ).records as Record<string, unknown>[],
        insert: async (objectApiName, records) =>
          records.map((record) => {
            created.push({ object: objectApiName, record });
            return { id: id('new', created.length), success: true, errors: [] };
          }),
        update: async (_objectApiName, records) =>
          records.map(() => ({ id: 'x', success: true, errors: [] })),
        anonymizer,
        remapper: new RecordIdRemapper(),
      }),
  });
  return { orchestrator, created, pagesRead };
}

/** A plan of `selected` over `rows`, ready to fit. */
async function planned(rows: Record<string, LargeOrgRow[]>, selected: string[]) {
  const connection = fitConnection(fitOrg(rows));
  const source = connection.conn as unknown as AutopilotConnection;
  const { orchestrator, created, pagesRead } = orchestratorOver(connection.conn);
  const scan = await orchestrator.scanSchemas(source, source, {
    selectedObjects: selected,
    includeStandardObjects: false,
  });
  const graph = orchestrator.buildGraph(scan);
  const plan = orchestrator.generatePlan(graph, 'none', [], scan.scope);
  connection.calls.queries.length = 0;
  const ask = (over: Partial<AutopilotFitAsk>): AutopilotFitAsk => ({
    scan,
    graph,
    plan,
    rules: [],
    mode: { share: true },
    budget: budgetOf(BYTES_PER_MB),
    automation: NO_AUTOMATION,
    ...over,
  });
  return { orchestrator, source, connection, scan, graph, plan, ask, created, pagesRead };
}

const SELECTED = ['Account', 'Contact', 'Case'];

describe('fitting a plan to the target’s storage', () => {
  it('keeps the plan whole, reading the lookups alone, when it fits as it stands', async () => {
    const { orchestrator, source, ask, connection } = await planned(integrityRows(), SELECTED);

    const fit = await orchestrator.fitPlan(source, ask({}));

    expect(fit.heldBy).toBe('whole');
    expect(fit.fitted).toBeUndefined();
    expect(fit.report.requestsRead).toBe(SELECTED.length);
    expect(connection.calls.queries).toHaveLength(SELECTED.length);
  });

  it('cuts along the lookups that hold, empties those that do not, and reads the parents again', async () => {
    // Fourteen records in all; room for nine. A share of a half keeps the even
    // accounts and the last of the two contacts with none.
    const { orchestrator, source, ask, connection } = await planned(integrityRows(), SELECTED);

    const fit = await orchestrator.fitPlan(source, ask({ budget: budgetOf(9 * 2 * KB) }));

    expect(fit.cannotFit).toBeUndefined();
    expect(fit.keptIds.get('Account')).toEqual([account(2), account(4)]);
    // The contact of the account cut went with it; those with none are roots.
    expect(fit.keptIds.get('Contact')).toEqual([contact(2), contact(4)]);
    expect(fit.keptIds.get('Case')).toEqual([caseId(2)]);
    expect(fit.report.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Account', kept: 2, cutSpread: 2 }),
      expect.objectContaining({
        objectApiName: 'Contact',
        kept: 2,
        cutSpread: 1,
        cutWithParent: [{ field: 'AccountId', parent: 'Account', count: 1 }],
      }),
      expect.objectContaining({
        objectApiName: 'Case',
        kept: 1,
        cutWithParent: [{ field: 'AccountId', parent: 'Account', count: 1 }],
      }),
    ]);
    // Hier 2 names its parent and its key contact, both cut with Hier 1.
    expect(fit.report.emptied).toEqual(
      expect.arrayContaining([
        { objectApiName: 'Account', field: 'ParentId', count: 1, why: 'selfReference' },
        { objectApiName: 'Account', field: 'Primary_Contact__c', count: 1, why: 'owed' },
      ]),
    );
    expect(fit.report.parents).toEqual([
      { objectApiName: 'Territory__c', records: 2 },
      { objectApiName: 'Region__c', records: 2 },
    ]);
    expect(fit.report.requestsRead).toBe(connection.calls.queries.length);
    expect(connection.calls.queries.length).toBe(SELECTED.length + 2);
  });

  it('answers a plan that reads the selected objects by the ids kept, and counts what it keeps', async () => {
    const { orchestrator, source, ask, graph, scan } = await planned(integrityRows(), SELECTED);

    const fit = await orchestrator.fitPlan(source, ask({ budget: budgetOf(9 * 2 * KB) }));

    const fitted = fit.fitted;
    if (!fitted) throw new Error('The plan was fitted.');
    expect(fitted.scan.parentIds.get('Account')).toEqual([account(2), account(4)]);
    expect(fitted.scan.parentIds.get('Territory__c')).toHaveLength(2);
    expect(fitted.scan.recordCounts.get('Contact')).toBe(2);
    expect(fitted.plan.scope?.fitted).toEqual(fit.report);
    expect(fitted.plan.totalRecords).toBe(fit.report.records);
    expect(new Set(graph.nodes.map((node) => node.objectApiName))).toEqual(
      new Set(fitted.graph.nodes.map((node) => node.objectApiName)),
    );
    // What the run's gate counts is what the report says.
    const gate = autopilotWritePlan(
      fitted.plan,
      fitted.scan.recordCounts,
      fitted.scan.personAccounts,
    );
    expect(gate.totalRows).toBe(fit.report.records);
    expect(gate.storageBytes / BYTES_PER_MB).toBe(fit.report.estimateMB);
    // The plan it came from is left as it was.
    expect(scan.parentIds.has('Account')).toBe(false);
  });

  it('runs what it said: read by id, no record without its parent, the emptied lookups empty', async () => {
    const { orchestrator, source, ask, created, pagesRead } = await planned(
      integrityRows(),
      SELECTED,
    );
    const fit = await orchestrator.fitPlan(source, ask({ budget: budgetOf(9 * 2 * KB) }));
    const fitted = fit.fitted;
    if (!fitted) throw new Error('The plan was fitted.');

    const result = await orchestrator.executePlan(
      fitted.plan,
      fitted.graph,
      [],
      fitted.scan.recordCounts,
      undefined,
      undefined,
      fitted.scan.parentIds,
      { keepContactPoints: true, fit: fitted.run },
    );

    expect(pagesRead).toEqual([]);
    expect(result.totalSuccess).toBe(fit.report.records);
    expect(result.totalFailure).toBe(0);
    expect(result).not.toHaveProperty('cutSinceFit');
    const of = (object: string) => created.filter((c) => c.object === object);
    expect(of('Account').map((c) => c.record['Id'])).toEqual([account(2), account(4)]);
    expect(of('Contact').map((c) => c.record['Id'])).toEqual([contact(2), contact(4)]);
    const hier2 = of('Account').find((c) => c.record['Id'] === account(2));
    expect(hier2?.record['ParentId']).toBeNull();
    expect(hier2?.record['Primary_Contact__c']).toBeNull();
    // Its case and its contact went with an id of the target, not with none.
    const contactOfHier2 = of('Contact').find((c) => c.record['Id'] === contact(2));
    expect(contactOfHier2?.record['AccountId']).toMatch(/^new/);
    expect(of('Case')[0].record['AccountId']).toMatch(/^new/);
    expect(of('Case')[0].record['ContactId']).toMatch(/^new/);
  });

  it('drops from the plan a parent no record kept names', async () => {
    const rows = integrityRows();
    const { orchestrator, source, ask } = await planned(rows, ['Account']);

    // One account, the last: the one in a territory. With a cap that keeps
    // the third of them, none is named.
    const fit = await orchestrator.fitPlan(
      source,
      ask({ mode: { caps: { Account: 1 } }, budget: budgetOf(BYTES_PER_MB) }),
    );

    expect(fit.fitted?.scan.parentIds.get('Account')).toEqual([account(4)]);
    expect(fit.fitted?.scan.scope.parents).toEqual([
      { objectApiName: 'Territory__c', records: 1 },
      { objectApiName: 'Region__c', records: 1 },
    ]);
    expect(fit.report.objects[0]).toMatchObject({ kept: 1, cutSpread: 3 });
  });

  it('keeps room for what still runs, and none for what the run mutes', async () => {
    const flow: ForgeTargetFlow = {
      apiName: 'Task_On_Contact',
      label: 'Task on contact',
      timing: 'afterSave',
      startsOn: 'create',
      condition: 'read',
      permissions: [{ name: 'Bypass', bypass: true, held: false }],
      creates: ['Task'],
    };
    const automation: ForgeTargetAutomation = {
      ...NO_AUTOMATION,
      objects: [{ objectApiName: 'Contact', flows: [flow], triggers: [] }],
      bypassGrants: [
        {
          permission: 'Bypass',
          permissionSets: [{ name: 'PS_Bypass', label: 'Bypass', grants: 1 }],
        },
      ],
    };
    const { orchestrator, source, ask } = await planned(integrityRows(), SELECTED);

    const running = await orchestrator.fitPlan(
      source,
      ask({ automation, budget: budgetOf(9 * 2 * KB) }),
    );
    const muted = await orchestrator.fitPlan(
      source,
      ask({
        automation,
        budget: budgetOf(9 * 2 * KB),
        mutePlan: {
          assign: [{ permissionSet: 'PS_Bypass', label: 'Bypass', permissions: ['Bypass'] }],
        },
      }),
    );

    expect(running.report.budget.automationMB).toBeGreaterThan(0);
    expect(running.report.records).toBeLessThan(muted.report.records);
    expect(muted.report.budget.automationMB).toBe(0);
  });

  it('says it kept no room for an automation it could not read, and goes on', async () => {
    const { orchestrator, source, ask } = await planned(integrityRows(), SELECTED);

    const fit = await orchestrator.fitPlan(
      source,
      ask({ automation: { unread: 'INSUFFICIENT_ACCESS' }, budget: budgetOf(9 * 2 * KB) }),
    );

    expect(fit.automationUnread).toBe('INSUFFICIENT_ACCESS');
    expect(fit.fitted).toBeDefined();
  });

  it('refuses a source that came to hold more than the plan', async () => {
    const rows = integrityRows();
    const { orchestrator, source, ask } = await planned(rows, SELECTED);
    rows['Account'].push({ Id: account(5) });

    const fit = await orchestrator.fitPlan(source, ask({ budget: budgetOf(9 * 2 * KB) }));

    expect(fit.cannotFit).toBe('the source changed since the plan: plan again');
    expect(fit.fitted).toBeUndefined();
  });

  it('hands the run every list it reads, and the lookups it holds records to', async () => {
    const { orchestrator, source, ask } = await planned(integrityRows(), SELECTED);

    const fit = await orchestrator.fitPlan(source, ask({ budget: budgetOf(9 * 2 * KB) }));

    const run = fit.fitted?.run;
    expect(run?.kept.get('Account')).toEqual([account(2), account(4)]);
    expect(run?.kept.get('Territory__c')).toHaveLength(2);
    expect(run?.holds).toContainEqual(
      expect.objectContaining({ objectApiName: 'Contact', field: 'AccountId', parent: 'Account' }),
    );
    expect(run?.holds.map((hold) => hold.field)).not.toContain('ParentId');
    expect(run?.holds.map((hold) => hold.field)).not.toContain('Primary_Contact__c');
  });

  it('assigns nothing, and writes nothing: a fit only reads the source', async () => {
    const { orchestrator, source, ask, created, connection } = await planned(
      integrityRows(),
      SELECTED,
    );

    await orchestrator.fitPlan(source, ask({ budget: budgetOf(9 * 2 * KB) }));

    expect(created).toEqual([]);
    expect(connection.calls.queries.every((soql) => soql.startsWith('SELECT'))).toBe(true);
  });

  it('orders a cycle by what the target says only a create can set', async () => {
    // The target will not let an update set a contact's account key contact:
    // Contact goes first in their cycle, and the account follows it.
    const { orchestrator, source, ask } = await planned(integrityRows(), ['Account', 'Contact']);
    const describeLookups = vi.fn(async (objectApiName: string) =>
      objectApiName === 'Account'
        ? [
            {
              name: 'Primary_Contact__c',
              referenceTo: ['Contact'],
              createable: true,
              updateable: false,
            },
          ]
        : [],
    );

    const fit = await orchestrator.fitPlan(
      source,
      ask({ describeLookups, budget: budgetOf(4 * 2 * KB) }),
    );

    expect(describeLookups).toHaveBeenCalledWith('Account');
    expect(fit.report.objects.map((object) => object.objectApiName)).toEqual([
      'Contact',
      'Account',
    ]);
    expect(fit.report.objects[1].cutWithParent).toContainEqual(
      expect.objectContaining({ field: 'Primary_Contact__c', parent: 'Contact' }),
    );
  });

  it('asks the real budget as Seed does: 0.5 MB off, then 80 % of the rest', async () => {
    const budget = fitBudgetOf({ storage: { maxMB: 5, remainingMB: 5 } });
    if ('unread' in budget) throw new Error('read');
    const many: LargeOrgRow[] = Array.from({ length: 4_000 }, (_, i) => ({ Id: account(i + 1) }));
    const { orchestrator, source, ask } = await planned({ Account: many }, ['Account']);

    const fit = await orchestrator.fitPlan(source, ask({ budget }));

    expect(fit.report.budget).toMatchObject({ remainingMB: 5, share: 0.8, roundingMB: 0.5 });
    expect(fit.report.budget.budgetMB).toBeCloseTo(3.6);
    expect(fit.report.records * 2 * KB).toBeLessThanOrEqual(3.6 * BYTES_PER_MB);
    expect((fit.report.records + 1) * 2 * KB).toBeGreaterThan(3.6 * BYTES_PER_MB);
  });
});
