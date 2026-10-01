import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
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
 * A record whose parent — a record it cannot be written without — was not
 * read with the parent's object. Run between two sandboxes, a clone of a case
 * read the case's two accounts, then the insurance policy the case names: the
 * policy's named insured, a lookup it may not leave empty, was neither of the
 * accounts, whose read was over. The policy was refused for want of it, and
 * its three coverages were held back behind it.
 */

const idField: FieldInfo = { name: 'Id', queryable: true, createable: false, isReference: false };
const text = (name: string): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  isReference: false,
});
/** A flag no write sets: `IsPersonAccount`. */
const readOnly = (name: string): FieldInfo => ({
  name,
  queryable: true,
  createable: false,
  updateable: false,
  isReference: false,
});
const lookup = (
  name: string,
  target: string,
  { required = false, settable = true }: { required?: boolean; settable?: boolean } = {},
): FieldInfo => ({
  name,
  queryable: true,
  createable: settable,
  updateable: settable,
  isReference: true,
  referenceTo: [target],
  nillable: !required,
});

const CASE = '500000000000001AAA';
const CUSTOMER = '001000000000001AAA';
const BROKER = '001000000000002AAA';
const NAMED_INSURED = '001000000000003AAA';
const AGENT = '001000000000008AAA';
const POLICY = 'a0P000000000001AAA';
const PRIOR_POLICY = 'a0P000000000009AAA';

/** The source's fields of each object. */
const FIELDS: Record<string, FieldInfo[]> = {
  Case: [
    idField,
    text('Name'),
    lookup('AccountId', 'Account'),
    lookup('Broker__c', 'Account'),
    lookup('Policy__c', 'Policy__c'),
  ],
  Account: [idField, text('Name')],
  Policy__c: [
    idField,
    text('Name'),
    lookup('Named_Insured__c', 'Account', { required: true }),
    lookup('Agent__c', 'Account'),
    lookup('Prior_Policy__c', 'Policy__c'),
  ],
  Coverage__c: [idField, text('Name'), lookup('Policy__c', 'Policy__c', { required: true })],
};

/** The case, its customer and broker, the policy it names, insured by a third account, and the policy's coverages. */
function sourceRows(): Record<string, FakeRow[]> {
  return {
    Case: [{ Id: CASE, Name: 'Claim', AccountId: CUSTOMER, Broker__c: BROKER, Policy__c: POLICY }],
    Account: [
      { Id: CUSTOMER, Name: 'Customer' },
      { Id: BROKER, Name: 'Broker' },
      { Id: NAMED_INSURED, Name: 'Named insured' },
      { Id: AGENT, Name: 'Agent' },
    ],
    Policy__c: [
      {
        Id: POLICY,
        Name: 'Home',
        Named_Insured__c: NAMED_INSURED,
        Agent__c: null,
        Prior_Policy__c: null,
      },
      {
        Id: PRIOR_POLICY,
        Name: 'Lapsed',
        Named_Insured__c: '001000000000009AAA',
        Agent__c: null,
        Prior_Policy__c: null,
      },
    ],
    Coverage__c: [
      { Id: 'a0C000000000001AAA', Name: 'Fire', Policy__c: POLICY },
      { Id: 'a0C000000000002AAA', Name: 'Flood', Policy__c: POLICY },
      { Id: 'a0C000000000003AAA', Name: 'Theft', Policy__c: POLICY },
      { Id: 'a0C000000000009AAA', Name: 'Elsewhere', Policy__c: PRIOR_POLICY },
    ],
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
  type: 'lookup',
  ...(required ? { required: true } : {}),
});

function graphOf(nodes: ForgeGraphNode[], edges: ForgeGraphEdge[]): ForgeGraph {
  return { nodes, edges, totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0 };
}

/**
 * The graph discovery builds around the case: the accounts' turn comes before
 * the policy's, the policy's before its coverages'.
 */
function caseGraph(): ForgeGraph {
  return graphOf(
    [node('Case', 0), node('Account', 1), node('Policy__c', 1), node('Coverage__c', 2)],
    [
      edge('Account', 'Case'),
      edge('Policy__c', 'Case'),
      edge('Account', 'Policy__c', true),
      edge('Policy__c', 'Coverage__c', true),
    ],
  );
}

const ROOTED_AT_THE_CASE = { rootRecordId: CASE, rootObjectApiName: 'Case' };

/** Of each object, the lookups a row the target takes may not leave empty. */
const REQUIRED_IN_THE_TARGET: Record<string, string[]> = {
  Policy__c: ['Named_Insured__c'],
  Coverage__c: ['Policy__c'],
};

/**
 * A source org holding `tables`, and a target that names each record it
 * creates after the row's name — the account named Broker becomes
 * `Account:Broker` — and refuses a row without a lookup it requires, as the
 * platform does. What the source was asked and the ids of the rows it gave,
 * and what the target was sent, are kept.
 */
function orgs(
  tables: Record<string, FakeRow[]> = sourceRows(),
  fields: Record<string, FieldInfo[]> = FIELDS,
) {
  const inserted: Record<string, Array<Record<string, unknown>>> = {};
  const asked: string[] = [];
  const read = new Set<string>();
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => fields[object] ?? [idField]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      asked.push(soql);
      const rows = selectRows(tables, soql);
      for (const row of rows) read.add(String(row['Id']));
      return rows;
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      (inserted[object] ??= []).push(...rows);
      return rows.map((row): InsertResult => {
        const missing = (REQUIRED_IN_THE_TARGET[object] ?? []).filter(
          (field) => typeof row[field] !== 'string',
        );
        if (missing.length > 0) {
          return {
            id: '',
            success: false,
            errors: [
              `REQUIRED_FIELD_MISSING: Required fields are missing: [${missing.join(', ')}]`,
            ],
          };
        }
        return {
          id: `${object}:${String(row['Name'] ?? row['LastName'])}`,
          success: true,
          errors: [],
        };
      });
    }),
    updateRecords: vi.fn(async (_org: string, _object: string, rows: Record<string, unknown>[]) =>
      rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] })),
    ),
  } satisfies ForgeExecutorDeps;
  return { deps, inserted, asked, read };
}

/** The statements sent for `object`. */
const statementsOf = (asked: readonly string[], object: string): string[] =>
  asked.filter((soql) => new RegExp(`\\bFROM ${object}\\b`).test(soql));

describe('ForgeExecutor, a record whose required parent was not read', () => {
  it("reads the account a policy cannot be written without, its object's read over, and writes it before the policy", async () => {
    const { deps, inserted, asked } = orgs();

    const summary = await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    expect(inserted['Account'].map((row) => row['Name'])).toEqual([
      'Customer',
      'Broker',
      'Named insured',
    ]);
    expect(inserted['Policy__c']).toEqual([
      { Name: 'Home', Named_Insured__c: 'Account:Named insured' },
    ]);
    expect(inserted['Coverage__c'].map((row) => [row['Name'], row['Policy__c']])).toEqual([
      ['Fire', 'Policy__c:Home'],
      ['Flood', 'Policy__c:Home'],
      ['Theft', 'Policy__c:Home'],
    ]);
    expect(summary.errors).toEqual([]);
    expect(summary.failedCount).toBe(0);
    expect(finishedRunStatus(summary)).toBe('success');
    expect(summary.readByObject.find((r) => r.objectApiName === 'Account')?.read).toBe(3);
    // Two requests more than the clone would send otherwise: the account by
    // its id, and the policies read again under it.
    expect(statementsOf(asked, 'Account')).toHaveLength(2);
    expect(statementsOf(asked, 'Policy__c')).toHaveLength(3);
  });

  it('asks for the record by its id, once, however many rows name it', async () => {
    const tables = sourceRows();
    tables['Case'][0]['Second_Policy__c'] = 'a0P000000000002AAA';
    tables['Policy__c'].push({
      Id: 'a0P000000000002AAA',
      Name: 'Car',
      Named_Insured__c: NAMED_INSURED,
      Agent__c: null,
      Prior_Policy__c: null,
    });
    const fields = {
      ...FIELDS,
      Case: [...FIELDS['Case'], lookup('Second_Policy__c', 'Policy__c')],
    };
    const { deps, inserted, asked } = orgs(tables, fields);

    await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    const byIdOfTheInsured = statementsOf(asked, 'Account').filter(
      (soql) => soql.includes(NAMED_INSURED) && !soql.includes(CUSTOMER),
    );
    expect(byIdOfTheInsured).toHaveLength(1);
    expect(byIdOfTheInsured[0]).toMatch(/WHERE Id IN \('001000000000003AAA'\)$/);
    expect(inserted['Policy__c'].map((row) => row['Named_Insured__c'])).toEqual([
      'Account:Named insured',
      'Account:Named insured',
    ]);
  });

  it('says in a dry run that it would insert the record, and why', async () => {
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
      '[dry-run] Account: 1 more record(s) would be inserted, which the Policy__c records read after it cannot be written without',
    );
    expect(summary.wouldInsertCount).toBe(
      1 /* case */ + 2 /* accounts */ + 1 /* policy */ + 1 /* insured */ + 3 /* coverages */,
    );
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('leaves a lookup the row may leave empty at a record outside the clone empty, reads nothing for it, and says so without a failure', async () => {
    // The policy's agent and the policy it replaced are none of the clone's:
    // read for an optional lookup, each would have brought what is under it.
    const tables = sourceRows();
    tables['Policy__c'][0]['Agent__c'] = AGENT;
    tables['Policy__c'][0]['Prior_Policy__c'] = PRIOR_POLICY;
    const { deps, inserted, read } = orgs(tables);

    const summary = await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    expect(read.has(AGENT)).toBe(false);
    expect(read.has(PRIOR_POLICY)).toBe(false);
    expect(inserted['Policy__c']).toEqual([
      { Name: 'Home', Named_Insured__c: 'Account:Named insured' },
    ]);
    expect(summary.errors).toEqual([
      {
        objectApiName: 'Policy__c',
        stage: 'scope',
        failedCount: 0,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: 'Agent__c → Account (1 record)',
            messages: [
              'Written with the lookup empty: the Account record it points at is not in the clone.',
            ],
          },
          {
            recordSummary: 'Prior_Policy__c → Policy__c (1 record)',
            messages: [
              'Written with the lookup empty: the Policy__c record it points at is not in the clone.',
            ],
          },
        ],
      },
    ]);
    expect(summary.failedCount).toBe(0);
    expect(finishedRunStatus(summary)).toBe('success');
    expect(deps.updateRecords).not.toHaveBeenCalled();
  });

  it('reads under the record read late what is read under any account, as under any row read late', async () => {
    // The named insured's other policy comes with it, as it would have had the
    // account been read at its turn, and that policy's coverage at theirs.
    const tables = sourceRows();
    tables['Policy__c'].push({
      Id: 'a0P000000000003AAA',
      Name: 'Boat',
      Named_Insured__c: NAMED_INSURED,
      Agent__c: null,
      Prior_Policy__c: null,
    });
    tables['Coverage__c'].push({
      Id: 'a0C000000000004AAA',
      Name: 'Hull',
      Policy__c: 'a0P000000000003AAA',
    });
    const { deps, inserted } = orgs(tables);

    const summary = await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    expect(inserted['Policy__c'].map((row) => row['Name'])).toEqual(['Home', 'Boat']);
    expect(inserted['Coverage__c'].map((row) => row['Name'])).toEqual([
      'Fire',
      'Flood',
      'Theft',
      'Hull',
    ]);
    expect(summary.errors).toEqual([]);
  });

  it("does not read again the root's object for a record that needs another of its records", async () => {
    // The root's object is read by the root's id alone: an account's clone is
    // that account's, and the policy it names, insured by another account, is
    // refused for want of it, as before.
    const tables = sourceRows();
    tables['Account'][0]['Main_Policy__c'] = POLICY;
    const fields = {
      ...FIELDS,
      Account: [...FIELDS['Account'], lookup('Main_Policy__c', 'Policy__c')],
    };
    const { deps, inserted, read } = orgs(tables, fields);
    const graph = graphOf(
      [node('Account', 0), node('Policy__c', 1)],
      [edge('Account', 'Policy__c', true), edge('Policy__c', 'Account')],
    );

    const summary = await new ForgeExecutor(deps).execute(graph, 'src', 'tgt', () => undefined, {
      rootRecordId: CUSTOMER,
      rootObjectApiName: 'Account',
    });

    expect(read.has(POLICY)).toBe(true);
    expect(read.has(NAMED_INSURED)).toBe(false);
    expect(inserted['Account'].map((row) => row['Name'])).toEqual(['Customer']);
    expect(summary.errors).toContainEqual(
      expect.objectContaining({ objectApiName: 'Policy__c', stage: 'insert', failedCount: 1 }),
    );
  });

  it('reads nothing more when the record is in the clone already', async () => {
    const tables = sourceRows();
    tables['Policy__c'][0]['Named_Insured__c'] = BROKER;
    const { deps, asked } = orgs(tables);

    await new ForgeExecutor(deps).execute(
      caseGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    expect(statementsOf(asked, 'Account')).toHaveLength(1);
  });
});

describe('ForgeExecutor, a person account a record cannot be written without, not read', () => {
  const PERSON_CONTACT = '003000000000003AAA';
  const CUSTOMER_CONTACT = '003000000000001AAA';
  /** The source's fields, as an org with person accounts describes them. */
  const PERSON_FIELDS: Record<string, FieldInfo[]> = {
    ...FIELDS,
    Account: [
      idField,
      text('Name'),
      text('LastName'),
      readOnly('IsPersonAccount'),
      lookup('PersonContactId', 'Contact', { settable: false }),
    ],
    Contact: [
      idField,
      text('LastName'),
      lookup('AccountId', 'Account'),
      readOnly('IsPersonAccount'),
    ],
    Policy__c: [...FIELDS['Policy__c'], lookup('Insured_Contact__c', 'Contact')],
  };

  /** The named insured a person account, its contact the one the policy names too. */
  function personTables(): Record<string, FakeRow[]> {
    const tables = sourceRows();
    tables['Account'] = [
      {
        Id: CUSTOMER,
        Name: 'Customer',
        LastName: null,
        IsPersonAccount: false,
        PersonContactId: null,
      },
      { Id: BROKER, Name: 'Broker', LastName: null, IsPersonAccount: false, PersonContactId: null },
      {
        Id: NAMED_INSURED,
        Name: 'Jane Doe',
        LastName: 'Doe',
        IsPersonAccount: true,
        PersonContactId: PERSON_CONTACT,
      },
    ];
    tables['Contact'] = [
      { Id: CUSTOMER_CONTACT, LastName: 'Roe', AccountId: CUSTOMER, IsPersonAccount: false },
      { Id: PERSON_CONTACT, LastName: 'Doe', AccountId: NAMED_INSURED, IsPersonAccount: true },
    ];
    tables['Policy__c'][0]['Insured_Contact__c'] = PERSON_CONTACT;
    return tables;
  }

  /** The case's graph, with the contacts of the accounts read before the policy. */
  function personGraph(): ForgeGraph {
    return graphOf(
      [
        node('Case', 0),
        node('Account', 1),
        node('Contact', 2),
        node('Policy__c', 1),
        node('Coverage__c', 2),
      ],
      [
        edge('Account', 'Case'),
        edge('Policy__c', 'Case'),
        edge('Account', 'Contact'),
        { ...edge('Contact', 'Account'), settable: false },
        edge('Account', 'Policy__c', true),
        edge('Contact', 'Policy__c'),
        edge('Policy__c', 'Coverage__c', true),
      ],
    );
  }

  /**
   * The orgs of {@link orgs}, the target with person accounts: it writes the
   * contact of an account sent with a last name, as the platform does, and
   * tells it by the account's `PersonContactId`.
   */
  function personOrgs() {
    const made = orgs(personTables(), PERSON_FIELDS);
    const personContactOf = new Map<string, string>();
    const insert = made.deps.insertRecords;
    made.deps.insertRecords = vi.fn(
      async (org: string, object: string, rows: Record<string, unknown>[]) => {
        const results = await insert(org, object, rows);
        rows.forEach((row, index) => {
          if (
            object === 'Account' &&
            typeof row['LastName'] === 'string' &&
            results[index].success
          ) {
            personContactOf.set(results[index].id, `Contact:${row['LastName']} (the platform's)`);
          }
        });
        return results;
      },
    );
    const query = made.deps.queryRecords;
    made.deps.queryRecords = vi.fn(async (org: string, soql: string) => {
      const asked = /^SELECT Id, PersonContactId FROM Account WHERE Id IN \((.*)\)$/.exec(soql);
      if (org === 'tgt' && asked) {
        return [...asked[1].matchAll(/'([^']+)'/g)].map(([, id]) => ({
          Id: id,
          PersonContactId: personContactOf.get(id) ?? null,
        }));
      }
      return query(org, soql);
    });
    return made;
  }

  it('writes it as a person account and links its contact to the one the platform wrote with it', async () => {
    const { deps, inserted } = personOrgs();

    const summary = await new ForgeExecutor(deps).execute(
      personGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    // Its name the platform computes, as for any person account.
    expect(inserted['Account']).toContainEqual({ LastName: 'Doe' });
    // Never sent: the platform wrote it with the account.
    expect(inserted['Contact'].map((row) => row['LastName'])).toEqual(['Roe']);
    expect(inserted['Policy__c']).toEqual([
      {
        Name: 'Home',
        Named_Insured__c: 'Account:Doe',
        Insured_Contact__c: "Contact:Doe (the platform's)",
      },
    ]);
    expect(summary.errors).toEqual([]);
    expect(summary.withTheirRecordSourceIds).toEqual([PERSON_CONTACT]);
  });

  it('says in a dry run that the platform would write its contact, not that it would insert it', async () => {
    const { deps } = personOrgs();
    const said: string[] = [];

    await new ForgeExecutor(deps).execute(
      personGraph(),
      'src',
      'tgt',
      (event) => said.push(event.message),
      { ...ROOTED_AT_THE_CASE, dryRun: true },
    );

    expect(said).toContain(
      '[dry-run] Contact: 0 more record(s) would be inserted, 1 more would be written by the platform with their person account, under the Account records read after it',
    );
  });
});
