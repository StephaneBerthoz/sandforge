import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  InsertResult,
} from './ForgeExecutor.js';
import { finishedRunStatus } from './runResult.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A record whose parent — one it cannot be written without — belongs to an
 * object no node of the graph holds. Run between two sandboxes, a direct clone
 * of a case read the case's invoice junction, a child of the case with a
 * master-detail at an invoice: discovery walks nothing of an object at the
 * depth asked, so the invoice's object was in no node, and every junction was
 * refused, `REQUIRED_FIELD_MISSING: Required fields are missing: [Invoice__c]`.
 * Walked by discovery, such a parent became a node, and a node is a scope for
 * the children the graph already holds: the graph grew to a hundred objects,
 * and the clone wrote some thirty-four thousand records.
 */

const idField: FieldInfo = { name: 'Id', queryable: true, createable: false, isReference: false };
const text = (name: string): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  isReference: false,
});
const lookup = (name: string, target: string, required = false): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  updateable: true,
  isReference: true,
  referenceTo: [target],
  nillable: !required,
});

const CASE = '500000000000001AAA';
const OTHER_CASE = '500000000000009AAA';
const CUSTOMER = '001000000000001AAA';
const OTHER_CUSTOMER = '001000000000002AAA';
const JANUARY = 'a0I000000000001AAA';
const FEBRUARY = 'a0I000000000002AAA';
const UNRELATED = 'a0I000000000009AAA';
const POLICY = 'a0P000000000001AAA';
const BILLING = 'a0B000000000001AAA';

/** The source's fields of each object: the invoice's object is in no node of the graph. */
const FIELDS: Record<string, FieldInfo[]> = {
  Case: [idField, text('Name'), lookup('AccountId', 'Account')],
  Account: [idField, text('Name')],
  Contact: [idField, text('Name'), lookup('AccountId', 'Account')],
  InvoiceLink__c: [
    idField,
    text('Name'),
    lookup('Case__c', 'Case', true),
    lookup('Invoice__c', 'Invoice__c', true),
  ],
  Invoice__c: [
    idField,
    text('Name'),
    lookup('Account__c', 'Account'),
    lookup('Policy__c', 'Policy__c'),
  ],
  Invoice_Line__c: [idField, text('Name'), lookup('Invoice__c', 'Invoice__c', true)],
  Policy__c: [idField, text('Name')],
  Billing__c: [idField, text('Name')],
};

/**
 * The case, its customer, the junction rows that tie it to two invoices — and,
 * none of them the clone's, another case's junction row on the first invoice,
 * an invoice no row names, the first invoice's lines and the policy it names.
 */
function sourceRows(): Record<string, FakeRow[]> {
  return {
    Case: [
      { Id: CASE, Name: 'Claim', AccountId: CUSTOMER },
      { Id: OTHER_CASE, Name: 'Other claim', AccountId: OTHER_CUSTOMER },
    ],
    Account: [
      { Id: CUSTOMER, Name: 'Customer' },
      { Id: OTHER_CUSTOMER, Name: 'Other customer' },
    ],
    Contact: [
      { Id: '003000000000001AAA', Name: 'Roe', AccountId: CUSTOMER },
      { Id: '003000000000002AAA', Name: 'Doe', AccountId: OTHER_CUSTOMER },
    ],
    InvoiceLink__c: [
      { Id: 'a0J000000000001AAA', Name: 'J1', Case__c: CASE, Invoice__c: JANUARY },
      { Id: 'a0J000000000002AAA', Name: 'J2', Case__c: CASE, Invoice__c: FEBRUARY },
      { Id: 'a0J000000000009AAA', Name: 'J9', Case__c: OTHER_CASE, Invoice__c: JANUARY },
    ],
    Invoice__c: [
      { Id: JANUARY, Name: 'January', Account__c: CUSTOMER, Policy__c: POLICY },
      { Id: FEBRUARY, Name: 'February', Account__c: null, Policy__c: null },
      { Id: UNRELATED, Name: 'Unrelated', Account__c: CUSTOMER, Policy__c: null },
    ],
    Invoice_Line__c: [{ Id: 'a0L000000000001AAA', Name: 'Line', Invoice__c: JANUARY }],
    Policy__c: [{ Id: POLICY, Name: 'Home' }],
    Billing__c: [{ Id: BILLING, Name: 'Monthly' }],
  };
}

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 4,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 3,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'rest',
  };
}

const edge = (parent: string, child: string, required = false): ForgeGraphEdge => ({
  sourceObject: parent,
  targetObject: child,
  relationshipName: `${parent}To${child}`,
  type: required ? 'master-detail' : 'lookup',
  ...(required ? { required: true } : {}),
});

function graphOf(nodes: ForgeGraphNode[], edges: ForgeGraphEdge[]): ForgeGraph {
  return { nodes, edges, totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0 };
}

/** The graph a direct clone of the case builds: the case, its account and its junction rows. */
function caseGraph(): ForgeGraph {
  return graphOf(
    [node('Case', 0), node('Account', 1), node('InvoiceLink__c', 1)],
    [edge('Account', 'Case'), edge('Case', 'InvoiceLink__c', true)],
  );
}

const ROOTED_AT_THE_CASE: ExecuteOptions = { rootRecordId: CASE, rootObjectApiName: 'Case' };

/**
 * A source org holding `tables`, and a target that names each record it
 * creates after the row's name — the invoice named January becomes
 * `Invoice__c:January` — and refuses a row without a lookup its own describe
 * says may not be left empty, as the platform does. What the source was asked,
 * the ids of the rows it gave and what the target was sent, call by call, are
 * kept.
 *
 * @param targetFields - The target's fields, where they are not the source's.
 * @param isObjectCreatable - Whether the target takes inserts of an object.
 */
function orgs(
  tables: Record<string, FakeRow[]> = sourceRows(),
  {
    fields = FIELDS,
    targetFields = {},
    isObjectCreatable,
  }: {
    fields?: Record<string, FieldInfo[]>;
    targetFields?: Record<string, FieldInfo[]>;
    isObjectCreatable?: ForgeExecutorDeps['isObjectCreatable'];
  } = {},
) {
  const inserted: Record<string, Array<Record<string, unknown>>> = {};
  const insertOrder: string[] = [];
  const asked: string[] = [];
  const read = new Set<string>();
  const fieldsIn = (org: string, object: string): FieldInfo[] =>
    (org === 'tgt' ? (targetFields[object] ?? fields[object]) : fields[object]) ?? [idField];
  const deps = {
    describeFields: vi.fn(async (org: string, object: string) => fieldsIn(org, object)),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      asked.push(soql);
      const rows = selectRows(tables, soql);
      for (const row of rows) read.add(String(row['Id']));
      return rows;
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      (inserted[object] ??= []).push(...rows);
      insertOrder.push(object);
      const required = fieldsIn('tgt', object)
        .filter((f) => f.isReference && f.nillable === false)
        .map((f) => f.name);
      return rows.map((row): InsertResult => {
        const missing = required.filter((field) => typeof row[field] !== 'string');
        if (missing.length > 0) {
          return {
            id: '',
            success: false,
            errors: [
              `REQUIRED_FIELD_MISSING: Required fields are missing: [${missing.join(', ')}]`,
            ],
          };
        }
        return { id: `${object}:${String(row['Name'])}`, success: true, errors: [] };
      });
    }),
    updateRecords: vi.fn(async (_org: string, _object: string, rows: Record<string, unknown>[]) =>
      rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] })),
    ),
    ...(isObjectCreatable ? { isObjectCreatable } : {}),
  } satisfies ForgeExecutorDeps;
  return { deps, inserted, insertOrder, asked, read };
}

/** The statements sent for `object`. */
const statementsOf = (asked: readonly string[], object: string): string[] =>
  asked.filter((soql) => new RegExp(`\\bFROM ${object}\\b`).test(soql));

/** The rows read of each object, but `object`'s. */
const readOfOthers = (summary: ExecutionSummary, object: string) =>
  summary.readByObject.filter((r) => r.objectApiName !== object);

describe('ForgeExecutor, a record whose required parent belongs to an object outside the graph', () => {
  it('reads the invoices the junction rows cannot be written without by id, writes them first, and links the rows to them', async () => {
    const { deps, inserted, insertOrder, asked, read } = orgs();

    const summary = await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    expect(statementsOf(asked, 'Invoice__c')).toEqual([
      `SELECT Id, Name, Account__c, Policy__c FROM Invoice__c WHERE Id IN ('${JANUARY}', '${FEBRUARY}')`,
    ]);
    // The invoice's lookup at the customer, a record the clone writes, is set;
    // the one at its policy, outside the clone, is left empty.
    expect(inserted['Invoice__c']).toEqual([
      { Name: 'January', Account__c: 'Account:Customer' },
      { Name: 'February' },
    ]);
    expect(inserted['InvoiceLink__c']).toEqual([
      { Name: 'J1', Case__c: 'Case:Claim', Invoice__c: 'Invoice__c:January' },
      { Name: 'J2', Case__c: 'Case:Claim', Invoice__c: 'Invoice__c:February' },
    ]);
    expect(insertOrder.indexOf('Invoice__c')).toBeLessThan(insertOrder.indexOf('InvoiceLink__c'));
    expect(read.has(POLICY)).toBe(false);
    expect(summary.failedCount).toBe(0);
    expect(finishedRunStatus(summary)).toBe('success');
    expect(summary.readByObject).toContainEqual({ objectApiName: 'Invoice__c', read: 2 });
    expect(summary.createdByObject).toContainEqual({
      objectApiName: 'Invoice__c',
      sourceIds: [JANUARY, FEBRUARY],
    });
    expect(summary.errors).toEqual([
      {
        objectApiName: 'Invoice__c',
        stage: 'scope',
        failedCount: 0,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: 'Policy__c → Policy__c (1 record)',
            messages: [
              'Written with the lookup empty: the Policy__c record it points at is not in the clone.',
            ],
          },
        ],
      },
    ]);
  });

  it('reads no other row than before: none under the invoices, nor any more of the objects of the graph', async () => {
    // The same clone of a target that already holds the two invoices: the
    // junction rows link to them, and no invoice is read.
    const before = orgs();
    const known = await new ForgeExecutor(before.deps).execute(
      caseGraph(),
      'src',
      'tgt',
      () => undefined,
      {
        ...ROOTED_AT_THE_CASE,
        writtenBefore: { [JANUARY]: 'a0Ixx0000000001AAA', [FEBRUARY]: 'a0Ixx0000000002AAA' },
      },
    );
    const after = orgs();

    const summary = await new ForgeExecutor(after.deps).execute(
      caseGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    const others = (asked: readonly string[]): string[] =>
      asked.filter((soql) => !/\bFROM Invoice__c\b/.test(soql));
    expect(others(after.asked)).toEqual(others(before.asked));
    expect(readOfOthers(summary, 'Invoice__c')).toEqual(readOfOthers(known, 'Invoice__c'));
    // Neither the other case's junction row on the first invoice, nor the
    // invoice's lines, nor an invoice no row names.
    for (const id of ['a0J000000000009AAA', 'a0L000000000001AAA', UNRELATED, OTHER_CASE]) {
      expect(after.read.has(id)).toBe(false);
    }
    expect(statementsOf(after.asked, 'Invoice_Line__c')).toEqual([]);
  });

  it('says in a dry run that it would insert the invoices, and why, and counts them', async () => {
    const { deps } = orgs();
    const said: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      (event) => said.push(event),
      { ...ROOTED_AT_THE_CASE, dryRun: true },
    );

    expect(said.map((event) => event.message)).toContain(
      '[dry-run] Invoice__c: 2 record(s) would be inserted, which the InvoiceLink__c records ' +
        'cannot be written without: read by id, nothing read under them',
    );
    expect(summary.wouldInsertCount).toBe(1 /* case */ + 1 /* account */ + 2 /* rows */ + 2);
    expect(summary.readByObject).toContainEqual({ objectApiName: 'Invoice__c', read: 2 });
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it("says on the invoices' line that they were read by id for the junction rows", async () => {
    const { deps } = orgs();
    const said: string[] = [];

    await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      (event) => said.push(event.message),
      ROOTED_AT_THE_CASE,
    );

    expect(said).toContain(
      'Completed Invoice__c: 2 succeeded, 0 failed, 2 read by id for the InvoiceLink__c records ' +
        'that cannot be written without them',
    );
  });

  it('asks for each invoice once, however many rows name it', async () => {
    const tables = sourceRows();
    tables['InvoiceLink__c'].push({
      Id: 'a0J000000000003AAA',
      Name: 'J3',
      Case__c: CASE,
      Invoice__c: JANUARY,
    });
    const { deps, asked, inserted } = orgs(tables);

    await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    expect(statementsOf(asked, 'Invoice__c')).toHaveLength(1);
    expect(inserted['Invoice__c'].map((row) => row['Name'])).toEqual(['January', 'February']);
    expect(inserted['InvoiceLink__c'].map((row) => row['Invoice__c'])).toEqual([
      'Invoice__c:January',
      'Invoice__c:February',
      'Invoice__c:January',
    ]);
  });

  it('does not ask again, a level up, for a record a row of the graph needed and the run read', async () => {
    // The junction rows and the invoices both need the same billing: read for
    // the rows, it is in hand when the invoices want it.
    const fields: Record<string, FieldInfo[]> = {
      ...FIELDS,
      InvoiceLink__c: [...FIELDS['InvoiceLink__c'], lookup('Billing__c', 'Billing__c', true)],
      Invoice__c: [idField, text('Name'), lookup('Billing__c', 'Billing__c', true)],
    };
    const tables = sourceRows();
    for (const row of tables['InvoiceLink__c']) row['Billing__c'] = BILLING;
    tables['Invoice__c'] = [
      { Id: JANUARY, Name: 'January', Billing__c: BILLING },
      { Id: FEBRUARY, Name: 'February', Billing__c: BILLING },
    ];
    const { deps, asked, inserted } = orgs(tables, { fields });

    const summary = await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    expect(statementsOf(asked, 'Billing__c')).toHaveLength(1);
    expect(inserted['Billing__c']).toEqual([{ Name: 'Monthly' }]);
    expect(inserted['Invoice__c'].map((row) => row['Billing__c'])).toEqual([
      'Billing__c:Monthly',
      'Billing__c:Monthly',
    ]);
    expect(summary.failedCount).toBe(0);
  });

  it('reads what an invoice cannot be written without the same way: a parent outside the graph, and an account no read took, with nothing under it', async () => {
    // The invoice needs its billing, outside the graph too, and its account,
    // which for the second invoice is not the case's. The graph reads contacts
    // under the accounts: none is read under the account read for the invoice.
    const fields: Record<string, FieldInfo[]> = {
      ...FIELDS,
      Invoice__c: [
        idField,
        text('Name'),
        lookup('Account__c', 'Account', true),
        lookup('Billing__c', 'Billing__c', true),
      ],
    };
    const tables = sourceRows();
    tables['Invoice__c'] = [
      { Id: JANUARY, Name: 'January', Account__c: CUSTOMER, Billing__c: BILLING },
      { Id: FEBRUARY, Name: 'February', Account__c: OTHER_CUSTOMER, Billing__c: BILLING },
    ];
    const graph = graphOf(
      [node('Case', 0), node('Account', 1), node('InvoiceLink__c', 1), node('Contact', 2)],
      [edge('Account', 'Case'), edge('Case', 'InvoiceLink__c', true), edge('Account', 'Contact')],
    );
    const { deps, asked, inserted, insertOrder } = orgs(tables, { fields });

    const summary = await new ForgeExecutor(deps).execute(
      graph,
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    expect(statementsOf(asked, 'Billing__c')).toEqual([
      `SELECT Id, Name FROM Billing__c WHERE Id IN ('${BILLING}')`,
    ]);
    expect(statementsOf(asked, 'Account')).toContain(
      `SELECT Id, Name FROM Account WHERE Id IN ('${OTHER_CUSTOMER}')`,
    );
    expect(statementsOf(asked, 'Contact').some((soql) => soql.includes(OTHER_CUSTOMER))).toBe(
      false,
    );
    expect(inserted['Account'].map((row) => row['Name'])).toEqual(['Customer', 'Other customer']);
    expect(inserted['Contact'].map((row) => row['Name'])).toEqual(['Roe']);
    expect(inserted['Invoice__c']).toEqual([
      { Name: 'January', Account__c: 'Account:Customer', Billing__c: 'Billing__c:Monthly' },
      { Name: 'February', Account__c: 'Account:Other customer', Billing__c: 'Billing__c:Monthly' },
    ]);
    expect(insertOrder.indexOf('Billing__c')).toBeLessThan(insertOrder.indexOf('Invoice__c'));
    expect(insertOrder.indexOf('Account')).toBeLessThan(insertOrder.indexOf('Invoice__c'));
    expect(summary.failedCount).toBe(0);
    expect(summary.readByObject).toContainEqual({ objectApiName: 'Account', read: 2 });
  });

  it('says in a dry run that it would insert one more record of an object of the graph, and why', async () => {
    const fields: Record<string, FieldInfo[]> = {
      ...FIELDS,
      Invoice__c: [idField, text('Name'), lookup('Account__c', 'Account', true)],
    };
    const tables = sourceRows();
    tables['Invoice__c'] = [
      { Id: JANUARY, Name: 'January', Account__c: CUSTOMER },
      { Id: FEBRUARY, Name: 'February', Account__c: OTHER_CUSTOMER },
    ];
    const { deps } = orgs(tables, { fields });
    const said: string[] = [];

    const summary = await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      (event) => said.push(event.message),
      { ...ROOTED_AT_THE_CASE, dryRun: true },
    );

    expect(said).toContain(
      '[dry-run] Account: 1 more record(s) would be inserted, which the Invoice__c records ' +
        'cannot be written without: read by id, nothing read under them',
    );
    expect(summary.wouldInsertCount).toBe(1 + 1 + 2 + 2 + 1);
  });

  it('goes five levels up at most', async () => {
    // Each object outside the graph needs a record of the next one.
    const chain = ['P1__c', 'P2__c', 'P3__c', 'P4__c', 'P5__c', 'P6__c', 'P7__c'];
    const fields: Record<string, FieldInfo[]> = {
      ...FIELDS,
      InvoiceLink__c: [
        idField,
        text('Name'),
        lookup('Case__c', 'Case', true),
        lookup('P__c', 'P1__c', true),
      ],
    };
    const tables = sourceRows();
    tables['InvoiceLink__c'] = [
      { Id: 'a0J000000000001AAA', Name: 'J1', Case__c: CASE, P__c: 'a01000000000001AAA' },
    ];
    chain.forEach((object, index) => {
      const next = chain[index + 1];
      fields[object] = [idField, text('Name'), ...(next ? [lookup('Next__c', next, true)] : [])];
      tables[object] = [
        {
          Id: `a0${index + 1}000000000001AAA`,
          Name: object,
          ...(next ? { Next__c: `a0${index + 2}000000000001AAA` } : {}),
        },
      ];
    });
    const { deps, asked } = orgs(tables, { fields });

    await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    for (const object of chain.slice(0, 5)) expect(statementsOf(asked, object)).toHaveLength(1);
    expect(statementsOf(asked, 'P6__c')).toEqual([]);
    expect(statementsOf(asked, 'P7__c')).toEqual([]);
  });

  it('holds the cap on the object', async () => {
    const { deps, asked, inserted } = orgs();

    await new ForgeExecutor(deps).execute(caseGraph(), 'src', 'tgt', () => undefined, {
      ...ROOTED_AT_THE_CASE,
      maxRecordsPerObject: 1,
    });

    expect(statementsOf(asked, 'Invoice__c')[0]).toMatch(/ LIMIT 1$/);
    expect(inserted['Invoice__c']).toHaveLength(1);
  });

  describe('an object the target cannot take', () => {
    it('holds back the rows that need one of its records, reads none, and says why', async () => {
      const { deps, asked, inserted } = orgs(sourceRows(), {
        isObjectCreatable: async (_org, object) => object !== 'Invoice__c',
      });

      const summary = await new ForgeExecutor(deps).execute(
        caseGraph(),
        'src',
        'tgt',
        () => undefined,
        ROOTED_AT_THE_CASE,
      );

      expect(statementsOf(asked, 'Invoice__c')).toEqual([]);
      expect(inserted['InvoiceLink__c']).toBeUndefined();
      expect(summary.failedCount).toBe(2);
      expect(summary.errors).toContainEqual({
        objectApiName: 'InvoiceLink__c',
        stage: 'scope',
        failedCount: 2,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: 'Invoice__c → Invoice__c (2 records)',
            messages: [
              'Not written: Invoice__c may not be left empty, and the target org takes no insert of Invoice__c.',
            ],
          },
        ],
      });
    });

    it('says in a dry run that the rows would not be inserted, and why', async () => {
      const { deps } = orgs(sourceRows(), {
        isObjectCreatable: async (_org, object) => object !== 'Invoice__c',
      });
      const said: string[] = [];

      const summary = await new ForgeExecutor(deps).execute(
        caseGraph(),
        'src',
        'tgt',
        (event) => said.push(event.message),
        { ...ROOTED_AT_THE_CASE, dryRun: true },
      );

      expect(said).toContain(
        '[dry-run] InvoiceLink__c: 2 fewer would be inserted, 2 failed, held back for want of ' +
          'Invoice__c, which the target org takes no insert of',
      );
      expect(summary.wouldInsertCount).toBe(1 /* case */ + 1 /* account */);
    });

    it('says so of an object the target does not have', async () => {
      const notFound = Object.assign(new Error('The requested resource does not exist'), {
        errorCode: 'NOT_FOUND',
      });
      const { deps, asked } = orgs(sourceRows(), {
        isObjectCreatable: async (_org, object) => {
          if (object === 'Invoice__c') throw notFound;
          return true;
        },
      });

      const summary = await new ForgeExecutor(deps).execute(
        caseGraph(),
        'src',
        'tgt',
        () => undefined,
        ROOTED_AT_THE_CASE,
      );

      expect(statementsOf(asked, 'Invoice__c')).toEqual([]);
      expect(summary.errors.find((e) => e.objectApiName === 'InvoiceLink__c')?.samples).toEqual([
        {
          recordSummary: 'Invoice__c → Invoice__c (2 records)',
          messages: [
            'Not written: Invoice__c may not be left empty, and the target org does not have Invoice__c.',
          ],
        },
      ]);
    });

    it("writes the rows without the lookup where the target's object does not carry it, as before", async () => {
      const notFound = Object.assign(new Error('The requested resource does not exist'), {
        errorCode: 'NOT_FOUND',
      });
      const { deps, inserted } = orgs(sourceRows(), {
        targetFields: {
          InvoiceLink__c: [idField, text('Name'), lookup('Case__c', 'Case', true)],
        },
        isObjectCreatable: async (_org, object) => {
          if (object === 'Invoice__c') throw notFound;
          return true;
        },
      });

      const summary = await new ForgeExecutor(deps).execute(
        caseGraph(),
        'src',
        'tgt',
        () => undefined,
        ROOTED_AT_THE_CASE,
      );

      expect(inserted['InvoiceLink__c']).toEqual([
        { Name: 'J1', Case__c: 'Case:Claim' },
        { Name: 'J2', Case__c: 'Case:Claim' },
      ]);
      expect(summary.failedCount).toBe(0);
    });

    it('reads nothing more for a row it holds back: not the other record the row needs', async () => {
      // The junction rows need their billing too, which the target takes: held
      // back for their invoice, they leave the billing unread.
      const fields: Record<string, FieldInfo[]> = {
        ...FIELDS,
        InvoiceLink__c: [...FIELDS['InvoiceLink__c'], lookup('Billing__c', 'Billing__c', true)],
      };
      const tables = sourceRows();
      for (const row of tables['InvoiceLink__c']) row['Billing__c'] = BILLING;
      const { deps, asked, inserted } = orgs(tables, {
        fields,
        isObjectCreatable: async (_org, object) => object !== 'Invoice__c',
      });

      await new ForgeExecutor(deps).execute(
        caseGraph(),
        'src',
        'tgt',
        () => undefined,
        ROOTED_AT_THE_CASE,
      );

      expect(statementsOf(asked, 'Billing__c')).toEqual([]);
      expect(inserted['Billing__c']).toBeUndefined();
    });

    it('holds back, after the record read for them, the rows that need a record it holds back', async () => {
      // The invoices need their account, of an object of the graph the target
      // takes no insert of: the invoices are held back, then the junction rows.
      const fields: Record<string, FieldInfo[]> = {
        ...FIELDS,
        Invoice__c: [idField, text('Name'), lookup('Account__c', 'Account', true)],
      };
      const tables = sourceRows();
      tables['Invoice__c'] = [
        { Id: JANUARY, Name: 'January', Account__c: OTHER_CUSTOMER },
        { Id: FEBRUARY, Name: 'February', Account__c: OTHER_CUSTOMER },
      ];
      const { deps, inserted, asked } = orgs(tables, {
        fields,
        isObjectCreatable: async (_org, object) => object !== 'Account',
      });
      const said: string[] = [];

      const summary = await new ForgeExecutor(deps).execute(
        caseGraph(),
        'src',
        'tgt',
        (event) => said.push(event.message),
        ROOTED_AT_THE_CASE,
      );

      expect(statementsOf(asked, 'Account').some((soql) => soql.includes(OTHER_CUSTOMER))).toBe(
        false,
      );
      expect(inserted['Invoice__c']).toBeUndefined();
      expect(inserted['InvoiceLink__c']).toBeUndefined();
      expect(summary.errors.find((e) => e.objectApiName === 'Invoice__c')?.samples).toEqual([
        {
          recordSummary: 'Account__c → Account (2 records)',
          messages: [
            'Not written: Account__c may not be left empty, and the target org takes no insert of Account.',
          ],
        },
      ]);
      expect(summary.errors.find((e) => e.objectApiName === 'InvoiceLink__c')?.samples).toEqual([
        {
          recordSummary: 'Invoice__c → Invoice__c (2 records)',
          messages: [
            'Not written: Invoice__c may not be left empty, and the Invoice__c it names is held ' +
              'back for Account, which the target org takes no insert of.',
          ],
        },
      ]);
      expect(said).toContain(
        'Held back InvoiceLink__c, nothing written, 2 failed: every record needs Account, ' +
          'which the target org takes no insert of. Objects that cannot be written without it ' +
          'will be skipped.',
      );
    });
  });

  it("reads nothing for a run that keeps the source's ids of the records it does not write", async () => {
    const { deps, asked } = orgs();

    await new ForgeExecutor(deps).execute(caseGraph(), 'src', 'tgt', () => undefined, {
      ...ROOTED_AT_THE_CASE,
      referenceFallback: 'keep',
    });

    expect(statementsOf(asked, 'Invoice__c')).toEqual([]);
  });

  it('reads nothing of an object the user excluded: the rows that need it are held back, as before', async () => {
    const { deps, asked, inserted } = orgs();

    const summary = await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      () => undefined,
      { ...ROOTED_AT_THE_CASE, excludedObjects: ['Invoice__c'] },
    );

    expect(statementsOf(asked, 'Invoice__c')).toEqual([]);
    expect(inserted['InvoiceLink__c']).toBeUndefined();
    expect(summary.errors.find((e) => e.objectApiName === 'InvoiceLink__c')?.samples).toEqual([
      {
        recordSummary: 'Invoice__c → Invoice__c (2 records)',
        messages: [
          'Not written: Invoice__c may not be left empty, and Invoice__c is excluded from this run.',
        ],
      },
    ]);
  });
});
