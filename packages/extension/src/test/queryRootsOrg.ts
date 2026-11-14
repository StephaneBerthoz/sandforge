/**
 * A source and a target in memory for a clone from the records a query
 * chooses: the source is the org a sample's reads are tested against
 * (`sampleSourceOrg.ts`), taken as it stands — it refuses a statement past
 * the URI the org holds, a column its describe does not list, a semi-join
 * beside an OR, and counts every request —, with the accounts, contacts,
 * opportunities and cases below; the target creates what it is sent.
 *
 * The columns each object answers are a scratch org's, as its describe gave
 * them (14/11), the few the clone reads; so is whether a lookup may be left
 * empty. The deps count a request for each statement and page of the
 * source, each describe and each call to the target, as the extension's
 * count each call (`requestsSent`).
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import type { FieldInfo, ForgeExecutorDeps } from '../modules/forge/ForgeExecutor.js';
import { cursorPages } from '../modules/forge/queryAllPages.js';
import type { SoqlRow } from './memorySoql.js';
import { SampleSourceOrg } from './sampleSourceOrg.js';

/** A row as the source holds it and the target is sent it. */
export type Row = Record<string, unknown>;

/** The columns of each object a scratch org's describe lists, of those the clone reads. */
export const QUERY_ROOTS_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Account: ['Id', 'IsDeleted', 'Name', 'Industry', 'ParentId', 'CreatedDate'],
  Contact: ['Id', 'IsDeleted', 'LastName', 'Department', 'AccountId', 'ReportsToId'],
  Opportunity: ['Id', 'IsDeleted', 'Name', 'StageName', 'CloseDate', 'AccountId'],
  Case: ['Id', 'IsDeleted', 'Subject', 'AccountId', 'ContactId'],
  Product2: ['Id', 'IsDeleted', 'Name', 'Family', 'IsActive'],
  // A custom object under a product: what a row of the catalog brings only
  // when the run reached it from above.
  Note__c: ['Id', 'IsDeleted', 'Name', 'Product__c'],
};

/** The key prefix of each object's ids. */
export const PREFIX: Readonly<Record<string, string>> = {
  Account: '001',
  Contact: '003',
  Opportunity: '006',
  Case: '500',
  Product2: '01t',
  Note__c: 'a0N',
};

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  updateable: name !== 'Id',
  isReference: false,
  ...overrides,
});

const lookup = (name: string, to: string): FieldInfo =>
  field(name, { isReference: true, referenceTo: [to], nillable: true });

/** The fields the clone reads of each object, each lookup as the describe gives it: nillable. */
export const QUERY_ROOTS_FIELDS: Readonly<Record<string, FieldInfo[]>> = {
  Account: [field('Id'), field('Name'), field('Industry'), lookup('ParentId', 'Account')],
  Contact: [
    field('Id'),
    field('LastName'),
    field('Department'),
    lookup('AccountId', 'Account'),
    lookup('ReportsToId', 'Contact'),
  ],
  Opportunity: [
    field('Id'),
    field('Name'),
    field('StageName'),
    field('CloseDate'),
    lookup('AccountId', 'Account'),
  ],
  Case: [
    field('Id'),
    field('Subject'),
    lookup('AccountId', 'Account'),
    lookup('ContactId', 'Contact'),
  ],
  Product2: [field('Id'), field('Name'), field('Family'), field('IsActive')],
  Note__c: [field('Id'), field('Name'), lookup('Product__c', 'Product2')],
};

/** A fake id: the object's prefix, a letter for the org, a counter; the length of a real one. */
export function fakeId(object: string, org: 'S' | 'T', n: number): string {
  return `${PREFIX[object] ?? 'a00'}${org}${String(n).padStart(11, '0')}AAA`;
}

/** The lookups between the objects of the clone, parent to child. */
const EDGES: readonly ForgeGraphEdge[] = [
  {
    sourceObject: 'Account',
    targetObject: 'Contact',
    relationshipName: 'Contacts',
    type: 'lookup',
  },
  {
    sourceObject: 'Account',
    targetObject: 'Opportunity',
    relationshipName: 'Opportunities',
    type: 'lookup',
  },
  { sourceObject: 'Account', targetObject: 'Case', relationshipName: 'Cases', type: 'lookup' },
  { sourceObject: 'Contact', targetObject: 'Case', relationshipName: 'Cases', type: 'lookup' },
  {
    sourceObject: 'Product2',
    targetObject: 'Note__c',
    relationshipName: 'Notes__r',
    type: 'lookup',
  },
];

function node(objectApiName: string, level: number, recordCount: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
    fieldCount: QUERY_ROOTS_FIELDS[objectApiName]?.length ?? 1,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

/**
 * The graph discovery gives a clone rooted at `root` over `objects`: the
 * root first, at level 0, each other object one level down, and the lookups
 * between them.
 */
export function queryRootsGraph(
  org: QueryRootsOrg,
  root: string,
  objects: readonly string[],
): ForgeGraph {
  const names = [root, ...objects.filter((o) => o !== root)];
  const nodes = names.map((name) =>
    node(name, name === root ? 0 : 1, org.source.rows.get(name)?.length ?? 0),
  );
  return {
    nodes,
    edges: EDGES.filter((e) => names.includes(e.sourceObject) && names.includes(e.targetObject)),
    totalRecords: nodes.reduce((sum, n) => sum + n.recordCount, 0),
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

/** The source and target of a clone from records, and the deps a run reads and writes them through. */
export class QueryRootsOrg {
  /** The source, answering as `SampleSourceOrg` answers. */
  readonly source = new SampleSourceOrg();
  /** What the target was sent and created, by object. */
  readonly inserted = new Map<string, Row[]>();
  /** Requests the deps sent: each statement and page of the source, each describe, each call to the target. */
  requests = 0;
  /** Every statement the source was sent, in order. */
  readonly statements: string[] = [];
  private created = 0;

  constructor() {
    for (const [object, columns] of Object.entries(QUERY_ROOTS_COLUMNS)) {
      this.source.columns.set(object, columns);
    }
  }

  /** Add rows of `object` to the source, each live. */
  add(object: string, ...rows: SoqlRow[]): void {
    this.source.add(object, ...rows.map((row) => ({ IsDeleted: false, ...row })));
  }

  /** The statements the source was sent that read `object`. */
  statementsOf(object: string): string[] {
    return this.statements.filter((soql) => new RegExp(`\\bFROM ${object}\\b`).test(soql));
  }

  /** The ids of `object` the source answered, to any statement. */
  readonly answered = new Map<string, Set<string>>();

  /** The deps a run reads the source and writes the target through. */
  deps(): ForgeExecutorDeps {
    const source = this.source;
    const gather = async (soql: string): Promise<Row[]> => {
      this.statements.push(soql);
      const before = source.requests;
      const rows: Row[] = [];
      try {
        for await (const page of cursorPages(source, soql)) rows.push(...page);
      } finally {
        this.requests += source.requests - before;
      }
      const object = /\bFROM (\w+)/.exec(soql)?.[1] ?? '';
      const ids = this.answered.get(object) ?? new Set<string>();
      for (const row of rows) if (typeof row['Id'] === 'string') ids.add(row['Id']);
      this.answered.set(object, ids);
      return rows;
    };
    return {
      describeFields: async (_org, object) => {
        this.requests++;
        return QUERY_ROOTS_FIELDS[object] ?? [];
      },
      queryRecords: async (org, soql) => {
        if (org === 'src') return gather(soql);
        this.requests++;
        return [];
      },
      insertRecords: async (_org, object, rows) => {
        this.requests++;
        const held = this.inserted.get(object) ?? [];
        this.inserted.set(object, held);
        return rows.map((row) => {
          held.push({ ...row });
          return { id: fakeId(object, 'T', ++this.created), success: true, errors: [] };
        });
      },
      updateRecords: async (_org, _object, rows) => {
        this.requests++;
        return rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] }));
      },
      isObjectCreatable: async () => true,
      requestsSent: () => this.requests,
    };
  }
}

/**
 * The org the design's cases are drawn on: three accounts, two of them in
 * Energy; two contacts under the first, one under each other; an
 * opportunity under each account; and a case under the third account naming
 * the first account's first contact.
 */
export function energyOrg(): QueryRootsOrg {
  const org = new QueryRootsOrg();
  const account = (n: number): string => fakeId('Account', 'S', n);
  const contact = (n: number): string => fakeId('Contact', 'S', n);
  org.add(
    'Account',
    { Id: account(1), Name: 'A1', Industry: 'Energy', ParentId: null },
    { Id: account(2), Name: 'A2', Industry: 'Energy', ParentId: null },
    { Id: account(3), Name: 'A3', Industry: 'Retail', ParentId: null },
  );
  org.add(
    'Contact',
    {
      Id: contact(1),
      LastName: 'C1a',
      Department: 'Sales',
      AccountId: account(1),
      ReportsToId: null,
    },
    {
      Id: contact(2),
      LastName: 'C1b',
      Department: 'Support',
      AccountId: account(1),
      ReportsToId: null,
    },
    {
      Id: contact(3),
      LastName: 'C2',
      Department: 'Sales',
      AccountId: account(2),
      ReportsToId: null,
    },
    {
      Id: contact(4),
      LastName: 'C3',
      Department: 'Sales',
      AccountId: account(3),
      ReportsToId: null,
    },
  );
  org.add(
    'Opportunity',
    ...[1, 2, 3].map((n) => ({
      Id: fakeId('Opportunity', 'S', n),
      Name: `O${n}`,
      StageName: 'Prospecting',
      CloseDate: '2026-12-31',
      AccountId: account(n),
    })),
  );
  org.add('Case', {
    Id: fakeId('Case', 'S', 1),
    Subject: 'K3',
    AccountId: account(3),
    ContactId: contact(1),
  });
  return org;
}
