import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  InsertResult,
} from './ForgeExecutor.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * An org with person accounts. The platform writes a person account's contact
 * itself as it takes the account, and links the two by the account's
 * PersonContactId — a field neither an insert nor an update can set: a contact
 * sent on its own is never that one. A clone reads the contact with the
 * account, never sends it, and points what points at it at the one the
 * platform wrote.
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
const lookup = (name: string, target: string, settable = true): FieldInfo => ({
  name,
  queryable: true,
  createable: settable,
  updateable: settable,
  isReference: true,
  referenceTo: [target],
  nillable: true,
});

/** The source's fields, as an org with person accounts describes them. */
const FIELDS: Record<string, FieldInfo[]> = {
  Account: [
    idField,
    text('Name'),
    text('LastName'),
    readOnly('IsPersonAccount'),
    lookup('PersonContactId', 'Contact', false),
    lookup('Key_Contact__c', 'Contact'),
  ],
  Contact: [idField, text('LastName'), lookup('AccountId', 'Account'), readOnly('IsPersonAccount')],
  Case: [idField, text('Subject'), lookup('AccountId', 'Account'), lookup('ContactId', 'Contact')],
};

/** A fake id of `prefix` whose first twelve characters tell it apart. */
const fakeId = (prefix: string, n: number): string =>
  `${prefix}Fk${String(n).padStart(7, '0')}SrCIA`;

const PERSON = fakeId('001', 1);
const BUSINESS = fakeId('001', 2);
const PERSON_CONTACT = fakeId('003', 1);
const CONTACT = fakeId('003', 2);
const CASE = fakeId('500', 1);

/** A person account, a business account, the contact of each, and a case on the person. */
const SOURCE: Record<string, Record<string, unknown>[]> = {
  Account: [
    {
      Id: PERSON,
      Name: 'Jane Doe',
      LastName: 'Doe',
      IsPersonAccount: true,
      PersonContactId: PERSON_CONTACT,
      Key_Contact__c: null,
    },
    {
      Id: BUSINESS,
      Name: 'Acme',
      LastName: null,
      IsPersonAccount: false,
      PersonContactId: null,
      Key_Contact__c: CONTACT,
    },
  ],
  Contact: [
    { Id: PERSON_CONTACT, LastName: 'Doe', AccountId: PERSON, IsPersonAccount: true },
    { Id: CONTACT, LastName: 'Roe', AccountId: BUSINESS, IsPersonAccount: false },
  ],
  Case: [{ Id: CASE, Subject: 'Help', AccountId: PERSON, ContactId: PERSON_CONTACT }],
};

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 2,
    fieldCount: 5,
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

const edge = (
  parent: string,
  child: string,
  relationshipName: string,
  more: Partial<ForgeGraphEdge> = {},
): ForgeGraphEdge => ({
  sourceObject: parent,
  targetObject: child,
  relationshipName,
  type: 'lookup',
  ...more,
});

function graphOf(nodes: ForgeGraphNode[], edges: ForgeGraphEdge[]): ForgeGraph {
  return { nodes, edges, totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0 };
}

/**
 * The graph discovery builds around the case, the contact met before the
 * account: the account's lookup at its contact is one no write sets.
 */
const CASE_GRAPH = graphOf(
  [node('Case', 0), node('Contact', 1), node('Account', 1)],
  [
    edge('Account', 'Case', 'Account'),
    edge('Contact', 'Case', 'Contact'),
    edge('Account', 'Contact', 'Contacts'),
    edge('Contact', 'Account', 'PersonContact', { settable: false }),
  ],
);

const ROOTED_AT_THE_CASE = { rootRecordId: CASE, rootObjectApiName: 'Case' };

/** A record the target already held, named by a refusal: fifteen characters, as a message gives it. */
const HELD_ACCOUNT = '001Fk00000HeLdA';

/** What else the orgs of {@link orgsWithPersonAccounts} hold. */
interface PersonAccountOrgs {
  /** The objects' fields in both orgs; {@link FIELDS} when left out. */
  fields?: Record<string, FieldInfo[]>;
  /** The target's record types of the account, each with its `IsPersonType`. */
  recordTypes?: Record<string, unknown>[];
  /** What the target says of an object's record types, for the user the run writes as. */
  describeObject?: ForgeExecutorDeps['describeObject'];
}

/**
 * A source org holding {@link SOURCE}, and a target that creates what it is
 * sent and, for an account sent as a person — its last name and no company
 * name — writes the contact of it too, as the platform does.
 *
 * @param refuse - The answer the target gives a row instead of creating it.
 * @param source - The source's rows, by object.
 * @param orgs - What else the orgs hold.
 */
function orgsWithPersonAccounts(
  refuse?: (object: string, row: Record<string, unknown>) => InsertResult | undefined,
  source: Record<string, Record<string, unknown>[]> = SOURCE,
  { fields = FIELDS, recordTypes = [], describeObject }: PersonAccountOrgs = {},
) {
  let created = 0;
  const newId = (prefix: string): string => `${prefix}Tg${String(created++).padStart(13, '0')}`;
  const inserted: Array<{ object: string; rows: Record<string, unknown>[] }> = [];
  const updated: Array<{ object: string; rows: Record<string, unknown>[] }> = [];
  /** The contact the target wrote with each person account it holds, by the account's first fifteen characters. */
  const personContactOf = new Map<string, string>([
    [HELD_ACCOUNT, `003Tg${'HELD'.padStart(13, '0')}`],
  ]);
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => fields[object] ?? [idField]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org === 'src') {
        const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
        return (source[object] ?? []).map((row) => ({ ...row }));
      }
      if (soql.startsWith('SELECT Id, IsPersonType FROM RecordType')) {
        return recordTypes.map((row) => ({ ...row }));
      }
      const asked = /^SELECT Id, PersonContactId FROM Account WHERE Id IN \((.*)\)$/.exec(soql);
      if (!asked) return [];
      return [...asked[1].matchAll(/'([^']+)'/g)].map(([, id]) => ({
        Id: id,
        PersonContactId: personContactOf.get(id.slice(0, 15)) ?? null,
      }));
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      inserted.push({ object, rows });
      return rows.map((row): InsertResult => {
        const refused = refuse?.(object, row);
        if (refused) return refused;
        const id = newId(object.slice(0, 3).toUpperCase());
        if (object === 'Account' && typeof row['LastName'] === 'string') {
          personContactOf.set(id.slice(0, 15), newId('003'));
        }
        return { id, success: true, errors: [] };
      });
    }),
    updateRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      updated.push({ object, rows });
      return rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] }));
    }),
    ...(describeObject ? { describeObject } : {}),
  } satisfies ForgeExecutorDeps;
  return { executor: new ForgeExecutor(deps), deps, inserted, updated, personContactOf };
}

/**
 * A source org holding `rows`, described by `fields`, and a target that
 * creates what it is sent.
 *
 * @param unreadable - An object whose read from the source fails.
 */
function plainOrgs(
  fields: Record<string, FieldInfo[]>,
  rows: Record<string, Record<string, unknown>[]>,
  unreadable?: string,
) {
  let created = 0;
  const inserted: Array<{ object: string; rows: Record<string, unknown>[] }> = [];
  const updateRecords = vi.fn(
    async (_org: string, _object: string, sent: Record<string, unknown>[]) =>
      sent.map((row) => ({ id: String(row['Id']), success: true, errors: [] })),
  );
  const executor = new ForgeExecutor({
    describeFields: vi.fn(async (_org: string, object: string) => fields[object] ?? [idField]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
      if (object === unreadable) throw new Error('INVALID_TYPE');
      return (rows[object] ?? []).map((row) => ({ ...row }));
    }),
    insertRecords: vi.fn(async (_org: string, object: string, sent: Record<string, unknown>[]) => {
      inserted.push({ object, rows: sent });
      return sent.map(() => ({
        id: `${object.slice(0, 3)}Tg${String(created++).padStart(13, '0')}`,
        success: true,
        errors: [],
      }));
    }),
    updateRecords,
  } satisfies ForgeExecutorDeps);
  return { executor, inserted, updateRecords };
}

/** The last line each object ended on. */
function lastLines(events: readonly ForgeProgressEvent[]): Map<string, string> {
  const lines = new Map<string, string>();
  for (const event of events) lines.set(event.objectName, event.message);
  return lines;
}

describe('ForgeExecutor, person accounts', () => {
  it("never sends a person account's contact, and points what pointed at it at the one the platform wrote with the account", async () => {
    // Run for real in an org with person accounts, the contacts went in
    // before the accounts: the account's lookup at its contact, which no
    // write sets, made the contact the account's parent.
    const { executor, inserted, updated, personContactOf } = orgsWithPersonAccounts();
    const events: ForgeProgressEvent[] = [];

    const summary = await executor.execute(
      CASE_GRAPH,
      'src',
      'tgt',
      (e) => events.push(e),
      ROOTED_AT_THE_CASE,
    );

    const person = summary.remapTable[PERSON];
    const platformContact = personContactOf.get(person.slice(0, 15));
    expect(inserted.map(({ object }) => object)).toEqual(['Account', 'Contact', 'Case']);
    expect(inserted.find(({ object }) => object === 'Contact')?.rows).toEqual([
      { LastName: 'Roe', AccountId: summary.remapTable[BUSINESS] },
    ]);
    expect(inserted.find(({ object }) => object === 'Case')?.rows).toEqual([
      { Subject: 'Help', AccountId: person, ContactId: platformContact },
    ]);
    expect(summary.remapTable[PERSON_CONTACT]).toBe(platformContact);
    // Linked, as a record the run did not create: no removal of the run's
    // records deletes it on its own; it goes with its account.
    expect(summary.existingSourceIds).toContain(PERSON_CONTACT);
    expect(summary.createdByObject.find((o) => o.objectApiName === 'Contact')?.sourceIds).toEqual([
      CONTACT,
    ]);
    expect(summary.linkedCount).toBe(1);
    expect(summary.existingRecords).toEqual([
      { objectApiName: 'Contact', linked: 1, unidentified: 0 },
    ]);
    // The account's lookup at its contact is owed nothing: the platform
    // refuses an update of it.
    expect(updated.flatMap(({ rows }) => rows).some((row) => 'PersonContactId' in row)).toBe(false);
    expect(summary.errors).toEqual([]);
    expect(lastLines(events).get('Contact')).toBe(
      'Completed Contact: 1 succeeded, 1 written by the platform with their person account, 0 failed',
    );
  });

  it('writes the person accounts before the contacts even when an account’s key contact makes a cycle of the two', async () => {
    // The account's key contact can be set, so the pair orders the write,
    // and the graph's order would put the contacts first: the platform's
    // contacts would not be there yet to link the person's to.
    const { executor, inserted, updated, personContactOf } = orgsWithPersonAccounts();
    const graph = graphOf(
      [node('Case', 0), node('Contact', 1), node('Account', 1)],
      [
        edge('Account', 'Case', 'Account'),
        edge('Contact', 'Case', 'Contact'),
        edge('Account', 'Contact', 'Contacts'),
        edge('Contact', 'Account', 'Key_Contact__r'),
      ],
    );

    const summary = await executor.execute(
      graph,
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    expect(inserted.map(({ object }) => object)).toEqual(['Account', 'Contact', 'Case']);
    expect(summary.remapTable[PERSON_CONTACT]).toBe(
      personContactOf.get(summary.remapTable[PERSON].slice(0, 15)),
    );
    // The business account's key contact, written after it, is filled in
    // by the second pass; the person's contact owes it nothing.
    expect(updated.flatMap(({ object, rows }) => rows.map((row) => [object, row]))).toEqual([
      [
        'Account',
        { Id: summary.remapTable[BUSINESS], Key_Contact__c: summary.remapTable[CONTACT] },
      ],
    ]);
  });

  it('links the contact of a person account the target already held, found by the refusal of its copy', async () => {
    const { executor, inserted, personContactOf } = orgsWithPersonAccounts((object, row) =>
      object === 'Account' && row['LastName'] === 'Doe'
        ? {
            id: '',
            success: false,
            errors: [
              `DUPLICATE_VALUE: duplicate value found: Ext__c duplicates value on record with id: ${HELD_ACCOUNT}`,
            ],
          }
        : undefined,
    );

    const summary = await executor.execute(
      CASE_GRAPH,
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    const heldContact = personContactOf.get(HELD_ACCOUNT);
    expect(summary.remapTable[PERSON].slice(0, 15)).toBe(HELD_ACCOUNT);
    expect(summary.remapTable[PERSON_CONTACT]).toBe(heldContact);
    expect(inserted.find(({ object }) => object === 'Case')?.rows[0]?.['ContactId']).toBe(
      heldContact,
    );
    expect(
      inserted
        .filter(({ object }) => object === 'Contact')
        .flatMap(({ rows }) => rows)
        .map((row) => row['LastName']),
    ).toEqual(['Roe']);
  });

  it('holds back the contact of a person account the run did not write, and counts it as failed with why', async () => {
    const { executor, inserted } = orgsWithPersonAccounts((object, row) =>
      object === 'Account' && row['LastName'] === 'Doe'
        ? {
            id: '',
            success: false,
            errors: ['REQUIRED_FIELD_MISSING: Required fields are missing'],
          }
        : undefined,
    );
    const events: ForgeProgressEvent[] = [];

    const summary = await executor.execute(
      CASE_GRAPH,
      'src',
      'tgt',
      (e) => events.push(e),
      ROOTED_AT_THE_CASE,
    );

    expect(
      inserted
        .filter(({ object }) => object === 'Contact')
        .flatMap(({ rows }) => rows)
        .map((row) => row['LastName']),
    ).toEqual(['Roe']);
    expect(summary.remapTable[PERSON_CONTACT]).toBeUndefined();
    expect(summary.errors).toContainEqual({
      objectApiName: 'Contact',
      stage: 'scope',
      failedCount: 1,
      attemptedCount: 0,
      samples: [
        {
          recordSummary: 'IsPersonAccount=true (1 record)',
          messages: [
            "Not written: a person account's contact goes in with its account, which this run did not write.",
          ],
        },
      ],
    });
    expect(lastLines(events).get('Contact')).toBe(
      "Completed Contact: 1 succeeded, 1 failed, 1 of them not sent: a person account's contact " +
        'goes in with its account, which this run did not write',
    );
  });

  it('holds the contact node back whole when every row is the contact of a person account the target does not have', async () => {
    // Nothing of the contacts is in the target: what cannot be written
    // without one is skipped, as behind a parent that failed.
    const { executor, inserted } = orgsWithPersonAccounts(
      (object, row) =>
        object === 'Account' && row['LastName'] === 'Doe'
          ? {
              id: '',
              success: false,
              errors: ['REQUIRED_FIELD_MISSING: Required fields are missing'],
            }
          : undefined,
      { ...SOURCE, Contact: SOURCE.Contact.filter((row) => row['Id'] === PERSON_CONTACT) },
    );
    const events: ForgeProgressEvent[] = [];

    await executor.execute(CASE_GRAPH, 'src', 'tgt', (e) => events.push(e), ROOTED_AT_THE_CASE);

    expect(inserted.some(({ object }) => object === 'Contact')).toBe(false);
    const contactLine = events.filter((e) => e.objectName === 'Contact').at(-1);
    expect(contactLine?.status).toBe('error');
    expect(contactLine?.message).toBe(
      "Held back Contact, nothing written, 1 failed: every record is a person account's contact, " +
        'which the platform writes with its account, and the run has none of them in the target. ' +
        'Objects that cannot be written without it will be skipped.',
    );
  });

  it('writes the accounts when the contacts fail, whatever kind of edge their lookup at them has', async () => {
    // Should a describe give the account's lookup at its contact as cascading
    // on delete, the edge reads master-detail; no write sets the field all the
    // same, and the contacts failing takes nothing from the accounts.
    const { executor, deps, inserted } = orgsWithPersonAccounts();
    const read = deps.queryRecords.getMockImplementation();
    deps.queryRecords.mockImplementation(async (org: string, soql: string) => {
      if (org === 'src' && /FROM Contact\b/.test(soql)) throw new Error('INVALID_QUERY_LOCATOR');
      return read ? read(org, soql) : [];
    });
    // No key contact here: a lookup at the contacts a write can set orders the
    // pair, as it should, and the edge's kind with it.
    deps.describeFields.mockImplementation(async (_org: string, object: string) =>
      object === 'Account'
        ? FIELDS.Account.filter((f) => f.name !== 'Key_Contact__c')
        : (FIELDS[object] ?? [idField]),
    );
    const graph = graphOf(CASE_GRAPH.nodes, [
      ...CASE_GRAPH.edges.filter((e) => e.relationshipName !== 'PersonContact'),
      edge('Contact', 'Account', 'PersonContact', { type: 'master-detail', settable: false }),
    ]);

    const summary = await executor.execute(
      graph,
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    expect(summary.failedReads).toEqual(['Contact']);
    expect(
      inserted
        .filter(({ object }) => object === 'Account')
        .flatMap(({ rows }) => rows)
        .map((row) => row['LastName'] ?? row['Name']),
    ).toEqual(['Doe', 'Acme']);
  });

  it('links the contacts of person accounts in a run of whole tables, whatever order the graph met them in', async () => {
    // A graph kept from before discovery marked the lookup: the account's
    // fields, described before the run reads anything, say no write sets it,
    // and that the org has person accounts.
    const { executor, inserted, personContactOf } = orgsWithPersonAccounts();
    const graph = graphOf(
      [node('Contact', 0), node('Account', 0)],
      [edge('Account', 'Contact', 'Contacts'), edge('Contact', 'Account', 'PersonContact')],
    );

    const summary = await executor.execute(graph, 'src', 'tgt', () => undefined);

    expect(inserted.map(({ object }) => object)).toEqual(['Account', 'Contact']);
    expect(inserted.find(({ object }) => object === 'Contact')?.rows).toEqual([
      { LastName: 'Roe', AccountId: summary.remapTable[BUSINESS] },
    ]);
    expect(summary.remapTable[PERSON_CONTACT]).toBe(
      personContactOf.get(summary.remapTable[PERSON].slice(0, 15)),
    );
  });

  it('takes no order from a lookup the fields say no write sets, where the graph does not say it', async () => {
    // A converted lead names its account, and the platform alone fills that
    // lookup; the account names the lead it came from, which a write sets.
    // A graph kept from before discovery marked such lookups made a cycle of
    // the two, broken by the graph's order: the account first, its lookup at
    // the lead left for the second pass.
    const LEAD = fakeId('00Q', 1);
    const fields: Record<string, FieldInfo[]> = {
      Account: [idField, text('Name'), lookup('Origin_Lead__c', 'Lead')],
      Lead: [
        idField,
        text('LastName'),
        text('Company'),
        lookup('ConvertedAccountId', 'Account', false),
      ],
    };
    const { executor, inserted, updateRecords } = plainOrgs(fields, {
      Account: [{ Id: BUSINESS, Name: 'Acme', Origin_Lead__c: LEAD }],
      Lead: [{ Id: LEAD, LastName: 'Roe', Company: 'Acme', ConvertedAccountId: BUSINESS }],
    });
    const graph = graphOf(
      [node('Account', 0), node('Lead', 1)],
      [edge('Account', 'Lead', 'ConvertedAccount'), edge('Lead', 'Account', 'Origin_Lead__r')],
    );

    const summary = await executor.execute(graph, 'src', 'tgt', () => undefined, {
      rootRecordId: BUSINESS,
      rootObjectApiName: 'Account',
    });

    expect(inserted.map(({ object }) => object)).toEqual(['Lead', 'Account']);
    expect(inserted[1].rows).toEqual([{ Name: 'Acme', Origin_Lead__c: summary.remapTable[LEAD] }]);
    expect(updateRecords).not.toHaveBeenCalled();
  });

  it('takes no order from a lookup no write sets, required as its field reads', async () => {
    // Filled by the platform alone and never empty, as a record's creator is:
    // the line never carries it, and so never waits for the header through it.
    const HEADER = fakeId('a01', 1);
    const LINE = fakeId('a02', 1);
    const { executor, inserted, updateRecords } = plainOrgs(
      {
        Header__c: [idField, text('Name'), lookup('Last_Line__c', 'Line__c')],
        Line__c: [
          idField,
          text('Name'),
          { ...lookup('Stamped_By__c', 'Header__c', false), nillable: false },
        ],
      },
      {
        Header__c: [{ Id: HEADER, Name: 'H', Last_Line__c: LINE }],
        Line__c: [{ Id: LINE, Name: 'L', Stamped_By__c: HEADER }],
      },
    );
    const graph = graphOf(
      [node('Header__c', 0), node('Line__c', 1)],
      [edge('Header__c', 'Line__c', 'Lines__r'), edge('Line__c', 'Header__c', 'Last_Line__r')],
    );

    const summary = await executor.execute(graph, 'src', 'tgt', () => undefined, {
      rootRecordId: HEADER,
      rootObjectApiName: 'Header__c',
    });

    expect(inserted.map(({ object }) => object)).toEqual(['Line__c', 'Header__c']);
    expect(inserted[1].rows).toEqual([{ Name: 'H', Last_Line__c: summary.remapTable[LINE] }]);
    expect(updateRecords).not.toHaveBeenCalled();
  });

  it('writes the rows of an object whose lookup no write sets names one that failed', async () => {
    // The header's read fails. The line cannot carry its stamp whatever the
    // header does, so nothing of the line is lost with it.
    const HEADER = fakeId('a01', 1);
    const LINE = fakeId('a02', 1);
    const { executor, inserted } = plainOrgs(
      {
        Header__c: [idField, text('Name')],
        Line__c: [
          idField,
          text('Name'),
          { ...lookup('Stamped_By__c', 'Header__c', false), nillable: false },
        ],
      },
      { Line__c: [{ Id: LINE, Name: 'L', Stamped_By__c: HEADER }] },
      'Header__c',
    );
    const graph = graphOf(
      [node('Header__c', 0), node('Line__c', 1)],
      [edge('Header__c', 'Line__c', 'Lines__r')],
    );

    const summary = await executor.execute(graph, 'src', 'tgt', () => undefined);

    expect(summary.failedReads).toEqual(['Header__c']);
    expect(inserted).toEqual([{ object: 'Line__c', rows: [{ Name: 'L' }] }]);
  });

  it('counts the contact the platform wrote with an account the run created as going with it, never as kept', async () => {
    // Linked, it read as a record a removal of the run's records keeps; the
    // platform deletes it with its account, and refuses its delete on its own.
    const { executor } = orgsWithPersonAccounts();

    const summary = await executor.execute(
      CASE_GRAPH,
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    expect(summary.existingSourceIds).toContain(PERSON_CONTACT);
    expect(summary.withTheirRecordSourceIds).toEqual([PERSON_CONTACT]);
  });

  it('counts the contact of a person account the target already held as kept', async () => {
    const { executor } = orgsWithPersonAccounts((object, row) =>
      object === 'Account' && row['LastName'] === 'Doe'
        ? {
            id: '',
            success: false,
            errors: [
              `DUPLICATE_VALUE: duplicate value found: Ext__c duplicates value on record with id: ${HELD_ACCOUNT}`,
            ],
          }
        : undefined,
    );

    const summary = await executor.execute(
      CASE_GRAPH,
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_CASE,
    );

    expect(summary.existingSourceIds).toContain(PERSON_CONTACT);
    expect(summary.withTheirRecordSourceIds).toBeUndefined();
  });

  describe('a target that writes no contact with the account', () => {
    /** A business account the target already held, with no contact of the platform's. */
    const HELD_BUSINESS = '001Fk00000BuSyA';

    it('sends the contact of a person account it holds as a business one as a contact of that account', async () => {
      // The copy refused as a duplicate of a business account: the platform
      // wrote no contact with it. Held back, the contact was lost, and the
      // case's lookup at it with it.
      const { executor, inserted, deps } = orgsWithPersonAccounts((object, row) =>
        object === 'Account' && row['LastName'] === 'Doe'
          ? {
              id: '',
              success: false,
              errors: [
                `DUPLICATE_VALUE: duplicate value found: Ext__c duplicates value on record with id: ${HELD_BUSINESS}`,
              ],
            }
          : undefined,
      );
      const events: ForgeProgressEvent[] = [];

      const summary = await executor.execute(
        CASE_GRAPH,
        'src',
        'tgt',
        (e) => events.push(e),
        ROOTED_AT_THE_CASE,
      );

      const business = summary.remapTable[PERSON];
      expect(business.slice(0, 15)).toBe(HELD_BUSINESS);
      expect(inserted.find(({ object }) => object === 'Contact')?.rows).toEqual([
        { LastName: 'Doe', AccountId: business },
        { LastName: 'Roe', AccountId: summary.remapTable[BUSINESS] },
      ]);
      expect(inserted.find(({ object }) => object === 'Case')?.rows).toEqual([
        { Subject: 'Help', AccountId: business, ContactId: summary.remapTable[PERSON_CONTACT] },
      ]);
      // Created by the run, as any contact it writes.
      expect(summary.existingSourceIds).not.toContain(PERSON_CONTACT);
      // Asked once which contact the platform wrote with the account: none.
      expect(
        deps.queryRecords.mock.calls.filter(
          ([org, soql]) => org === 'tgt' && soql.includes('PersonContactId'),
        ),
      ).toHaveLength(1);
      expect(lastLines(events).get('Contact')).toBe(
        "Completed Contact: 2 succeeded, 0 failed, 1 person account's contact sent on their own: " +
          'the target wrote none with their account',
      );
      expect(summary.errors).toContainEqual({
        objectApiName: 'Contact',
        stage: 'scope',
        failedCount: 0,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: 'IsPersonAccount=true (1 record)',
            messages: [
              'Sent as contacts of their own: their account is no person account in the target, ' +
                'and wrote no contact with it.',
            ],
          },
        ],
      });
    });

    /**
     * The source's person accounts, and a target that has none: its account has
     * no PersonContactId, nor a computed name, and it refuses a statement that
     * asks for the field and an account sent without a name, as the platform
     * does.
     */
    function orgsWithoutPersonAccountsInTheTarget() {
      const targetFields: Record<string, FieldInfo[]> = {
        Account: [idField, text('Name'), lookup('Key_Contact__c', 'Contact')],
        Contact: [idField, text('LastName'), lookup('AccountId', 'Account')],
        Case: FIELDS.Case,
      };
      let created = 0;
      const inserted: Array<{ object: string; rows: Record<string, unknown>[] }> = [];
      const targetQueries: string[] = [];
      const executor = new ForgeExecutor({
        describeFields: vi.fn(
          async (org: string, object: string) =>
            (org === 'src' ? FIELDS : targetFields)[object] ?? [idField],
        ),
        queryRecords: vi.fn(async (org: string, soql: string) => {
          if (org === 'src') {
            const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
            return (SOURCE[object] ?? []).map((row) => ({ ...row }));
          }
          targetQueries.push(soql);
          if (soql.includes('PersonContactId')) {
            throw new Error("INVALID_FIELD: No such column 'PersonContactId' on entity 'Account'");
          }
          return [];
        }),
        insertRecords: vi.fn(
          async (_org: string, object: string, rows: Record<string, unknown>[]) => {
            inserted.push({ object, rows });
            return rows.map((row): InsertResult =>
              object === 'Account' && typeof row['Name'] !== 'string'
                ? {
                    id: '',
                    success: false,
                    errors: ['REQUIRED_FIELD_MISSING: Required fields are missing: [Name]'],
                  }
                : {
                    id: `${object.slice(0, 3).toUpperCase()}Tg${String(created++).padStart(13, '0')}`,
                    success: true,
                    errors: [],
                  },
            );
          },
        ),
        updateRecords: vi.fn(
          async (_org: string, _object: string, rows: Record<string, unknown>[]) =>
            rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] })),
        ),
      } satisfies ForgeExecutorDeps);
      return { executor, inserted, targetQueries };
    }

    it('writes a person account as a business one by its name in a target without person accounts, and its contact as one of its own, asking no contact of it', async () => {
      // The target's account has no PersonContactId, and asked for one it
      // refused the statement. Left out as a person account's is, the name
      // the target needs cost the account, and the contact with it.
      const { executor, inserted, targetQueries } = orgsWithoutPersonAccountsInTheTarget();
      const events: ForgeProgressEvent[] = [];

      const summary = await executor.execute(
        CASE_GRAPH,
        'src',
        'tgt',
        (e) => events.push(e),
        ROOTED_AT_THE_CASE,
      );

      expect(inserted.find(({ object }) => object === 'Account')?.rows).toEqual([
        { Name: 'Jane Doe' },
        { Name: 'Acme' },
      ]);
      expect(inserted.find(({ object }) => object === 'Contact')?.rows).toEqual([
        { LastName: 'Doe', AccountId: summary.remapTable[PERSON] },
        { LastName: 'Roe', AccountId: summary.remapTable[BUSINESS] },
      ]);
      expect(inserted.find(({ object }) => object === 'Case')?.rows[0]?.['ContactId']).toBe(
        summary.remapTable[PERSON_CONTACT],
      );
      expect(targetQueries.some((soql) => soql.includes('PersonContactId'))).toBe(false);
      expect(summary.failedCount).toBe(0);
      expect(lastLines(events).get('Contact')).toBe(
        "Completed Contact: 2 succeeded, 0 failed, 1 person account's contact sent on their own: " +
          'the target wrote none with their account',
      );
      expect(summary.errors).toContainEqual(
        expect.objectContaining({
          objectApiName: 'Contact',
          samples: [
            {
              recordSummary: 'IsPersonAccount=true (1 record)',
              messages: [
                'Sent as contacts of their own: the target has no person accounts, and wrote no ' +
                  'contact with it.',
              ],
            },
          ],
        }),
      );
    });

    describe("a person account whose record type in the target is a business account's", () => {
      const SOURCE_TYPE = fakeId('012', 1);
      const PERSON_TYPE = '012Tg0000000PeRAAA';
      const BUSINESS_TYPE = '012Tg0000000BuSAAA';
      /** The target's record types of the account. */
      const RECORD_TYPES = [
        { Id: PERSON_TYPE, IsPersonType: true },
        { Id: BUSINESS_TYPE, IsPersonType: false },
      ];
      const TYPED_FIELDS: Record<string, FieldInfo[]> = {
        ...FIELDS,
        Account: [...FIELDS.Account, text('PersonEmail'), lookup('RecordTypeId', 'RecordType')],
      };
      /** The source, its person account of a record type the mapping knows. */
      const TYPED_SOURCE = {
        ...SOURCE,
        Account: SOURCE.Account.map((row) =>
          row['Id'] === PERSON
            ? { ...row, PersonEmail: 'person@example.com', RecordTypeId: SOURCE_TYPE }
            : { ...row, PersonEmail: null, RecordTypeId: null },
        ),
      };
      /** The platform's refusal of an account of no person record type sent without its name. */
      const refusedWithoutName = (
        object: string,
        row: Record<string, unknown>,
      ): InsertResult | undefined =>
        object === 'Account' && row['RecordTypeId'] !== PERSON_TYPE && !row['Name']
          ? {
              id: '',
              success: false,
              errors: ['REQUIRED_FIELD_MISSING: Required fields are missing: [Name]'],
            }
          : undefined;
      const mappedTo = (targetId: string) => ({
        ...ROOTED_AT_THE_CASE,
        recordTypeMappings: [{ sourceId: SOURCE_TYPE, targetId, developerName: 'Retail' }],
      });
      /** A record type of the account as the user the run writes as sees it. */
      const recordType = (recordTypeId: string, defaultRecordTypeMapping: boolean) => ({
        recordTypeId,
        developerName: recordTypeId === PERSON_TYPE ? 'Person' : 'Retail',
        name: recordTypeId === PERSON_TYPE ? 'Person' : 'Retail',
        available: true,
        active: true,
        master: false,
        defaultRecordTypeMapping,
      });

      it('writes it as a business account by its name, and its contact as one of its own', async () => {
        // Sent as a person account — without its name, with its person
        // fields — the target refused it, and its contact went with it.
        const { executor, inserted, deps } = orgsWithPersonAccounts(
          refusedWithoutName,
          TYPED_SOURCE,
          { fields: TYPED_FIELDS, recordTypes: RECORD_TYPES },
        );
        const events: ForgeProgressEvent[] = [];

        const summary = await executor.execute(
          CASE_GRAPH,
          'src',
          'tgt',
          (e) => events.push(e),
          mappedTo(BUSINESS_TYPE),
        );

        expect(inserted.find(({ object }) => object === 'Account')?.rows).toEqual([
          { Name: 'Jane Doe', RecordTypeId: BUSINESS_TYPE },
          { Name: 'Acme' },
        ]);
        expect(inserted.find(({ object }) => object === 'Contact')?.rows).toEqual([
          { LastName: 'Doe', AccountId: summary.remapTable[PERSON] },
          { LastName: 'Roe', AccountId: summary.remapTable[BUSINESS] },
        ]);
        expect(inserted.find(({ object }) => object === 'Case')?.rows[0]?.['ContactId']).toBe(
          summary.remapTable[PERSON_CONTACT],
        );
        expect(summary.failedCount).toBe(0);
        // The target's record types are read once a run.
        expect(
          deps.queryRecords.mock.calls.filter(([, soql]) => soql.includes('FROM RecordType')),
        ).toHaveLength(1);
        expect(lastLines(events).get('Contact')).toBe(
          "Completed Contact: 2 succeeded, 0 failed, 1 person account's contact sent on their own: " +
            'the target wrote none with their account',
        );
      });

      it("writes one whose record type there is a person account's as a person account, as before", async () => {
        const { executor, inserted, personContactOf } = orgsWithPersonAccounts(
          refusedWithoutName,
          TYPED_SOURCE,
          { fields: TYPED_FIELDS, recordTypes: RECORD_TYPES },
        );

        const summary = await executor.execute(
          CASE_GRAPH,
          'src',
          'tgt',
          () => undefined,
          mappedTo(PERSON_TYPE),
        );

        expect(inserted.find(({ object }) => object === 'Account')?.rows[0]).toEqual({
          LastName: 'Doe',
          PersonEmail: 'person@example.com',
          RecordTypeId: PERSON_TYPE,
        });
        expect(summary.remapTable[PERSON_CONTACT]).toBe(
          personContactOf.get(summary.remapTable[PERSON].slice(0, 15)),
        );
        expect(summary.failedCount).toBe(0);
      });

      it("takes the running user's default record type for one written without its record type", async () => {
        const { executor, inserted } = orgsWithPersonAccounts(refusedWithoutName, TYPED_SOURCE, {
          fields: TYPED_FIELDS,
          recordTypes: RECORD_TYPES,
          describeObject: async (_org, object) => ({
            keyPrefix: null,
            recordTypes:
              object === 'Account'
                ? [recordType(BUSINESS_TYPE, true), recordType(PERSON_TYPE, false)]
                : [],
          }),
        });

        const summary = await executor.execute(CASE_GRAPH, 'src', 'tgt', () => undefined, {
          ...mappedTo(PERSON_TYPE),
          fieldExclusions: { Account: ['RecordTypeId'] },
        });

        expect(inserted.find(({ object }) => object === 'Account')?.rows).toEqual([
          { Name: 'Jane Doe' },
          { Name: 'Acme' },
        ]);
        expect(summary.failedCount).toBe(0);
      });

      it('says on a dry run that reads the account first that its contact would be inserted', async () => {
        // A run of whole tables writes, and reads, the accounts before the
        // contacts. One that reads the contact first — its case before its
        // account — has no account to tell by, and says the platform would
        // write it.
        const { executor, inserted } = orgsWithPersonAccounts(refusedWithoutName, TYPED_SOURCE, {
          fields: TYPED_FIELDS,
          recordTypes: RECORD_TYPES,
        });
        const events: ForgeProgressEvent[] = [];

        const summary = await executor.execute(CASE_GRAPH, 'src', 'tgt', (e) => events.push(e), {
          recordTypeMappings: mappedTo(BUSINESS_TYPE).recordTypeMappings,
          dryRun: true,
        });

        expect(inserted).toEqual([]);
        // Two accounts, two contacts and the case.
        expect(summary.wouldInsertCount).toBe(5);
        expect(lastLines(events).get('Contact')).toBe(
          '[dry-run] Contact: 2 record(s) would be inserted',
        );
      });

      it('says no contact was sent on its own when the contact node is held back whole', async () => {
        // Said before the write, the note told of contacts sent from a node
        // whose every row was then held back, none of them sent.
        const SOURCE_CONTACT_TYPE = fakeId('012', 2);
        const CLOSED_CONTACT_TYPE = '012Tg0000000CoNAAA';
        const { executor, inserted } = orgsWithPersonAccounts(
          refusedWithoutName,
          {
            ...TYPED_SOURCE,
            Contact: SOURCE.Contact.map((row) => ({ ...row, RecordTypeId: SOURCE_CONTACT_TYPE })),
          },
          {
            fields: {
              ...TYPED_FIELDS,
              Contact: [...FIELDS.Contact, lookup('RecordTypeId', 'RecordType')],
            },
            recordTypes: RECORD_TYPES,
            describeObject: async (_org, object) => ({
              keyPrefix: null,
              recordTypes:
                object === 'Account'
                  ? [recordType(BUSINESS_TYPE, true), recordType(PERSON_TYPE, false)]
                  : [{ ...recordType(CLOSED_CONTACT_TYPE, true), available: false }],
            }),
          },
        );
        const events: ForgeProgressEvent[] = [];

        const summary = await executor.execute(CASE_GRAPH, 'src', 'tgt', (e) => events.push(e), {
          ...ROOTED_AT_THE_CASE,
          recordTypeMappings: [
            { sourceId: SOURCE_TYPE, targetId: BUSINESS_TYPE, developerName: 'Retail' },
            {
              sourceId: SOURCE_CONTACT_TYPE,
              targetId: CLOSED_CONTACT_TYPE,
              developerName: 'Retail',
            },
          ],
        });

        expect(inserted.some(({ object }) => object === 'Contact')).toBe(false);
        expect(lastLines(events).get('Contact')).toMatch(/^Held back Contact, nothing written/);
        expect(
          summary.errors.flatMap(({ samples }) => samples.flatMap(({ messages }) => messages)),
        ).not.toContainEqual(expect.stringContaining('Sent as contacts of their own'));
      });
    });

    it('says on a dry run that the contact of a person account would be inserted in a target without person accounts', async () => {
      const { executor, inserted } = orgsWithoutPersonAccountsInTheTarget();
      const events: ForgeProgressEvent[] = [];

      const summary = await executor.execute(CASE_GRAPH, 'src', 'tgt', (e) => events.push(e), {
        ...ROOTED_AT_THE_CASE,
        dryRun: true,
      });

      expect(inserted).toEqual([]);
      expect(summary.wouldInsertCount).toBe(5);
      expect(lastLines(events).get('Contact')).toBe(
        '[dry-run] Contact: 2 record(s) would be inserted',
      );
    });
  });

  it('says on a dry run that the contact of a person account would be written by the platform, not inserted', async () => {
    const { executor, inserted } = orgsWithPersonAccounts();
    const events: ForgeProgressEvent[] = [];

    const summary = await executor.execute(CASE_GRAPH, 'src', 'tgt', (e) => events.push(e), {
      ...ROOTED_AT_THE_CASE,
      dryRun: true,
    });

    expect(inserted).toEqual([]);
    // Two accounts, one contact and the case would be inserted.
    expect(summary.wouldInsertCount).toBe(4);
    expect(lastLines(events).get('Contact')).toBe(
      '[dry-run] Contact: 1 record(s) would be inserted, 1 would be written by the platform with their person account',
    );
  });
});
